/**
 * Single shared SQLite connection for all queue modules.
 * Both queueDb.ts and audioQueueDb.ts import from here so there is
 * exactly one Database instance open against queue.db at any time.
 */

import Database from 'better-sqlite3';
import { DB_PATH } from './constants';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');

    // Create both tables in one exec so the schema is always consistent
    _db.exec(`
      CREATE TABLE IF NOT EXISTS queue_items (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        url      TEXT    NOT NULL,
        title    TEXT    NOT NULL DEFAULT '',
        duration TEXT    NOT NULL DEFAULT '?',
        channel  TEXT    NOT NULL DEFAULT '',
        added_at INTEGER NOT NULL,
        position INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_position ON queue_items(position);

      CREATE TABLE IF NOT EXISTS audio_queue (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        url             TEXT    NOT NULL,
        title           TEXT    NOT NULL DEFAULT '',
        duration        TEXT    NOT NULL DEFAULT '?',
        artist          TEXT    NOT NULL DEFAULT '',
        cached_file     TEXT,
        download_status TEXT    NOT NULL DEFAULT 'pending',
        added_at        INTEGER NOT NULL,
        position        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audio_position ON audio_queue(position);
    `);
  }
  return _db;
}
