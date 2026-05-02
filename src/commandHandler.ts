import type { Client, TextChannel, VoiceChannel } from 'discord.js-selfbot-v13';
import type { VideoQueue } from './videoQueue';
import { isYouTubeUrl, searchYouTube, searchYouTubeMultiple, searchChannelVideos, type SearchResult } from './youtubePlayer';

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
  const { streamController, queue, client } = deps;

  const GUILD_ID = process.env['GUILD_ID']!;
  const VOICE_CHANNEL_ID = process.env['VOICE_CHANNEL_ID']!;
  const TEXT_CHANNEL_ID = process.env['TEXT_CHANNEL_ID']!;
  const OWNER_ID = process.env['OWNER_ID']!;

  // Pending pick session — cleared after use or on new search
  let pendingResults: SearchResult[] | null = null;

  async function reply(msg: string): Promise<void> {
    try {
      const ch = await client.channels.fetch(TEXT_CHANNEL_ID) as TextChannel;
      await ch.send(msg);
    } catch { /* ignore */ }
  }

  client.on('raw', async (packet: RawMessagePacket) => {
    if (packet.t !== 'MESSAGE_CREATE') return;

    const data = packet.d;
    if (data.author.id !== OWNER_ID) return;
    if (data.channel_id !== TEXT_CHANNEL_ID) return;

    const content = data.content.trim();

    if (content === '!help') {
      await reply(
        '**Commands**\n' +
        '`!search <query>` — Search YouTube and play the top result\n' +
        '`!search -pick <query>` — Search and choose from top 5 results\n' +
        '  └ `!pick <number>` — Pick a result\n' +
        '`!search -channel <handle>` — Browse latest videos from a channel\n' +
        '  └ `!pick <number>` — Pick a video to play\n' +
        '`!play <url>` — Download and stream a YouTube video\n' +
        '`!start` — Stream videos from your local folder\n' +
        '`!pause` — Pause the current stream\n' +
        '`!resume` — Resume from where you paused\n' +
        '`!skip` — Skip to the next video\n' +
        '`!loop` — Toggle looping the current track\n' +
        '`!loopqueue` — Toggle looping the entire queue\n' +
        '`!stop` — Stop streaming and leave voice'
      );
      return;
    }

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
          '`!search -channel <handle>` — browse a channel\'s latest videos'
        );
        return;
      }
      if (streamController.isStreaming) { await reply('Already streaming. Use `!stop` first.'); return; }

      if (channelMode) {
        await reply(`📺 Fetching latest videos from **${query}**...`);
        let results: SearchResult[];
        try {
          const abort = new AbortController();
          results = await searchChannelVideos(query, 5, abort.signal);
        } catch (err: unknown) {
          console.error('[cmd] !search -channel error:', err);
          const msg = err instanceof Error ? err.message : 'Unknown error';
          await reply(`❌ ${msg}`);
          return;
        }
        if (results.length === 0) { await reply('No videos found for that channel.'); return; }

        pendingResults = results;
        const list = results
          .map((r, i) => `**${i + 1}.** ${r.title} \`${r.duration}\``)
          .join('\n');
        await reply(`**${results[0].channel} — Latest videos**\n${list}\n\nReply \`!pick <number>\` to play.`);

      } else if (pickMode) {
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
        const list = results
          .map((r, i) => `**${i + 1}.** ${r.title} \`${r.duration}\` — ${r.channel}`)
          .join('\n');
        await reply(`**Search results** — reply \`!pick <number>\` to play:\n${list}`);

      } else {
        // Instant play top result
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
      }
      return;
    }

    if (content.startsWith('!pick ')) {
      if (!pendingResults) { await reply('No active search. Use `!search -pick <query>` first.'); return; }
      if (streamController.isStreaming) { await reply('Already streaming. Use `!stop` first.'); return; }

      const n = parseInt(content.slice('!pick '.length).trim(), 10);
      if (isNaN(n) || n < 1 || n > pendingResults.length) {
        await reply(`Pick a number between 1 and ${pendingResults.length}.`);
        return;
      }

      const chosen = pendingResults[n - 1];
      pendingResults = null;

      await reply(`▶️ Playing: **${chosen.title}**`);

      try {
        await client.guilds.fetch(GUILD_ID);
        const voiceChannel = await client.channels.fetch(VOICE_CHANNEL_ID) as VoiceChannel;
        const textChannel = await client.channels.fetch(TEXT_CHANNEL_ID) as TextChannel;
        await streamController.playUrl(voiceChannel, chosen.url, textChannel);
      } catch (err) {
        console.error('[cmd] !pick playUrl error:', err);
      }
      return;
    }

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
