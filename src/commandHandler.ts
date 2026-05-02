import type { Client, TextChannel, VoiceChannel } from 'discord.js-selfbot-v13';
import type { VideoQueue } from './videoQueue';
import { isYouTubeUrl } from './youtubePlayer';

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
