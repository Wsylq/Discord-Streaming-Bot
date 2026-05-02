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
  abortController: AbortController | null;
  queue: VideoQueue | null;
}

export function createStreamController(streamer: Streamer): StreamController {
  const state: StreamState = {
    isStreaming: false,
    abortController: null,
    queue: null,
  };

  async function playNext(queue: VideoQueue): Promise<void> {
    const filePath = currentFile(queue);

    if (!filePath) {
      streamer.leaveVoice();
      state.isStreaming = false;
      state.abortController = null;
      state.queue = null;
      console.log('Queue complete. Left voice channel.');
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

    async start(voiceChannel: VoiceChannel, queue: VideoQueue, _textChannel: TextChannel): Promise<void> {
      if (state.isStreaming) return;

      state.isStreaming = true;
      console.log(`[stream] Joining voice channel ${voiceChannel.id}...`);

      try {
        await streamer.joinVoice(voiceChannel.guild.id, voiceChannel.id);
        console.log('[stream] Joined voice. Creating stream...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        console.log('[stream] Starting playback...');
      } catch (err) {
        console.error('[stream] Failed to join voice channel:', err);
        state.isStreaming = false;
        return;
      }

      playNext(queue).catch((err) => {
        console.error('[stream] Unhandled playNext error:', err);
        state.isStreaming = false;
      });
    },

    async playUrl(voiceChannel: VoiceChannel, url: string, textChannel: TextChannel): Promise<void> {
      if (state.isStreaming) return;

      state.isStreaming = true;
      console.log(`[stream] Joining voice channel ${voiceChannel.id} for YouTube stream...`);

      try {
        await streamer.joinVoice(voiceChannel.guild.id, voiceChannel.id);
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (err) {
        console.error('[stream] Failed to join voice channel:', err);
        state.isStreaming = false;
        return;
      }

      const abort = new AbortController();
      state.abortController = abort;

      console.log(`[stream] Streaming YouTube: ${url}`);

      // Send progress updates to the text channel every ~5 seconds
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
          if (state.isStreaming) {
            streamer.leaveVoice();
            state.isStreaming = false;
            state.abortController = null;
            console.log('[stream] YouTube stream finished.');
            try { await textChannel.send('✅ Stream finished.'); } catch { /* ignore */ }
          }
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
      if (!state.isStreaming) return;

      state.isStreaming = false;

      if (state.abortController) {
        state.abortController.abort();
        state.abortController = null;
      }

      state.queue = null;
      streamer.stopStream();
      streamer.leaveVoice();
      console.log('[stream] Stopped.');
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
        streamer.stopStream();
        streamer.leaveVoice();
        console.log('[stream] Queue complete after skip. Left voice channel.');
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
