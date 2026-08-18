// Elixir / Erlang parser tests — sample-based.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStackFrames, detectLanguage } from '../../parser.js';

const samplesDir = join(dirname(fileURLToPath(import.meta.url)), 'samples');
const HINT = 'elixir';

const CASES: Record<string, { n: number; file: string; line: number | null; func: string; sev: string[] }> = {
  'elixir.txt': { n: 3, file: 'lib/enum.ex', line: 2510, func: 'reduce', sev: ['trigger', 'propagation', 'source'] },
  'erlang.txt': { n: 2, file: 'lists.erl', line: 1462, func: 'do_map', sev: ['trigger', 'source'] },
};

for (const [name, exp] of Object.entries(CASES)) {
  test(`parses ${name}`, () => {
    const text = readFileSync(join(samplesDir, name), 'utf8');
    const frames = parseStackFrames(text, HINT);
    assert.equal(frames.length, exp.n);
    assert.equal(frames[0].language, 'elixir');
    assert.equal(frames[0].file_path, exp.file);
    assert.equal(frames[0].line_number, exp.line);
    assert.equal(frames[0].function_name, exp.func);
    assert.deepEqual(frames.map(f => f.severity), exp.sev);
  });
}

test('detects via runtime hint (elixir / erlang)', () => {
  const text = readFileSync(join(samplesDir, 'erlang.txt'), 'utf8');
  assert.equal(detectLanguage(text, 'erlang'), 'erlang');
  assert.equal(detectLanguage(text, 'erl'), 'erlang');
});

test('needs a runtime hint (content auto-detect not supported)', () => {
  const text = readFileSync(join(samplesDir, 'elixir.txt'), 'utf8');
  assert.equal(detectLanguage(text, ''), 'unknown');
});
