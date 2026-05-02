import type { TextChannel, VoiceChannel } from 'discord.js-selfbot-v13';
import { prepareStream, playStream } from '@dank074/discord-video-stream';
import type { Streamer } from '@dank074/discord-video-stream';
import { advance, currentFile, isEmpty } from './videoQueue';
import type { VideoQueue } from './videoQueue';
import type { StreamController } from './commandHandler';
import { ENCODER_OPTIONS } from './encoderOptions';
import { playYouTubeUrl, type DownloadProgress } from './youtubePlayer';

interface StreamState {
  isStreaming: boolean;
  isInVoice: boolean;
  abortController: AbortController | null;
  queue: VideoQueue | null;
}

export function createStreamController(streamer: Streamer): StreamController {
  const state: StreamState = {
    isStreaming: false,
    isInVoice: false,
    abortController: null,
    queue: null,
  };

  async function joinVoice(voiceChannel: VoiceChannel): Promise<boolean> {
    // Always rejoin — reusing an existing SRTP session between streams
    // causes "SRTP protect error" when the crypto context expires
    if (state.isInVoice) {
      try {
        streamer.leaveVoice();
      } catch { /* ignore */ }
      state.isInVoice = false;
      // Brief pause for the old connection to fully close
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    try {
      await streamer.joinVoice(voiceChannel.guild.id, voiceChannel.id);
      await new Promise(resolve => setTimeout(resolve, 1000));
      state.isInVoice = true;
      return true;
    } catch (err) {
      console.error('[stream] Failed to join voice channel:', err);
      return false;
    }
  }

  async function playNext(queue: VideoQueue): Promise<void> {
    const filePath = currentFile(queue);

    if (!filePath) {
      // Queue done — stay in VC, just mark as not streaming
      state.isStreaming = false;
      state.abortController = null;
      state.queue = null;
      console.log('[stream] Queue complete. Staying in voice channel.');
      return;
    }

    state.queue = queue;
    console.log(`[stream] Playing: ${filePath}`);

    try {
      const abort = new AbortController();
      state.abortController = abort;

      const { output, promise } = prepareStream(filePath, ENCODER_OPTIONS, abort.signal);
      await playStream(output, streamer, { type: 'camera', readrateInitialBurst: 10 }, abort.signal);
      await promise;
    } catch (err: unknown) {
      if (err instanceof Error && (err.name === 'AbortError' || err.message?.includes('aborted'))) {
        return;
      }
      console.error(`[stream] Error on "${filePath}":`, err);
    }

    if (state.isStreaming) {
      await playNext(advance(queue));
    }
  }

  const controller: StreamController = {
    get isStreaming() {
      return state.isStreaming;
    },

    get isInVoice() {
      return state.isInVoice;
    },

    async start(voiceChannel: VoiceChannel, queue: VideoQueue, _textChannel: TextChannel): Promise<void> {
      if (state.isStreaming) return;

      const joined = await joinVoice(voiceChannel);
      if (!joined) return;

      state.isStreaming = true;

      playNext(queue).catch((err) => {
        console.error('[stream] Unhandled playNext error:', err);
        state.isStreaming = false;
      });
    },

    async playUrl(voiceChannel: VoiceChannel, url: string, textChannel: TextChannel): Promise<void> {
      if (state.isStreaming) return;

      const joined = await joinVoice(voiceChannel);
      if (!joined) return;

      state.isStreaming = true;

      const abort = new AbortController();
      state.abortController = abort;

      console.log(`[stream] Streaming YouTube: ${url}`);

      let lastProgressMsg = 0;
      const onProgress = async (p: { percent: number; speed: string; eta: string }) => {
        const now = Date.now();
        if (now - lastProgressMsg < 5000) return;
        lastProgressMsg = now;
        try {
          await textChannel.send(`⬇️ Downloading: **${p.percent.toFixed(1)}%** at ${p.speed} — ETA ${p.eta}`);
        } catch { /* ignore */ }
      };

      playYouTubeUrl(url, streamer, abort.signal, onProgress)
        .then(async () => {
          state.isStreaming = false;
          state.abortController = null;
          console.log('[stream] YouTube stream finished. Staying in voice channel.');
          try { await textChannel.send('✅ Done. Send `!play` to queue another.'); } catch { /* ignore */ }
        })
        .catch((err: unknown) => {
          if (err instanceof Error && (err.name === 'AbortError' || err.message?.includes('aborted'))) {
            return;
          }
          console.error('[stream] YouTube stream error:', err);
          state.isStreaming = false;
        });
    },

    async stop(): Promise<void> {
      if (state.abortController) {
        state.abortController.abort();
        state.abortController = null;
      }

      state.isStreaming = false;
      state.queue = null;

      if (state.isInVoice) {
        streamer.stopStream();
        streamer.leaveVoice();
        state.isInVoice = false;
        console.log('[stream] Stopped and left voice channel.');
      }
    },

    async skip(): Promise<void> {
      if (!state.isStreaming || !state.queue) return;

      const nextQueue = advance(state.queue);

      if (state.abortController) {
        state.abortController.abort();
        state.abortController = null;
      }

      if (isEmpty(nextQueue)) {
        state.isStreaming = false;
        state.queue = null;
        console.log('[stream] Queue complete after skip. Staying in voice channel.');
        return;
      }

      playNext(nextQueue).catch((err) => {
        console.error('[stream] Unhandled skip error:', err);
        state.isStreaming = false;
      });
    },
  };

  return controller;
}
