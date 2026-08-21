import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLinePatch,
  computeContentHash,
  computeLinePatch,
  isPatchSmall,
} from './source.js';

const CASES: Array<[string, string]> = [
  ['', ''],
  ['a\nb\nc\n', 'a\nb\nc\n'],
  ['a\nb\nc\n', 'a\nb\nc\nd\ne\n'],
  ['a\nb\nc\n', 'x\ny\na\nb\nc\n'],
  ['a\nb\nc\nd\n', 'a\nb\nX\nY\nc\nd\n'],
  ['one\ntwo\nthree\n', 'one\nchanged\nthree\n'],
  ['first\nmiddle\nlast\n', 'first\nmiddle\nlast\nfourth\n'],
  ['no trailing newline', 'no trailing newline but changed'],
  ['same\nmiddle\nend\n', 'same\nother\nmiddle\nend\n'],
  ['a\nb\nc\n', 'a\nc\n'],
  ['a\nc\n', 'a\nb\nc\n'],
];

test('computeContentHash is stable and content-sensitive', () => {
  const a = computeContentHash(Buffer.from('hello\n'));
  const b = computeContentHash(Buffer.from('hello\n'));
  const c = computeContentHash(Buffer.from('hello\nworld\n'));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 64);
});

test('computeLinePatch returns null for identical content', () => {
  for (const [oldText, newText] of CASES) {
    if (oldText === newText) assert.equal(computeLinePatch(oldText, newText), null);
  }
});

test('computeLinePatch + applyLinePatch round-trips', () => {
  for (const [oldText, newText] of CASES) {
    if (oldText === newText) continue;
    const patch = computeLinePatch(oldText, newText);
    assert.ok(patch, `expected a patch for ${JSON.stringify(newText)}`);
    assert.equal(applyLinePatch(oldText, patch), newText);
  }
});

test('applyLinePatch rejects patches that do not fit the base', () => {
  assert.throws(
    () => applyLinePatch('short\n', { prefix: 5, suffix: 0, lines: ['x'] }),
    /does not fit/
  );
});

test('isPatchSmall reflects patch size relative to new content', () => {
  const oldText = Array.from({ length: 40 }, (_, i) => `line number ${i}`).join('\n') + '\n';
  const changedLines = oldText.split('\n');
  changedLines[20] = 'line number 20 CHANGED';
  const smallNew = changedLines.join('\n');
  const largeNew = 'TOTALLY\nDIFFERENT\nCONTENT\nACROSS\n' + 'MANY\n'.repeat(60);
  const small = computeLinePatch(oldText, smallNew);
  const large = computeLinePatch(oldText, largeNew);
  assert.ok(small && isPatchSmall(small, smallNew.length));
  assert.ok(large && !isPatchSmall(large, largeNew.length));
  assert.equal(isPatchSmall({ prefix: 1, suffix: 1, lines: ['x'] }, 0), false);
});
