import type { TextChannel, VoiceChannel } from 'discord.js-selfbot-v13';
import { prepareStream, playStream } from '@dank074/discord-video-stream';
import type { Streamer } from '@dank074/discord-video-stream';
import { advance, currentFile, isEmpty } from './videoQueue';
import type { VideoQueue } from './videoQueue';
import type { StreamController } from './commandHandler';
import { ENCODER_OPTIONS } from './encoderOptions';
import { downloadYouTubeVideo, deleteTempFile, type DownloadProgress } from './youtubePlayer';
import { fetchVideoMeta, type WebhookNotifier } from './webhookNotifier';

interface PauseState {
  filePath: string;
  isTempFile: boolean;
  seekSeconds: number;
  startedAt: number;
  baseSeconds: number;
}

interface StreamState {
  isStreaming: boolean;
  isPaused: boolean;
  isInVoice: boolean;
  loopTrack: boolean;
  loopQueue: boolean;
  abortController: AbortController | null;
  queue: VideoQueue | null;
  pause: PauseState | null;
  loopTempFile: string | null;
  loopUrl: string | null;
  voiceChannel: VoiceChannel | null;
  currentUrl: string | null; // YouTube URL of currently playing video (null for local)
}

export function createStreamController(streamer: Streamer, notifier: WebhookNotifier | null = null): StreamController {
  const state: StreamState = {
    isStreaming: false,
    isPaused: false,
    isInVoice: false,
    loopTrack: false,
    loopQueue: false,
    abortController: null,
    queue: null,
    pause: null,
    loopTempFile: null,
    loopUrl: null,
    voiceChannel: null,
    currentUrl: null,
  };

  function cleanupTempFile(): void {
    if (state.pause?.isTempFile && state.pause.filePath) {
      // Don't delete if it's the loop file — we'll reuse it
      if (state.pause.filePath !== state.loopTempFile) {
        deleteTempFile(state.pause.filePath);
      }
    }
  }

  function cleanupLoopTempFile(): void {
    if (state.loopTempFile) {
      deleteTempFile(state.loopTempFile);
      state.loopTempFile = null;
      state.loopUrl = null;
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
      state.voiceChannel = voiceChannel;
      return true;
    } catch (err) {
      console.error('[stream] Failed to join voice channel:', err);
      return false;
    }
  }

  async function playFile(
    filePath: string,
    isTempFile: boolean,
    seekSeconds = 0,
    meta?: import('./webhookNotifier').VideoMeta,
  ): Promise<boolean> {
    const abort = new AbortController();
    state.abortController = abort;

    const seekInputOptions = seekSeconds > 0 ? ['-ss', seekSeconds.toFixed(3)] : [];
    const options = { ...ENCODER_OPTIONS, customInputOptions: seekInputOptions };

    // Set startedAt AFTER prepareStream+playStream are ready, not before.
    state.pause = {
      filePath,
      isTempFile,
      seekSeconds,
      startedAt: Date.now(),
      baseSeconds: seekSeconds,
    };

    try {
      const { output, promise } = prepareStream(filePath, options, abort.signal);

      // Fire webhook notifier immediately — don't wait for playStream to resolve
      if (notifier && meta) {
        console.log('[webhook] Firing notifier.start()...');
        notifier.start(meta, seekSeconds).then(() => {
          console.log('[webhook] Embed sent successfully.');
        }).catch((err) => {
          console.warn('[webhook] Failed to send embed:', err);
        });
      }

      await playStream(output, streamer, { type: 'camera', readrateInitialBurst: 10 }, abort.signal);

      // Reset the clock now that frames are actually flowing
      if (state.pause) {
        state.pause = { ...state.pause, startedAt: Date.now() };
      }
      // Also sync the notifier's clock
      if (notifier) {
        notifier.resetClock();
      }

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
      if (state.loopQueue && queue.files.length > 0) {
        console.log('[stream] Queue loop: restarting from beginning.');
        await new Promise(resolve => setTimeout(resolve, 800));
        if (state.voiceChannel) await joinVoice(state.voiceChannel);
        await playNext({ files: queue.files, currentIndex: 0 });
        return;
      }
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
      if (state.loopTrack) {
        console.log('[stream] Track loop: replaying.');
        // Rejoin for a fresh SRTP context
        await new Promise(resolve => setTimeout(resolve, 800));
        if (state.voiceChannel) await joinVoice(state.voiceChannel);
        await playNext(queue);
      } else {
        await playNext(advance(queue));
      }
    }
  }

  const controller: StreamController = {
    get isStreaming()  { return state.isStreaming; },
    get isPaused()     { return state.isPaused; },
    get isInVoice()    { return state.isInVoice; },
    get loopTrack()    { return state.loopTrack; },
    get loopQueue()    { return state.loopQueue; },

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

      // If looping the same URL, reuse the already-downloaded file
      let tmpFile: string;
      if (state.loopTempFile && state.loopUrl === url) {
        console.log('[stream] Loop: reusing cached file.');
        tmpFile = state.loopTempFile;
      } else {
        // Clean up any previous loop file before downloading new one
        cleanupLoopTempFile();
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

        // Cache for potential loop reuse
        state.loopTempFile = tmpFile;
        state.loopUrl = url;
      }

      console.log('[stream] Playing downloaded file...');
      state.currentUrl = url;

      // Fetch metadata now so the embed fires immediately when playback starts
      const meta = notifier ? await fetchVideoMeta(url).catch(() => null) : null;
      if (meta) console.log(`[webhook] Got meta: "${meta.title}" by ${meta.channel}`);
      else if (notifier) console.warn('[webhook] fetchVideoMeta returned null');

      const playLoop = async (): Promise<void> => {
        const completed = await playFile(tmpFile, true, 0, meta ?? undefined);

        if (!state.isPaused && state.isStreaming) {
          if (completed && state.loopTrack) {
            console.log('[stream] Track loop: replaying YouTube video.');
            // Rejoin for a fresh SRTP context before replaying
            await new Promise(resolve => setTimeout(resolve, 800));
            const rejoined = await joinVoice(voiceChannel);
            if (!rejoined) {
              state.isStreaming = false;
              cleanupLoopTempFile();
              return;
            }
            await playLoop();
          } else {
            if (!state.loopTrack) cleanupLoopTempFile();
            state.pause = null;
            state.isStreaming = false;
            state.abortController = null;
            if (completed) {
              console.log('[stream] YouTube stream finished.');
              try { await textChannel.send('✅ Done. Send `!play` to queue another.'); } catch { /* ignore */ }
            }
          }
        }
      };

      await playLoop();
    },

    toggleLoopTrack(): boolean {
      state.loopTrack = !state.loopTrack;
      if (state.loopTrack) state.loopQueue = false; // mutually exclusive
      console.log(`[stream] Loop track: ${state.loopTrack}`);
      return state.loopTrack;
    },

    toggleLoopQueue(): boolean {
      state.loopQueue = !state.loopQueue;
      if (state.loopQueue) state.loopTrack = false;
      console.log(`[stream] Loop queue: ${state.loopQueue}`);
      return state.loopQueue;
    },

    async pause(): Promise<boolean> {
      if (!state.isStreaming || state.isPaused || !state.pause) return false;

      const elapsed = (Date.now() - state.pause.startedAt) / 1000;
      const seekSeconds = state.pause.baseSeconds + elapsed;

      state.pause = { ...state.pause, seekSeconds };
      state.isPaused = true;
      state.isStreaming = false;

      if (state.abortController) {
        state.abortController.abort();
        state.abortController = null;
      }

      // Fully leave voice so the SRTP context is torn down cleanly.
      // Resume will rejoin with a fresh context.
      try { streamer.stopStream(); } catch { /* ignore */ }
      try { streamer.leaveVoice(); } catch { /* ignore */ }
      state.isInVoice = false;

      if (notifier) notifier.pause(seekSeconds).catch(() => {});
      console.log(`[stream] Paused at ${seekSeconds.toFixed(1)}s`);
      return true;
    },

    async resume(voiceChannel: VoiceChannel): Promise<boolean> {
      if (!state.isPaused || !state.pause) return false;

      const { filePath, isTempFile, seekSeconds } = state.pause;

      state.isPaused = false;
      state.isStreaming = true;

      console.log(`[stream] Resuming from ${seekSeconds.toFixed(1)}s`);

      if (notifier) notifier.resume(seekSeconds).catch(() => {});

      // isInVoice is already false (we left on pause), so joinVoice
      // goes straight to joining without the leave+wait cycle
      const joined = await joinVoice(voiceChannel);
      if (!joined) {
        state.isStreaming = false;
        state.isPaused = true;
        return false;
      }

      const completed = await playFile(filePath, isTempFile, seekSeconds);

      if (!state.isPaused) {
        if (isTempFile && filePath !== state.loopTempFile) {
          cleanupTempFile();
        }
        state.pause = null;

        if (completed && state.isStreaming && !isTempFile && state.queue) {
          if (state.loopTrack) {
            await playNext(state.queue);
          } else {
            await playNext(advance(state.queue));
          }
        } else if (completed && state.isStreaming && isTempFile && state.loopTrack && state.loopTempFile) {
          // Loop YouTube video from start
          const completed2 = await playFile(state.loopTempFile, true);
          if (!completed2 || !state.loopTrack) {
            cleanupLoopTempFile();
            state.isStreaming = false;
          }
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
      cleanupLoopTempFile();

      state.isStreaming = false;
      state.isPaused = false;
      state.loopTrack = false;
      state.loopQueue = false;
      state.queue = null;
      state.pause = null;
      state.currentUrl = null;

      if (notifier) notifier.stop();

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

      // Skipping always breaks out of track loop
      state.loopTrack = false;

      cleanupTempFile();
      // Keep loopTempFile if loopQueue is on and it's a YouTube video
      if (!state.loopQueue) cleanupLoopTempFile();

      state.pause = null;
      state.isPaused = false;

      if (!state.queue) {
        state.isStreaming = false;
        return;
      }

      const nextQueue = advance(state.queue);

      if (isEmpty(nextQueue)) {
        if (state.loopQueue) {
          state.isStreaming = true;
          playNext({ files: state.queue.files, currentIndex: 0 }).catch((err) => {
            console.error('[stream] Loop queue restart error:', err);
            state.isStreaming = false;
          });
        } else {
          state.isStreaming = false;
          state.queue = null;
          console.log('[stream] Queue complete after skip.');
        }
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
