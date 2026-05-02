import { Encoders } from '@dank074/discord-video-stream';

const sharedX264 = {
  preset: 'ultrafast' as const,
  tune: 'zerolatency' as const,
};

// Standard quality — 360p @ 24fps
export const ENCODER_OPTIONS = {
  encoder: Encoders.software({ x264: sharedX264 }),
  width: 640,
  height: 360,
  frameRate: 24,
  bitrateVideo: 800,
  bitrateVideoMax: 1200,
  bitrateAudio: 64,
  videoCodec: 'H264' as const,
  includeAudio: true,
  hardwareAcceleratedDecoding: false,
  minimizeLatency: true,
  noTranscoding: false,
  customHeaders: {},
  // -itsoffset delays the input by 200ms, which means video frames get
  // PTS values 200ms higher than audio — Discord plays video 200ms later.
  // This compensates for video frames being larger and arriving at Discord
  // after the smaller audio frames.
  // Tune: video still ahead → increase to 0.3 | audio now ahead → decrease to 0.1
  customInputOptions: ['-itsoffset', '0.2'],
  customFfmpegFlags: [
    '-af', 'aresample=async=1000',
    '-vsync', 'cfr',
    '-g', '48',
  ],
};

// Low quality fallback — 240p @ 15fps for slow machines or poor upload
// Usage: import { ENCODER_OPTIONS_LOW_QUALITY as ENCODER_OPTIONS } from './encoderOptions'
export const ENCODER_OPTIONS_LOW_QUALITY = {
  encoder: Encoders.software({ x264: sharedX264 }),
  width: 426,
  height: 240,
  frameRate: 15,
  bitrateVideo: 400,
  bitrateVideoMax: 600,
  bitrateAudio: 48,
  videoCodec: 'H264' as const,
  includeAudio: true,
  hardwareAcceleratedDecoding: false,
  minimizeLatency: true,
  noTranscoding: false,
  customHeaders: {},
  customInputOptions: [],
  customFfmpegFlags: [
    '-af', 'aresample=async=1000',
    '-vsync', 'cfr',
    '-g', '30',
  ],
};
