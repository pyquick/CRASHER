// Python parser tests — sample-based.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStackFrames, detectLanguage } from '../../parser.js';

const samplesDir = join(dirname(fileURLToPath(import.meta.url)), 'samples');
const HINT = 'python';

const CASES: Record<string, { n: number; file: string; line: number | null; func: string; sev: string[] }> = {
  'pytest.txt': { n: 1, file: 'tests/test_api.py', line: 15, func: 'test_login', sev: ['trigger'] },
  'traceback.txt': { n: 4, file: 'lib/python3.11/json/decoder.py', line: 337, func: 'decode', sev: ['framework', 'framework', 'trigger', 'source'] },
};

for (const [name, exp] of Object.entries(CASES)) {
  test(`parses ${name}`, () => {
    const text = readFileSync(join(samplesDir, name), 'utf8');
    const frames = parseStackFrames(text, HINT);
    assert.equal(frames.length, exp.n);
    assert.equal(frames[0].language, 'python');
    assert.equal(frames[0].file_path, exp.file);
    assert.equal(frames[0].line_number, exp.line);
    assert.equal(frames[0].function_name, exp.func);
    assert.deepEqual(frames.map(f => f.severity), exp.sev);
  });
}

test('detects via runtime hint', () => {
  const text = readFileSync(join(samplesDir, 'traceback.txt'), 'utf8');
  assert.equal(detectLanguage(text, 'python3'), 'python');
});

test('auto-detects Traceback without hint', () => {
  const text = readFileSync(join(samplesDir, 'traceback.txt'), 'utf8');
  assert.equal(detectLanguage(text, ''), 'python');
});
