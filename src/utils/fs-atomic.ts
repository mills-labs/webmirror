/**
 * Atomic JSON state persistence — shared by manifest, orchestrator state,
 * run reports, index ledger, recorder flushes, and crawl checkpoints.
 *
 * Mirrors the write-tmp/fsync/rename pattern in provenance/sidecar.ts so a
 * crash mid-write never leaves a truncated JSON file in place.
 */

import { openSync, fsyncSync, writeSync, closeSync, renameSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { dirname } from 'path';

/**
 * Write `value` as pretty-printed JSON to `filePath` atomically:
 * tmp file in the same directory, fsync, rename into place.
 */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  const bytes = Buffer.from(JSON.stringify(value, null, 2), 'utf-8');

  mkdirSync(dirname(filePath), { recursive: true });

  const fd = openSync(tmpPath, 'w');
  try {
    writeSync(fd, bytes, 0, bytes.length, 0);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  renameSync(tmpPath, filePath);
}

/**
 * Write raw bytes to `filePath` atomically, using the same
 * tmp-file/fsync/rename pattern as writeJsonAtomic so a crash mid-write never
 * leaves a truncated file in place.
 */
export function writeFileAtomic(filePath: string, data: Buffer | string): void {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;

  mkdirSync(dirname(filePath), { recursive: true });

  const fd = openSync(tmpPath, 'w');
  try {
    writeSync(fd, bytes, 0, bytes.length, 0);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  renameSync(tmpPath, filePath);
}

/**
 * Read and parse a JSON state file.
 *
 * - Missing file → null (silently; a fresh state is normal).
 * - Read/parse error → the corrupt file is preserved as
 *   `<filePath>.corrupt-<ISO-ts>`, a warning is printed, and null is
 *   returned. Corruption is never silently swallowed.
 */
export function readJsonOrRecover<T>(filePath: string, label: string): T | null {
  if (!existsSync(filePath)) return null;

  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    const corruptPath = `${filePath}.corrupt-${new Date().toISOString()}`;
    try {
      renameSync(filePath, corruptPath);
      console.warn(`  WARNING: ${label} was corrupt; preserved at ${corruptPath}`);
    } catch {
      console.warn(`  WARNING: ${label} was corrupt at ${filePath} (could not preserve a copy)`);
    }
    return null;
  }
}
