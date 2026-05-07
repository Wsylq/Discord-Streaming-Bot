import type { ChatInputCommandInteraction, Client } from 'discord.js';
import type { Client as SelfbotClient, TextChannel, VoiceChannel } from 'discord.js-selfbot-v13';
import type { StreamController } from './commandHandler';
import type { QueueDisplay } from './queueDisplay';
import type { AudioQueueDisplay } from './audioQueueDisplay';
import type { SearchResult } from './youtubePlayer';
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
import {
  isYouTubeUrl,
  searchYouTube,
  searchYouTubeMultiple,
  fetchChannelVideosBatch,
  resolveChannelUrl,
} from './youtubePlayer';
import {
  enqueue,
  clearQueue,
  getAll,
  queueLength,
} from './queueDb';
import {
  audioEnqueue,
  audioRemoveByPosition,
  audioClearQueue,
  audioGetAll,
} from './audioQueueDb';

export interface BotCommandHandlerDeps {
  streamController: StreamController;
  guildId: string;
  voiceChannelId: string;
  textChannelId: string;
  ownerId: string;
  /** Optional role ID — members with this role can use slash commands in addition to the owner. */
  allowedRoleId: string | null;
  botClient: Client;
  selfbotClient: SelfbotClient;
  queueDisplay: QueueDisplay | null;
  audioQueueDisplay: AudioQueueDisplay | null;
  /** Called after audio-mode is toggled to update the guild's slash command list. */
  reregisterCommands: (audioMode: boolean) => Promise<void>;
}

const PAGE_SIZE = 5;

