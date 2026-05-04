import type { Client, Guild } from 'discord.js';
import { ChatInputCommandInteraction } from 'discord.js';
import type { Client as SelfbotClient, TextChannel } from 'discord.js-selfbot-v13';
import type { StreamController } from './commandHandler';
import { getSlashCommands } from './slashCommands';
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
  /** Optional role ID — members with this role can use slash commands. */
  allowedRoleId: string | null;
}

export class BotManager {
  private deps: BotManagerDeps;
  private guild: Guild | null = null;

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

  /**
   * Re-registers slash commands for the current audio mode.
   * Called by the audio-mode command handler after toggling.
   * No-op if the guild was not found at startup.
   */
  async reregisterCommands(audioMode: boolean): Promise<void> {
    if (!this.guild) return;
    try {
      const commands = getSlashCommands(audioMode);
      await this.guild.commands.set(commands);
      console.log(`[BotManager] Slash commands updated for audio mode: ${audioMode} (${commands.length} commands).`);
    } catch (err) {
      console.error('[BotManager] Failed to re-register slash commands:', err);
    }
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
      allowedRoleId,
    } = this.deps;

    // 1. Attempt to fetch the guild from the bot client's guild cache
    const guild = botClient.guilds.cache.get(guildId) ?? null;

    if (!guild) {
      // Guild not found — send warning + help embed via selfbot
      try {
        const textChannel = await selfbotClient.channels.fetch(textChannelId) as TextChannel;
        await textChannel.send('discord bot not invited, invite the discord bot for slash commands');
        await textChannel.send(buildHelpEmbeds(true));
      } catch (err) {
        console.error('[BotManager] Failed to send guild-not-found warning via selfbot:', err);
      }
      return;
    }

    this.guild = guild;
    console.log(`[BotManager] Bot is a member of guild ${guildId}. Registering slash commands...`);

    // 2. Register slash commands for current audio mode (starts as false = video mode)
    try {
      await guild.commands.set(getSlashCommands(streamController.audioMode));
      console.log('[BotManager] Slash commands registered successfully.');
    } catch (err) {
      console.error('[BotManager] Failed to register slash commands:', err);
    }

    // 3. Attach the interactionCreate listener
    const handleInteraction = createBotCommandHandler({
      streamController,
      guildId,
      voiceChannelId,
      textChannelId,
      ownerId,
      allowedRoleId,
      botClient,
      selfbotClient,
      queueDisplay: null,
      audioQueueDisplay: null,
      reregisterCommands: (audioMode: boolean) => this.reregisterCommands(audioMode),
    });

    botClient.on('interactionCreate', async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      try {
        await handleInteraction(interaction as ChatInputCommandInteraction);
      } catch (err) {
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
