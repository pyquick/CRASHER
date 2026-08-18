// PHP parser tests — sample-based.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStackFrames, detectLanguage } from '../../parser.js';

const samplesDir = join(dirname(fileURLToPath(import.meta.url)), 'samples');
const HINT = 'php';

const CASES: Record<string, { n: number; file: string; line: number | null; func: string; sev: string[] }> = {
  'fatal.txt': { n: 4, file: 'Calculator.php', line: 42, func: 'divide(10, 0)', sev: ['trigger', 'propagation', 'source', 'framework'] },
  'simple.txt': { n: 2, file: 'src/init.php', line: 12, func: 'setup()', sev: ['trigger', 'source'] },
};

for (const [name, exp] of Object.entries(CASES)) {
  test(`parses ${name}`, () => {
    const text = readFileSync(join(samplesDir, name), 'utf8');
    const frames = parseStackFrames(text, HINT);
    assert.equal(frames.length, exp.n);
    assert.equal(frames[0].language, 'php');
    assert.equal(frames[0].file_path, exp.file);
    assert.equal(frames[0].line_number, exp.line);
    assert.equal(frames[0].function_name, exp.func);
    assert.deepEqual(frames.map(f => f.severity), exp.sev);
  });
}

test('detects via runtime hint', () => {
  const text = readFileSync(join(samplesDir, 'fatal.txt'), 'utf8');
  assert.equal(detectLanguage(text, HINT), 'php');
});

test('auto-detects PHP fatal error without hint', () => {
  const text = readFileSync(join(samplesDir, 'fatal.txt'), 'utf8');
  assert.equal(detectLanguage(text, ''), 'php');
});
