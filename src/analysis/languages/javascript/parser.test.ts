// JavaScript / TypeScript / Node / Browser parser tests — sample-based.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStackFrames, detectLanguage } from '../../parser.js';

const samplesDir = join(dirname(fileURLToPath(import.meta.url)), 'samples');
const HINT = 'node';

const CASES: Record<string, { n: number; file: string; line: number | null; func: string; sev: string[] }> = {
  'browser.txt': { n: 2, file: 'https://example.com/static/js/app.js', line: 120, func: '<anonymous>', sev: ['framework', 'trigger'] },
  'node.txt': { n: 3, file: 'src/services/order.js', line: 42, func: 'processOrders', sev: ['trigger', 'source', 'framework'] },
  'webpack.txt': { n: 2, file: 'https://cdn.example.com/static/js/chunk-vendors.js', line: 1, func: '<anonymous>', sev: ['framework', 'trigger'] },
};

for (const [name, exp] of Object.entries(CASES)) {
  test(`parses ${name}`, () => {
    const text = readFileSync(join(samplesDir, name), 'utf8');
    const frames = parseStackFrames(text, HINT);
    assert.equal(frames.length, exp.n);
    assert.equal(frames[0].language, 'javascript');
    assert.equal(frames[0].file_path, exp.file);
    assert.equal(frames[0].line_number, exp.line);
    assert.equal(frames[0].function_name, exp.func);
    assert.deepEqual(frames.map(f => f.severity), exp.sev);
  });
}

test('detects via runtime hint (node / browser / typescript)', () => {
  const text = readFileSync(join(samplesDir, 'node.txt'), 'utf8');
  assert.equal(detectLanguage(text, 'node'), 'node');
  assert.equal(detectLanguage(text, 'browser'), 'browser');
  assert.equal(detectLanguage(text, 'typescript'), 'typescript');
});

test('auto-detects Node stack without hint', () => {
  const text = readFileSync(join(samplesDir, 'node.txt'), 'utf8');
  assert.equal(detectLanguage(text, ''), 'javascript');
});
