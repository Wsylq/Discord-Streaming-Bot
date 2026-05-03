import { webhookRequest } from './webhookHttp';
import { getAll, queueLength } from './queueDb';

const PAGE_SIZE = 10;

function buildEmbed(page: number): object {
  const all = getAll();
  const total = all.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const p = Math.max(0, Math.min(page, totalPages - 1));
  const start = p * PAGE_SIZE;
  const items = all.slice(start, start + PAGE_SIZE);

  const description = items.length > 0
    ? items.map((item, i) =>
        `**${start + i + 1}.** [${item.title}](${item.url}) \`${item.duration}\` — ${item.channel}`,
      ).join('\n')
    : '_Queue is empty._';

  return {
    embeds: [{
      color: 0x57f287,
      title: `🎬 Queue — ${total} video${total !== 1 ? 's' : ''}`,
      description,
      footer: {
        text: `Page ${p + 1} / ${totalPages} • !queue-next !queue-prev !queue-remove <n> !queue-clear`,
      },
      timestamp: new Date().toISOString(),
    }],
  };
}

export class QueueDisplay {
  private webhookUrl: string;
  private messageId: string | null = null;
  private page = 0;

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl;
  }

  async show(): Promise<void> {
    this.page = 0;
    const embed = buildEmbed(this.page);
    if (this.messageId) {
      await webhookRequest(this.webhookUrl, 'PATCH', this.messageId, embed);
    } else {
      this.messageId = await webhookRequest(this.webhookUrl, 'POST', null, embed);
    }
  }

  async refresh(): Promise<void> {
    if (!this.messageId) return;
    await webhookRequest(this.webhookUrl, 'PATCH', this.messageId, buildEmbed(this.page));
  }

  async next(): Promise<void> {
    const total = queueLength();
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (this.page < totalPages - 1) {
      this.page++;
      await this.refresh();
    }
  }

  async prev(): Promise<void> {
    if (this.page > 0) {
      this.page--;
      await this.refresh();
    }
  }

  reset(): void {
    this.messageId = null;
    this.page = 0;
  }
}
