// Ruby parser tests — sample-based.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStackFrames, detectLanguage } from '../../parser.js';

const samplesDir = join(dirname(fileURLToPath(import.meta.url)), 'samples');
const HINT = 'ruby';

const CASES: Record<string, { n: number; file: string; line: number | null; func: string; sev: string[] }> = {
  'rails.txt': { n: 3, file: 'lib/workers/job_worker.rb', line: 42, func: 'perform', sev: ['trigger', 'propagation', 'source'] },
  'simple.txt': { n: 2, file: 'lib/job.rb', line: 42, func: 'run', sev: ['trigger', 'source'] },
};

for (const [name, exp] of Object.entries(CASES)) {
  test(`parses ${name}`, () => {
    const text = readFileSync(join(samplesDir, name), 'utf8');
    const frames = parseStackFrames(text, HINT);
    assert.equal(frames.length, exp.n);
    assert.equal(frames[0].language, 'ruby');
    assert.equal(frames[0].file_path, exp.file);
    assert.equal(frames[0].line_number, exp.line);
    assert.equal(frames[0].function_name, exp.func);
    assert.deepEqual(frames.map(f => f.severity), exp.sev);
  });
}

test('detects via runtime hint', () => {
  const text = readFileSync(join(samplesDir, 'rails.txt'), 'utf8');
  assert.equal(detectLanguage(text, 'rb'), 'ruby');
});

test('auto-detects Rails stack without hint', () => {
  const text = readFileSync(join(samplesDir, 'rails.txt'), 'utf8');
  assert.equal(detectLanguage(text, ''), 'ruby');
});
