import type { Client, TextChannel, VoiceChannel } from 'discord.js-selfbot-v13';
import type { VideoQueue } from './videoQueue';
import { isYouTubeUrl, searchYouTube, searchYouTubeMultiple, searchChannelVideos, resolveChannelUrl, fetchChannelVideosBatch, type SearchResult } from './youtubePlayer';
import type { ChannelBrowser } from './channelBrowser';

export interface StreamController {
  isStreaming: boolean;
  isPaused: boolean;
  isInVoice: boolean;
  loopTrack: boolean;
  loopQueue: boolean;
  start(voiceChannel: VoiceChannel, queue: VideoQueue, textChannel: TextChannel): Promise<void>;
  playUrl(voiceChannel: VoiceChannel, url: string, textChannel: TextChannel): Promise<void>;
  toggleLoopTrack(): boolean;
  toggleLoopQueue(): boolean;
  pause(): Promise<boolean>;
  resume(voiceChannel: VoiceChannel): Promise<boolean>;
  stop(): Promise<void>;
  skip(): Promise<void>;
}

export interface CommandHandlerDeps {
  streamController: StreamController;
  queue: VideoQueue;
  client: Client;
  browser: ChannelBrowser | null;
}

interface RawMessagePacket {
  t: string;
  d: {
    content: string;
    channel_id: string;
    author: { id: string };
  };
}

