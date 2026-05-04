import { Client } from 'discord.js-selfbot-v13';
import { Streamer } from '@dank074/discord-video-stream';
import { loadConfig } from './config';
import { buildQueue, isEmpty } from './videoQueue';
import { createStreamController } from './streamController';
import { registerCommandHandler } from './commandHandler';
import { WebhookNotifier } from './webhookNotifier';
import { ChannelBrowser } from './channelBrowser';
import { QueueDisplay } from './queueDisplay';
import { AudioQueueDisplay } from './audioQueueDisplay';
import { startPredownloader } from './audioMode';
import { BotManager } from './botManager';

process.on('uncaughtException', (err: Error) => {
  // SRTP errors from node-datachannel are non-fatal — the stream ended
  // but the process should keep running for the next command
  if (err.message?.includes('SRTP') || err.message?.includes('libdatachannel')) {
    console.warn('[warn] Caught non-fatal native error:', err.message);
    return;
  }
  // Discord interaction errors (10062 = Unknown Interaction) are non-fatal —
  // the interaction token expired before we could reply. Log and continue.
  if (err.message?.includes('Unknown Interaction') || err.message?.includes('10062')) {
    console.warn('[warn] Caught non-fatal Discord interaction error:', err.message);
    return;
  }
  console.error('Uncaught exception:', err.stack ?? err);
  process.exit(1);
});

async function main(): Promise<void> {
  const config = loadConfig();

  const queue = buildQueue(config.videoFolder);
  if (isEmpty(queue)) {
    console.warn(`Warning: No supported video files found in "${config.videoFolder}".`);
  } else {
    console.log(`Found ${queue.files.length} video(s) in queue.`);
  }

  const client = new Client({
    partials: ['MESSAGE', 'CHANNEL', 'REACTION'],
  });

  const streamer = new Streamer(client);
  const notifier = config.webhookUrl ? new WebhookNotifier(config.webhookUrl) : null;
  const browser = config.webhookUrl ? new ChannelBrowser(config.webhookUrl) : null;
  const queueDisplay = config.webhookUrl ? new QueueDisplay(config.webhookUrl) : null;
  const audioQueueDisplay = config.webhookUrl ? new AudioQueueDisplay(config.webhookUrl) : null;
  const streamController = createStreamController(streamer, notifier, queueDisplay, audioQueueDisplay);

  registerCommandHandler({ streamController, queue, client, browser, queueDisplay, audioQueueDisplay, botEnabled: config.botEnabled });

  // Conditionally start the Discord bot (shares the same streamController instance)
  if (config.botEnabled) {
    const { Client: BotClient, GatewayIntentBits } = await import('discord.js');
    const botClient = new BotClient({ intents: [GatewayIntentBits.Guilds] });
    const botManager = new BotManager({
      botClient,
      selfbotClient: client,
      streamController,
      guildId: process.env['GUILD_ID'] ?? '',
      voiceChannelId: process.env['VOICE_CHANNEL_ID'] ?? '',
      textChannelId: process.env['TEXT_CHANNEL_ID'] ?? '',
      ownerId: process.env['OWNER_ID'] ?? '',
    });
    botManager.start();
    try {
      // config.botToken is guaranteed non-null when botEnabled is true (validated in loadConfig)
      await botClient.login(config.botToken!);
    } catch (err) {
      console.error('Failed to log in to Discord bot:', err);
      process.exit(1);
    }
  }

  // Start background audio pre-downloader
  startPredownloader();

  client.on('ready', () => {
    console.log(`Selfbot ready. Logged in as ${client.user?.username ?? 'unknown'}.`);

    client.user?.setPresence({
      activities: [{ name: 'trustion dih | !start', type: 'WATCHING' }],
      status: 'online',
    });
  });

  try {
    await client.login(config.token);
  } catch (err) {
    console.error('Failed to log in to Discord:', err);
    process.exit(1);
  }
}

main();
