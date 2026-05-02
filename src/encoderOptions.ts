import { Encoders } from '@dank074/discord-video-stream';

export const ENCODER_OPTIONS = {
  encoder: Encoders.software({ x264: { preset: 'superfast' } }),
  width: 1280,
  height: 720,
  frameRate: 30,
  bitrateVideo: 2500,
  bitrateVideoMax: 5000,
  bitrateAudio: 128,
  videoCodec: 'H264' as const,
  includeAudio: true,
  hardwareAcceleratedDecoding: false,
  minimizeLatency: false,
  noTranscoding: false,
  customHeaders: {},
  customInputOptions: [],
  customFfmpegFlags: [],
};
