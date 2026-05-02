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
