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

test('AttributeError with no resolvable definition produces no candidates (crash chain only)', () => {
  const model = buildSnapshotModel(loadSampleApp());
  const candidates = analyzePythonRootCause(model, [frame('app.py', 6, '<module>')], {
    type: 'AttributeError',
    message: "'NoneType' object has no attribute 'name'",
  });
  assert.deepEqual(candidates, []);
});

// ── Missing-attribute scenarios (MacBoxTool-style traceback) ──

function snapshotOf(sourceFiles: Record<string, string>): AnalysisSourceSnapshot {
  const files = Object.entries(sourceFiles).map(([relative_path, content]) => ({
    relative_path,
    language: 'python' as const,
    content,
  }));
  return {
    project_name: 'audio_app',
    requested_release: '',
    snapshot_release: '',
    snapshot_id: 1,
    match_type: 'exact',
    files,
  };
}

const AUDIO_SNAPSHOT_FILES: Record<string, string> = {
  'sys_patch/constants.py': [
    'class Constants:',
    "    audio_type = 'VoodooHDA'",
  ].join('\n'),
  'sys_patch/patchsets/hardware/audio/voodoo_audio.py': [
    'class VoodooAudio:',
    '    def __init__(self, constants):',
    '        self._constants = Constants(constants)',
    '',
    '    def present(self):',
    '        return self._constants.audio_type=="VoodooHDA" and not self._constants.voodoo_patch_already',
  ].join('\n'),
  'sys_patch/patchsets/detect.py': [
    'class HardwarePatchsetDetection:',
    '    def __init__(self, constants):',
    '        self._detect()',
    '',
    '    def _detect(self):',
    '        if VoodooAudio(None).present() is False:',
    '            pass',
  ].join('\n'),
  'qt_gui/gui_sys_patch.py': [
    'from sys_patch.patchsets.detect import HardwarePatchsetDetection',
    '',
    'class GuiSysPatch:',
    '    def run(self, constants):',
    '        patches = HardwarePatchsetDetection(constants=constants).device_properties',
  ].join('\n'),
};

function audioCrashFrames(): StackFrame[] {
  return [
    frame('sys_patch/patchsets/hardware/audio/voodoo_audio.py', 6, 'present', 'trigger'),
    frame('sys_patch/patchsets/detect.py', 6, '_detect', 'propagation'),
    frame('sys_patch/patchsets/detect.py', 3, '__init__', 'propagation'),
    frame('qt_gui/gui_sys_patch.py', 5, 'run', 'source'),
  ];
}

test("AttributeError names the class in the message and points at its definition ('Constants' case)", () => {
  const model = buildSnapshotModel(snapshotOf(AUDIO_SNAPSHOT_FILES));
  const candidates = analyzePythonRootCause(model, audioCrashFrames(), {
    type: 'AttributeError',
    message: "'Constants' object has no attribute 'voodoo_patch_already'",
  });

  assert.ok(candidates.length > 0);
  const top = candidates[0];
  assert.equal(top.kind, 'missing-attribute');
  assert.equal(top.file_path, 'sys_patch/constants.py');
  assert.equal(top.line_number, 1); // the class definition line, not the crash line
  assert.equal(top.function_name, 'Constants');
  assert.ok(top.confidence >= 0.9, `confidence ${top.confidence}`);
  assert.ok(top.reason.includes("'voodoo_patch_already'"), `reason: ${top.reason}`);
  assert.ok(top.reason.includes('Constants'), `reason: ${top.reason}`);
});

test("targeted Constants AttributeError also resolves a function definition and stops", () => {
  const model = buildSnapshotModel(snapshotOf({
    'factory.py': [
      'import json',
      'def Constants(value):',
      "    return type('Constants', (), {})()",
    ].join('\n'),
    'crash.py': [
      'from factory import Constants',
      '',
      'def run():',
      '    constants = Constants(None)',
      '    return constants.voodoo_patch_already',
    ].join('\n'),
  }));
  const candidates = analyzePythonRootCause(model, [frame('crash.py', 5, 'run')], {
    type: 'AttributeError',
    message: "'Constants' object has no attribute 'voodoo_patch_already'",
  });

  assert.equal(candidates.length, 1, 'resolved definition is the terminal cause');
  const top = candidates[0];
  assert.equal(top.kind, 'missing-attribute');
  assert.equal(top.file_path, 'factory.py');
  assert.equal(top.line_number, 2);
  assert.equal(top.function_name, 'Constants');
  assert.equal(top.definition_kind, 'function');
  assert.equal(top.definition_module, 'factory');
  assert.equal(top.is_conclusive, true);
  assert.equal(top.confidence, 1);
  assert.ok(top.reason.includes("'Constants' from factory.py:2"), `reason: ${top.reason}`);
  assert.ok(top.reason.includes("never defines 'voodoo_patch_already'"), `reason: ${top.reason}`);
});

test('falls back to resolving self.<attr> chains to the constructor class', () => {
  const model = buildSnapshotModel(snapshotOf(AUDIO_SNAPSHOT_FILES));
  // Class name in the message is wrong/unknown → the self._constants chain
  // (self._constants = Constants(...) in __init__) must resolve Constants.
  const candidates = analyzePythonRootCause(model, audioCrashFrames(), {
    type: 'AttributeError',
    message: "'AudioConstants' object has no attribute 'voodoo_patch_already'",
  });

  assert.ok(candidates.length > 0);
  const top = candidates[0];
  assert.equal(top.kind, 'missing-attribute');
  assert.equal(top.file_path, 'sys_patch/constants.py');
  assert.equal(top.function_name, 'Constants');
});

