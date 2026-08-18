// Dart / Flutter parser tests — sample-based.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStackFrames, detectLanguage } from '../../parser.js';

const samplesDir = join(dirname(fileURLToPath(import.meta.url)), 'samples');
const HINT = 'dart';

const CASES: Record<string, { n: number; file: string; line: number | null; func: string; sev: string[] }> = {
  'flutter.txt': { n: 3, file: 'renderer.dart', line: 42, func: 'render', sev: ['trigger', 'propagation', 'source'] },
  'plain.txt': { n: 2, file: 'screens/home.dart', line: 42, func: 'build', sev: ['trigger', 'source'] },
};

for (const [name, exp] of Object.entries(CASES)) {
  test(`parses ${name}`, () => {
    const text = readFileSync(join(samplesDir, name), 'utf8');
    const frames = parseStackFrames(text, HINT);
    assert.equal(frames.length, exp.n);
    assert.equal(frames[0].language, 'dart');
    assert.equal(frames[0].file_path, exp.file);
    assert.equal(frames[0].line_number, exp.line);
    assert.equal(frames[0].function_name, exp.func);
    assert.deepEqual(frames.map(f => f.severity), exp.sev);
  });
}

test('detects via runtime hint (dart / flutter)', () => {
  const text = readFileSync(join(samplesDir, 'flutter.txt'), 'utf8');
  assert.equal(detectLanguage(text, 'flutter'), 'dart');
});

test('auto-detects package: stack without hint', () => {
  const text = readFileSync(join(samplesDir, 'plain.txt'), 'utf8');
  assert.equal(detectLanguage(text, ''), 'dart');
});
