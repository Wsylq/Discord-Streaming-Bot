import { webhookRequest } from './webhookHttp';
import { audioGetAll, audioQueueLength } from './audioQueueDb';

const PAGE_SIZE = 10;

const STATUS_ICON: Record<string, string> = {
  pending: '⏳',
  downloading: '⬇️',
  ready: '✅',
  failed: '❌',
};

function buildEmbed(page: number): object {
  const all = audioGetAll();
  const total = all.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const p = Math.max(0, Math.min(page, totalPages - 1));
  const start = p * PAGE_SIZE;
  const items = all.slice(start, start + PAGE_SIZE);

  const description = items.length > 0
    ? items.map((item, i) => {
        const icon = STATUS_ICON[item.downloadStatus] ?? '⏳';
        return `${icon} **${start + i + 1}.** ${item.title} \`${item.duration}\` — ${item.artist}`;
      }).join('\n')
    : '_Audio queue is empty._';

  return {
    embeds: [{
      color: 0xeb459e,
      title: `🎵 Audio Queue — ${total} track${total !== 1 ? 's' : ''}`,
      description,
      footer: {
        text: `Page ${p + 1} / ${totalPages} • !aq-next !aq-prev !aq-remove <n> !aq-clear`,
      },
      timestamp: new Date().toISOString(),
    }],
  };
}

export class AudioQueueDisplay {
  private webhookUrl: string;
  private messageId: string | null = null;
  private page = 0;

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl;
  }

  async show(): Promise<void> {
    this.page = 0;
    const embed = buildEmbed(this.page);
    // Always POST a new message so it appears at the bottom of chat
    this.messageId = await webhookRequest(this.webhookUrl, 'POST', null, embed);
  }

  async refresh(): Promise<void> {
    if (!this.messageId) return;
    await webhookRequest(this.webhookUrl, 'PATCH', this.messageId, buildEmbed(this.page)).catch(() => {});
  }

  async next(): Promise<void> {
    const total = audioQueueLength();
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (this.page < totalPages - 1) { this.page++; await this.refresh(); }
  }

  async prev(): Promise<void> {
    if (this.page > 0) { this.page--; await this.refresh(); }
  }

  reset(): void { this.messageId = null; this.page = 0; }
}
