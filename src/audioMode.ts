/**
 * Audio-only mode.
 *
 * Spotify metadata: resolved via yt-dlp's built-in Spotify extractor
 * (no API key needed — yt-dlp scrapes open.spotify.com directly).
 *
 * Pre-download: items are downloaded in the background as soon as they're
 * added to the audio queue, so playback starts instantly.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  audioGetPending, audioSetDownloading, audioSetReady, audioSetFailed, audioSetUrl,
  type AudioQueueItem,
} from './audioQueueDb';
import { YTDLP_BIN } from './constants';

// ─── URL detection ───────────────────────────────────────────────────────────

export function isSpotifyUrl(url: string): boolean {
  return /^https?:\/\/(open\.)?spotify\.com\/(track|album|playlist)\//.test(url);
}

export function isAudioUrl(url: string): boolean {
  // Anything yt-dlp can handle as audio
  return url.startsWith('http');
}

// ─── Spotify metadata via spotify-url-info ───────────────────────────────────
// Uses spotify-url-info which scrapes Spotify's public embed pages.
// No API key or authentication required.

export interface SpotifyTrackInfo {
  title: string;
  artist: string;
  searchQuery: string;
}

/**
 * Resolves a Spotify track/album/playlist URL to a list of track metadata.
 * Uses spotify-url-info — no API key needed, scrapes public embed pages.
 */
export async function resolveSpotifyTracks(
  url: string,
  _abortSignal: AbortSignal,
): Promise<SpotifyTrackInfo[]> {
  // spotify-url-info requires a fetch implementation — use node-fetch@2 (CJS)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fetch = require('node-fetch');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getTracks } = require('spotify-url-info')(fetch);

  // getTracks returns an array of track objects from the Spotify embed page
  const rawTracks = await getTracks(url) as Array<{
    name?: string;
    title?: string;
    artists?: Array<{ name: string }>;
    artist?: string;
  }>;

  if (!rawTracks || rawTracks.length === 0) {
    throw new Error('No tracks found for this Spotify URL');
  }

  return rawTracks.map(t => {
    const title = t.name ?? t.title ?? 'Unknown';
    const artist = t.artists?.map(a => a.name).join(', ') ?? t.artist ?? 'Unknown';
    return { title, artist, searchQuery: `${artist} - ${title}` };
  });
}

// ─── YouTube Music search ─────────────────────────────────────────────────────

export function searchYouTubeMusic(
  query: string,
  abortSignal: AbortSignal,
): Promise<{ url: string; title: string; duration: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      YTDLP_BIN,
      [
        '--js-runtimes', 'node',
        '--no-warnings',
        '--flat-playlist',
        '--print', '%(webpage_url)s\t%(title)s\t%(duration_string)s',
        `ytsearch1:${query}`,
      ],
      { shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    abortSignal.addEventListener('abort', () => { proc.kill('SIGKILL'); reject(new Error('Aborted')); }, { once: true });

    let out = '';
    proc.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    proc.stderr?.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) console.error('[yt-dlp music search]', msg);
    });

    proc.on('close', (code) => {
      if (abortSignal.aborted) return;
      const line = out.trim().split('\n')[0] ?? '';
      const [url, title, duration] = line.split('\t');
      if (code === 0 && url?.startsWith('http')) {
        resolve({ url, title: title ?? query, duration: duration ?? '?' });
      } else {
        reject(new Error(`YouTube Music search failed (code ${code})`));
      }
    });

    proc.on('error', reject);
  });
}

// ─── Audio download ───────────────────────────────────────────────────────────

export interface AudioDownloadProgress {
  percent: number;
  speed: string;
  eta: string;
}

/**
 * Downloads the best available audio from any yt-dlp supported URL.
 *
 * Speed strategy:
 * - For YouTube: request bestaudio[ext=webm] which is natively opus in a webm
 *   container — no ffmpeg re-encode needed, just a raw download.
 * - Falls back to bestaudio for non-YouTube sources (Spotify-resolved URLs,
 *   SoundCloud, etc.) which may need extraction.
 * - 8 concurrent fragments + 25M chunk size saturates most connections.
 *
 * Returns path to the downloaded audio file (.webm or .opus).
 */
