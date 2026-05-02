import * as fs from 'fs';
import * as path from 'path';

export const SUPPORTED_EXTENSIONS = ['.mp4', '.mkv', '.mov', '.avi', '.webm'] as const;

export interface VideoQueue {
  files: string[];       // absolute paths, sorted case-insensitively
  currentIndex: number;
}

/**
 * Builds a VideoQueue by discovering all supported video files in the given folder.
 * Uses non-recursive directory listing, filters by supported extensions (case-insensitive),
 * sorts filenames case-insensitively, and returns absolute paths.
 */
export function buildQueue(videoFolder: string): VideoQueue {
  const entries = fs.readdirSync(videoFolder, { withFileTypes: true });

  const files = entries
    .filter((entry) => {
      // Only include files (not directories or other non-file entries)
      if (!entry.isFile()) {
        return false;
      }
      const ext = path.extname(entry.name).toLowerCase();
      return (SUPPORTED_EXTENSIONS as readonly string[]).includes(ext);
    })
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .map((filename) => path.join(videoFolder, filename));

  return { files, currentIndex: 0 };
}

/**
 * Returns the current file path, or null if the queue is exhausted.
 */
export function currentFile(queue: VideoQueue): string | null {
  if (queue.currentIndex >= queue.files.length) {
    return null;
  }
  return queue.files[queue.currentIndex];
}

/**
 * Returns a new VideoQueue with currentIndex advanced by 1 (immutable-style).
 */
export function advance(queue: VideoQueue): VideoQueue {
  return { files: queue.files, currentIndex: queue.currentIndex + 1 };
}

/**
 * Returns true when the queue contains no files.
 */
export function isEmpty(queue: VideoQueue): boolean {
  return queue.files.length === 0;
}
