import { webhookRequest } from './webhookHttp';
import { streamChannelVideos } from './youtubePlayer';
import type { SearchResult } from './youtubePlayer';

const PAGE_SIZE = 5;
const RENDER_EVERY = 10;          // re-render after every N new videos
const MIN_RENDER_INTERVAL = 3500; // ms between background renders (webhook rate limit)

interface BrowseSession {
  channelName: string;
  videosUrl: string;
  allResults: SearchResult[];
  filteredResults: SearchResult[];
  page: number;
  messageId: string | null;
  keyword: string | null;
  fetchedCount: number;
  exhausted: boolean;
  fetchAbort: AbortController;
  lastRenderAt: number; // timestamp of last background render
}

function totalPages(session: BrowseSession): number {
  return Math.max(1, Math.ceil(session.filteredResults.length / PAGE_SIZE));
}

function buildEmbed(session: BrowseSession): object {
  const total = totalPages(session);
  const start = session.page * PAGE_SIZE;
  const pageItems = session.filteredResults.slice(start, start + PAGE_SIZE);

  const description = pageItems.length > 0
    ? pageItems.map((r, i) => `**${start + i + 1}.** [${r.title}](${r.url}) \`${r.duration}\``).join('\n')
    : session.keyword
      ? `_No results matching "${session.keyword}"._`
      : '_No videos found._';

  const filterNote = session.keyword ? ` • 🔍 "${session.keyword}"` : '';
  const loadingNote = !session.exhausted ? ' • ⏳ loading more...' : '';
  const totalNote = session.exhausted ? `${total}` : `${total}+`;

  return {
    embeds: [{
      color: 0x5865f2,
      author: { name: `📺 ${session.channelName}` },
      description,
      footer: {
        text: `Page ${session.page + 1} / ${totalNote}${filterNote}${loadingNote} • !next !prev !page <n> !search-in <kw> !browse-clear !pick <n>`,
      },
      timestamp: new Date().toISOString(),
    }],
  };
}

export class ChannelBrowser {
  private webhookUrl: string;
  private session: BrowseSession | null = null;
  private busy = false;

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl;
  }

  get isActive(): boolean { return this.session !== null; }
  get currentResults(): SearchResult[] { return this.session?.filteredResults ?? []; }

  async open(channelName: string, videosUrl: string, initialResults: SearchResult[]): Promise<void> {
    this.close();
    const fetchAbort = new AbortController();
    this.session = {
      channelName, videosUrl,
      allResults: [...initialResults],
      filteredResults: [...initialResults],
      page: 0, messageId: null, keyword: null,
      fetchedCount: initialResults.length,
      exhausted: initialResults.length === 0,
      fetchAbort,
      lastRenderAt: 0,
    };
    await this.render();
    this.streamAll(); // single process, results arrive as they're found
  }

  async next(): Promise<boolean> {
    if (!this.session || this.busy) return false;
    this.busy = true;
    try {
      const nextPage = this.session.page + 1;
      const needed = (nextPage + 1) * PAGE_SIZE;

      // Fetch until we have content for the next page
      if (this.session.filteredResults.length < needed && !this.session.exhausted) {
        await this.waitForResults(needed);
      }

      // Check if next page actually has content
      const hasNextContent = this.session.filteredResults.length > this.session.page * PAGE_SIZE + PAGE_SIZE;
      if (!hasNextContent) return false;

      this.session.page = nextPage;
      await this.render();
      return true;
    } finally {
      this.busy = false;
    }
  }

  async prev(): Promise<boolean> {
    if (!this.session || this.busy) return false;
    if (this.session.page <= 0) return false;
    this.busy = true;
    try {
      this.session.page--;
      await this.render();
      return true;
    } finally {
      this.busy = false;
    }
  }

  async goToPage(pageNum: number): Promise<boolean> {
    if (!this.session || this.busy) return false;
    this.busy = true;
    try {
      const p = pageNum - 1;
      if (p < 0) return false;

      const needed = (p + 1) * PAGE_SIZE;
      if (needed > this.session.filteredResults.length && !this.session.exhausted) {
        await this.waitForResults(needed);
      }

      if (p >= totalPages(this.session)) return false;

      this.session.page = p;
      await this.render();
      return true;
    } finally {
      this.busy = false;
    }
  }

  async searchIn(keyword: string): Promise<void> {
    if (!this.session || this.busy) return;
    this.busy = true;
    try {
      this.session.keyword = keyword;
      this.applyFilter(this.session);
      this.session.page = 0;
      await this.render();
    } finally {
      this.busy = false;
    }
  }

  async clearFilter(): Promise<void> {
    if (!this.session || this.busy) return;
    this.busy = true;
    try {
      this.session.keyword = null;
      this.applyFilter(this.session);
      this.session.page = 0;
      await this.render();
    } finally {
      this.busy = false;
    }
  }

  close(): void {
    if (this.session) {
      this.session.fetchAbort.abort();
      this.session = null;
    }
    this.busy = false;
  }

  private applyFilter(session: BrowseSession): void {
    if (session.keyword) {
      const kw = session.keyword.toLowerCase();
      session.filteredResults = session.allResults.filter(r => r.title.toLowerCase().includes(kw));
    } else {
      session.filteredResults = [...session.allResults];
    }
  }

  /** Wait until we have at least `needed` filtered results or the channel is exhausted. */
  private async waitForResults(needed: number): Promise<void> {
    const session = this.session;
    if (!session) return;
    while (session.filteredResults.length < needed && !session.exhausted && !session.fetchAbort.signal.aborted) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  /** Single yt-dlp process that streams all channel videos, updating the browser as results arrive. */
  private async streamAll(): Promise<void> {
    const session = this.session;
    if (!session) return;

    let sinceLastRender = 0;

    try {
      await streamChannelVideos(
        session.videosUrl,
        session.channelName,
        session.fetchAbort.signal,
        (result) => {
          if (session.fetchAbort.signal.aborted) return;

          // Skip videos already in the initial batch
          if (session.allResults.some(r => r.url === result.url)) return;

          session.allResults.push(result);
          session.fetchedCount++;
          this.applyFilter(session);
          sinceLastRender++;

          // Re-render periodically, but respect rate limit
          if (sinceLastRender >= RENDER_EVERY) {
            const now = Date.now();
            if (now - session.lastRenderAt >= MIN_RENDER_INTERVAL) {
              sinceLastRender = 0;
              session.lastRenderAt = now;
              this.render().catch(() => {});
            }
          }
        },
      );
    } catch { /* ignore — process killed on close() */ }

    if (!session.fetchAbort.signal.aborted) {
      session.exhausted = true;
      await this.render().catch(() => {});
    }
  }

  private async render(): Promise<void> {
    if (!this.session) return;
    const embed = buildEmbed(this.session);
    if (this.session.messageId) {
      await webhookRequest(this.webhookUrl, 'PATCH', this.session.messageId, embed);
    } else {
      this.session.messageId = await webhookRequest(this.webhookUrl, 'POST', null, embed);
    }
  }
}
