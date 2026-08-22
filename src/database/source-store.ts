import { getDb } from './connection.js';
import type { SourceFile } from '../model.js';

// ----- Source file dedup queries -----

export function getSourceFileById(id: number): SourceFile | undefined {
  return getDb().prepare('SELECT * FROM source_files WHERE id = ?').get(id) as SourceFile | undefined;
}

// Latest stored version of a path within a project (across all snapshots).
export function getLatestSourceFileForPath(projectId: number, relativePath: string): SourceFile | undefined {
  return getDb().prepare(`
    SELECT sf.* FROM source_files sf
    JOIN source_snapshots ss ON ss.id = sf.snapshot_id
    WHERE ss.project_id = ? AND sf.relative_path = ?
    ORDER BY sf.id DESC LIMIT 1
  `).get(projectId, relativePath) as SourceFile | undefined;
}

// Current state of a project's sources: the latest row (by id) for each
// relative_path across all of the project's snapshots. This is what source
// matching reads, so changed files are matched by their new content while
// unchanged files from older snapshots stay part of the state.
export function getCurrentSourceFilesForProject(projectId: number, containerId?: number | null): SourceFile[] {
  const scope = containerId === undefined ? '' : containerId === null ? ' AND ss.container_id IS NULL' : ' AND ss.container_id = ?';
  const innerScope = containerId === undefined ? '' : containerId === null ? ' AND ss2.container_id IS NULL' : ' AND ss2.container_id = ?';
  const scopeParams = containerId === undefined ? [] : containerId === null ? [] : [containerId];
  return getDb().prepare(`
    SELECT sf.* FROM source_files sf
    JOIN source_snapshots ss ON ss.id = sf.snapshot_id
    WHERE ss.project_id = ?${scope}
      AND sf.id = (
        SELECT MAX(sf2.id) FROM source_files sf2
        JOIN source_snapshots ss2 ON ss2.id = sf2.snapshot_id
        WHERE ss2.project_id = ? AND sf2.relative_path = sf.relative_path${innerScope}
      )
    ORDER BY sf.relative_path
  `).all(projectId, ...scopeParams, projectId, ...scopeParams) as SourceFile[];
}

export function listSourceFileRows(): SourceFile[] {
  return getDb().prepare('SELECT * FROM source_files ORDER BY id').all() as SourceFile[];
}

export function listSourceFileChildren(parentFileId: number): SourceFile[] {
  return getDb().prepare('SELECT * FROM source_files WHERE parent_file_id = ?').all(parentFileId) as SourceFile[];
}

// Writes full content to disk for a row and detaches it from its patch chain.
export function updateSourceFileContent(
  id: number,
  storagePath: string,
  contentHash: string
): void {
  getDb().prepare(
    "UPDATE source_files SET storage_path = ?, content_hash = ?, parent_file_id = NULL, patch = '' WHERE id = ?"
  ).run(storagePath, contentHash, id);
}

export function backfillSourceFileHash(id: number, contentHash: string): void {
  getDb().prepare('UPDATE source_files SET content_hash = ? WHERE id = ?').run(contentHash, id);
}

export function deleteSourceFileRow(id: number): void {
  getDb().prepare('DELETE FROM source_files WHERE id = ?').run(id);
}

// Groups of (project, relative_path, content_hash) stored more than once.
export function listDuplicateSourceGroups(): Array<{ project_id: number; relative_path: string; content_hash: string; count: number }> {
  return getDb().prepare(`
    SELECT ss.project_id, sf.relative_path, sf.content_hash, COUNT(*) AS count
    FROM source_files sf
    JOIN source_snapshots ss ON ss.id = sf.snapshot_id
    WHERE sf.content_hash != ''
    GROUP BY ss.project_id, sf.relative_path, sf.content_hash
    HAVING COUNT(*) > 1
  `).all() as Array<{ project_id: number; relative_path: string; content_hash: string; count: number }>;
}

export function listSourceFilesInGroup(projectId: number, relativePath: string, contentHash: string): SourceFile[] {
  return getDb().prepare(`
    SELECT sf.* FROM source_files sf
    JOIN source_snapshots ss ON ss.id = sf.snapshot_id
    WHERE ss.project_id = ? AND sf.relative_path = ? AND sf.content_hash = ?
    ORDER BY sf.id
  `).all(projectId, relativePath, contentHash) as SourceFile[];
}
