// Swift parser tests — sample-based.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStackFrames, detectLanguage } from '../../parser.js';

const samplesDir = join(dirname(fileURLToPath(import.meta.url)), 'samples');
const HINT = 'swift';

const CASES: Record<string, { n: number; file: string; line: number | null; func: string; sev: string[] }> = {
  'crash.txt': { n: 3, file: 'GameScene.swift', line: 42, func: 'GameScene.update(_:)', sev: ['trigger', 'source', 'framework'] },
  'thread.txt': { n: 2, file: '', line: null, func: '0x104d2e1a0', sev: ['trigger', 'framework'] },
};

for (const [name, exp] of Object.entries(CASES)) {
  test(`parses ${name}`, () => {
    const text = readFileSync(join(samplesDir, name), 'utf8');
    const frames = parseStackFrames(text, HINT);
    assert.equal(frames.length, exp.n);
    assert.equal(frames[0].language, 'swift');
    assert.equal(frames[0].file_path, exp.file);
    assert.equal(frames[0].line_number, exp.line);
    assert.equal(frames[0].function_name, exp.func);
    assert.deepEqual(frames.map(f => f.severity), exp.sev);
  });
}

test('detects via runtime hint', () => {
  const text = readFileSync(join(samplesDir, 'crash.txt'), 'utf8');
  assert.equal(detectLanguage(text, HINT), 'swift');
});

test('auto-detects Apple crash report without hint', () => {
  const text = readFileSync(join(samplesDir, 'crash.txt'), 'utf8');
  assert.equal(detectLanguage(text, ''), 'swift');
});
