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
  audioGetPending, audioSetDownloading, audioSetReady, audioSetFailed,
  type AudioQueueItem,
} from './audioQueueDb';

const YTDLP_BIN = path.join(
  path.dirname(require.resolve('youtube-dl-exec')),
  '..',
  'bin',
  process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp',
);

// ─── URL detection ───────────────────────────────────────────────────────────

export function isSpotifyUrl(url: string): boolean {
  return /^https?:\/\/(open\.)?spotify\.com\/(track|album|playlist)\//.test(url);
}

export function isAudioUrl(url: string): boolean {
  // Anything yt-dlp can handle as audio
  return url.startsWith('http');
}

// ─── Spotify metadata via yt-dlp ─────────────────────────────────────────────

export interface SpotifyTrackInfo {
  title: string;
  artist: string;
  searchQuery: string;
}

/**
 * Uses yt-dlp's built-in Spotify extractor to get track metadata.
 * No API key needed — yt-dlp scrapes open.spotify.com.
 * For playlists/albums, returns all tracks.
 */
export function resolveSpotifyTracks(
  url: string,
  abortSignal: AbortSignal,
): Promise<SpotifyTrackInfo[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      YTDLP_BIN,
      [
        '--js-runtimes', 'node',
        '--no-warnings',
        '--flat-playlist',
        '--print', '%(title)s\t%(artist)s\t%(uploader)s',
        url,
      ],
      { shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    abortSignal.addEventListener('abort', () => { proc.kill('SIGKILL'); reject(new Error('Aborted')); }, { once: true });

    let out = '';
    proc.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    proc.stderr?.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) console.error('[yt-dlp spotify]', msg);
    });

    proc.on('close', (code) => {
      if (abortSignal.aborted) return;
      if (code !== 0) { reject(new Error(`yt-dlp Spotify extraction failed (code ${code})`)); return; }

      const tracks: SpotifyTrackInfo[] = out
        .trim().split('\n').filter(Boolean)
        .map(line => {
          const [title, artist, uploader] = line.split('\t');
          const resolvedArtist = (artist && artist !== 'NA') ? artist : (uploader ?? 'Unknown');
          const resolvedTitle = title ?? 'Unknown';
          return {
            title: resolvedTitle,
            artist: resolvedArtist,
            searchQuery: `${resolvedArtist} - ${resolvedTitle}`,
          };
        });

      if (tracks.length === 0) {
        reject(new Error('No tracks found for this Spotify URL'));
        return;
      }

      resolve(tracks);
    });

    proc.on('error', reject);
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
 * Returns path to the downloaded audio file.
 */
export function downloadAudio(
  url: string,
  onProgress: (p: AudioDownloadProgress) => void,
  abortSignal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const tmpBase = path.join(os.tmpdir(), `audio-${Date.now()}`);
    const outTemplate = `${tmpBase}.%(ext)s`;

    const args = [
      '--js-runtimes', 'node',
      '-f', 'bestaudio',
      '--extract-audio',
      '--audio-format', 'opus',
      '--audio-quality', '0',
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
        for (const ext of ['opus', 'm4a', 'mp3', 'webm', 'ogg']) {
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

/**
 * Starts the background pre-download loop.
 * Picks up 'pending' items from the audio queue and downloads them one by one.
 * Runs continuously until stopPredownloader() is called.
 */
export function startPredownloader(): void {
  if (predownloaderRunning) return;
  predownloaderRunning = true;
  predownloaderAbort = new AbortController();
  runPredownloadLoop(predownloaderAbort.signal).catch(() => {});
}

export function stopPredownloader(): void {
  predownloaderRunning = false;
  predownloaderAbort?.abort();
  predownloaderAbort = null;
}

async function runPredownloadLoop(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const pending = audioGetPending();

    if (pending.length === 0) {
      // Nothing to download — wait and check again
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }

    const item = pending[0];
    console.log(`[predownload] Downloading: ${item.title || item.url}`);
    audioSetDownloading(item.id);

    try {
      const filePath = await downloadAudio(
        item.url,
        (p) => {
          if (p.percent % 25 < 1) { // log at 0, 25, 50, 75, 100%
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
      audioSetFailed(item.id);
    }

    // Small pause between downloads
    await new Promise(r => setTimeout(r, 500));
  }
}
