import * as path from 'path';
import { execFile } from 'child_process';
import { webhookRequest } from './webhookHttp';

const YTDLP_BIN = path.join(
  path.dirname(require.resolve('youtube-dl-exec')),
  '..',
  'bin',
  process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp',
);

export interface VideoMeta {
  title: string;
  channel: string;
  duration: string;   // human-readable e.g. "3:45"
  durationSecs: number;
  thumbnail: string;
  url: string;
}

/** Fetch video metadata from yt-dlp. Returns null for local files. */
export function fetchVideoMeta(url: string): Promise<VideoMeta | null> {
  if (!url.startsWith('http')) return Promise.resolve(null);

  return new Promise((resolve) => {
    execFile(
      YTDLP_BIN,
      [
        '--js-runtimes', 'node',
        '--no-warnings',
        '--print', '%(title)s\t%(channel)s\t%(duration_string)s\t%(duration)s\t%(thumbnail)s',
        '--no-playlist',
        '--playlist-items', '1',
        url,
      ],
      { shell: false },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        const [title, channel, duration, durationSecs, thumbnail] = stdout.trim().split('\t');
        resolve({
          title: title ?? 'Unknown',
          channel: channel ?? 'Unknown',
          duration: duration ?? '?',
          durationSecs: parseInt(durationSecs ?? '0', 10),
          thumbnail: thumbnail ?? '',
          url,
        });
      },
    );
  });
}

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function buildEmbed(meta: VideoMeta, elapsedSecs: number, status: 'playing' | 'paused' | 'stopped'): object {
  const statusIcon = status === 'playing' ? '▶️' : status === 'paused' ? '⏸️' : '⏹️';
  const progress = meta.durationSecs > 0
    ? `${formatTimestamp(elapsedSecs)} / ${meta.duration}`
    : formatTimestamp(elapsedSecs);

  return {
    embeds: [{
      color: status === 'playing' ? 0x5865f2 : status === 'paused' ? 0xfaa61a : 0x747f8d,
      title: meta.title,
      url: meta.url,
      author: { name: meta.channel },
      thumbnail: meta.thumbnail ? { url: meta.thumbnail } : undefined,
      fields: [
        { name: 'Status', value: `${statusIcon} ${status.charAt(0).toUpperCase() + status.slice(1)}`, inline: true },
        { name: 'Progress', value: `\`${progress}\``, inline: true },
      ],
      timestamp: new Date().toISOString(),
      footer: { text: 'lossai owns all' },
    }],
  };
}

export class WebhookNotifier {
  private webhookUrl: string;
  private messageId: string | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private meta: VideoMeta | null = null;
  private startedAt: number = 0;
  private seekOffset: number = 0;
  private status: 'playing' | 'paused' | 'stopped' = 'stopped';

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl;
  }

  private elapsed(): number {
    if (this.status !== 'playing') return this.seekOffset;
    return this.seekOffset + (Date.now() - this.startedAt) / 1000;
  }

  private async sendOrUpdate(): Promise<void> {
    if (!this.meta) return;
    const embed = buildEmbed(this.meta, this.elapsed(), this.status);

    if (this.messageId) {
      await webhookRequest(this.webhookUrl, 'PATCH', this.messageId, embed);
    } else {
      this.messageId = await webhookRequest(this.webhookUrl, 'POST', null, embed);
    }
  }

  async start(meta: VideoMeta, seekOffset = 0): Promise<void> {
    this.stop();
    this.meta = meta;
    this.seekOffset = seekOffset;
    this.startedAt = Date.now();
    this.status = 'playing';

    console.log(`[webhook] POSTing embed to webhook... URL starts with: ${this.webhookUrl.slice(0, 40)}`);
    await this.sendOrUpdate();
    console.log(`[webhook] POST done, messageId: ${this.messageId}`);

    // Update every 32 seconds
    this.intervalId = setInterval(() => {
      this.sendOrUpdate().catch(() => {});
    }, 32_000);
  }

  /** Call this when actual playback starts (after WebRTC connection established) to sync the clock. */
  resetClock(): void {
    if (this.status === 'playing') {
      this.startedAt = Date.now();
    }
  }

  async pause(seekOffset: number): Promise<void> {
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
    this.status = 'paused';
    this.seekOffset = seekOffset; // freeze at exact pause position
    await this.sendOrUpdate();
  }

  async resume(seekOffset: number): Promise<void> {
    this.seekOffset = seekOffset;
    this.startedAt = Date.now();
    this.status = 'playing';
    await this.sendOrUpdate();

    this.intervalId = setInterval(() => {
      this.sendOrUpdate().catch(() => {});
    }, 32_000);
  }

  stop(): void {
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
    this.status = 'stopped';
    this.meta = null;
    this.messageId = null;
    this.seekOffset = 0;
  }
}
