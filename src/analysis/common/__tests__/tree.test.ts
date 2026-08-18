// File tree builder tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StackFrame } from '../../types.js';
import { buildFileTree, severityToColor } from '../tree.js';

function frame(overrides: Partial<StackFrame>): StackFrame {
  return {
    index: 0,
    language: 'javascript',
    file_path: '',
    line_number: null,
    column_number: null,
    function_name: '',
    module_name: '',
    address: '',
    raw_line: '',
    severity: 'unknown',
    ...overrides,
  };
}

test('builds nested tree with crash site marked', () => {
  const frames = [
    frame({ index: 0, file_path: 'src/controllers/player.js', line_number: 42, severity: 'trigger' }),
    frame({ index: 1, file_path: 'src/controllers/player.js', line_number: 10, severity: 'source' }),
    frame({ index: 2, file_path: 'src/services/order.js', line_number: 7, severity: 'propagation' }),
  ];
  const tree = buildFileTree(frames);

  assert.equal(tree.length, 1);
  assert.equal(tree[0].name, 'src');
  assert.equal(tree[0].is_file, false);

  const controllers = tree[0].children.find(n => n.name === 'controllers');
  assert.ok(controllers);
  const player = controllers?.children.find(n => n.name === 'player.js');
  assert.ok(player);
  assert.equal(player?.is_file, true);
  assert.equal(player?.is_crash_site, true);
  assert.equal(player?.line_number, 42);
  assert.equal(player?.severity, 'red');
});

test('skips frames without file paths', () => {
  const tree = buildFileTree([frame({ index: 0, file_path: '' })]);
  assert.deepEqual(tree, []);
});

test('severityToColor mapping', () => {
  assert.equal(severityToColor('trigger'), 'red');
  assert.equal(severityToColor('propagation'), 'orange');
  assert.equal(severityToColor('source'), 'yellow');
  assert.equal(severityToColor('framework'), 'gray');
  assert.equal(severityToColor('unknown'), 'gray');
});
