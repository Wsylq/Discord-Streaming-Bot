import type { Client, TextChannel, VoiceChannel } from 'discord.js-selfbot-v13';
import type { VideoQueue } from './videoQueue';
import { isYouTubeUrl } from './youtubePlayer';

export interface StreamController {
  isStreaming: boolean;
  start(voiceChannel: VoiceChannel, queue: VideoQueue, textChannel: TextChannel): Promise<void>;
  playUrl(voiceChannel: VoiceChannel, url: string): Promise<void>;
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

  client.on('raw', async (packet: RawMessagePacket) => {
    if (packet.t !== 'MESSAGE_CREATE') return;

    const data = packet.d;

    // Only respond to the owner in the configured text channel
    if (data.author.id !== OWNER_ID) return;
    if (data.channel_id !== TEXT_CHANNEL_ID) return;

    const content = data.content.trim();

    if (content === '!start') {
      if (streamController.isStreaming) return;

      if (queue.files.length === 0) {
        try {
          const ch = await client.channels.fetch(TEXT_CHANNEL_ID) as TextChannel;
          await ch.send('No videos found in the configured folder.');
        } catch { /* ignore */ }
        return;
      }

      try {
        await client.guilds.fetch(GUILD_ID);
        const voiceChannel = await client.channels.fetch(VOICE_CHANNEL_ID) as VoiceChannel;
        const textChannel = await client.channels.fetch(TEXT_CHANNEL_ID) as TextChannel;
        await streamController.start(voiceChannel, queue, textChannel);
      } catch (err) {
        console.error('[cmd] !start error:', err);
      }
      return;
    }

    if (content.startsWith('!play ')) {
      const url = content.slice('!play '.length).trim();

      if (!isYouTubeUrl(url)) {
        try {
          const ch = await client.channels.fetch(TEXT_CHANNEL_ID) as TextChannel;
          await ch.send('Invalid URL. Only YouTube links are supported.');
        } catch { /* ignore */ }
        return;
      }

      if (streamController.isStreaming) {
        try {
          const ch = await client.channels.fetch(TEXT_CHANNEL_ID) as TextChannel;
          await ch.send('Already streaming. Use !stop first.');
        } catch { /* ignore */ }
        return;
      }

      try {
        await client.guilds.fetch(GUILD_ID);
        const voiceChannel = await client.channels.fetch(VOICE_CHANNEL_ID) as VoiceChannel;
        await streamController.playUrl(voiceChannel, url);
      } catch (err) {
        console.error('[cmd] !play error:', err);
      }
      return;
    }

    if (content === '!stop') {
      await streamController.stop();
      return;
    }

    if (content === '!skip') {
      if (!streamController.isStreaming) return;
      await streamController.skip();
      return;
    }
  });
}
