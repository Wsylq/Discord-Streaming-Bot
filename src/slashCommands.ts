import type { ApplicationCommandData } from 'discord.js';

// ── Commands always available regardless of audio mode ────────────────────────
const SHARED_COMMANDS: ApplicationCommandData[] = [
  { name: 'help', type: 1, description: 'Show available commands' },
  { name: 'np', type: 1, description: 'Show what is currently playing' },
  { name: 'audio-mode', type: 1, description: 'Toggle audio-only mode' },
  { name: 'pause', type: 1, description: 'Pause the stream' },
  { name: 'resume', type: 1, description: 'Resume the stream' },
  { name: 'stop', type: 1, description: 'Stop and leave voice' },
  { name: 'skip', type: 1, description: 'Skip to next in queue' },
];

// ── Video streaming commands (shown when audio mode is OFF) ───────────────────
const VIDEO_COMMANDS: ApplicationCommandData[] = [
  { name: 'start', type: 1, description: 'Start streaming local video queue' },
  {
    name: 'play',
    type: 1,
    description: 'Play a YouTube URL',
    options: [{ name: 'url', type: 3, description: 'YouTube URL', required: true }],
  },
  {
    name: 'search',
    type: 1,
    description: 'Search YouTube and play top result',
    options: [{ name: 'query', type: 3, description: 'Search query', required: true }],
  },
  {
    name: 'search-pick',
    type: 1,
    description: 'Search YouTube and pick from top 5',
    options: [{ name: 'query', type: 3, description: 'Search query', required: true }],
  },
  {
    name: 'search-channel',
    type: 1,
    description: "Browse a YouTube channel's videos",
    options: [{ name: 'name', type: 3, description: 'Channel name', required: true }],
  },
  {
    name: 'pick',
    type: 1,
    description: 'Pick from pending search results',
    options: [{ name: 'number', type: 4, description: 'Result number', required: true }],
  },
  { name: 'loop', type: 1, description: 'Toggle loop current video track' },
  { name: 'loopqueue', type: 1, description: 'Toggle loop entire video queue' },
  { name: 'queue', type: 1, description: 'Show video queue' },
  {
    name: 'queue-add',
    type: 1,
    description: 'Add a YouTube URL to the video queue',
    options: [{ name: 'url', type: 3, description: 'YouTube URL', required: true }],
  },
  { name: 'queue-play', type: 1, description: 'Play from video queue' },
  { name: 'queue-clear', type: 1, description: 'Clear the video queue' },
];

// ── Audio-only commands (shown when audio mode is ON) ─────────────────────────
const AUDIO_COMMANDS: ApplicationCommandData[] = [
  {
    name: 'audio',
    type: 1,
    description: 'Play audio from a URL',
    options: [{ name: 'url', type: 3, description: 'Audio URL', required: true }],
  },
  {
    name: 'music-search',
    type: 1,
    description: 'Search and play as audio',
    options: [{ name: 'query', type: 3, description: 'Search query', required: true }],
  },
  {
    name: 'music-search-pick',
    type: 1,
    description: 'Search and pick from top 5 as audio',
    options: [{ name: 'query', type: 3, description: 'Search query', required: true }],
  },
  {
    name: 'pick',
    type: 1,
    description: 'Pick from pending search results',
    options: [{ name: 'number', type: 4, description: 'Result number', required: true }],
  },
  { name: 'loop-audio', type: 1, description: 'Toggle loop current audio track' },
  { name: 'loop-audio-queue', type: 1, description: 'Toggle loop entire audio queue' },
  { name: 'aq', type: 1, description: 'Show audio queue' },
  {
    name: 'aq-remove',
    type: 1,
    description: 'Remove item from audio queue',
    options: [{ name: 'number', type: 4, description: 'Item number', required: true }],
  },
  { name: 'aq-clear', type: 1, description: 'Clear the audio queue' },
];

/**
 * Returns the slash command list appropriate for the current audio mode.
 * audioMode = false → shared + video commands
 * audioMode = true  → shared + audio commands
 */
export function getSlashCommands(audioMode: boolean): ApplicationCommandData[] {
  return audioMode
    ? [...SHARED_COMMANDS, ...AUDIO_COMMANDS]
    : [...SHARED_COMMANDS, ...VIDEO_COMMANDS];
}

// Legacy export — full list used for tests and initial registration fallback
export const SLASH_COMMANDS: ApplicationCommandData[] = [
  ...SHARED_COMMANDS,
  ...VIDEO_COMMANDS,
  // Include audio-only commands too so the test suite can verify all 26 names
  ...AUDIO_COMMANDS.filter(c => !VIDEO_COMMANDS.some(v => v.name === c.name)),
];
