import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import type { Streamer } from '@dank074/discord-video-stream';
import { prepareStream, playStream } from '@dank074/discord-video-stream';
import { ENCODER_OPTIONS } from './encoderOptions';

const YTDLP_BIN = path.join(
  path.dirname(require.resolve('youtube-dl-exec')),
  '..',
  'bin',
  process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp',
);

export function isYouTubeUrl(input: string): boolean {
  return /^https?:\/\/(www\.)?(youtube\.com\/watch|youtu\.be\/)/.test(input);
}

/**
 * Searches YouTube for a query and returns the URL of the top result.
 * Uses yt-dlp's ytsearch: prefix — no API key needed.
 */
export function searchYouTube(query: string, abortSignal: AbortSignal): Promise<{ url: string; title: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      YTDLP_BIN,
      [
        '--js-runtimes', 'node',
        '--no-warnings',
        '--print', '%(webpage_url)s\t%(title)s',
        '--no-playlist',
        `ytsearch1:${query}`,
      ],
      { shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    abortSignal.addEventListener('abort', () => {
      proc.kill('SIGKILL');
      reject(new Error('Search aborted'));
    }, { once: true });

    let output = '';
    proc.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    proc.stderr?.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) console.error('[yt-dlp search]', msg);
    });

    proc.on('close', (code) => {
      if (abortSignal.aborted) return;
      const line = output.trim().split('\n')[0] ?? '';
      const [url, ...titleParts] = line.split('\t');
      const title = titleParts.join('\t').trim();
      if (code === 0 && url?.startsWith('http')) {
        resolve({ url, title: title || url });
      } else {
        reject(new Error(`yt-dlp search failed (code ${code})`));
      }
    });

    proc.on('error', reject);
  });
}

export interface SearchResult {
  url: string;
  title: string;
  duration: string;
  channel: string;
}

/**
 * Searches YouTube and returns top N results for user selection.
 */
export function searchYouTubeMultiple(
  query: string,
  count: number,
  abortSignal: AbortSignal,
): Promise<SearchResult[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      YTDLP_BIN,
      [
        '--js-runtimes', 'node',
        '--no-warnings',
        '--print', '%(webpage_url)s\t%(title)s\t%(duration_string)s\t%(channel)s',
        '--no-playlist',
        `ytsearch${count}:${query}`,
      ],
      { shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    abortSignal.addEventListener('abort', () => {
      proc.kill('SIGKILL');
      reject(new Error('Search aborted'));
    }, { once: true });

    let output = '';
    proc.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    proc.stderr?.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) console.error('[yt-dlp search]', msg);
    });

    proc.on('close', (code) => {
      if (abortSignal.aborted) return;
      if (code !== 0) { reject(new Error(`yt-dlp search failed (code ${code})`)); return; }

      const results: SearchResult[] = output
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const [url, title, duration, channel] = line.split('\t');
          return { url: url ?? '', title: title ?? url ?? '', duration: duration ?? '?', channel: channel ?? '?' };
        })
        .filter(r => r.url.startsWith('http'));

      resolve(results);
    });

    proc.on('error', reject);
  });
}

/**
 * Fetches the latest N videos from a YouTube channel by name.
 * Step 1: search for a video to resolve the channel URL + real name.
 * Step 2: fetch videos from that channel's uploads page.
 */
export function searchChannelVideos(
  channelName: string,
  count: number,
  abortSignal: AbortSignal,
): Promise<SearchResult[]> {
  return new Promise((resolve, reject) => {
    // Step 1: get channel_url and channel name from a search result
    const step1 = spawn(
      YTDLP_BIN,
      [
        '--js-runtimes', 'node',
        '--no-warnings',
        '--print', '%(channel_url)s\t%(channel)s',
        '--no-playlist',
        '--playlist-items', '1',
        `ytsearch1:${channelName}`,
      ],
      { shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    abortSignal.addEventListener('abort', () => { step1.kill('SIGKILL'); reject(new Error('Aborted')); }, { once: true });

    let step1Out = '';
    step1.stdout?.on('data', (chunk: Buffer) => { step1Out += chunk.toString(); });
    step1.stderr?.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) console.error('[yt-dlp channel resolve]', msg);
    });

    step1.on('close', (code) => {
      if (abortSignal.aborted) return;
      if (code !== 0) { reject(new Error(`Could not resolve channel (code ${code})`)); return; }

      const line = step1Out.trim().split('\n')[0] ?? '';
      const [channelUrl, resolvedName] = line.split('\t');

      if (!channelUrl?.startsWith('http')) {
        reject(new Error(`Could not find channel "${channelName}"`));
        return;
      }

      const displayName = resolvedName?.trim() || channelName;
      const videosUrl = channelUrl.replace(/\/?$/, '/videos');
      console.log(`[yt-dlp] Resolved "${channelName}" → "${displayName}" (${videosUrl})`);

      // Step 2: fetch videos — no --flat-playlist so titles/durations are populated
      const step2 = spawn(
        YTDLP_BIN,
        [
          '--js-runtimes', 'node',
          '--no-warnings',
          '--print', '%(webpage_url)s\t%(title)s\t%(duration_string)s',
          '--playlist-end', String(count),
          videosUrl,
        ],
        { shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
      );

      abortSignal.addEventListener('abort', () => { step2.kill('SIGKILL'); }, { once: true });

      let step2Out = '';
      step2.stdout?.on('data', (chunk: Buffer) => { step2Out += chunk.toString(); });
      step2.stderr?.on('data', (chunk: Buffer) => {
        const msg = chunk.toString().trim();
        if (msg) console.error('[yt-dlp channel videos]', msg);
      });

      step2.on('close', (code2) => {
        if (abortSignal.aborted) return;
        if (code2 !== 0) { reject(new Error(`Failed to fetch channel videos (code ${code2})`)); return; }

        const results: SearchResult[] = step2Out
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(line => {
            const [url, title, duration] = line.split('\t');
            return { url: url ?? '', title: title ?? '', duration: duration ?? '?', channel: displayName };
          })
          .filter(r => r.url.startsWith('http'));

        if (results.length === 0) {
          reject(new Error(`No videos found for "${displayName}".`));
          return;
        }

        resolve(results);
      });

      step2.on('error', reject);
    });

    step1.on('error', reject);
  });
}