export function createBotCommandHandler(
  deps: BotCommandHandlerDeps,
): (interaction: ChatInputCommandInteraction) => Promise<void> {
  const {
    streamController,
    guildId,
    voiceChannelId,
    textChannelId,
    ownerId,
    allowedRoleId,
    selfbotClient,
    queueDisplay,
    audioQueueDisplay,
    reregisterCommands,
  } = deps;

  // Pending pick results — local to the bot handler (not shared with selfbot)
  let pendingResults: SearchResult[] | null = null;
  // Track whether the last search-pick was a music (audio) pick
  let pendingResultsIsAudio = false;
  // Cooldown for audio-mode toggle — prevents rapid re-registration spam
  let lastAudioModeToggle = 0;
  const AUDIO_MODE_COOLDOWN_MS = 20_000;

  async function getSelfbotTextChannel(): Promise<TextChannel> {
    return selfbotClient.channels.fetch(textChannelId) as Promise<TextChannel>;
  }

  async function getSelfbotVoiceChannel(): Promise<VoiceChannel> {
    return selfbotClient.channels.fetch(voiceChannelId) as Promise<VoiceChannel>;
  }

  async function autoEnqueue(url: string, knownTitle?: string, knownDuration?: string, knownChannel?: string): Promise<string> {
    let title = knownTitle ?? url;
    let duration = knownDuration ?? '?';
    let channel = knownChannel ?? '';
    if (!knownTitle) {
      try {
        const { fetchVideoMeta } = await import('./webhookNotifier');
        const meta = await fetchVideoMeta(url);
        if (meta) { title = meta.title; duration = meta.duration; channel = meta.channel; }
      } catch { /* ignore */ }
    }
    enqueue({ url, title, duration, channel });
    if (queueDisplay) queueDisplay.refresh().catch(() => { });
    return `➕ Added to queue: **${title}**`;
  }

  async function autoAudioEnqueue(url: string, knownTitle?: string, knownDuration?: string, knownArtist?: string): Promise<string> {
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
    return `🎵 Added to audio queue: **${title}**`;
  }

  async function playChosen(chosen: SearchResult): Promise<string> {
    if (streamController.isStreaming) {
      return streamController.audioMode
        ? autoAudioEnqueue(chosen.url, chosen.title, chosen.duration, chosen.channel)
        : autoEnqueue(chosen.url, chosen.title, chosen.duration, chosen.channel);
    }
    try {
      await selfbotClient.guilds.fetch(guildId);
      const voiceChannel = await getSelfbotVoiceChannel();
      const textChannel = await getSelfbotTextChannel();
      if (streamController.audioMode) {
        await streamController.playAudio(voiceChannel, chosen.url, textChannel);
      } else {
        await streamController.playUrl(voiceChannel, chosen.url, textChannel);
      }
      return `▶️ Playing: **${chosen.title}**`;
    } catch (err) {
      console.error('[bot] playChosen error:', err);
      return `❌ Failed to play: ${err instanceof Error ? err.message : 'Unknown error'}`;
    }
  }

  async function playChosenAudio(chosen: SearchResult): Promise<string> {
    if (streamController.isStreaming) {
      return autoAudioEnqueue(chosen.url, chosen.title, chosen.duration, chosen.channel);
    }
    try {
      await selfbotClient.guilds.fetch(guildId);
      const voiceChannel = await getSelfbotVoiceChannel();
      const textChannel = await getSelfbotTextChannel();
      await streamController.playAudio(voiceChannel, chosen.url, textChannel);
      return `🎵 Playing: **${chosen.title}**`;
    } catch (err) {
      console.error('[bot] playChosenAudio error:', err);
      return `❌ Failed to play: ${err instanceof Error ? err.message : 'Unknown error'}`;
    }
  }

  /**
   * Safe wrappers — Discord interactions expire after 3 seconds (for the initial
   * acknowledgement) or 15 minutes (for follow-ups). Wrapping every reply call
   * prevents DiscordAPIError[10062] (Unknown interaction) from crashing the process.
   */
  async function safeReply(
    interaction: ChatInputCommandInteraction,
    payload: Parameters<ChatInputCommandInteraction['reply']>[0],
  ): Promise<void> {
    try {
      await interaction.reply(payload);
    } catch (err) {
      console.warn('[bot] interaction.reply failed (interaction may have expired):', (err as Error).message);
    }
  }

  async function safeEditReply(
    interaction: ChatInputCommandInteraction,
    payload: Parameters<ChatInputCommandInteraction['editReply']>[0],
  ): Promise<void> {
    try {
      await interaction.editReply(payload);
    } catch (err) {
      console.warn('[bot] interaction.editReply failed (interaction may have expired):', (err as Error).message);
    }
  }

  async function safeDeferReply(interaction: ChatInputCommandInteraction): Promise<boolean> {
    try {
      await interaction.deferReply();
      return true;
    } catch (err) {
      console.warn('[bot] interaction.deferReply failed (interaction may have expired):', (err as Error).message);
      return false;
    }
  }

  async function handleInteractionInner(interaction: ChatInputCommandInteraction): Promise<void> {
    // ── Authorization check ──────────────────────────────────────────────────
    // Allow if: user is the owner, OR user has the configured allowed role
    const isOwner = interaction.user.id === ownerId;
    const hasRole = allowedRoleId !== null
      && interaction.member !== null
      && 'roles' in interaction.member
      && (
        Array.isArray(interaction.member.roles)
          ? (interaction.member.roles as string[]).includes(allowedRoleId)
          : (interaction.member.roles as { cache: Map<string, unknown> }).cache.has(allowedRoleId)
      );

    if (!isOwner && !hasRole) {
      await safeReply(interaction, {
        content: 'You are not authorized to use this command.',
        ephemeral: true,
      });
      return;
    }

    const cmd = interaction.commandName;

    // ── Help ─────────────────────────────────────────────────────────────────
    if (cmd === 'help') {
      // Bot is enabled (we're in the slash command handler), so show slash command syntax
      await safeReply(interaction, buildHelpEmbeds(true));
      return;
    }

    // ── Now Playing ──────────────────────────────────────────────────────────
    if (cmd === 'np') {
      const np = streamController.nowPlaying();
      if (!np) {
        await safeReply(interaction, { content: 'Nothing is currently playing.', ephemeral: true });
        return;
      }
      const elapsed = formatElapsed(np.elapsedSeconds);
      const icon = np.type === 'audio' ? '🎵' : np.type === 'local' ? '📁' : '▶️';
      const status = np.isPaused ? '⏸️ Paused' : '▶️ Playing';
      await safeReply(interaction, {
        embeds: [{
          color: np.isPaused ? 0xfaa61a : (np.type === 'audio' ? 0x57f287 : 0x5865f2),
          title: `${icon} Now Playing — ${status}`,
          description: np.url
            ? `**[${np.title}](${np.url})**`
            : `**${np.title}**`,
          fields: [
            { name: '⏱️ Elapsed', value: `\`${elapsed}\``, inline: true },
            { name: '🎚️ Type', value: np.type.charAt(0).toUpperCase() + np.type.slice(1), inline: true },
          ],
          timestamp: new Date().toISOString(),
        }],
      });
      return;
    }

    // ── Playback control commands — defer first since StreamController ops are async ──

    if (cmd === 'pause') {
      if (!streamController.isStreaming) { await safeReply(interaction, 'Nothing is playing.'); return; }
      const deferred = await safeDeferReply(interaction);
      if (!deferred) return;
      const ok = await streamController.pause();
      await safeEditReply(interaction, ok ? '⏸️ Paused.' : 'Nothing is playing.');
      return;
    }

    if (cmd === 'resume') {
      if (!streamController.isPaused) { await safeReply(interaction, 'Nothing is paused.'); return; }
      const deferred = await safeDeferReply(interaction);
      if (!deferred) return;
      try {
        const voiceChannel = await getSelfbotVoiceChannel();
        const ok = await streamController.resume(voiceChannel);
        await safeEditReply(interaction, ok ? '▶️ Resumed.' : 'Nothing is paused.');
      } catch (err) {
        console.error('[bot] /resume error:', err);
        await safeEditReply(interaction, '❌ Failed to resume.');
      }
      return;
    }

    if (cmd === 'stop') {
      const deferred = await safeDeferReply(interaction);
      if (!deferred) return;
      await streamController.stop();
      await safeEditReply(interaction, '⏹️ Stopped.');
      return;
    }

    if (cmd === 'skip') {
      if (!streamController.isStreaming && !streamController.isPaused) {
        await safeReply(interaction, 'Nothing is playing.');
        return;
      }
      const deferred = await safeDeferReply(interaction);
      if (!deferred) return;
      try {
        const textChannel = await selfbotClient.channels.fetch(textChannelId) as TextChannel;
        await streamController.skip(textChannel);
      } catch {
        await streamController.skip();
      }
      await safeEditReply(interaction, '⏭️ Skipped.');
      return;
    }

    if (cmd === 'loop') {
      const on = streamController.toggleLoopTrack();
      await safeReply(interaction, on ? '🔂 Loop track **on**.' : '🔂 Loop track **off**.');
      return;
    }

    if (cmd === 'loopqueue') {
      const on = streamController.toggleLoopQueue();
      await safeReply(interaction, on ? '🔁 Loop queue **on**.' : '🔁 Loop queue **off**.');
      return;
    }

    if (cmd === 'audio-mode') {
      const now = Date.now();
      const remaining = AUDIO_MODE_COOLDOWN_MS - (now - lastAudioModeToggle);
      if (remaining > 0) {
        await safeReply(interaction, {
          content: `⏳ Audio mode was just changed. Please wait **${Math.ceil(remaining / 1000)}s** before toggling again.`,
          ephemeral: true,
        });
        return;
      }
      lastAudioModeToggle = now;
      const on = streamController.toggleAudioMode();
      // Re-register slash commands in the background — show video or audio set
      reregisterCommands(on).catch((err) =>
        console.error('[bot] Failed to re-register commands after audio-mode toggle:', err),
      );
      await safeReply(interaction, on
        ? '🎵 Audio mode **ON** — slash commands updated to audio commands.'
        : '🎵 Audio mode **OFF** — slash commands updated to video commands.',
      );
      return;
    }

    if (cmd === 'loop-audio') {
      const on = streamController.toggleLoopAudioTrack();
      await safeReply(interaction, on ? '🔂 Audio loop track **on**.' : '🔂 Audio loop track **off**.');
      return;
    }

    if (cmd === 'loop-audio-queue') {
      const on = streamController.toggleLoopAudioQueue();
      await safeReply(interaction, on ? '🔁 Audio loop queue **on**.' : '🔁 Audio loop queue **off**.');
      return;
    }

    if (cmd === 'aq-clear') {
      const count = audioClearQueue();
      if (audioQueueDisplay) audioQueueDisplay.refresh().catch(() => { });
      await safeReply(interaction, `🗑️ Cleared ${count} audio item${count !== 1 ? 's' : ''}.`);
      return;
    }

    if (cmd === 'queue-clear') {
      const count = clearQueue();
      if (queueDisplay) queueDisplay.refresh().catch(() => { });
      await safeReply(interaction, `🗑️ Cleared ${count} item${count !== 1 ? 's' : ''} from queue.`);
      return;
    }

    if (cmd === 'queue') {
      if (queueDisplay) {
        await queueDisplay.show();
        await safeReply(interaction, '📋 Queue displayed.');
      } else {
        const items = getAll();
        if (items.length === 0) { await safeReply(interaction, 'Queue is empty.'); return; }
        const list = items.slice(0, 10).map((item, i) => `**${i + 1}.** ${item.title} \`${item.duration}\``).join('\n');
        await safeReply(interaction, `**Queue (${items.length} videos)**\n${list}`);
      }
      return;
    }

    if (cmd === 'aq') {
      if (audioQueueDisplay) {
        await audioQueueDisplay.show();
        await safeReply(interaction, '🎵 Audio queue displayed.');
      } else {
        const items = audioGetAll();
        if (items.length === 0) { await safeReply(interaction, 'Audio queue is empty.'); return; }
        const list = items.slice(0, 10).map((item, i) => `**${i + 1}.** ${item.title} \`${item.duration}\``).join('\n');
        await safeReply(interaction, `**Audio Queue (${items.length} tracks)**\n${list}`);
      }
      return;
    }

    if (cmd === 'aq-remove') {
      const n = interaction.options.getInteger('number', true);
      const ok = audioRemoveByPosition(n);
      if (ok) {
        if (audioQueueDisplay) audioQueueDisplay.refresh().catch(() => { });
        await safeReply(interaction, `✅ Removed audio item #${n}.`);
      } else {
        await safeReply(interaction, `No item at position ${n}.`);
      }
      return;
    }

    if (cmd === 'pick') {
      const results = pendingResults;
      if (!results || results.length === 0) {
        await safeReply(interaction, 'No active search. Use `/search-pick` or `/music-search-pick` first.');
        return;
      }
      const n = interaction.options.getInteger('number', true);
      if (n < 1 || n > results.length) {
        await safeReply(interaction, `Pick a number between 1 and ${results.length}.`);
        return;
      }
      const chosen = results[n - 1];
      const isAudio = pendingResultsIsAudio;
      pendingResults = null;
      pendingResultsIsAudio = false;
      const deferred = await safeDeferReply(interaction);
      if (!deferred) return;
      try {
        const msg = isAudio ? await playChosenAudio(chosen) : await playChosen(chosen);
        await safeEditReply(interaction, msg);
      } catch (err) {
        console.error('[bot] /pick error:', err);
        await safeEditReply(interaction, `❌ ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
      return;
    }

    if (cmd === 'queue-play') {
      if (streamController.isStreaming) { await safeReply(interaction, 'Already streaming. Use `/stop` first.'); return; }
      if (queueLength() === 0) { await safeReply(interaction, 'Queue is empty.'); return; }
      const deferred = await safeDeferReply(interaction);
      if (!deferred) return;
      try {
        await selfbotClient.guilds.fetch(guildId);
        const voiceChannel = await getSelfbotVoiceChannel();
        const textChannel = await getSelfbotTextChannel();
        const ok = await streamController.playFromQueue(voiceChannel, textChannel);
        await safeEditReply(interaction, ok ? '▶️ Playing from queue.' : 'Queue is empty.');
      } catch (err) {
        console.error('[bot] /queue-play error:', err);
        await safeEditReply(interaction, `❌ ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
      return;
    }

    // ── Long-running commands (defer → editReply) ────────────────────────────

    if (cmd === 'play') {
      const url = interaction.options.getString('url', true);
      if (!isYouTubeUrl(url)) { await safeReply(interaction, 'Invalid URL. Only YouTube links are supported.'); return; }
      const deferred = await safeDeferReply(interaction);
      if (!deferred) return;
      if (streamController.isStreaming) {
        await safeEditReply(interaction, await autoEnqueue(url));
        return;
      }
      try {
        await selfbotClient.guilds.fetch(guildId);
        const voiceChannel = await getSelfbotVoiceChannel();
        const textChannel = await getSelfbotTextChannel();
        if (streamController.audioMode) {
          await streamController.playAudio(voiceChannel, url, textChannel);
        } else {
          await streamController.playUrl(voiceChannel, url, textChannel);
        }
        await safeEditReply(interaction, `▶️ Playing: ${url}`);
      } catch (err) {
        console.error('[bot] /play error:', err);
        await safeEditReply(interaction, `❌ ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
      return;
    }

    if (cmd === 'audio') {
      const url = interaction.options.getString('url', true);
      if (streamController.isStreaming) {
        audioEnqueue({ url, title: url, duration: '?', artist: '' });
        if (audioQueueDisplay) audioQueueDisplay.refresh().catch(() => { });
        await safeReply(interaction, '➕ Added to audio queue.');
        return;
      }
      const deferred = await safeDeferReply(interaction);
      if (!deferred) return;
      try {
        await selfbotClient.guilds.fetch(guildId);
        const voiceChannel = await getSelfbotVoiceChannel();
        const textChannel = await getSelfbotTextChannel();
        await streamController.playAudio(voiceChannel, url, textChannel);
        await safeEditReply(interaction, `🎵 Playing audio: ${url}`);
      } catch (err) {
        console.error('[bot] /audio error:', err);
        await safeEditReply(interaction, `❌ ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
      return;
    }

    if (cmd === 'search') {
      const query = interaction.options.getString('query', true);
      const deferred = await safeDeferReply(interaction);
      if (!deferred) return;
      try {
        const abort = new AbortController();
        const result = await searchYouTube(query, abort.signal);
        if (streamController.isStreaming) {
          const msg = streamController.audioMode
            ? await autoAudioEnqueue(result.url, result.title)
            : await autoEnqueue(result.url, result.title);
          await safeEditReply(interaction, msg);
          return;
        }
        await selfbotClient.guilds.fetch(guildId);
        const voiceChannel = await getSelfbotVoiceChannel();
        const textChannel = await getSelfbotTextChannel();
        if (streamController.audioMode) {
          await streamController.playAudio(voiceChannel, result.url, textChannel);
        } else {
          await streamController.playUrl(voiceChannel, result.url, textChannel);
        }
        await safeEditReply(interaction, `▶️ Playing: **${result.title}**`);
      } catch (err) {
        console.error('[bot] /search error:', err);
        await safeEditReply(interaction, `❌ Search failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
      return;
    }

    if (cmd === 'search-pick') {
      const query = interaction.options.getString('query', true);
      const deferred = await safeDeferReply(interaction);
      if (!deferred) return;
      try {
        const abort = new AbortController();
        const results = await searchYouTubeMultiple(query, 5, abort.signal);
        if (results.length === 0) { await safeEditReply(interaction, 'No results found.'); return; }
        pendingResults = results;
        pendingResultsIsAudio = false;
        const list = results.map((r, i) => `**${i + 1}.** ${r.title} \`${r.duration}\` — ${r.channel}`).join('\n');
        await safeEditReply(interaction, `**Search results** — use \`/pick <number>\` to play:\n${list}`);
      } catch (err) {
        console.error('[bot] /search-pick error:', err);
        await safeEditReply(interaction, `❌ Search failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
      return;
    }

    if (cmd === 'search-channel') {
      const name = interaction.options.getString('name', true);
      const deferred = await safeDeferReply(interaction);
      if (!deferred) return;
      try {
        const abort = new AbortController();
        const { videosUrl, displayName } = await resolveChannelUrl(name, abort.signal);
        const abort2 = new AbortController();
        const initialResults = await fetchChannelVideosBatch(videosUrl, displayName, 1, PAGE_SIZE, abort2.signal);
        if (initialResults.length === 0) { await safeEditReply(interaction, 'No videos found for that channel.'); return; }
        pendingResults = initialResults;
        pendingResultsIsAudio = false;
        const list = initialResults.map((r, i) => `**${i + 1}.** ${r.title} \`${r.duration}\``).join('\n');
        await safeEditReply(interaction, `**${displayName} — Videos**\n${list}\n\nUse \`/pick <number>\` to play.`);
      } catch (err) {
        console.error('[bot] /search-channel error:', err);
        await safeEditReply(interaction, `❌ ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
      return;
    }

    if (cmd === 'music-search') {
      const query = interaction.options.getString('query', true);
      const deferred = await safeDeferReply(interaction);
      if (!deferred) return;
      try {
        const abort = new AbortController();
        const result = await searchYouTube(query, abort.signal);
        if (streamController.isStreaming) {
          await safeEditReply(interaction, await autoAudioEnqueue(result.url, result.title));
          return;
        }
        await selfbotClient.guilds.fetch(guildId);
        const voiceChannel = await getSelfbotVoiceChannel();
        const textChannel = await getSelfbotTextChannel();
        await streamController.playAudio(voiceChannel, result.url, textChannel);
        await safeEditReply(interaction, `🎵 Playing: **${result.title}**`);
      } catch (err) {
        console.error('[bot] /music-search error:', err);
        await safeEditReply(interaction, `❌ Search failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
      return;
    }

    if (cmd === 'music-search-pick') {
      const query = interaction.options.getString('query', true);
      const deferred = await safeDeferReply(interaction);
      if (!deferred) return;
      try {
        const abort = new AbortController();
        const results = await searchYouTubeMultiple(query, 5, abort.signal);
        if (results.length === 0) { await safeEditReply(interaction, 'No results found.'); return; }
        pendingResults = results;
        pendingResultsIsAudio = true;
        const list = results.map((r, i) => `**${i + 1}.** ${r.title} \`${r.duration}\` — ${r.channel}`).join('\n');
        await safeEditReply(interaction, `**Music results** — use \`/pick <number>\` to play:\n${list}`);
      } catch (err) {
        console.error('[bot] /music-search-pick error:', err);
        await safeEditReply(interaction, `❌ Search failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
      return;
    }

    if (cmd === 'start') {
      if (streamController.isStreaming) { await safeReply(interaction, 'Already streaming.'); return; }
      const deferred = await safeDeferReply(interaction);
      if (!deferred) return;
      try {
        await selfbotClient.guilds.fetch(guildId);
        const voiceChannel = await getSelfbotVoiceChannel();
        const textChannel = await getSelfbotTextChannel();
        await safeEditReply(interaction, '▶️ Starting stream. Use `!start` if the local video queue is not configured.');
        await streamController.start(voiceChannel, { files: [], currentIndex: 0 }, textChannel);
      } catch (err) {
        console.error('[bot] /start error:', err);
        await safeEditReply(interaction, `❌ ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
      return;
    }

    // ── Unrecognised command ─────────────────────────────────────────────────
    await safeReply(interaction, { content: '❓ Unknown command.', ephemeral: true });
  }

  // Outer wrapper: catches any error that slips past the safe* helpers,
  // including DiscordAPIError[10062] (expired interaction).
  return async function handleInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      await handleInteractionInner(interaction);
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 10062) {
        console.warn('[bot] Interaction expired before bot could respond (10062). Ignoring.');
        return;
      }
      console.error('[bot] Unhandled error in slash command handler:', err);
    }
  };
}
