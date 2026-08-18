// C++/C parser tests — sample-based.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStackFrames, detectLanguage } from '../../parser.js';

const samplesDir = join(dirname(fileURLToPath(import.meta.url)), 'samples');
const HINT = 'cpp';

const CASES: Record<string, { n: number; file: string; line: number | null; func: string; sev: string[] }> = {
  'addr.txt': { n: 2, file: '', line: null, func: '', sev: ['trigger', 'source'] },
  'gdb.txt': { n: 2, file: 'lib/libserver.so', line: null, func: 'ProcessRequest', sev: ['trigger', 'source'] },
  'windows.txt': { n: 2, file: '', line: null, func: 'Player::Update()', sev: ['trigger', 'framework'] },
};

for (const [name, exp] of Object.entries(CASES)) {
  test(`parses ${name}`, () => {
    const text = readFileSync(join(samplesDir, name), 'utf8');
    const frames = parseStackFrames(text, HINT);
    assert.equal(frames.length, exp.n);
    assert.equal(frames[0].language, 'cpp');
    assert.equal(frames[0].file_path, exp.file);
    assert.equal(frames[0].line_number, exp.line);
    assert.equal(frames[0].function_name, exp.func);
    assert.deepEqual(frames.map(f => f.severity), exp.sev);
  });
}

test('detects via runtime hint (cpp and c)', () => {
  const text = readFileSync(join(samplesDir, 'gdb.txt'), 'utf8');
  assert.equal(detectLanguage(text, 'cpp'), 'cpp');
  assert.equal(detectLanguage(text, 'c'), 'c');
});

test('auto-detects GDB backtrace without hint', () => {
  const text = readFileSync(join(samplesDir, 'gdb.txt'), 'utf8');
  assert.equal(detectLanguage(text, ''), 'cpp');
});