export function downloadAudio(
  url: string,
  onProgress: (p: AudioDownloadProgress) => void,
  abortSignal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const tmpBase = path.join(os.tmpdir(), `audio-${Date.now()}`);
    const outTemplate = `${tmpBase}.%(ext)s`;

    // Prefer native webm/opus (no re-encode). Fall back to bestaudio for
    // non-YouTube sources where webm may not be available.
    const isYouTube = /youtube\.com|youtu\.be/.test(url);

    const args = isYouTube
      ? [
        '--js-runtimes', 'node',
        // Native opus in webm — zero re-encode, just download
        '-f', 'bestaudio[ext=webm]/bestaudio',
        // No extraction step needed — webm is already playable by ffmpeg
        '--concurrent-fragments', '8',
        '--http-chunk-size', '25M',
        '--buffer-size', '16K',
        '--no-part',
        '--no-mtime',
        '--newline', '--progress', '--no-warnings',
        '-o', outTemplate,
        url,
      ]
      : [
        '--js-runtimes', 'node',
        '-f', 'bestaudio',
        '--extract-audio',
        '--audio-format', 'opus',
        '--audio-quality', '0',
        '--concurrent-fragments', '8',
        '--http-chunk-size', '25M',
        '--buffer-size', '16K',
        '--no-part',
        '--no-mtime',
        '--newline', '--progress', '--no-warnings',
        '-o', outTemplate,
        url,
      ];

    const proc = spawn(YTDLP_BIN, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });

    abortSignal.addEventListener('abort', () => {
      proc.kill('SIGKILL');
      reject(new Error('Download aborted'));
    }, { once: true });

    const progressRe = /\[download\]\s+([\d.]+)%.*?at\s+(\S+)\s+ETA\s+(\S+)/;
    let resolvedPath: string | null = null;

    proc.stdout?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        const m = progressRe.exec(line);
        if (m) onProgress({ percent: parseFloat(m[1]), speed: m[2], eta: m[3] });
        const dest = line.match(/\[(?:ExtractAudio|download)\] Destination: (.+)/);
        if (dest) resolvedPath = dest[1].trim();
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) console.error('[yt-dlp audio]', msg);
    });

    proc.on('close', (code) => {
      if (abortSignal.aborted) return;
      if (code === 0) {
        if (resolvedPath && fs.existsSync(resolvedPath)) { resolve(resolvedPath); return; }
        for (const ext of ['webm', 'opus', 'm4a', 'mp3', 'ogg']) {
          const candidate = `${tmpBase}.${ext}`;
          if (fs.existsSync(candidate)) { resolve(candidate); return; }
        }
        reject(new Error('Audio file not found after download'));
      } else {
        reject(new Error(`yt-dlp audio download failed (code ${code})`));
      }
    });

    proc.on('error', reject);
  });
}

export function deleteAudioFile(filePath: string): void {
  fs.unlink(filePath, (err) => {
    if (err) console.warn('[audio] Failed to delete temp file:', err.message);
  });
}

// ─── Background pre-downloader ────────────────────────────────────────────────

let predownloaderRunning = false;
let predownloaderAbort: AbortController | null = null;
let onPredownloadFailure: ((title: string) => void) | null = null;

/**
 * Starts the background pre-download loop.
 * Picks up 'pending' items from the audio queue and downloads them one by one.
 * Runs continuously until stopPredownloader() is called.
 * @param onFailure Optional callback called with the item title when a download fails.
 */
export function startPredownloader(onFailure?: (title: string) => void): void {
  if (predownloaderRunning) return;
  predownloaderRunning = true;
  onPredownloadFailure = onFailure ?? null;
  predownloaderAbort = new AbortController();
  runPredownloadLoop(predownloaderAbort.signal).catch(() => { });
}

export function stopPredownloader(): void {
  predownloaderRunning = false;
  predownloaderAbort?.abort();
  predownloaderAbort = null;
  onPredownloadFailure = null;
}

async function runPredownloadLoop(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const pending = audioGetPending();

    if (pending.length === 0) {
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }

    const item = pending[0];
    console.log(`[predownload] Downloading: ${item.title || item.url}`);
    audioSetDownloading(item.id);

    try {
      // If this is a Spotify track that hasn't been resolved to a YouTube URL yet,
      // search YouTube Music first to get the actual download URL.
      let downloadUrl = item.url;
      if (item.spotifySearchQuery) {
        console.log(`[predownload] Resolving Spotify track: ${item.spotifySearchQuery}`);
        const result = await searchYouTubeMusic(item.spotifySearchQuery, signal);
        downloadUrl = result.url;
        // Persist the resolved URL so it's available for playback
        audioSetUrl(item.id, downloadUrl);
      }

      const filePath = await downloadAudio(
        downloadUrl,
        (p) => {
          if (p.percent % 25 < 1) {
            console.log(`[predownload] ${item.title} — ${p.percent.toFixed(0)}%`);
          }
        },
        signal,
      );
      audioSetReady(item.id, filePath);
      console.log(`[predownload] Ready: ${item.title}`);
    } catch (err: unknown) {
      if (signal.aborted) break;
      console.error(`[predownload] Failed: ${item.title}`, err instanceof Error ? err.message : err);
      const failedTitle = audioSetFailed(item.id);
      if (failedTitle && onPredownloadFailure) {
        onPredownloadFailure(failedTitle);
      }
    }

    await new Promise(r => setTimeout(r, 500));
  }
}
