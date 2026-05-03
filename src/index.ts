import { Client } from 'discord.js-selfbot-v13';
import { Streamer } from '@dank074/discord-video-stream';
import { loadConfig } from './config';
import { buildQueue, isEmpty } from './videoQueue';
import { createStreamController } from './streamController';
import { registerCommandHandler } from './commandHandler';
import { WebhookNotifier } from './webhookNotifier';
import { ChannelBrowser } from './channelBrowser';
import { QueueDisplay } from './queueDisplay';

process.on('uncaughtException', (err: Error) => {
  // SRTP errors from node-datachannel are non-fatal — the stream ended
  // but the process should keep running for the next command
  if (err.message?.includes('SRTP') || err.message?.includes('libdatachannel')) {
    console.warn('[warn] Caught non-fatal native error:', err.message);
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
  const streamController = createStreamController(streamer, notifier, queueDisplay);

  registerCommandHandler({ streamController, queue, client, browser, queueDisplay });

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
