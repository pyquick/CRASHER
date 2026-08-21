import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { config } from '../config.js';
import * as store from '../store.js';
import { applyLinePatch, computeContentHash, type LinePatch } from '../source.js';
import type { SourceFile } from '../model.js';

const MAX_PATCH_DEPTH = 100;
// Only remove orphan disk files that are at least this old, so files from
// in-flight uploads are never collected mid-write.
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

// Materializes the full content of a source file row by walking its patch
// chain back to the base file on disk. Verifies the content hash when set.
export function readSourceFileContent(file: SourceFile): string {
  const chain: SourceFile[] = [];
  let current: SourceFile | undefined = file;
  let depth = 0;
  while (current && current.patch && current.parent_file_id !== null && depth < MAX_PATCH_DEPTH) {
    chain.push(current);
    current = store.getSourceFileById(current.parent_file_id);
    depth++;
  }
  if (!current || !current.storage_path) {
    throw new Error(`Source file ${file.id} has no base content on disk`);
  }
  let text = readFileSync(current.storage_path, 'utf-8');
  for (const link of chain.reverse()) {
    text = applyLinePatch(text, JSON.parse(link.patch) as LinePatch);
  }
  if (file.content_hash && computeContentHash(Buffer.from(text, 'utf-8')) !== file.content_hash) {
    throw new Error(`Source file ${file.id} content hash mismatch (corrupt patch chain)`);
  }
  return text;
}

// Non-throwing variant: returns null when the content cannot be materialized
// (missing base file, corrupt patch, etc.) so callers can fall back to
// storing full content.
export function tryReadSourceFileContent(file: SourceFile): string | null {
  try {
    return readSourceFileContent(file);
  } catch {
    return null;
  }
}

// Writes the full content of a patch row to disk and detaches it from its
// parent chain.
function materializeSourceFile(file: SourceFile): void {
  const content = readSourceFileContent(file);
  const storagePath = join(config.sourcesDir, `${randomBytes(16).toString('hex')}.src`);
  writeFileSync(storagePath, content, { flag: 'wx' });
  store.updateSourceFileContent(file.id, storagePath, computeContentHash(Buffer.from(content, 'utf-8')));
}

// Deletes a source file row, materializing any patch rows that reference it
// first so no chain is left dangling.
function removeSourceFileRow(row: SourceFile): void {
  for (const child of store.listSourceFileChildren(row.id)) {
    materializeSourceFile(child);
  }
  if (row.storage_path) {
    try { if (existsSync(row.storage_path)) unlinkSync(row.storage_path); } catch {}
  }
  store.deleteSourceFileRow(row.id);
}

export interface SweepStats {
  hashes_backfilled: number;
  duplicates_removed: number;
  disk_files_removed: number;
  orphans_removed: number;
}

// Deduplication sweep: backfill missing hashes, drop exact duplicate rows
// per (project, path, content), and collect orphaned disk files.
export function sweepSourceDuplicates(): SweepStats {
  const stats: SweepStats = {
    hashes_backfilled: 0,
    duplicates_removed: 0,
    disk_files_removed: 0,
    orphans_removed: 0,
  };

  for (const row of store.listSourceFileRows()) {
    if (row.content_hash || !row.storage_path) continue;
    try {
      store.backfillSourceFileHash(row.id, computeContentHash(readFileSync(row.storage_path)));
      stats.hashes_backfilled++;
    } catch {
      // Unreadable file: leave hash empty so it stays excluded from dedup.
    }
  }

  for (const group of store.listDuplicateSourceGroups()) {
    try {
      const rows = store.listSourceFilesInGroup(group.project_id, group.relative_path, group.content_hash);
      // Rows are ordered by id ascending; keep the newest copy.
      for (const row of rows.slice(0, -1)) {
        if (row.storage_path) stats.disk_files_removed++;
        removeSourceFileRow(row);
        stats.duplicates_removed++;
      }
    } catch (err) {
      console.error(`[dedup] skipping ${group.relative_path}:`, err);
    }
  }

  const referenced = new Set(
    store.listSourceFileRows().filter(r => r.storage_path).map(r => r.storage_path)
  );
  let entries: string[] = [];
  try { entries = readdirSync(config.sourcesDir); } catch { return stats; }
  for (const name of entries) {
    if (!name.endsWith('.src')) continue;
    const full = join(config.sourcesDir, name);
    if (referenced.has(full)) continue;
    try {
      if (statSync(full).mtimeMs > Date.now() - ORPHAN_MIN_AGE_MS) continue;
      unlinkSync(full);
      stats.orphans_removed++;
    } catch {}
  }
  return stats;
}
