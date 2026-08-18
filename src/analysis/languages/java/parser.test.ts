// Java / Kotlin parser tests — sample-based.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStackFrames, detectLanguage } from '../../parser.js';

const samplesDir = join(dirname(fileURLToPath(import.meta.url)), 'samples');
const HINT = 'java';

const CASES: Record<string, { n: number; file: string; line: number | null; func: string; sev: string[] }> = {
  'java.txt': { n: 3, file: 'UserService.java', line: 42, func: 'getDisplayName', sev: ['trigger', 'source', 'framework'] },
  'kotlin.txt': { n: 2, file: 'MainActivity.kt', line: 25, func: 'onCreate', sev: ['trigger', 'source'] },
};

for (const [name, exp] of Object.entries(CASES)) {
  test(`parses ${name}`, () => {
    const text = readFileSync(join(samplesDir, name), 'utf8');
    const frames = parseStackFrames(text, HINT);
    assert.equal(frames.length, exp.n);
    assert.equal(frames[0].language, 'java');
    assert.equal(frames[0].file_path, exp.file);
    assert.equal(frames[0].line_number, exp.line);
    assert.equal(frames[0].function_name, exp.func);
    assert.deepEqual(frames.map(f => f.severity), exp.sev);
  });
}

test('detects via runtime hint (java / kotlin)', () => {
  const text = readFileSync(join(samplesDir, 'kotlin.txt'), 'utf8');
  assert.equal(detectLanguage(text, 'kotlin'), 'kotlin');
});

test('auto-detects Java stack without hint', () => {
  const text = readFileSync(join(samplesDir, 'java.txt'), 'utf8');
  assert.equal(detectLanguage(text, ''), 'java');
});
