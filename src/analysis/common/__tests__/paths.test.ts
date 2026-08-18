// normalizePath / extractModuleFromPath tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePath, extractModuleFromPath } from '../paths.js';

test('normalizePath strips /app/ prefix', () => {
  assert.equal(normalizePath('/app/src/worker.py'), 'src/worker.py');
});

test('normalizePath strips /home/ prefix', () => {
  assert.equal(normalizePath('/home/runner/work/app/src/Program.cs'), 'src/Program.cs');
});

test('normalizePath converts backslashes and strips build prefix', () => {
  assert.equal(normalizePath('C:\\build\\Assets\\Scripts\\GameManager.cs'), 'Assets/Scripts/GameManager.cs');
});

test('normalizePath strips Unity angle-bracket paths', () => {
  assert.equal(normalizePath('<8f2c3a1d4b5e6f7a8b9c0d1e2f3a4b5c>'), '');
});

test('normalizePath handles file:// URLs', () => {
  assert.equal(normalizePath('file:///app/src/index.js'), 'src/index.js');
});

test('normalizePath keeps relative paths', () => {
  assert.equal(normalizePath('src/game/board.rs'), 'src/game/board.rs');
});

test('normalizePath returns empty for empty input', () => {
  assert.equal(normalizePath(''), '');
});

test('extractModuleFromPath uses parent/file', () => {
  assert.equal(extractModuleFromPath('/app/src/worker.py'), 'src/worker');
});

test('extractModuleFromPath falls back to filename', () => {
  assert.equal(extractModuleFromPath('main.go'), 'main');
});

test('extractModuleFromPath returns empty for empty input', () => {
  assert.equal(extractModuleFromPath(''), '');
});
