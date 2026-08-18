// C# / Unity parser tests — sample-based.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStackFrames, detectLanguage } from '../../parser.js';

const samplesDir = join(dirname(fileURLToPath(import.meta.url)), 'samples');
const HINT = 'unity';

const CASES: Record<string, { n: number; file: string; line: number | null; func: string; sev: string[] }> = {
  'dotnet-console.txt': { n: 3, file: 'src/Program.cs', line: 42, func: 'ProcessData', sev: ['trigger', 'propagation', 'source'] },
  'unity-nullref.txt': { n: 4, file: '', line: 0, func: 'Update', sev: ['trigger', 'propagation', 'propagation', 'source'] },
  'unity-simple.txt': { n: 2, file: '', line: null, func: 'Update', sev: ['trigger', 'source'] },
};

for (const [name, exp] of Object.entries(CASES)) {
  test(`parses ${name}`, () => {
    const text = readFileSync(join(samplesDir, name), 'utf8');
    const frames = parseStackFrames(text, HINT);
    assert.equal(frames.length, exp.n);
    assert.equal(frames[0].language, 'csharp');
    assert.equal(frames[0].file_path, exp.file);
    assert.equal(frames[0].line_number, exp.line);
    assert.equal(frames[0].function_name, exp.func);
    assert.deepEqual(frames.map(f => f.severity), exp.sev);
  });
}

test('detects via runtime hint', () => {
  const text = readFileSync(join(samplesDir, 'unity-simple.txt'), 'utf8');
  assert.equal(detectLanguage(text, HINT), 'csharp');
});

test('auto-detects Unity stack without hint', () => {
  const text = readFileSync(join(samplesDir, 'unity-nullref.txt'), 'utf8');
  assert.equal(detectLanguage(text, ''), 'csharp');
});
