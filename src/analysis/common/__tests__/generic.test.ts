// Generic fallback parser and log extraction tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGeneric, extractGenericStackFrames } from '../generic.js';

test('parseGeneric parses at-func format', () => {
  const frames = parseGeneric(['at runTask (build/worker.js:42:15)', 'at main (build/index.js:10:3)']);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].function_name, 'runTask');
  assert.equal(frames[0].file_path, 'build/worker.js');
  assert.equal(frames[0].line_number, 42);
  assert.equal(frames[0].column_number, 15);
});

test('parseGeneric parses #N php format', () => {
  const frames = parseGeneric(['#0 /app/src/init.php(12): setup()']);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].file_path, 'src/init.php');
  assert.equal(frames[0].line_number, 12);
});

test('parseGeneric includes unparseable lines as-is', () => {
  const frames = parseGeneric(['some random line']);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].function_name, 'some random line');
});

test('parseGeneric skips empty lines', () => {
  assert.equal(parseGeneric(['', '   ']).length, 0);
});

test('extractGenericStackFrames collects frame-looking lines', () => {
  const log = [
    'INFO server started',
    '    at runTask (/app/src/task.js:42:15)',
    'ERROR boom',
    '0x00007f8a2b3c4d5e',
    'nothing here',
  ].join('\n');
  const extracted = extractGenericStackFrames(log);
  assert.ok(extracted.includes('at runTask'));
  assert.ok(extracted.includes('0x00007f8a2b3c4d5e'));
  assert.ok(!extracted.includes('server started'));
  assert.ok(!extracted.includes('nothing here'));
});
