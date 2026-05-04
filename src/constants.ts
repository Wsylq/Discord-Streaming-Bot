/**
 * Shared constants used across multiple modules.
 * Centralised here to avoid duplication and make changes in one place.
 */

import * as path from 'path';

// ─── yt-dlp binary path ───────────────────────────────────────────────────────
// Resolved from the youtube-dl-exec package's bin directory so it works
// regardless of where the project is installed.
export const YTDLP_BIN = path.join(
  path.dirname(require.resolve('youtube-dl-exec')),
  '..',
  'bin',
  process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp',
);

// ─── SQLite database path ─────────────────────────────────────────────────────
export const DB_PATH = path.join(process.cwd(), 'queue.db');

// ─── Embed footer ─────────────────────────────────────────────────────────────
export const EMBED_FOOTER = 'lossai owns all';
