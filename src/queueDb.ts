/**
 * Persistent video queue backed by SQLite (better-sqlite3).
 *
 * Schema:
 *   queue_items(id INTEGER PK, url TEXT, title TEXT, duration TEXT, channel TEXT,
 *               added_at INTEGER, position INTEGER)
 *
 * "position" is a monotonically increasing integer used for ordering.
 * Items are removed after they finish playing.
 */

import { getDb } from './db';

export interface QueueItem {
  id: number;
  url: string;
  title: string;
  duration: string;
  channel: string;
  addedAt: number;
  position: number;
}

/** Raw SQLite row shape for queue_items. */
interface QueueRow {
  id: number;
  url: string;
  title: string;
  duration: string;
  channel: string;
  added_at: number;
  position: number;
}

function nextPosition(): number {
  const row = getDb().prepare('SELECT MAX(position) as m FROM queue_items').get() as { m: number | null };
  return (row.m ?? 0) + 1;
}

export function enqueue(item: Omit<QueueItem, 'id' | 'addedAt' | 'position'>): QueueItem {
  const db = getDb();
  const pos = nextPosition();
  const now = Date.now();
  const result = db.prepare(
    'INSERT INTO queue_items (url, title, duration, channel, added_at, position) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(item.url, item.title, item.duration, item.channel, now, pos);

  return { id: result.lastInsertRowid as number, ...item, addedAt: now, position: pos };
}

export function dequeue(): QueueItem | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM queue_items ORDER BY position ASC LIMIT 1').get() as QueueRow | undefined;
  if (!row) return null;
  db.prepare('DELETE FROM queue_items WHERE id = ?').run(row.id);
  return mapRow(row);
}

export function peek(): QueueItem | null {
  const row = getDb().prepare('SELECT * FROM queue_items ORDER BY position ASC LIMIT 1').get() as QueueRow | undefined;
  return row ? mapRow(row) : null;
}

export function getAll(): QueueItem[] {
  return (getDb().prepare('SELECT * FROM queue_items ORDER BY position ASC').all() as QueueRow[]).map(mapRow);
}

export function removeById(id: number): boolean {
  const result = getDb().prepare('DELETE FROM queue_items WHERE id = ?').run(id);
  return result.changes > 0;
}

export function removeByPosition(pos: number): boolean {
  const all = getAll();
  if (pos < 1 || pos > all.length) return false;
  return removeById(all[pos - 1].id);
}

export function clearQueue(): number {
  const result = getDb().prepare('DELETE FROM queue_items').run();
  return result.changes;
}

export function queueLength(): number {
  const row = getDb().prepare('SELECT COUNT(*) as c FROM queue_items').get() as { c: number };
  return row.c;
}

function mapRow(row: QueueRow): QueueItem {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    duration: row.duration,
    channel: row.channel,
    addedAt: row.added_at,
    position: row.position,
  };
}