export function registerCommandHandler(deps: CommandHandlerDeps): void {
  const { streamController, queue, client, browser } = deps;

  const GUILD_ID = process.env['GUILD_ID']!;
  const VOICE_CHANNEL_ID = process.env['VOICE_CHANNEL_ID']!;
  const TEXT_CHANNEL_ID = process.env['TEXT_CHANNEL_ID']!;
  const OWNER_ID = process.env['OWNER_ID']!;

  // Pending pick results — from !search -pick or channel browser
  let pendingResults: SearchResult[] | null = null;
  const PAGE_SIZE = 5;

  async function reply(msg: string): Promise<void> {
    try {
      const ch = await client.channels.fetch(TEXT_CHANNEL_ID) as TextChannel;
      await ch.send(msg);
    } catch { /* ignore */ }
  }

  async function playChosen(chosen: SearchResult): Promise<void> {
    await reply(`▶️ Playing: **${chosen.title}**`);
    try {
      await client.guilds.fetch(GUILD_ID);
      const voiceChannel = await client.channels.fetch(VOICE_CHANNEL_ID) as VoiceChannel;
      const textChannel = await client.channels.fetch(TEXT_CHANNEL_ID) as TextChannel;
      await streamController.playUrl(voiceChannel, chosen.url, textChannel);
    } catch (err) {
      console.error('[cmd] playChosen error:', err);
    }
  }

  client.on('raw', async (packet: RawMessagePacket) => {
    if (packet.t !== 'MESSAGE_CREATE') return;

    const data = packet.d;
    if (data.author.id !== OWNER_ID) return;
    if (data.channel_id !== TEXT_CHANNEL_ID) return;

    const content = data.content.trim();

    // ── Help ────────────────────────────────────────────────────────────────
    if (content === '!help') {
      const helpEmbed = {
        embeds: [{
          color: 0x5865f2,
          title: '📋 Commands',
          fields: [
            {
              name: '🔍 Search',
              value: [
                '`!search <query>` — play top result instantly',
                '`!search -pick <query>` — choose from top 5',
                '`!search -channel <name>` — browse a channel\'s videos',
              ].join('\n'),
            },
            {
              name: '📺 Channel Browser',
              value: [
                '`!next` / `!prev` — navigate pages',
                '`!page <n>` — jump to any page directly',
                '`!search-in <keyword>` — filter by keyword',
                '`!browse-clear` — clear filter',
                '`!pick <n>` — play video by number',
              ].join('\n'),
            },
            {
              name: '▶️ Playback',
              value: [
                '`!play <url>` — stream a YouTube video',
                '`!start` — stream from local folder',
                '`!pause` / `!resume` — pause and resume',
                '`!skip` — skip to next',
                '`!loop` — loop current track',
                '`!loopqueue` — loop entire queue',
                '`!stop` — stop and leave voice',
              ].join('\n'),
            },
          ],
          footer: { text: 'lossai owns all' },
          timestamp: new Date().toISOString(),
        }],
      };

      // Try sending embed via webhook, fall back to plain text
      if (browser) {
        try {
          const { webhookRequest: wr } = await import('./webhookHttp');
          const webhookUrl = process.env['WEBHOOK_URL']!;
          await wr(webhookUrl, 'POST', null, helpEmbed);
          return;
        } catch { /* fall through to text */ }
      }

      await reply(
        '**Commands**\n' +
        '🔍 **Search**\n' +
        '`!search <query>` — play top result\n' +
        '`!search -pick <query>` — choose from top 5\n' +
        '  └ `!pick <n>`\n' +
        '`!search -channel <name>` — browse channel videos\n' +
        '  └ `!next` `!prev` `!page <n>` `!search-in <kw>` `!browse-clear` `!pick <n>`\n\n' +
        '▶️ **Playback**\n' +
        '`!play <url>` `!start` `!pause` `!resume` `!skip` `!loop` `!loopqueue` `!stop`'
      );
      return;
    }

    // ── Start local queue ────────────────────────────────────────────────────
    if (content === '!start') {
      if (streamController.isStreaming) return;
      if (queue.files.length === 0) { await reply('No videos found in the configured folder.'); return; }
      try {
        await client.guilds.fetch(GUILD_ID);
        const voiceChannel = await client.channels.fetch(VOICE_CHANNEL_ID) as VoiceChannel;
        const textChannel = await client.channels.fetch(TEXT_CHANNEL_ID) as TextChannel;
        await streamController.start(voiceChannel, queue, textChannel);
      } catch (err) { console.error('[cmd] !start error:', err); }
      return;
    }

    // ── Search ───────────────────────────────────────────────────────────────
    if (content.startsWith('!search ')) {
      const raw = content.slice('!search '.length).trim();
      const pickMode = raw.startsWith('-pick ');
      const channelMode = raw.startsWith('-channel ');
      const query = pickMode
        ? raw.slice('-pick '.length).trim()
        : channelMode
          ? raw.slice('-channel '.length).trim()
          : raw;

      if (!query) {
        await reply(
          'Usage:\n' +
          '`!search <query>` — play top result\n' +
          '`!search -pick <query>` — choose from top 5\n' +
          '`!search -channel <name>` — browse a channel\'s videos'
        );
        return;
      }

      if (channelMode) {
        // Resolve channel URL first, then fetch initial 5 videos and open browser
        await reply(`📺 Fetching videos from **${query}**...`);
        let videosUrl: string;
        let displayName: string;
        try {
          const abort = new AbortController();
          ({ videosUrl, displayName } = await resolveChannelUrl(query, abort.signal));
        } catch (err: unknown) {
          console.error('[cmd] !search -channel resolve error:', err);
          await reply(`❌ ${err instanceof Error ? err.message : 'Unknown error'}`);
          return;
        }

        // Fetch first 5 immediately so the embed appears fast
        let initialResults: SearchResult[] = [];
        try {
          const abort = new AbortController();
          initialResults = await fetchChannelVideosBatch(videosUrl, displayName, 1, PAGE_SIZE, abort.signal);
        } catch (err) {
          console.error('[cmd] !search -channel initial fetch error:', err);
          await reply('❌ Failed to fetch videos. Try again.');
          return;
        }

        if (initialResults.length === 0) { await reply('No videos found for that channel.'); return; }

        pendingResults = initialResults;

        if (browser) {
          await browser.open(displayName, videosUrl, initialResults);
        } else {
          // No webhook — fall back to text list
          const list = initialResults.map((r, i) => `**${i + 1}.** ${r.title} \`${r.duration}\``).join('\n');
          await reply(`**${displayName} — Videos**\n${list}\n\nReply \`!pick <number>\` to play.`);
        }
        return;
      }

      if (pickMode) {
        await reply(`🔍 Searching for **${query}**...`);
        let results: SearchResult[];
        try {
          const abort = new AbortController();
          results = await searchYouTubeMultiple(query, 5, abort.signal);
        } catch (err) {
          console.error('[cmd] !search -pick error:', err);
          await reply('❌ Search failed. Try again.');
          return;
        }
        if (results.length === 0) { await reply('No results found.'); return; }

        pendingResults = results;
        const list = results.map((r, i) => `**${i + 1}.** ${r.title} \`${r.duration}\` — ${r.channel}`).join('\n');
        await reply(`**Search results** — reply \`!pick <number>\` to play:\n${list}`);
        return;
      }

      // Instant play
      pendingResults = null;
      await reply(`🔍 Searching for **${query}**...`);
      let result: { url: string; title: string };
      try {
        const abort = new AbortController();
        result = await searchYouTube(query, abort.signal);
      } catch (err) {
        console.error('[cmd] !search error:', err);
        await reply('❌ Search failed. Try again.');
        return;
      }
      await reply(`▶️ Playing: **${result.title}**`);
      try {
        await client.guilds.fetch(GUILD_ID);
        const voiceChannel = await client.channels.fetch(VOICE_CHANNEL_ID) as VoiceChannel;
        const textChannel = await client.channels.fetch(TEXT_CHANNEL_ID) as TextChannel;
        await streamController.playUrl(voiceChannel, result.url, textChannel);
      } catch (err) { console.error('[cmd] !search playUrl error:', err); }
      return;
    }

    // ── Browser navigation ───────────────────────────────────────────────────
    if (content === '!next') {
      if (!browser?.isActive) { await reply('No active channel browser. Use `!search -channel <name>` first.'); return; }
      const moved = await browser.next();
      if (!moved) await reply('Already on the last page.');
      return;
    }

    if (content === '!prev') {
      if (!browser?.isActive) { await reply('No active channel browser. Use `!search -channel <name>` first.'); return; }
      const moved = await browser.prev();
      if (!moved) await reply('Already on the first page.');
      return;
    }

    if (content.startsWith('!page ')) {
      if (!browser?.isActive) { await reply('No active channel browser. Use `!search -channel <name>` first.'); return; }
      const n = parseInt(content.slice('!page '.length).trim(), 10);
      if (isNaN(n) || n < 1) { await reply('Usage: `!page <number>`'); return; }
      await reply(`⏳ Jumping to page ${n}...`);
      const ok = await browser.goToPage(n);
      if (!ok) await reply(`Page ${n} doesn't exist.`);
      return;
    }

    if (content.startsWith('!search-in ')) {
      if (!browser?.isActive) { await reply('No active channel browser. Use `!search -channel <name>` first.'); return; }
      const keyword = content.slice('!search-in '.length).trim();
      if (!keyword) { await reply('Usage: `!search-in <keyword>`'); return; }
      await browser.searchIn(keyword);
      return;
    }

    if (content === '!browse-clear') {
      if (!browser?.isActive) return;
      await browser.clearFilter();
      return;
    }

    // ── Pick ─────────────────────────────────────────────────────────────────
    if (content.startsWith('!pick ')) {
      // Resolve pick source: browser takes priority over pendingResults
      // For browser, use the full filtered list so !pick 1 always means item 1 overall
      const results = browser?.isActive ? browser.currentResults : pendingResults;

      if (!results || results.length === 0) {
        await reply('No active search. Use `!search -pick <query>` or `!search -channel <name>` first.');
        return;
      }
      if (streamController.isStreaming) { await reply('Already streaming. Use `!stop` first.'); return; }

      const n = parseInt(content.slice('!pick '.length).trim(), 10);
      if (isNaN(n) || n < 1 || n > results.length) {
        await reply(`Pick a number between 1 and ${results.length}.`);
        return;
      }

      const chosen = results[n - 1];
      pendingResults = null;
      browser?.close();

      await playChosen(chosen);
      return;
    }

    // ── Play URL ─────────────────────────────────────────────────────────────
    if (content.startsWith('!play ')) {
      const url = content.slice('!play '.length).trim();
      if (!isYouTubeUrl(url)) { await reply('Invalid URL. Only YouTube links are supported.'); return; }
      if (streamController.isStreaming) { await reply('Already streaming. Use `!stop` first.'); return; }
      try {
        await client.guilds.fetch(GUILD_ID);
        const voiceChannel = await client.channels.fetch(VOICE_CHANNEL_ID) as VoiceChannel;
        const textChannel = await client.channels.fetch(TEXT_CHANNEL_ID) as TextChannel;
        await streamController.playUrl(voiceChannel, url, textChannel);
      } catch (err) { console.error('[cmd] !play error:', err); }
      return;
    }

    // ── Playback controls ────────────────────────────────────────────────────
    if (content === '!pause') {
      if (!streamController.isStreaming) { await reply('Nothing is playing.'); return; }
      const ok = await streamController.pause();
      if (ok) await reply('⏸️ Paused.');
      return;
    }

    if (content === '!resume') {
      if (!streamController.isPaused) { await reply('Nothing is paused.'); return; }
      try {
        const voiceChannel = await client.channels.fetch(VOICE_CHANNEL_ID) as VoiceChannel;
        const ok = await streamController.resume(voiceChannel);
        if (ok) await reply('▶️ Resumed.');
      } catch (err) { console.error('[cmd] !resume error:', err); }
      return;
    }

    if (content === '!loop') {
      const on = streamController.toggleLoopTrack();
      await reply(on ? '🔂 Loop track **on**.' : '🔂 Loop track **off**.');
      return;
    }

    if (content === '!loopqueue') {
      const on = streamController.toggleLoopQueue();
      await reply(on ? '🔁 Loop queue **on**.' : '🔁 Loop queue **off**.');
      return;
    }

    if (content === '!stop') {
      await streamController.stop();
      return;
    }

    if (content === '!skip') {
      if (!streamController.isStreaming && !streamController.isPaused) return;
      await streamController.skip();
      return;
    }
  });
}
