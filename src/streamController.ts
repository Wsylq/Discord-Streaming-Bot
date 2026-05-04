import type { TextChannel, VoiceChannel } from 'discord.js-selfbot-v13';
import { prepareStream, playStream } from '@dank074/discord-video-stream';
import type { Streamer } from '@dank074/discord-video-stream';
import { advance, currentFile, isEmpty } from './videoQueue';
import type { VideoQueue } from './videoQueue';
import type { StreamController } from './commandHandler';
import { ENCODER_OPTIONS } from './encoderOptions';
import { downloadYouTubeVideo, deleteTempFile, type DownloadProgress } from './youtubePlayer';
import { downloadAudio, deleteAudioFile, isSpotifyUrl, resolveSpotifyTracks, searchYouTubeMusic } from './audioMode';
import { audioDequeue, audioEnqueue, audioGetAll, audioQueueLength, type AudioQueueItem } from './audioQueueDb';
import type { AudioQueueDisplay } from './audioQueueDisplay';
import { fetchVideoMeta, type WebhookNotifier } from './webhookNotifier';
import { dequeue, enqueue, type QueueItem } from './queueDb';
import type { QueueDisplay } from './queueDisplay';

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
  audioMode: boolean;
  loopTrack: boolean;
  loopQueue: boolean;
  loopAudioTrack: boolean;   // loop current audio track
  loopAudioQueue: boolean;   // loop entire audio queue
  audioQueueHistory: Array<{ url: string; title: string; duration: string; artist: string }>;
  abortController: AbortController | null;
  queue: VideoQueue | null;
  pause: PauseState | null;
  loopTempFile: string | null;
  loopUrl: string | null;
  // For audio loop: keep the cached audio file and URL
  loopAudioFile: string | null;
  loopAudioUrl: string | null;
  voiceChannel: VoiceChannel | null;
  currentUrl: string | null;
}

