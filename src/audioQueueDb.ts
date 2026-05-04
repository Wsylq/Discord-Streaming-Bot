/**
 * Persistent audio queue with pre-download support.
 *
 * Schema:
 *   audio_queue(id, url, title, duration, artist, cached_file, download_status,
 *               added_at, position)
 *
 * download_status: 'pending' | 'downloading' | 'ready' | 'failed'
 * cached_file: local path to downloaded audio file (null until ready)
 */

import * as fs from 'fs';
import { getDb } from './db';

export type DownloadStatus = 'pending' | 'downloading' | 'ready' | 'failed';

export interface AudioQueueItem {
  id: number;
  url: string;
  title: string;
  duration: string;
  artist: string;
  cachedFile: string | null;
  downloadStatus: DownloadStatus;
  addedAt: number;
  position: number;
}

/** Raw SQLite row shape for audio_queue. */
interface AudioQueueRow {
  id: number;
  url: string;
  title: string;
  duration: string;
  artist: string;
  cached_file: string | null;
  download_status: string;
  added_at: number;
  position: number;
}

function nextPosition(): number {
  const row = getDb().prepare('SELECT MAX(position) as m FROM audio_queue').get() as { m: number | null };
  return (row.m ?? 0) + 1;
}

export function audioEnqueue(item: Pick<AudioQueueItem, 'url' | 'title' | 'duration' | 'artist'>): AudioQueueItem {
  const db = getDb();
  const pos = nextPosition();
  const now = Date.now();
  const result = db.prepare(
    `INSERT INTO audio_queue (url, title, duration, artist, cached_file, download_status, added_at, position)
     VALUES (?, ?, ?, ?, NULL, 'pending', ?, ?)`,
  ).run(item.url, item.title, item.duration, item.artist, now, pos);

  return {
    id: result.lastInsertRowid as number,
    ...item,
    cachedFile: null,
    downloadStatus: 'pending',
    addedAt: now,
    position: pos,
  };
}

export function audioDequeue(): AudioQueueItem | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM audio_queue ORDER BY position ASC LIMIT 1').get() as AudioQueueRow | undefined;
  if (!row) return null;
  db.prepare('DELETE FROM audio_queue WHERE id = ?').run(row.id);
  return mapRow(row);
}

export function audioPeek(): AudioQueueItem | null {
  const row = getDb().prepare('SELECT * FROM audio_queue ORDER BY position ASC LIMIT 1').get() as AudioQueueRow | undefined;
  return row ? mapRow(row) : null;
}

export function audioGetAll(): AudioQueueItem[] {
  return (getDb().prepare('SELECT * FROM audio_queue ORDER BY position ASC').all() as AudioQueueRow[]).map(mapRow);
}

export function audioGetPending(): AudioQueueItem[] {
  return (getDb()
    .prepare(`SELECT * FROM audio_queue WHERE download_status = 'pending' ORDER BY position ASC`)
    .all() as AudioQueueRow[]).map(mapRow);
}

export function audioSetDownloading(id: number): void {
  getDb().prepare(`UPDATE audio_queue SET download_status = 'downloading' WHERE id = ?`).run(id);
}

export function audioSetReady(id: number, cachedFile: string): void {
  getDb().prepare(`UPDATE audio_queue SET download_status = 'ready', cached_file = ? WHERE id = ?`).run(cachedFile, id);
}

/**
 * Marks an item as failed and removes it from the queue immediately.
 * The cached file (if any partial download exists) is deleted.
 * Returns the item's title so the caller can notify the user.
 */
export function audioSetFailed(id: number): string | null {
  const row = getDb().prepare('SELECT title, cached_file FROM audio_queue WHERE id = ?').get(id) as
    | Pick<AudioQueueRow, 'title' | 'cached_file'>
    | undefined;

  if (!row) return null;

  // Clean up any partial download
  if (row.cached_file) {
    fs.unlink(row.cached_file, () => {});
  }

  // Remove the failed item from the queue entirely
  getDb().prepare('DELETE FROM audio_queue WHERE id = ?').run(id);

  return row.title || null;
}

export function audioRemoveById(id: number): boolean {
  const row = getDb().prepare('SELECT cached_file FROM audio_queue WHERE id = ?').get(id) as
    | Pick<AudioQueueRow, 'cached_file'>
    | undefined;
  if (row?.cached_file) {
    fs.unlink(row.cached_file, () => {});
  }
  const result = getDb().prepare('DELETE FROM audio_queue WHERE id = ?').run(id);
  return result.changes > 0;
}

export function audioRemoveByPosition(pos: number): boolean {
  const all = audioGetAll();
  if (pos < 1 || pos > all.length) return false;
  return audioRemoveById(all[pos - 1].id);
}

export function audioClearQueue(): number {
  const all = audioGetAll();
  for (const item of all) {
    if (item.cachedFile) fs.unlink(item.cachedFile, () => {});
  }
  const result = getDb().prepare('DELETE FROM audio_queue').run();
  return result.changes;
}

export function audioQueueLength(): number {
  const row = getDb().prepare('SELECT COUNT(*) as c FROM audio_queue').get() as { c: number };
  return row.c;
}

function mapRow(row: AudioQueueRow): AudioQueueItem {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    duration: row.duration,
    artist: row.artist,
    cachedFile: row.cached_file ?? null,
    downloadStatus: row.download_status as DownloadStatus,
    addedAt: row.added_at,
    position: row.position,
  };
}
