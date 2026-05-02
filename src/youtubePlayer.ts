import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import type { Streamer } from '@dank074/discord-video-stream';
import { prepareStream, playStream } from '@dank074/discord-video-stream';
import { ENCODER_OPTIONS } from './encoderOptions';

// Resolve the bundled yt-dlp binary from youtube-dl-exec
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
 * Calls onProgress with parsed yt-dlp progress updates.
 * Returns the path to the downloaded file.
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
      '--newline',
      '--progress',
      '--no-warnings',
      '-o', tmpFile,
      url,
    ];

    const proc = spawn(YTDLP_BIN, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });

    abortSignal.addEventListener('abort', () => {
      proc.kill('SIGKILL');
      fs.unlink(tmpFile, () => {});
      reject(new Error('Download aborted'));
    }, { once: true });

    // "[download]  42.3% of 123.45MiB at 1.23MiB/s ETA 00:42"
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

/**
 * Streams a "Downloading..." holding screen to Discord camera.
 * Runs a lavfi color source with drawtext overlay for the full duration.
 * Returns a stop function.
 */
export function streamDownloadingScreen(
  streamer: Streamer,
  getProgress: () => DownloadProgress,
  abortSignal: AbortSignal,
): () => void {
  const screenAbort = new AbortController();
  abortSignal.addEventListener('abort', () => screenAbort.abort(), { once: true });

  // ffmpeg lavfi: black 640x360 @ 1fps, drawtext reads from a file we update
  // Simpler: just show static "Downloading..." — progress goes to text channel
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

export async function playYouTubeUrl(
  url: string,
  streamer: Streamer,
  abortSignal: AbortSignal,
  onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
  console.log('[yt-dlp] Downloading video...');

  let progress: DownloadProgress = { percent: 0, speed: '...', eta: '...' };

  const stopScreen = streamDownloadingScreen(streamer, () => progress, abortSignal);

  let tmpFile: string | null = null;
  try {
    tmpFile = await downloadVideo(
      url,
      (p) => {
        progress = p;
        console.log(`[yt-dlp] ${p.percent.toFixed(1)}% at ${p.speed} ETA ${p.eta}`);
        onProgress?.(p);
      },
      abortSignal,
    );
  } catch (err) {
    stopScreen();
    throw err;
  }

  stopScreen();

  if (abortSignal.aborted) {
    if (tmpFile) fs.unlink(tmpFile, () => {});
    return;
  }

  // Small pause so the camera stream has time to stop before we start the video
  await new Promise(r => setTimeout(r, 500));

  console.log('[stream] Playing downloaded file...');

  try {
    const { output, promise } = prepareStream(tmpFile, ENCODER_OPTIONS, abortSignal);
    await playStream(output, streamer, { type: 'camera', readrateInitialBurst: 10 }, abortSignal);
    await promise;
  } finally {
    fs.unlink(tmpFile, (err) => {
      if (err) console.warn('[yt-dlp] Failed to delete temp file:', err.message);
      else console.log('[yt-dlp] Temp file cleaned up.');
    });
  }
}