test('attribute defined in the class body → no missing-attribute candidate', () => {
  const files = {
    ...AUDIO_SNAPSHOT_FILES,
    'sys_patch/constants.py': [
      'class Constants:',
      "    audio_type = 'VoodooHDA'",
      '    voodoo_patch_already = False',
    ].join('\n'),
  };
  const model = buildSnapshotModel(snapshotOf(files));
  const candidates = analyzePythonRootCause(model, audioCrashFrames(), {
    type: 'AttributeError',
    message: "'Constants' object has no attribute 'voodoo_patch_already'",
  });

  assert.ok(!candidates.some(candidate => candidate.kind === 'missing-attribute'),
    `no missing-attribute candidates: ${JSON.stringify(candidates)}`);
});

test('attribute defined in __init__ → no missing-attribute candidate', () => {
  const files = {
    ...AUDIO_SNAPSHOT_FILES,
    'sys_patch/constants.py': [
      'class Constants:',
      '    def __init__(self):',
      '        self.voodoo_patch_already = False',
    ].join('\n'),
  };
  const model = buildSnapshotModel(snapshotOf(files));
  const candidates = analyzePythonRootCause(model, audioCrashFrames(), {
    type: 'AttributeError',
    message: "'Constants' object has no attribute 'voodoo_patch_already'",
  });

  assert.ok(!candidates.some(candidate => candidate.kind === 'missing-attribute'),
    `no missing-attribute candidates: ${JSON.stringify(candidates)}`);
});

// ── HDAU-style: runtime type defined in another file ──

const HDAU_SNAPSHOT_FILES: Record<string, string> = {
  'sys_patch/patchsets/hardware/audio/hda_universal_audio.py': [
    'class HDAU:',
    '    def __init__(self):',
    '        self._variant = 1',
    '',
    '    def hardware_variant(self):',
    '        return self._variant',
    '',
    '    def name(self):',
    '        return f"{self._trans.get(self.hardware_variant(), self.hardware_variant())}: HDAUniversal"',
  ].join('\n'),
  'sys_patch/patchsets/detect.py': [
    'class HardwarePatchsetDetection:',
    '    def __init__(self, constants):',
    '        self._detect()',
    '',
    '    def _detect(self):',
    '        device_properties = {}',
    '        device_properties[HDAU().name()] = True',
  ].join('\n'),
  'qt_gui/gui_sys_patch.py': [
    'from sys_patch.patchsets.detect import HardwarePatchsetDetection',
    '',
    'class GuiSysPatch:',
    '    def run(self, constants):',
    '        patches = HardwarePatchsetDetection(constants=constants).device_properties',
  ].join('\n'),
};

function hdauCrashFrames(): StackFrame[] {
  return [
    frame('sys_patch/patchsets/hardware/audio/hda_universal_audio.py', 9, 'name', 'trigger'),
    frame('sys_patch/patchsets/detect.py', 7, '_detect', 'propagation'),
    frame('qt_gui/gui_sys_patch.py', 5, 'run', 'source'),
  ];
}

test("AttributeError 'HDAU' object has no attribute '_trans' points at the HDAU definition file", () => {
  const model = buildSnapshotModel(snapshotOf(HDAU_SNAPSHOT_FILES));
  const candidates = analyzePythonRootCause(model, hdauCrashFrames(), {
    type: 'AttributeError',
    message: "'HDAU' object has no attribute '_trans'",
  });

  assert.equal(candidates.length, 1, 'single conclusive candidate, no rival causes');
  const top = candidates[0];
  assert.equal(top.kind, 'missing-attribute');
  assert.equal(top.file_path, 'sys_patch/patchsets/hardware/audio/hda_universal_audio.py');
  assert.equal(top.line_number, 1); // the class definition line
  assert.equal(top.function_name, 'HDAU');
  assert.equal(top.is_conclusive, true);
  assert.equal(top.definition_kind, 'class');
  assert.equal(top.definition_module, 'sys_patch.patchsets.hardware.audio.hda_universal_audio');
  assert.equal(top.confidence, 1);
  assert.ok(top.reason.includes("'HDAU'"), `reason: ${top.reason}`);
  assert.ok(top.reason.includes("'_trans'"), `reason: ${top.reason}`);
});

// ── ImportError: single conclusive import line ──

test("ImportError 'No module named' produces one conclusive import-failure candidate", () => {
  const model = buildSnapshotModel(snapshotOf({
    'crash.py': [
      'import missing_dep',
      '',
      'def run():',
      '    return missing_dep.work()',
    ].join('\n'),
  }));
  const candidates = analyzePythonRootCause(model, [frame('crash.py', 1, '<module>')], {
    type: 'ModuleNotFoundError',
    message: "No module named 'missing_dep'",
  });

  assert.equal(candidates.length, 1);
  const top = candidates[0];
  assert.equal(top.kind, 'import-failure');
  assert.equal(top.file_path, 'crash.py');
  assert.equal(top.line_number, 1);
  assert.equal(top.is_conclusive, true);
  assert.ok(top.reason.includes('missing_dep'), `reason: ${top.reason}`);
});
