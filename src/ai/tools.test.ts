import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { computeContentHash } from '../source.js';
import type { SourceFile } from '../model.js';
import type { AiToolCall } from './types.js';

// Bash tool settings must be in place before the config-backed modules load.
process.env.AI_BASH_ENABLED = 'true';
process.env.AI_BASH_TIMEOUT_MS = '1000';
process.env.AI_BASH_MAX_OUTPUT = '1024';

const { runTool, AGENT_TOOLS } = await import('./tools.js');
import type { ToolContext } from './tools.js';

const workspace = mkdtempSync(join(tmpdir(), 'ai-bash-'));
const filesDir = mkdtempSync(join(tmpdir(), 'ai-files-'));

function fakeSource(relativePath: string, content: string, onDisk = true): SourceFile {
  const storagePath = join(filesDir, `${relativePath.replace(/\//g, '_')}.src`);
  if (onDisk) writeFileSync(storagePath, content);
  return {
    id: Math.floor(Math.random() * 1_000_000) + 1,
    snapshot_id: 1,
    relative_path: relativePath,
    storage_path: storagePath,
    file_size: content.length,
    language: 'text',
    created_at: '',
    content_hash: computeContentHash(Buffer.from(content, 'utf-8')),
    parent_file_id: null,
    patch: '',
  };
}

const sourceA = fakeSource('src/a.cs', 'line one\nline two\nline three\nline four\nline five');
const sourceB = fakeSource('src/b.cs', 'b content\n');

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    convId: 1,
    workspaceDir: workspace,
    loadSourceFiles: async () => [sourceA, sourceB],
    ...overrides,
  };
}

function call(name: string, args: unknown): AiToolCall {
  return { id: 'call-1', name, arguments: JSON.stringify(args) };
}

after(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(filesDir, { recursive: true, force: true });
});

test('AGENT_TOOLS defines all five tools with JSON schemas', () => {
  const names = AGENT_TOOLS.map(entry => (entry as { function: { name: string } }).function.name);
  assert.deepEqual(names, ['read_source_file', 'web_fetch', 'run_bash', 'update_tasks', 'spawn_subagent']);
});

test('read_source_file lists all project files', async () => {
  const result = await runTool(call('read_source_file', { list: true }), ctx());
  assert.equal(result.ok, true);
  assert.ok(result.output.includes('src/a.cs'));
  assert.ok(result.output.includes('src/b.cs'));
});

test('read_source_file reads a line range', async () => {
  const result = await runTool(call('read_source_file', { path: 'src/a.cs', start_line: 2, end_line: 4 }), ctx());
  assert.equal(result.ok, true);
  assert.ok(result.output.includes('lines 2-4 of 5'));
  assert.ok(result.output.includes('line two'));
  assert.ok(result.output.includes('line four'));
  assert.ok(!result.output.includes('line one'));
  assert.ok(!result.output.includes('line five'));
});

test('read_source_file rejects paths that are not in the database', async () => {
  const result = await runTool(call('read_source_file', { path: '/etc/passwd' }), ctx());
  assert.equal(result.ok, false);
  assert.ok(result.output.includes('File not found'));
});

test('read_source_file reports unreadable files', async () => {
  const broken = fakeSource('src/broken.cs', 'gone', false);
  const result = await runTool(call('read_source_file', { path: 'src/broken.cs' }), ctx({ loadSourceFiles: async () => [broken] }));
  assert.equal(result.ok, false);
  assert.ok(result.output.includes('could not be read'));
});

test('update_tasks validates and returns the normalized task list', async () => {
  const tasks = [
    { id: 't1', title: 'read the crashing file', status: 'in_progress', notes: 'halfway' },
    { id: 't2', title: 'check the spec', status: 'pending' },
  ];
  const result = await runTool(call('update_tasks', { tasks }), ctx());
  assert.equal(result.ok, true);
  assert.deepEqual(result.tasks, tasks);
  assert.ok(result.output.includes('[in_progress] read the crashing file'));

  const bad = await runTool(call('update_tasks', { tasks: [{ id: 't1', title: 'x', status: 'bogus' }] }), ctx());
  assert.equal(bad.ok, false);
  const notArray = await runTool(call('update_tasks', { tasks: 'nope' }), ctx());
  assert.equal(notArray.ok, false);
});

test('run_bash executes a command in the workspace', async () => {
  const result = await runTool(call('run_bash', { command: 'echo hello && pwd' }), ctx());
  assert.equal(result.ok, true);
  assert.ok(result.output.includes('hello'));
  assert.ok(result.output.includes(workspace));
});

test('run_bash reports non-zero exit codes', async () => {
  const result = await runTool(call('run_bash', { command: 'exit 3' }), ctx());
  assert.equal(result.ok, false);
  assert.ok(result.output.includes('exit code: 3'));
});

test('run_bash enforces the timeout', async () => {
  const result = await runTool(call('run_bash', { command: 'sleep 5' }), ctx());
  assert.equal(result.ok, false);
  assert.ok(result.output.includes('timed out'), result.output);
});

test('run_bash caps output size and kills the process', async () => {
  const result = await runTool(call('run_bash', { command: "yes x | head -c 5000" }), ctx());
  assert.equal(result.ok, false);
  assert.ok(result.output.includes('truncated'), result.output);
  assert.ok(result.output.length < 2048);
});
