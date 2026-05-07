import type { Client, TextChannel, VoiceChannel } from 'discord.js-selfbot-v13';
import type { VideoQueue } from './videoQueue';
import { isYouTubeUrl, searchYouTube, searchYouTubeMultiple, resolveChannelUrl, fetchChannelVideosBatch, type SearchResult } from './youtubePlayer';
import type { ChannelBrowser } from './channelBrowser';
import type { QueueDisplay } from './queueDisplay';
import type { AudioQueueDisplay } from './audioQueueDisplay';
import { enqueue, removeByPosition, clearQueue, getAll, queueLength } from './queueDb';
import { audioEnqueue, audioRemoveByPosition, audioClearQueue, audioGetAll, audioQueueLength } from './audioQueueDb';
import { buildHelpEmbeds } from './helpEmbeds';

/** Formats seconds into m:ss or h:mm:ss */
function formatElapsed(secs: number): string {
  const s = Math.floor(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export interface StreamController {
  isStreaming: boolean;
  isPaused: boolean;
  isInVoice: boolean;
  loopTrack: boolean;
  loopQueue: boolean;
  start(voiceChannel: VoiceChannel, queue: VideoQueue, textChannel: TextChannel): Promise<void>;
  playUrl(voiceChannel: VoiceChannel, url: string, textChannel: TextChannel): Promise<void>;
  playAudio(voiceChannel: VoiceChannel, url: string, textChannel: TextChannel): Promise<void>;
  toggleAudioMode(): boolean;
  readonly audioMode: boolean;
  toggleLoopAudioTrack(): boolean;
  toggleLoopAudioQueue(): boolean;
  readonly loopAudioTrack: boolean;
  readonly loopAudioQueue: boolean;
  playFromQueue(voiceChannel: VoiceChannel, textChannel: TextChannel): Promise<boolean>;
  toggleLoopTrack(): boolean;
  toggleLoopQueue(): boolean;
  pause(): Promise<boolean>;
  resume(voiceChannel: VoiceChannel): Promise<boolean>;
  stop(): Promise<void>;
  skip(textChannel?: TextChannel): Promise<void>;
  /** Returns info about the currently playing track, or null if nothing is playing. */
  nowPlaying(): NowPlayingInfo | null;
}

export interface NowPlayingInfo {
  /** Track title or file name */
  title: string;
  /** URL for YouTube/audio tracks, null for local files */
  url: string | null;
  /** Elapsed playback time in seconds */
  elapsedSeconds: number;
  /** Whether the stream is currently paused */
  isPaused: boolean;
  /** 'video' | 'audio' | 'local' */
  type: 'video' | 'audio' | 'local';
}

export interface CommandHandlerDeps {
  streamController: StreamController;
  queue: VideoQueue;
  client: Client;
  browser: ChannelBrowser | null;
  queueDisplay: QueueDisplay | null;
  audioQueueDisplay: AudioQueueDisplay | null;
  botEnabled?: boolean;
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
  const { streamController, queue, client, browser, queueDisplay, audioQueueDisplay } = deps;
  const botEnabled = deps.botEnabled ?? false;

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

  /** Enqueue a video, fetching its metadata, and notify the user. */
  async function autoEnqueue(url: string, knownTitle?: string, knownDuration?: string, knownChannel?: string): Promise<void> {
    let title = knownTitle ?? url;
    let duration = knownDuration ?? '?';
    let channel = knownChannel ?? '';

    // Fetch meta if we don't have a title yet
    if (!knownTitle) {
      try {
        const { fetchVideoMeta } = await import('./webhookNotifier');
        const meta = await fetchVideoMeta(url);
        if (meta) { title = meta.title; duration = meta.duration; channel = meta.channel; }
      } catch { /* ignore */ }
    }

    enqueue({ url, title, duration, channel });
    if (queueDisplay) queueDisplay.refresh().catch(() => { });
    await reply(`➕ Added to queue: **${title}**`);
  }

  /** Enqueue to audio queue with metadata fetch. */
  async function autoAudioEnqueue(url: string, knownTitle?: string, knownDuration?: string, knownArtist?: string): Promise<void> {
    let title = knownTitle ?? url;
    let duration = knownDuration ?? '?';
    let artist = knownArtist ?? '';
    if (!knownTitle) {
      try {
        const { fetchVideoMeta } = await import('./webhookNotifier');
        const meta = await fetchVideoMeta(url);
        if (meta) { title = meta.title; duration = meta.duration; artist = meta.channel; }
      } catch { /* ignore */ }
    }
    audioEnqueue({ url, title, duration, artist });
    if (audioQueueDisplay) audioQueueDisplay.refresh().catch(() => { });
    await reply(`🎵 Added to audio queue: **${title}**`);
  }

  async function playChosen(chosen: SearchResult): Promise<void> {
    if (streamController.isStreaming) {
      if (streamController.audioMode) {
        await autoAudioEnqueue(chosen.url, chosen.title, chosen.duration, chosen.channel);
      } else {
        await autoEnqueue(chosen.url, chosen.title, chosen.duration, chosen.channel);
      }
      return;
    }
    await reply(`▶️ Playing: **${chosen.title}**`);
    try {
      await client.guilds.fetch(GUILD_ID);
      const voiceChannel = await client.channels.fetch(VOICE_CHANNEL_ID) as VoiceChannel;
      const textChannel = await client.channels.fetch(TEXT_CHANNEL_ID) as TextChannel;
      if (streamController.audioMode) {
        await streamController.playAudio(voiceChannel, chosen.url, textChannel);
      } else {
        await streamController.playUrl(voiceChannel, chosen.url, textChannel);
      }
    } catch (err) {
      console.error('[cmd] playChosen error:', err);
    }
  }

  /** Always plays/queues as audio regardless of audio mode flag. */
  async function playChosenAudio(chosen: SearchResult): Promise<void> {
    if (streamController.isStreaming) {
      await autoAudioEnqueue(chosen.url, chosen.title, chosen.duration, chosen.channel);
      return;
    }
    await reply(`🎵 Playing: **${chosen.title}**`);
    try {
      await client.guilds.fetch(GUILD_ID);
      const voiceChannel = await client.channels.fetch(VOICE_CHANNEL_ID) as VoiceChannel;
      const textChannel = await client.channels.fetch(TEXT_CHANNEL_ID) as TextChannel;
      await streamController.playAudio(voiceChannel, chosen.url, textChannel);
    } catch (err) {
      console.error('[cmd] playChosenAudio error:', err);
    }
  }

  // ── Focused handler functions ──────────────────────────────────────────────

  async function handleHelp(content: string): Promise<boolean> {
    if (content !== '!help') return false;

    const helpPayload = buildHelpEmbeds(botEnabled);

    if (browser) {
      try {
        const { webhookRequest: wr } = await import('./webhookHttp');
        const webhookUrl = process.env['WEBHOOK_URL']!;
        await wr(webhookUrl, 'POST', null, helpPayload);
        return true;
      } catch { /* fall through to channel send */ }
    }

    try {
      const ch = await client.channels.fetch(TEXT_CHANNEL_ID) as TextChannel;
      await ch.send(helpPayload);
    } catch { /* ignore */ }
    return true;
  }

  async function handleSearch(content: string): Promise<boolean> {
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
        return true;
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
          return true;
        }

        // Fetch first 5 immediately so the embed appears fast
        let initialResults: SearchResult[] = [];
        try {
          const abort = new AbortController();
          initialResults = await fetchChannelVideosBatch(videosUrl, displayName, 1, PAGE_SIZE, abort.signal);
        } catch (err) {
          console.error('[cmd] !search -channel initial fetch error:', err);
          await reply('❌ Failed to fetch videos. Try again.');
          return true;
        }

        if (initialResults.length === 0) { await reply('No videos found for that channel.'); return true; }

        pendingResults = initialResults;

        if (browser) {
          await browser.open(displayName, videosUrl, initialResults);
        } else {
          // No webhook — fall back to text list
          const list = initialResults.map((r, i) => `**${i + 1}.** ${r.title} \`${r.duration}\``).join('\n');
          await reply(`**${displayName} — Videos**\n${list}\n\nReply \`!pick <number>\` to play.`);
        }
        return true;
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
          return true;
        }
        if (results.length === 0) { await reply('No results found.'); return true; }

        pendingResults = results;
        const list = results.map((r, i) => `**${i + 1}.** ${r.title} \`${r.duration}\` — ${r.channel}`).join('\n');
        await reply(`**Search results** — reply \`!pick <number>\` to play:\n${list}`);
        return true;
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
        return true;
      }
      if (streamController.isStreaming) {
        if (streamController.audioMode) {
          await autoAudioEnqueue(result.url, result.title);
        } else {
          await autoEnqueue(result.url, result.title);
        }
        return true;
      }
      await reply(`▶️ Playing: **${result.title}**`);
      try {
        await client.guilds.fetch(GUILD_ID);
        const voiceChannel = await client.channels.fetch(VOICE_CHANNEL_ID) as VoiceChannel;
        const textChannel = await client.channels.fetch(TEXT_CHANNEL_ID) as TextChannel;
        if (streamController.audioMode) {
          await streamController.playAudio(voiceChannel, result.url, textChannel);
        } else {
          await streamController.playUrl(voiceChannel, result.url, textChannel);
        }
      } catch (err) { console.error('[cmd] !search playUrl error:', err); }
      return true;
    }

    // ── Music search (always audio) ──────────────────────────────────────────
    if (content.startsWith('!music-search ')) {
      const raw = content.slice('!music-search '.length).trim();
      const pickMode = raw.startsWith('-pick ');
      const query = pickMode ? raw.slice('-pick '.length).trim() : raw;

      if (!query) {
        await reply('Usage: `!music-search <query>` or `!music-search -pick <query>`');
        return true;
      }

      await reply(`🎵 Searching for **${query}**...`);

      if (pickMode) {
        let results: SearchResult[];
        try {
          const abort = new AbortController();
          results = await searchYouTubeMultiple(query, 5, abort.signal);
        } catch (err) {
          console.error('[cmd] !music-search -pick error:', err);
          await reply('❌ Search failed. Try again.');
          return true;
        }
        if (results.length === 0) { await reply('No results found.'); return true; }
        pendingResults = results;
        // Mark these as audio picks
        const list = results.map((r, i) => `**${i + 1}.** ${r.title} \`${r.duration}\` — ${r.channel}`).join('\n');
        await reply(`**Music results** — reply \`!music-pick <number>\` to play:\n${list}`);
      } else {
        let result: { url: string; title: string };
        try {
          const abort = new AbortController();
          result = await searchYouTube(query, abort.signal);
        } catch (err) {
          console.error('[cmd] !music-search error:', err);
          await reply('❌ Search failed. Try again.');
          return true;
        }
        if (streamController.isStreaming) {
          await autoAudioEnqueue(result.url, result.title);
          return true;
        }
        await reply(`🎵 Playing: **${result.title}**`);
        try {
          await client.guilds.fetch(GUILD_ID);
          const voiceChannel = await client.channels.fetch(VOICE_CHANNEL_ID) as VoiceChannel;
          const textChannel = await client.channels.fetch(TEXT_CHANNEL_ID) as TextChannel;
          await streamController.playAudio(voiceChannel, result.url, textChannel);
        } catch (err) { console.error('[cmd] !music-search play error:', err); }
      }
      return true;
    }

    if (content.startsWith('!music-pick ')) {
      if (!pendingResults || pendingResults.length === 0) {
        await reply('No active music search. Use `!music-search -pick <query>` first.');
        return true;
      }
      const n = parseInt(content.slice('!music-pick '.length).trim(), 10);
      if (isNaN(n) || n < 1 || n > pendingResults.length) {
        await reply(`Pick a number between 1 and ${pendingResults.length}.`);
        return true;
      }
      const chosen = pendingResults[n - 1];
      pendingResults = null;
      await playChosenAudio(chosen);
      return true;
    }

    // ── Browser navigation ───────────────────────────────────────────────────
    if (content === '!next') {
      if (!browser?.isActive) { await reply('No active channel browser. Use `!search -channel <name>` first.'); return true; }
      const moved = await browser.next();
      if (!moved) await reply('Already on the last page.');
      return true;
    }

    if (content === '!prev') {
      if (!browser?.isActive) { await reply('No active channel browser. Use `!search -channel <name>` first.'); return true; }
      const moved = await browser.prev();
      if (!moved) await reply('Already on the first page.');
      return true;
    }

    if (content.startsWith('!page ')) {
      if (!browser?.isActive) { await reply('No active channel browser. Use `!search -channel <name>` first.'); return true; }
      const n = parseInt(content.slice('!page '.length).trim(), 10);
      if (isNaN(n) || n < 1) { await reply('Usage: `!page <number>`'); return true; }
      await reply(`⏳ Jumping to page ${n}...`);
      const ok = await browser.goToPage(n);
      if (!ok) await reply(`Page ${n} doesn't exist.`);
      return true;
    }

    if (content.startsWith('!search-in ')) {
      if (!browser?.isActive) { await reply('No active channel browser. Use `!search -channel <name>` first.'); return true; }
      const keyword = content.slice('!search-in '.length).trim();
      if (!keyword) { await reply('Usage: `!search-in <keyword>`'); return true; }
      await browser.searchIn(keyword);
      return true;
    }

    if (content === '!browse-clear') {
      if (!browser?.isActive) return true;
      await browser.clearFilter();
      return true;
    }

    // ── Pick ─────────────────────────────────────────────────────────────────
    if (content.startsWith('!pick ')) {
      // Resolve pick source: browser takes priority over pendingResults
      // For browser, use the full filtered list so !pick 1 always means item 1 overall
      const results = browser?.isActive ? browser.currentResults : pendingResults;

      if (!results || results.length === 0) {
        await reply('No active search. Use `!search -pick <query>` or `!search -channel <name>` first.');
        return true;
      }

      const n = parseInt(content.slice('!pick '.length).trim(), 10);
      if (isNaN(n) || n < 1 || n > results.length) {
        await reply(`Pick a number between 1 and ${results.length}.`);
        return true;
      }

      const chosen = results[n - 1];
      pendingResults = null;
      browser?.close();

      await playChosen(chosen);
      return true;
    }

    return false;
  }

  async function handleQueueCommands(content: string): Promise<boolean> {
    if (content === '!queue') {
      if (queueDisplay) {
        await queueDisplay.show();
      } else {
        const items = getAll();
        if (items.length === 0) { await reply('Queue is empty.'); return true; }
        const list = items.slice(0, 10).map((item, i) => `**${i + 1}.** ${item.title} \`${item.duration}\``).join('\n');
        await reply(`**Queue (${items.length} videos)**\n${list}`);
      }
      return true;
    }

    if (content === '!queue-next') {
      if (queueDisplay) { await queueDisplay.next(); }
      return true;
    }

    if (content === '!queue-prev') {
      if (queueDisplay) { await queueDisplay.prev(); }
      return true;
    }

    if (content.startsWith('!queue-remove ')) {
      const n = parseInt(content.slice('!queue-remove '.length).trim(), 10);
      if (isNaN(n) || n < 1) { await reply('Usage: `!queue-remove <number>`'); return true; }
      const ok = removeByPosition(n);
      if (ok) {
        if (queueDisplay) queueDisplay.refresh().catch(() => { });
        await reply(`✅ Removed item #${n} from queue.`);
      } else {
        await reply(`No item at position ${n}.`);
      }
      return true;
    }

    if (content === '!queue-clear') {
      const count = clearQueue();
      if (queueDisplay) queueDisplay.refresh().catch(() => { });
      await reply(`🗑️ Cleared ${count} item${count !== 1 ? 's' : ''} from queue.`);
      return true;
    }

    if (content.startsWith('!queue-add ')) {
      const url = content.slice('!queue-add '.length).trim();
      if (!isYouTubeUrl(url)) { await reply('Invalid URL. Only YouTube links are supported.'); return true; }
      // Fetch title quickly
      let title = url;
      let duration = '?';
      let channel = '';
      try {
        const { fetchVideoMeta } = await import('./webhookNotifier');
        const meta = await fetchVideoMeta(url);
        if (meta) { title = meta.title; duration = meta.duration; channel = meta.channel; }
      } catch { /* ignore */ }
      enqueue({ url, title, duration, channel });
      if (queueDisplay) queueDisplay.refresh().catch(() => { });
      await reply(`➕ Added to queue: **${title}**`);
      return true;
    }

    if (content === '!queue-play') {
      if (streamController.isStreaming) { await reply('Already streaming. Use `!stop` first.'); return true; }
      if (queueLength() === 0) { await reply('Queue is empty.'); return true; }
      try {
        await client.guilds.fetch(GUILD_ID);
        const voiceChannel = await client.channels.fetch(VOICE_CHANNEL_ID) as VoiceChannel;
        const textChannel = await client.channels.fetch(TEXT_CHANNEL_ID) as TextChannel;
        const ok = await streamController.playFromQueue(voiceChannel, textChannel);
        if (!ok) await reply('Queue is empty.');
      } catch (err) { console.error('[cmd] !queue-play error:', err); }
      return true;
    }

    return false;
  }

  async function handleAudioCommands(content: string): Promise<boolean> {
    // ── Audio mode toggle ────────────────────────────────────────────────────
    if (content === '!audio-mode') {
      const on = streamController.toggleAudioMode();
      await reply(on
        ? '🎵 Audio mode **ON** — all plays will be audio-only at max quality.'
        : '🎵 Audio mode **OFF** — back to video streaming.'
      );
      return true;
    }

    // ── Audio mode commands ──────────────────────────────────────────────────
    if (content.startsWith('!audio ')) {
      const url = content.slice('!audio '.length).trim();
      if (!url) { await reply('Usage: `!audio <url>` — YouTube, Spotify, SoundCloud, etc.'); return true; }
      if (streamController.isStreaming) {
        // Auto-enqueue to audio queue
        audioEnqueue({ url, title: url, duration: '?', artist: '' });
        if (audioQueueDisplay) audioQueueDisplay.refresh().catch(() => { });
        await reply(`➕ Added to audio queue.`);
        return true;
      }
      try {
        await client.guilds.fetch(GUILD_ID);
        const voiceChannel = await client.channels.fetch(VOICE_CHANNEL_ID) as VoiceChannel;
        const textChannel = await client.channels.fetch(TEXT_CHANNEL_ID) as TextChannel;
        await streamController.playAudio(voiceChannel, url, textChannel);
      } catch (err) { console.error('[cmd] !audio error:', err); }
      return true;
    }

    // ── Audio queue commands ─────────────────────────────────────────────────
    if (content === '!aq') {
      if (audioQueueDisplay) {
        await audioQueueDisplay.show();
      } else {
        const items = audioGetAll();
        if (items.length === 0) { await reply('Audio queue is empty.'); return true; }
        const list = items.slice(0, 10).map((item, i) => `**${i + 1}.** ${item.title} \`${item.duration}\``).join('\n');
        await reply(`**Audio Queue (${items.length} tracks)**\n${list}`);
      }
      return true;
    }

    if (content === '!aq-next') {
      if (audioQueueDisplay) await audioQueueDisplay.next();
      return true;
    }

    if (content === '!aq-prev') {
      if (audioQueueDisplay) await audioQueueDisplay.prev();
      return true;
    }

    if (content.startsWith('!aq-remove ')) {
      const n = parseInt(content.slice('!aq-remove '.length).trim(), 10);
      if (isNaN(n) || n < 1) { await reply('Usage: `!aq-remove <number>`'); return true; }
      const ok = audioRemoveByPosition(n);
      if (ok) {
        if (audioQueueDisplay) audioQueueDisplay.refresh().catch(() => { });
        await reply(`✅ Removed audio item #${n}.`);
      } else {
        await reply(`No item at position ${n}.`);
      }
      return true;
    }

    if (content === '!aq-clear') {
      const count = audioClearQueue();
      if (audioQueueDisplay) audioQueueDisplay.refresh().catch(() => { });
      await reply(`🗑️ Cleared ${count} audio item${count !== 1 ? 's' : ''}.`);
      return true;
    }

    if (content === '!loop-audio') {
      const on = streamController.toggleLoopAudioTrack();
      await reply(on ? '🔂 Audio loop track **on**.' : '🔂 Audio loop track **off**.');
      return true;
    }

    if (content === '!loop-audio-queue') {
      const on = streamController.toggleLoopAudioQueue();
      await reply(on ? '🔁 Audio loop queue **on**.' : '🔁 Audio loop queue **off**.');
      return true;
    }

    return false;
  }

  async function handlePlaybackControls(content: string): Promise<boolean> {
    // ── Start local queue ────────────────────────────────────────────────────
    if (content === '!start') {
      if (streamController.isStreaming) return true;
      if (queue.files.length === 0) { await reply('No videos found in the configured folder.'); return true; }
      try {
        await client.guilds.fetch(GUILD_ID);
        const voiceChannel = await client.channels.fetch(VOICE_CHANNEL_ID) as VoiceChannel;
        const textChannel = await client.channels.fetch(TEXT_CHANNEL_ID) as TextChannel;
        await streamController.start(voiceChannel, queue, textChannel);
      } catch (err) { console.error('[cmd] !start error:', err); }
      return true;
    }

    // ── Play URL ─────────────────────────────────────────────────────────────
    if (content.startsWith('!play ')) {
      const url = content.slice('!play '.length).trim();
      if (!isYouTubeUrl(url)) { await reply('Invalid URL. Only YouTube links are supported.'); return true; }
      if (streamController.isStreaming) {
        await autoEnqueue(url);
        return true;
      }
      try {
        await client.guilds.fetch(GUILD_ID);
        const voiceChannel = await client.channels.fetch(VOICE_CHANNEL_ID) as VoiceChannel;
        const textChannel = await client.channels.fetch(TEXT_CHANNEL_ID) as TextChannel;
        if (streamController.audioMode) {
          await streamController.playAudio(voiceChannel, url, textChannel);
        } else {
          await streamController.playUrl(voiceChannel, url, textChannel);
        }
      } catch (err) { console.error('[cmd] !play error:', err); }
      return true;
    }

    // ── Playback controls ────────────────────────────────────────────────────
    if (content === '!pause') {
      if (!streamController.isStreaming) { await reply('Nothing is playing.'); return true; }
      const ok = await streamController.pause();
      if (ok) await reply('⏸️ Paused.');
      return true;
    }

    if (content === '!resume') {
      if (!streamController.isPaused) { await reply('Nothing is paused.'); return true; }
      try {
        const voiceChannel = await client.channels.fetch(VOICE_CHANNEL_ID) as VoiceChannel;
        const ok = await streamController.resume(voiceChannel);
        if (ok) await reply('▶️ Resumed.');
      } catch (err) { console.error('[cmd] !resume error:', err); }
      return true;
    }

    if (content === '!loop') {
      const on = streamController.toggleLoopTrack();
      await reply(on ? '🔂 Loop track **on**.' : '🔂 Loop track **off**.');
      return true;
    }

    if (content === '!loopqueue') {
      const on = streamController.toggleLoopQueue();
      await reply(on ? '🔁 Loop queue **on**.' : '🔁 Loop queue **off**.');
      return true;
    }

    if (content === '!stop') {
      await streamController.stop();
      return true;
    }

    if (content === '!skip') {
      if (!streamController.isStreaming && !streamController.isPaused) return true;
      try {
        const textChannel = await client.channels.fetch(TEXT_CHANNEL_ID) as TextChannel;
        await streamController.skip(textChannel);
      } catch { await streamController.skip(); }
      return true;
    }

    if (content === '!np') {
      const np = streamController.nowPlaying();
      if (!np) {
        await reply('Nothing is currently playing.');
        return true;
      }
      const elapsed = formatElapsed(np.elapsedSeconds);
      const icon = np.type === 'audio' ? '🎵' : np.type === 'local' ? '📁' : '▶️';
      const status = np.isPaused ? '⏸️ Paused' : '▶️ Playing';
      const urlPart = np.url ? ` — [link](${np.url})` : '';
      await reply(`${icon} **Now Playing** ${status}\n**${np.title}**${urlPart}\n⏱️ ${elapsed}`);
      return true;
    }

    return false;
  }

  client.on('raw', async (packet: RawMessagePacket) => {
    if (packet.t !== 'MESSAGE_CREATE') return;

    const data = packet.d;
    if (data.author.id !== OWNER_ID) return;
    if (data.channel_id !== TEXT_CHANNEL_ID) return;

    const content = data.content.trim();

    if (await handleHelp(content)) return;
    if (await handleSearch(content)) return;
    if (await handleQueueCommands(content)) return;
    if (await handleAudioCommands(content)) return;
    if (await handlePlaybackControls(content)) return;
  });
}
