import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { buildSnapshotModel } from '../code-model/index.js';
import type { AnalysisSourceSnapshot, AnalysisSourceFile, StackFrame } from '../../../types.js';
import { analyzePythonRootCause } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const sampleAppDir = join(here, '..', 'samples', 'sample_app');

function loadSampleApp(): AnalysisSourceSnapshot {
  const files: AnalysisSourceFile[] = readdirSync(sampleAppDir, { recursive: true })
    .filter(name => typeof name === 'string' && name.endsWith('.py'))
    .map(name => ({
      relative_path: name,
      language: 'python',
      content: readFileSync(join(sampleAppDir, name), 'utf-8'),
    }));
  return {
    project_name: 'sample_app',
    requested_release: '',
    snapshot_release: '',
    snapshot_id: 1,
    match_type: 'exact',
    files,
  };
}

function frame(
  filePath: string,
  lineNumber: number,
  functionName: string,
  severity: StackFrame['severity'] = 'trigger'
): StackFrame {
  return {
    index: 0,
    language: 'python',
    file_path: filePath,
    line_number: lineNumber,
    column_number: null,
    function_name: functionName,
    module_name: '',
    address: '',
    raw_line: '',
    severity,
  };
}

test('AttributeError on None points at the None-returning callee, not the crash line', () => {
  const model = buildSnapshotModel(loadSampleApp());
  const frames: StackFrame[] = [
    frame('app.py', 12, 'main', 'trigger'),
    frame('app.py', 10, 'main', 'propagation'),
    frame('app.py', 16, '<module>', 'source'),
  ];
  const candidates = analyzePythonRootCause(model, frames, {
    type: 'AttributeError',
    message: "'NoneType' object has no attribute 'name'",
  });

  assert.ok(candidates.length > 0, 'candidates found');
  const top = candidates[0];
  assert.equal(top.kind, 'none-return');
  assert.equal(top.file_path, 'services/user_service.py');
  assert.equal(top.line_number, 14); // the 'return None' line
  assert.equal(top.function_name, 'get_user');
  assert.ok(top.confidence >= 0.8, `confidence ${top.confidence}`);
  assert.ok(top.reason.includes('return None'), 'reason cites the None return');
});

test('RecursionError reports the call-graph cycle', () => {
  const model = buildSnapshotModel(loadSampleApp());
  const candidates = analyzePythonRootCause(model, [frame('utils/validators.py', 6, 'validate_depth')], {
    type: 'RecursionError',
    message: 'maximum recursion depth exceeded',
  });

  assert.ok(candidates.length > 0);
  const top = candidates[0];
  assert.equal(top.kind, 'recursion');
  assert.equal(top.function_name, 'validate_depth');
  assert.ok(top.reason.includes('validate_depth → validate_depth'), `reason: ${top.reason}`);
});

test('KeyError points at the dict construction site', () => {
  const model = buildSnapshotModel(loadSampleApp());
  const candidates = analyzePythonRootCause(model, [frame('config.py', 10, 'get_setting')], {
    type: 'KeyError',
    message: "'setting'",
  });

  assert.ok(candidates.length > 0);
  const top = candidates[0];
  assert.equal(top.kind, 'missing-key');
  assert.equal(top.file_path, 'config.py');
  assert.equal(top.line_number, 3); // SETTINGS = {...}
  assert.ok(top.reason.includes("'setting'"), `reason: ${top.reason}`);
});

test('NameError suggests the nearest defined name (typo)', () => {
  const source = [
    'from config import SETTINGS',
    '',
    'def run():',
    "    return SETTTINGS['host']",
  ].join('\n');
  const snapshot: AnalysisSourceSnapshot = {
    project_name: 'typo_app',
    requested_release: '',
    snapshot_release: '',
    snapshot_id: 1,
    match_type: 'exact',
    files: [{ relative_path: 'run.py', language: 'python', content: source }],
  };
  const model = buildSnapshotModel(snapshot);
  const candidates = analyzePythonRootCause(model, [frame('run.py', 4, 'run')], {
    type: 'NameError',
    message: "name 'SETTTINGS' is not defined",
  });

  assert.ok(candidates.length > 0);
  const top = candidates[0];
  assert.equal(top.kind, 'undefined-name');
  assert.ok(top.reason.includes("did you mean 'SETTINGS'"), `reason: ${top.reason}`);
  assert.equal(top.line_number, 1); // the import line that defines SETTINGS
});

test('unknown exception types fall back to a generic candidate', () => {
  const model = buildSnapshotModel(loadSampleApp());
  const candidates = analyzePythonRootCause(
    model,
    [frame('app.py', 12, 'main', 'trigger'), frame('app.py', 16, '<module>', 'source')],
    { type: 'RuntimeError', message: 'something broke' }
  );

  assert.ok(candidates.length > 0);
  assert.equal(candidates[0].kind, 'generic');
  assert.ok(candidates[0].confidence < 0.8, 'generic candidates keep low confidence');
});

test('crash outside any known function still produces candidates', () => {
  const model = buildSnapshotModel(loadSampleApp());
  const candidates = analyzePythonRootCause(model, [frame('app.py', 6, '<module>')], {
    type: 'AttributeError',
    message: "'NoneType' object has no attribute 'name'",
  });
  assert.ok(candidates.length > 0);
  assert.equal(candidates[0].kind, 'generic');
});
