import type { TextChannel, VoiceChannel } from 'discord.js-selfbot-v13';
import { prepareStream, playStream } from '@dank074/discord-video-stream';
import type { Streamer } from '@dank074/discord-video-stream';
import { advance, currentFile, isEmpty } from './videoQueue';
import type { VideoQueue } from './videoQueue';
import type { StreamController } from './commandHandler';
import { ENCODER_OPTIONS } from './encoderOptions';
import { downloadYouTubeVideo, deleteTempFile, type DownloadProgress } from './youtubePlayer';

interface PauseState {
  filePath: string;       // local file to resume from
  isTempFile: boolean;    // whether we own this file and must delete it
  seekSeconds: number;    // position to resume from
  startedAt: number;      // wall clock when this segment started
  baseSeconds: number;    // accumulated time before this segment
}

interface StreamState {
  isStreaming: boolean;
  isPaused: boolean;
  isInVoice: boolean;
  abortController: AbortController | null;
  queue: VideoQueue | null;
  pause: PauseState | null;
}

export function createStreamController(streamer: Streamer): StreamController {
  const state: StreamState = {
    isStreaming: false,
    isPaused: false,
    isInVoice: false,
    abortController: null,
    queue: null,
    pause: null,
  };

  function cleanupTempFile(): void {
    if (state.pause?.isTempFile && state.pause.filePath) {
      deleteTempFile(state.pause.filePath);
    }
  }

  async function joinVoice(voiceChannel: VoiceChannel): Promise<boolean> {
    if (state.isInVoice) {
      try { streamer.leaveVoice(); } catch { /* ignore */ }
      state.isInVoice = false;
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

  /**
   * Plays a local file from seekSeconds, tracking position for pause/resume.
   * Returns true if playback completed naturally, false if aborted.
   */
  async function playFile(
    filePath: string,
    isTempFile: boolean,
    seekSeconds = 0,
  ): Promise<boolean> {
    const abort = new AbortController();
    state.abortController = abort;

    state.pause = {
      filePath,
      isTempFile,
      seekSeconds,
      startedAt: Date.now(),
      baseSeconds: seekSeconds,
    };

    // Build input options: -ss must be the first input option for fast seek
    const seekInputOptions = seekSeconds > 0
      ? ['-ss', seekSeconds.toFixed(3)]
      : [];

    const options = {
      ...ENCODER_OPTIONS,
      customInputOptions: seekInputOptions,
    };

    try {
      const { output, promise } = prepareStream(filePath, options, abort.signal);
      await playStream(output, streamer, { type: 'camera', readrateInitialBurst: 10 }, abort.signal);
      await promise;
      return true;
    } catch (err: unknown) {
      if (err instanceof Error && (err.name === 'AbortError' || err.message?.includes('aborted'))) {
        return false;
      }
      console.error(`[stream] Error playing "${filePath}":`, err);
      return false;
    }
  }

  async function playNext(queue: VideoQueue): Promise<void> {
    const filePath = currentFile(queue);

    if (!filePath) {
      state.isStreaming = false;
      state.abortController = null;
      state.queue = null;
      state.pause = null;
      console.log('[stream] Queue complete. Staying in voice channel.');
      return;
    }

    state.queue = queue;
    console.log(`[stream] Playing: ${filePath}`);

    const completed = await playFile(filePath, false);

    if (completed && state.isStreaming && !state.isPaused) {
      state.pause = null;
      await playNext(advance(queue));
    }
  }

  const controller: StreamController = {
    get isStreaming() { return state.isStreaming; },
    get isPaused()    { return state.isPaused; },
    get isInVoice()   { return state.isInVoice; },

    async start(voiceChannel: VoiceChannel, queue: VideoQueue, _textChannel: TextChannel): Promise<void> {
      if (state.isStreaming) return;

      const joined = await joinVoice(voiceChannel);
      if (!joined) return;

      state.isStreaming = true;
      state.isPaused = false;

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
      state.isPaused = false;

      const downloadAbort = new AbortController();
      state.abortController = downloadAbort;

      let lastProgressMsg = 0;
      const onProgress = async (p: DownloadProgress) => {
        const now = Date.now();
        if (now - lastProgressMsg < 5000) return;
        lastProgressMsg = now;
        try {
          await textChannel.send(`⬇️ Downloading: **${p.percent.toFixed(1)}%** at ${p.speed} — ETA ${p.eta}`);
        } catch { /* ignore */ }
      };

      let tmpFile: string;
      try {
        tmpFile = await downloadYouTubeVideo(url, streamer, downloadAbort.signal, onProgress);
      } catch (err: unknown) {
        state.isStreaming = false;
        if (err instanceof Error && err.message?.includes('aborted')) return;
        console.error('[stream] Download error:', err);
        return;
      }

      if (downloadAbort.signal.aborted || !state.isStreaming) {
        deleteTempFile(tmpFile);
        return;
      }

      console.log('[stream] Playing downloaded file...');

      // playFile will set state.pause with isTempFile=true
      const completed = await playFile(tmpFile, true);

      if (!state.isPaused) {
        // Not paused — clean up temp file now
        cleanupTempFile();
        state.pause = null;
        state.isStreaming = false;
        state.abortController = null;
        if (completed) {
          console.log('[stream] YouTube stream finished.');
          try { await textChannel.send('✅ Done. Send `!play` to queue another.'); } catch { /* ignore */ }
        }
      }
      // If paused, temp file stays alive — resume will clean it up
    },

    async pause(): Promise<boolean> {
      if (!state.isStreaming || state.isPaused || !state.pause) return false;

      // Calculate current position
      const elapsed = (Date.now() - state.pause.startedAt) / 1000;
      const seekSeconds = state.pause.baseSeconds + elapsed;

      state.pause = { ...state.pause, seekSeconds };
      state.isPaused = true;
      state.isStreaming = false;

      if (state.abortController) {
        state.abortController.abort();
        state.abortController = null;
      }

      try { streamer.stopStream(); } catch { /* ignore */ }

      console.log(`[stream] Paused at ${seekSeconds.toFixed(1)}s`);
      return true;
    },

    async resume(voiceChannel: VoiceChannel): Promise<boolean> {
      if (!state.isPaused || !state.pause) return false;

      const { filePath, isTempFile, seekSeconds } = state.pause;

      state.isPaused = false;
      state.isStreaming = true;

      console.log(`[stream] Resuming from ${seekSeconds.toFixed(1)}s`);

      // Brief wait for previous stream cleanup to complete
      await new Promise(resolve => setTimeout(resolve, 800));

      // Rejoin for a fresh SRTP context
      const joined = await joinVoice(voiceChannel);
      if (!joined) {
        state.isStreaming = false;
        state.isPaused = true; // stay paused so user can retry
        return false;
      }

      const completed = await playFile(filePath, isTempFile, seekSeconds);

      if (!state.isPaused) {
        if (isTempFile) {
          cleanupTempFile();
        }
        state.pause = null;

        // If it was a local queue file and completed, advance queue
        if (completed && state.isStreaming && !isTempFile && state.queue) {
          await playNext(advance(state.queue));
        } else {
          state.isStreaming = false;
        }
      }

      return true;
    },

    async stop(): Promise<void> {
      if (state.abortController) {
        state.abortController.abort();
        state.abortController = null;
      }

      cleanupTempFile();

      state.isStreaming = false;
      state.isPaused = false;
      state.queue = null;
      state.pause = null;

      if (state.isInVoice) {
        try { streamer.stopStream(); } catch { /* ignore */ }
        streamer.leaveVoice();
        state.isInVoice = false;
        console.log('[stream] Stopped and left voice channel.');
      }
    },

    async skip(): Promise<void> {
      if (!state.isStreaming && !state.isPaused) return;

      if (state.abortController) {
        state.abortController.abort();
        state.abortController = null;
      }

      // Clean up temp file if skipping a YouTube video
      cleanupTempFile();
      state.pause = null;
      state.isPaused = false;

      if (!state.queue) {
        state.isStreaming = false;
        return;
      }

      const nextQueue = advance(state.queue);

      if (isEmpty(nextQueue)) {
        state.isStreaming = false;
        state.queue = null;
        console.log('[stream] Queue complete after skip.');
        return;
      }

      state.isStreaming = true;
      playNext(nextQueue).catch((err) => {
        console.error('[stream] Unhandled skip error:', err);
        state.isStreaming = false;
      });
    },
  };

  return controller;
}