export function createStreamController(
  streamer: Streamer,
  notifier: WebhookNotifier | null = null,
  queueDisplay: QueueDisplay | null = null,
  audioQueueDisplay: AudioQueueDisplay | null = null,
): StreamController {
  const state: StreamState = {
    isStreaming: false,
    isPaused: false,
    isInVoice: false,
    audioMode: false,
    loopTrack: false,
    loopQueue: false,
    loopAudioTrack: false,
    loopAudioQueue: false,
    audioQueueHistory: [],
    abortController: null,
    queue: null,
    pause: null,
    loopTempFile: null,
    loopUrl: null,
    loopAudioFile: null,
    loopAudioUrl: null,
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

  /**
   * Plays an already-dequeued audio item, using its cached file if available.
   * Avoids re-downloading when the pre-downloader already fetched it.
   */
  async function playAudioFromItem(
    item: AudioQueueItem,
    textChannel: TextChannel,
  ): Promise<void> {
    if (!state.voiceChannel) return;
    if (item.cachedFile && item.downloadStatus === 'ready') {
      // File is pre-downloaded — play it directly without going through
      // the full playAudio resolution/download flow
      state.isStreaming = true;
      state.isPaused = false;
      const abort = new AbortController();
      state.abortController = abort;

      const audioFile = item.cachedFile;
      state.loopAudioFile = audioFile;
      state.loopAudioUrl = item.url;

      console.log(`[audio] Playing pre-downloaded: ${item.title}`);
      // Record to history for queue loop
      if (state.loopAudioQueue) {
        state.audioQueueHistory.push({ url: item.url, title: item.title, duration: item.duration, artist: item.artist });
      }
      state.pause = { filePath: audioFile, isTempFile: false, seekSeconds: 0, startedAt: Date.now(), baseSeconds: 0 };

      try {
        const { PassThrough } = await import('stream');
        const { spawn: spawnFfmpeg } = await import('child_process');
        const ffmpegBin = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
        const output = new PassThrough();
        const ffmpegArgs = [
          '-i', audioFile,
          '-f', 'lavfi', '-i', 'color=c=black:s=2x2:r=1',
          '-map', '0:a:0', '-map', '1:v:0',
          '-c:a', 'libopus', '-b:a', '320k', '-ar', '48000', '-ac', '2',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
          '-b:v', '10k', '-r', '1', '-pix_fmt', 'yuv420p',
          '-shortest', '-f', 'nut', 'pipe:1',
        ];
        const ffmpegProc = spawnFfmpeg(ffmpegBin, ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
        ffmpegProc.stdout?.pipe(output);
        ffmpegProc.stderr?.on('data', (chunk: Buffer) => {
          const msg = chunk.toString().trim();
          if (msg && !msg.includes('frame=') && !msg.includes('size=')) console.error('[ffmpeg audio]', msg.split('\n')[0]);
        });
        abort.signal.addEventListener('abort', () => { ffmpegProc.kill('SIGKILL'); }, { once: true });
        const ffmpegDone = new Promise<void>((res) => { ffmpegProc.on('close', () => res()); ffmpegProc.on('error', () => res()); });

        await playStream(output, streamer, { type: 'camera', readrateInitialBurst: 10 }, abort.signal);
        if (state.pause) state.pause = { ...state.pause, startedAt: Date.now() };
        await ffmpegDone;
      } catch (err: unknown) {
        if (!(err instanceof Error && (err.name === 'AbortError' || err.message?.includes('aborted')))) {
          console.error('[audio] Stream error:', err);
        }
      }

      if (!state.isPaused) {
        state.pause = null;
        state.isStreaming = false;
        state.abortController = null;
        if (state.loopAudioTrack && state.voiceChannel) {
          await new Promise(r => setTimeout(r, 800));
          await joinVoice(state.voiceChannel);
          await playAudioFromItem(item, textChannel);
          return;
        }
        if (!state.loopAudioTrack) {
          state.loopAudioFile = null;
          state.loopAudioUrl = null;
        }
        const nextItem = audioDequeue();
        if (nextItem && state.voiceChannel) {
          if (audioQueueDisplay) audioQueueDisplay.refresh().catch(() => {});
          try { await textChannel.send(`🎵 Next up: **${nextItem.title}**`); } catch { /* ignore */ }
          // Rejoin for fresh SRTP context between tracks
          await new Promise(r => setTimeout(r, 800));
          await joinVoice(state.voiceChannel);
          await playAudioFromItem(nextItem, textChannel);
        } else if (state.loopAudioQueue && state.audioQueueHistory.length > 0 && state.voiceChannel) {
          console.log(`[audio] Queue loop (item): re-queueing ${state.audioQueueHistory.length} tracks.`);
          for (const h of state.audioQueueHistory) audioEnqueue(h);
          state.audioQueueHistory = [];
          if (audioQueueDisplay) audioQueueDisplay.refresh().catch(() => {});
          const first = audioDequeue();
          if (first) {
            try { await textChannel.send(`🔁 Looping queue — **${first.title}**`); } catch { /* ignore */ }
            await new Promise(r => setTimeout(r, 800));
            await joinVoice(state.voiceChannel);
            await playAudioFromItem(first, textChannel);
          }
        } else {
          try { await textChannel.send('✅ Audio finished. Queue is empty.'); } catch { /* ignore */ }
        }
      }
    } else {
      // Not pre-downloaded — fall back to normal playAudio
      await controller.playAudio(state.voiceChannel, item.url, textChannel);
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
              // Auto-play next item from persistent queue
              const next = dequeue();
              if (next && state.voiceChannel) {
                if (queueDisplay) queueDisplay.refresh().catch(() => {});
                console.log(`[queue] Auto-playing next: ${next.title}`);
                try { await textChannel.send(`▶️ Next up: **${next.title}**`); } catch { /* ignore */ }
                state.isStreaming = false; // reset so playUrl can run
                await controller.playUrl(state.voiceChannel, next.url, textChannel);
              } else {
                try { await textChannel.send('✅ Done. Queue is empty.'); } catch { /* ignore */ }
              }
            }
          }
        }
      };

      await playLoop();
    },

    async playFromQueue(voiceChannel: VoiceChannel, textChannel: TextChannel): Promise<boolean> {
      const next = dequeue();
      if (!next) return false;
      if (queueDisplay) queueDisplay.refresh().catch(() => {});
      await controller.playUrl(voiceChannel, next.url, textChannel);
      return true;
    },

    async playAudio(voiceChannel: VoiceChannel, url: string, textChannel: TextChannel): Promise<void> {
      if (state.isStreaming) return;

      const joined = await joinVoice(voiceChannel);
      if (!joined) return;

      state.isStreaming = true;
      state.isPaused = false;

      const abort = new AbortController();
      state.abortController = abort;

      // Resolve Spotify → YouTube Music via yt-dlp (no API key needed)
      let resolvedUrl = url;
      if (isSpotifyUrl(url)) {
        try {
          await textChannel.send('🎵 Resolving Spotify track...');
          const tracks = await resolveSpotifyTracks(url, abort.signal);
          if (tracks.length === 0) throw new Error('No tracks found');

          if (tracks.length === 1) {
            await textChannel.send(`🔍 Searching for **${tracks[0].searchQuery}**...`);
            const result = await searchYouTubeMusic(tracks[0].searchQuery, abort.signal);
            resolvedUrl = result.url;
          } else {
            // Album/playlist — enqueue rest, play first
            await textChannel.send(`📀 Found **${tracks.length} tracks**. Queueing...`);
            for (let i = 1; i < tracks.length; i++) {
              const result = await searchYouTubeMusic(tracks[i].searchQuery, abort.signal).catch(() => null);
              if (result) audioEnqueue({ url: result.url, title: tracks[i].title, duration: result.duration, artist: tracks[i].artist });
            }
            if (audioQueueDisplay) audioQueueDisplay.refresh().catch(() => {});
            const first = await searchYouTubeMusic(tracks[0].searchQuery, abort.signal);
            resolvedUrl = first.url;
          }
        } catch (err: unknown) {
          state.isStreaming = false;
          const msg = err instanceof Error ? err.message : 'Unknown error';
          try { await textChannel.send(`❌ Spotify error: ${msg}`); } catch { /* ignore */ }
          return;
        }
      }

      // Check audio queue for a pre-downloaded file for this URL
      let audioFile: string;
      let ownFile = true;
      const allAudio = audioGetAll();
      const preloaded = allAudio.find(i => i.url === resolvedUrl && i.downloadStatus === 'ready' && i.cachedFile);
      if (preloaded?.cachedFile) {
        audioFile = preloaded.cachedFile;
        ownFile = false;
        console.log(`[audio] Using pre-downloaded file for: ${preloaded.title}`);
      } else if (state.loopAudioFile && state.loopAudioUrl === resolvedUrl) {
        // Reuse loop-cached file
        audioFile = state.loopAudioFile;
        ownFile = false;
        console.log(`[audio] Reusing loop-cached file.`);
      } else {
        // Download now
        try {
          await textChannel.send('⬇️ Downloading audio...');
          audioFile = await downloadAudio(
            resolvedUrl,
            (p) => console.log(`[audio] ${p.percent.toFixed(1)}% at ${p.speed} ETA ${p.eta}`),
            abort.signal,
          );
        } catch (err: unknown) {
          state.isStreaming = false;
          if (err instanceof Error && err.message?.includes('aborted')) return;
          console.error('[audio] Download error:', err);
          try { await textChannel.send('❌ Audio download failed.'); } catch { /* ignore */ }
          return;
        }
      }

      if (abort.signal.aborted || !state.isStreaming) {
        if (ownFile) deleteAudioFile(audioFile);
        return;
      }

      // Cache audio file for loop reuse
      if (ownFile) {
        state.loopAudioFile = audioFile;
        state.loopAudioUrl = resolvedUrl;
      }

      // Record to history for queue loop
      if (state.loopAudioQueue) {
        // Only add if not already in history (avoid duplicates when looping)
        const alreadyInHistory = state.audioQueueHistory.some(h => h.url === resolvedUrl);
        if (!alreadyInHistory) {
          state.audioQueueHistory.push({ url: resolvedUrl, title: resolvedUrl, duration: '?', artist: '' });
        }
      }

      console.log(`[audio] Playing: ${audioFile}`);
      try { await textChannel.send('🎵 Now playing audio...'); } catch { /* ignore */ }

      state.pause = { filePath: audioFile, isTempFile: true, seekSeconds: 0, startedAt: Date.now(), baseSeconds: 0 };

      try {
        const { PassThrough } = await import('stream');
        const { spawn: spawnFfmpeg } = await import('child_process');

        const ffmpegBin = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
        const output = new PassThrough();

        const ffmpegArgs = [
          '-i', audioFile,
          '-f', 'lavfi', '-i', 'color=c=black:s=2x2:r=1',
          '-map', '0:a:0',
          '-map', '1:v:0',
          '-c:a', 'libopus', '-b:a', '320k', '-ar', '48000', '-ac', '2',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
          '-b:v', '10k', '-r', '1', '-pix_fmt', 'yuv420p',
          '-shortest',
          '-f', 'nut', 'pipe:1',
        ];

        const ffmpegProc = spawnFfmpeg(ffmpegBin, ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
        ffmpegProc.stdout?.pipe(output);
        ffmpegProc.stderr?.on('data', (chunk: Buffer) => {
          const msg = chunk.toString().trim();
          if (msg && !msg.includes('frame=') && !msg.includes('size=')) console.error('[ffmpeg audio]', msg.split('\n')[0]);
        });
        abort.signal.addEventListener('abort', () => { ffmpegProc.kill('SIGKILL'); }, { once: true });
        const ffmpegDone = new Promise<void>((res) => { ffmpegProc.on('close', () => res()); ffmpegProc.on('error', () => res()); });

        await playStream(output, streamer, { type: 'camera', readrateInitialBurst: 10 }, abort.signal);
        if (state.pause) state.pause = { ...state.pause, startedAt: Date.now() };
        await ffmpegDone;
      } catch (err: unknown) {
        if (!(err instanceof Error && (err.name === 'AbortError' || err.message?.includes('aborted')))) {
          console.error('[audio] Stream error:', err);
        }
      } finally {
        // Only delete if not keeping for loop
        if (ownFile && !state.loopAudioTrack) deleteAudioFile(audioFile);
      }

      if (!state.isPaused) {
        state.pause = null;
        state.isStreaming = false;
        state.abortController = null;

        if (state.loopAudioTrack && state.loopAudioFile && state.voiceChannel) {
          // Loop current track — rejoin for fresh SRTP, reuse cached file
          console.log('[audio] Loop track: replaying.');
          await new Promise(r => setTimeout(r, 800));
          const rejoined = await joinVoice(state.voiceChannel);
          if (rejoined) {
            await controller.playAudio(state.voiceChannel, state.loopAudioUrl ?? resolvedUrl, textChannel);
          } else {
            state.isStreaming = false;
          }
          return;
        }

        // Clean up audio file now that we're done looping
        if (ownFile && state.loopAudioFile === audioFile) {
          deleteAudioFile(audioFile);
          state.loopAudioFile = null;
          state.loopAudioUrl = null;
        }

        // Auto-play next from audio queue
        const next = audioDequeue();
        if (next && state.voiceChannel) {
          if (audioQueueDisplay) audioQueueDisplay.refresh().catch(() => {});
          try { await textChannel.send(`🎵 Next up: **${next.title}**`); } catch { /* ignore */ }
          await playAudioFromItem(next, textChannel);
        } else if (state.loopAudioQueue && state.audioQueueHistory.length > 0 && state.voiceChannel) {
          // Re-enqueue everything from history and restart
          console.log(`[audio] Queue loop: re-queueing ${state.audioQueueHistory.length} tracks.`);
          for (const item of state.audioQueueHistory) {
            audioEnqueue(item);
          }
          state.audioQueueHistory = [];
          if (audioQueueDisplay) audioQueueDisplay.refresh().catch(() => {});
          const first = audioDequeue();
          if (first) {
            try { await textChannel.send(`🔁 Looping queue — **${first.title}**`); } catch { /* ignore */ }
            await playAudioFromItem(first, textChannel);
          }
        } else {
          try { await textChannel.send('✅ Audio finished. Queue is empty.'); } catch { /* ignore */ }
        }
      }
    },

    toggleAudioMode(): boolean {
      state.audioMode = !state.audioMode;
      console.log(`[stream] Audio mode: ${state.audioMode}`);
      return state.audioMode;
    },

    get audioMode() { return state.audioMode; },

    toggleLoopAudioTrack(): boolean {
      state.loopAudioTrack = !state.loopAudioTrack;
      if (state.loopAudioTrack) state.loopAudioQueue = false;
      console.log(`[stream] Loop audio track: ${state.loopAudioTrack}`);
      return state.loopAudioTrack;
    },

    toggleLoopAudioQueue(): boolean {
      state.loopAudioQueue = !state.loopAudioQueue;
      if (state.loopAudioQueue) {
        state.loopAudioTrack = false;
        // Snapshot current queue into history so already-queued songs get looped too.
        // Also include the currently playing track (it's been dequeued already but is
        // still playing — without this it gets lost from the loop on the first cycle).
        const { audioGetAll } = require('./audioQueueDb');
        const current = audioGetAll() as Array<{ url: string; title: string; duration: string; artist: string }>;
        const history: Array<{ url: string; title: string; duration: string; artist: string }> = [];
        // Prepend the currently playing track if there is one
        if (state.loopAudioUrl) {
          history.push({
            url: state.loopAudioUrl,
            title: state.loopAudioFile ? (state.loopAudioUrl) : state.loopAudioUrl,
            duration: '?',
            artist: '',
          });
        }
        for (const i of current) {
          history.push({ url: i.url, title: i.title, duration: i.duration, artist: i.artist });
        }
        state.audioQueueHistory = history;
        console.log(`[stream] Loop audio queue ON — snapshotted ${state.audioQueueHistory.length} tracks (including current).`);
      } else {
        state.audioQueueHistory = [];
        console.log('[stream] Loop audio queue OFF.');
      }
      return state.loopAudioQueue;
    },

    get loopAudioTrack() { return state.loopAudioTrack; },
    get loopAudioQueue() { return state.loopAudioQueue; },

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
      state.loopAudioTrack = false;
      state.loopAudioQueue = false;
      state.audioQueueHistory = [];
      state.queue = null;
      state.pause = null;
      state.currentUrl = null;
      // Clean up audio loop cache
      if (state.loopAudioFile) {
        deleteAudioFile(state.loopAudioFile);
        state.loopAudioFile = null;
        state.loopAudioUrl = null;
      }

      if (notifier) notifier.stop();

      if (state.isInVoice) {
        try { streamer.stopStream(); } catch { /* ignore */ }
        streamer.leaveVoice();
        state.isInVoice = false;
        console.log('[stream] Stopped and left voice channel.');
      }
    },

    async skip(textChannel?: TextChannel): Promise<void> {
      if (!state.isStreaming && !state.isPaused) return;

      if (state.abortController) {
        state.abortController.abort();
        state.abortController = null;
      }

      // Skipping always breaks out of track loop
      state.loopTrack = false;

      cleanupTempFile();
      if (!state.loopQueue) cleanupLoopTempFile();

      state.pause = null;
      state.isPaused = false;

      // Helper: try to play next from DB queue
      const tryDbQueue = async (): Promise<boolean> => {
        if (!textChannel || !state.voiceChannel) {
          console.log(`[queue] tryDbQueue skipped: textChannel=${!!textChannel} voiceChannel=${!!state.voiceChannel}`);
          return false;
        }
        const next = dequeue();
        if (!next) return false;
        if (queueDisplay) queueDisplay.refresh().catch(() => {});
        console.log(`[queue] Skip → playing next from queue: ${next.title}`);
        try { await textChannel.send(`▶️ Next up: **${next.title}**`); } catch { /* ignore */ }
        // Brief wait for the aborted stream to fully clean up
        await new Promise(r => setTimeout(r, 300));
        await controller.playUrl(state.voiceChannel, next.url, textChannel);
        return true;
      };

      // If no local file queue, check DB queue
      if (!state.queue) {
        state.isStreaming = false;
        await tryDbQueue();
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
          // Local queue exhausted — try DB queue
          const played = await tryDbQueue();
          if (!played) console.log('[stream] Queue complete after skip.');
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