export interface DownloadProgress {
  percent: number;
  speed: string;
  eta: string;
}

/**
 * Downloads a YouTube video to a temp mp4 file at 480p.
 * Returns the path — caller is responsible for deleting it.
 */
export function downloadVideo(
  url: string,
  onProgress: (p: DownloadProgress) => void,
  abortSignal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `ytdl-${Date.now()}.mp4`);

    const args = [
      '--js-runtimes', 'node',
      '-f', 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best[height<=480]',
      '--merge-output-format', 'mp4',
      '--newline', '--progress', '--no-warnings',
      '-o', tmpFile,
      url,
    ];

    const proc = spawn(YTDLP_BIN, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });

    abortSignal.addEventListener('abort', () => {
      proc.kill('SIGKILL');
      fs.unlink(tmpFile, () => {});
      reject(new Error('Download aborted'));
    }, { once: true });

    const progressRe = /\[download\]\s+([\d.]+)%.*?at\s+(\S+)\s+ETA\s+(\S+)/;
    proc.stdout?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        const m = progressRe.exec(line);
        if (m) onProgress({ percent: parseFloat(m[1]), speed: m[2], eta: m[3] });
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) console.error('[yt-dlp]', msg);
    });

    proc.on('close', (code) => {
      if (abortSignal.aborted) return;
      if (code === 0) resolve(tmpFile);
      else {
        fs.unlink(tmpFile, () => {});
        reject(new Error(`yt-dlp exited with code ${code}`));
      }
    });

    proc.on('error', reject);
  });
}

export function streamDownloadingScreen(
  streamer: Streamer,
  abortSignal: AbortSignal,
): () => void {
  const screenAbort = new AbortController();
  abortSignal.addEventListener('abort', () => screenAbort.abort(), { once: true });

  const { output, promise } = prepareStream(
    'color=c=0x1a1a2e:s=640x360:r=2',
    {
      ...ENCODER_OPTIONS,
      includeAudio: false,
      frameRate: 2,
      customInputOptions: ['-f', 'lavfi'],
      customFfmpegFlags: [
        '-vf',
        "drawtext=fontsize=42:fontcolor=white:x=(w-text_w)/2:y=(h/2)-60:text='Downloading...'," +
        "drawtext=fontsize=24:fontcolor=0x888888:x=(w-text_w)/2:y=(h/2)+10:text='Please wait'",
      ],
    },
    screenAbort.signal,
  );

  playStream(output, streamer, { type: 'camera' }, screenAbort.signal).catch(() => {});
  promise.catch(() => {});

  return () => screenAbort.abort();
}

/**
 * Downloads the video, shows a holding screen, then returns the local file path.
 * The caller owns the file and must delete it when done.
 */
export async function downloadYouTubeVideo(
  url: string,
  streamer: Streamer,
  abortSignal: AbortSignal,
  onProgress?: (p: DownloadProgress) => void,
): Promise<string> {
  console.log('[yt-dlp] Downloading video...');

  const stopScreen = streamDownloadingScreen(streamer, abortSignal);

  let tmpFile: string;
  try {
    tmpFile = await downloadVideo(
      url,
      (p) => {
        console.log(`[yt-dlp] ${p.percent.toFixed(1)}% at ${p.speed} ETA ${p.eta}`);
        onProgress?.(p);
      },
      abortSignal,
    );
  } finally {
    stopScreen();
  }

  await new Promise(r => setTimeout(r, 500));
  return tmpFile;
}

export function deleteTempFile(filePath: string): void {
  fs.unlink(filePath, (err) => {
    if (err) console.warn('[yt-dlp] Failed to delete temp file:', err.message);
    else console.log('[yt-dlp] Temp file cleaned up.');
  });
}
