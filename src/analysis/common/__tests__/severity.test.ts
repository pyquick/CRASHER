// Severity classification tests (framework vs user code).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StackFrame } from '../../types.js';
import { classifySeverity } from '../severity.js';

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

test('marks first user frame trigger and last user frame source', () => {
  const frames = [
    frame({ index: 0, module_name: 'app.controller', function_name: 'list', file_path: 'src/a.js' }),
    frame({ index: 1, module_name: 'app.service', function_name: 'run', file_path: 'src/b.js' }),
    frame({ index: 2, module_name: 'app.main', function_name: 'start', file_path: 'src/c.js' }),
  ];
  classifySeverity(frames, 'javascript');
  assert.deepEqual(frames.map(f => f.severity), ['trigger', 'propagation', 'source']);
});

test('marks node:internal frames as framework', () => {
  const frames = [
    frame({ index: 0, module_name: 'app.controller', function_name: 'list', file_path: 'src/a.js' }),
    frame({ index: 1, function_name: 'processTicksAndRejections', file_path: 'node:internal/process/task_queues' }),
  ];
  classifySeverity(frames, 'node');
  assert.deepEqual(frames.map(f => f.severity), ['trigger', 'framework']);
});

test('all-framework stack marks first frame trigger', () => {
  const frames = [
    frame({ index: 0, function_name: 'processTicksAndRejections', file_path: 'node:internal/process/task_queues' }),
    frame({ index: 1, function_name: 'emit', file_path: 'node:internal/events' }),
  ];
  classifySeverity(frames, 'node');
  assert.deepEqual(frames.map(f => f.severity), ['trigger', 'framework']);
});

test('unknown language has no framework patterns', () => {
  const frames = [
    frame({ index: 0, module_name: 'a', function_name: 'b', file_path: 'x.js' }),
    frame({ index: 1, module_name: 'c', function_name: 'd', file_path: 'y.js' }),
  ];
  classifySeverity(frames, 'unknown');
  assert.deepEqual(frames.map(f => f.severity), ['trigger', 'source']);
});

test('empty frame list is a no-op', () => {
  const frames: StackFrame[] = [];
  classifySeverity(frames, 'javascript');
  assert.equal(frames.length, 0);
});
