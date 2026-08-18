// Rust parser tests — sample-based.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStackFrames, detectLanguage } from '../../parser.js';

const samplesDir = join(dirname(fileURLToPath(import.meta.url)), 'samples');
const HINT = 'rust';

const CASES: Record<string, { n: number; file: string; line: number | null; func: string; sev: string[] }> = {
  'panic.txt': { n: 5, file: 'src/game/board.rs', line: 42, func: 'panic', sev: ['trigger', 'framework', 'framework', 'propagation', 'source'] },
  'thread-panic.txt': { n: 1, file: 'src/net/client.rs', line: 87, func: 'panic', sev: ['trigger'] },
};

for (const [name, exp] of Object.entries(CASES)) {
  test(`parses ${name}`, () => {
    const text = readFileSync(join(samplesDir, name), 'utf8');
    const frames = parseStackFrames(text, HINT);
    assert.equal(frames.length, exp.n);
    assert.equal(frames[0].language, 'rust');
    assert.equal(frames[0].file_path, exp.file);
    assert.equal(frames[0].line_number, exp.line);
    assert.equal(frames[0].function_name, exp.func);
    assert.deepEqual(frames.map(f => f.severity), exp.sev);
  });
}

test('detects via runtime hint', () => {
  const text = readFileSync(join(samplesDir, 'panic.txt'), 'utf8');
  assert.equal(detectLanguage(text, 'rs'), 'rust');
});

test('auto-detects panicked-at without hint', () => {
  const text = readFileSync(join(samplesDir, 'panic.txt'), 'utf8');
  assert.equal(detectLanguage(text, ''), 'rust');
});
