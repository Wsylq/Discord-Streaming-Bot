// Stub for @dank074/discord-video-stream (ESM-only package)
// Used by Jest to avoid ESM parse errors in tests that don't need this module.
'use strict';

const Encoders = {
  software: jest.fn(() => ({})),
  hardware: jest.fn(() => ({})),
};

module.exports = {
  prepareStream: jest.fn(),
  playStream: jest.fn(),
  Streamer: jest.fn(),
  Encoders,
};
