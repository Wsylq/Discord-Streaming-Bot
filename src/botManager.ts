import type { Client } from 'discord.js';
import { ChatInputCommandInteraction } from 'discord.js';
import type { Client as SelfbotClient, TextChannel } from 'discord.js-selfbot-v13';
import type { StreamController } from './commandHandler';
import { SLASH_COMMANDS } from './slashCommands';
import { createBotCommandHandler } from './botCommandHandler';
import { buildHelpEmbeds } from './helpEmbeds';

export interface BotManagerDeps {
  botClient: Client;
  selfbotClient: SelfbotClient;
  streamController: StreamController;
  guildId: string;
  voiceChannelId: string;
  textChannelId: string;
  ownerId: string;
}


export class BotManager {
  private deps: BotManagerDeps;

  constructor(deps: BotManagerDeps) {
    this.deps = deps;
  }

  /** Called once after botClient.login() resolves. Attaches the ready handler. */
  start(): void {
    const { botClient } = this.deps;

    botClient.on('ready', async () => {
      await this._onReady();
    });
  }

  private async _onReady(): Promise<void> {
    const {
      botClient,
      selfbotClient,
      streamController,
      guildId,
      voiceChannelId,
      textChannelId,
      ownerId,
    } = this.deps;

    // 1. Attempt to fetch the guild from the bot client's guild cache
    const guild = botClient.guilds.cache.get(guildId);

    if (!guild) {
      // Guild not found — send warning + help embed via selfbot
      try {
        const textChannel = await selfbotClient.channels.fetch(textChannelId) as TextChannel;
        await textChannel.send('discord bot not invited, invite the discord bot for slash commands');
        // Show slash command help since the bot is enabled (just not in the guild yet)
        await textChannel.send(buildHelpEmbeds(true));
      } catch (err) {
        console.error('[BotManager] Failed to send guild-not-found warning via selfbot:', err);
      }
      return;
    }

    // Guild found — log confirmation
    console.log(`[BotManager] Bot is a member of guild ${guildId}. Registering slash commands...`);

    // 2. Register slash commands via bulk overwrite
    try {
      await guild.commands.set(SLASH_COMMANDS);
      console.log('[BotManager] Slash commands registered successfully.');
    } catch (err) {
      console.error('[BotManager] Failed to register slash commands:', err);
      // Continue without crashing — selfbot remains functional
    }

    // 3. Attach the interactionCreate listener
    const handleInteraction = createBotCommandHandler({
      streamController,
      guildId,
      voiceChannelId,
      textChannelId,
      ownerId,
      botClient,
      selfbotClient,
      queueDisplay: null,
      audioQueueDisplay: null,
    });

    botClient.on('interactionCreate', async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      try {
        await handleInteraction(interaction as ChatInputCommandInteraction);
      } catch (err) {
        // Swallow expired/unknown interaction errors — these happen when Discord's
        // 3-second acknowledgement window passes before the bot responds.
        const code = (err as { code?: number }).code;
        if (code === 10062) {
          console.warn('[BotManager] Interaction expired before bot could respond (10062). Ignoring.');
          return;
        }
        console.error('[BotManager] Unhandled error in interactionCreate:', err);
      }
    });
  }
}
