import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Env must be set before the config/database modules are imported.
const dataDir = mkdtempSync(join(tmpdir(), 'source-store-'));
process.env.DATA_DIR = dataDir;
process.env.DB_PATH = ':memory:';
process.env.SOURCES_DIR = join(dataDir, 'sources');

const { computeContentHash } = await import('../source.js');
const { initDb, closeDb, getDb } = await import('./connection.js');
const { getOrCreateProject, createSourceSnapshot, createSourceFile } = await import('./store.js');
const { getLatestSourceFileForPath, getCurrentSourceFilesForProject } = await import('./source-store.js');

after(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

test('getCurrentSourceFilesForProject returns the latest row per path across snapshots', () => {
  initDb();
  try {
    const now = new Date().toISOString();
    const project = getOrCreateProject('dedup-proj', now, null);

    const a1 = Buffer.from('line1\nline2\n');
    const b = Buffer.from('b content\n');
    const snapshot1 = createSourceSnapshot(project.id, 'r1', now, null);
    createSourceFile(snapshot1.id, 'src/a.txt', '', a1.length, 'text', computeContentHash(a1));
    createSourceFile(snapshot1.id, 'src/b.txt', '', b.length, 'text', computeContentHash(b));

    const a2 = Buffer.from('line1\nline2 changed\n');
    const c = Buffer.from('c content\n');
    const snapshot2 = createSourceSnapshot(project.id, 'r2', now, null);
    createSourceFile(snapshot2.id, 'src/a.txt', '', a2.length, 'text', computeContentHash(a2));
    createSourceFile(snapshot2.id, 'src/c.txt', '', c.length, 'text', computeContentHash(c));

    const current = getCurrentSourceFilesForProject(project.id);
    assert.deepEqual(
      current.map(file => file.relative_path),
      ['src/a.txt', 'src/b.txt', 'src/c.txt']
    );
    // The changed file resolves to its newest version.
    const currentA = current.find(file => file.relative_path === 'src/a.txt');
    assert.ok(currentA);
    assert.equal(currentA.content_hash, computeContentHash(a2));

    const latestA = getLatestSourceFileForPath(project.id, 'src/a.txt');
    assert.ok(latestA);
    assert.equal(latestA.content_hash, computeContentHash(a2));
    assert.equal(latestA.id, currentA.id);
  } finally {
    closeDb();
  }
});

test('container scope filters the current state', () => {
  initDb();
  try {
    const now = new Date().toISOString();
    const containerless = getOrCreateProject('scoped-proj', now, null);
    const s1 = createSourceSnapshot(containerless.id, '', now, null);
    createSourceFile(s1.id, 'src/only.txt', '', 4, 'text', computeContentHash(Buffer.from('only')));

    const containerId = 7;
    getDb().prepare("INSERT INTO containers (id, name) VALUES (?, 'test-container')").run(containerId);
    const contained = getOrCreateProject('other-proj', now, containerId);
    const s2 = createSourceSnapshot(contained.id, '', now, containerId);
    createSourceFile(s2.id, 'src/other.txt', '', 5, 'text', computeContentHash(Buffer.from('other')));

    assert.deepEqual(
      getCurrentSourceFilesForProject(containerless.id, null).map(file => file.relative_path),
      ['src/only.txt']
    );
    assert.deepEqual(
      getCurrentSourceFilesForProject(contained.id, 7).map(file => file.relative_path),
      ['src/other.txt']
    );
    assert.deepEqual(getCurrentSourceFilesForProject(contained.id, null), []);
    assert.equal(getCurrentSourceFilesForProject(containerless.id).length, 1);
  } finally {
    closeDb();
  }
});
