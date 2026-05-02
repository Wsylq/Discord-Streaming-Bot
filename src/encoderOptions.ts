import { Encoders } from '@dank074/discord-video-stream';

export const ENCODER_OPTIONS = {
  encoder: Encoders.software({
    x264: {
      preset: 'ultrafast',
      tune: 'zerolatency',
    },
  }),
  // 240p @ 15fps — absolute minimum for watchable video
  width: 426,
  height: 240,
  frameRate: 15,
  // Very low bitrate to fit within upload constraints
  bitrateVideo: 400,
  bitrateVideoMax: 600,
  bitrateAudio: 48,
  videoCodec: 'H264' as const,
  includeAudio: true,
  hardwareAcceleratedDecoding: false,
  minimizeLatency: false,
  noTranscoding: false,
  customHeaders: {},
  customInputOptions: [],
  customFfmpegFlags: [
    // Audio delay removed — at this low bitrate both should send in time
    '-af', 'aresample=async=1000',
    // Keyframe every 2s
    '-g', '30',
  ],
};
