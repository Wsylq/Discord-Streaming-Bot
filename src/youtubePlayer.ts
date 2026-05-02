import { execFile } from 'child_process';
import * as path from 'path';
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

/**
 * Ask yt-dlp for the best HLS stream URL (video+audio in one stream),
 * then hand that URL directly to prepareStream so FFmpeg fetches it.
 */
function getStreamUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      YTDLP_BIN,
      [
        '--js-runtimes', 'node',
        '-f', 'best[protocol=m3u8_native]/best[protocol=m3u8]/best',
        '--get-url',
        '--no-warnings',
        url,
      ],
      { shell: false },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`yt-dlp failed: ${stderr || err.message}`));
          return;
        }
        const streamUrl = stdout.trim().split('\n')[0];
        if (!streamUrl) {
          reject(new Error('yt-dlp returned no URL'));
          return;
        }
        resolve(streamUrl);
      },
    );
  });
}

export async function playYouTubeUrl(
  url: string,
  streamer: Streamer,
  abortSignal: AbortSignal,
): Promise<void> {
  console.log('[yt-dlp] Resolving stream URL...');
  const streamUrl = await getStreamUrl(url);
  console.log('[yt-dlp] Got stream URL, handing to FFmpeg...');

  const { output, promise } = prepareStream(streamUrl, ENCODER_OPTIONS, abortSignal);

  await playStream(output, streamer, { type: 'go-live' }, abortSignal);
  await promise;
}
