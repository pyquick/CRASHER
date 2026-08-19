import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { analyzeCrash } from '../../analyzer.js';
import type { AnalysisSourceSnapshot, AnalysisSourceFile } from '../../types.js';

const here = dirname(fileURLToPath(import.meta.url));
const sampleAppDir = join(here, 'samples', 'sample_app');

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

test('analyzeCrash produces Python root cause candidates, fixes and dependencies', () => {
  const report = {
    id: 1,
    exception_type: 'AttributeError',
    exception_message: "'NoneType' object has no attribute 'name'",
    stack_trace: [
      'Traceback (most recent call last):',
      '  File "app.py", line 16, in <module>',
      "    main(int(os.environ.get('USER_ID', '1')))",
      '  File "app.py", line 10, in main',
      '    user = get_user(user_id)',
      '  File "app.py", line 12, in main',
      '    print(user.name)',
      "AttributeError: 'NoneType' object has no attribute 'name'",
    ].join('\n'),
    runtime: 'python',
    runtime_version: '3.11',
  };

  const analysis = analyzeCrash(report, loadSampleApp());
  assert.ok(analysis, 'analysis produced');
  assert.equal(analysis.detected_language, 'python');
  assert.ok(analysis.source_analysis, 'source analysis present');

  const candidates = analysis.source_analysis.root_cause_candidates ?? [];
  assert.ok(candidates.length > 0, 'root cause candidates present');
  assert.equal(candidates[0].kind, 'none-return');
  assert.equal(candidates[0].file_path, 'services/user_service.py');
  assert.equal(candidates[0].line_number, 14);

  const fixes = analysis.source_analysis.fixes ?? [];
  assert.ok(fixes.length >= 2, `fixes present (${fixes.length})`);
  assert.ok(fixes.every(item => item.confidence > 0));

  const summary = analysis.source_analysis.dependency_summary;
  assert.ok(summary, 'dependency summary present');
  assert.equal(summary.variable_definitions.length, 1);
  assert.equal(summary.variable_definitions[0].line_number, 10);
  assert.ok(summary.variable_definitions[0].snippet.includes('user = get_user(user_id)'));
});

test('analyzeCrash with RecursionError reports the cycle', () => {
  const report = {
    id: 2,
    exception_type: 'RecursionError',
    exception_message: 'maximum recursion depth exceeded',
    stack_trace: [
      'Traceback (most recent call last):',
      '  File "utils/validators.py", line 6, in validate_depth',
      '    return validate_depth(depth + 1)',
      'RecursionError: maximum recursion depth exceeded',
    ].join('\n'),
    runtime: 'python',
    runtime_version: '3.11',
  };

  const analysis = analyzeCrash(report, loadSampleApp());
  const candidates = analysis?.source_analysis?.root_cause_candidates ?? [];
  assert.ok(candidates.length > 0);
  assert.equal(candidates[0].kind, 'recursion');
  assert.equal(candidates[0].file_path, 'utils/validators.py');

  const fixes = analysis?.source_analysis?.fixes ?? [];
  assert.ok(fixes.some(item => item.title.includes('base case')), 'recursion fix suggests a base case');
});

test('non-Python crashes are unaffected by the deep analysis', () => {
  const report = {
    id: 3,
    exception_type: 'RuntimeException',
    exception_message: 'boom',
    stack_trace: [
      'Exception in thread "main" java.lang.RuntimeException: boom',
      '\tat com.example.App.main(App.java:10)',
    ].join('\n'),
    runtime: 'java',
    runtime_version: '21',
  };

  const analysis = analyzeCrash(report, loadSampleApp());
  assert.ok(analysis, 'analysis produced');
  assert.equal(analysis.detected_language, 'java');
  assert.ok(!analysis.source_analysis?.root_cause_candidates, 'no Python deep analysis for Java crashes');
});

test('analyzeCrash builds a crash path flow ending at the root cause', () => {
  const sourceFiles: Record<string, string> = {
    'sys_patch/constants.py': ['class Constants:', "    audio_type = 'VoodooHDA'"].join('\n'),
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
  const snapshot: AnalysisSourceSnapshot = {
    project_name: 'macboxtool',
    requested_release: '',
    snapshot_release: '',
    snapshot_id: 1,
    match_type: 'exact',
    files: Object.entries(sourceFiles).map(([relative_path, content]) => ({
      relative_path,
      language: 'python',
      content,
    })),
  };

  const report = {
    id: 5,
    exception_type: 'AttributeError',
    exception_message: "'Constants' object has no attribute 'voodoo_patch_already'",
    stack_trace: [
      'Traceback (most recent call last):',
      '  File "qt_gui/gui_sys_patch.py", line 5, in run',
      '    patches = HardwarePatchsetDetection(constants=constants).device_properties',
      '  File "sys_patch/patchsets/detect.py", line 3, in __init__',
      '    self._detect()',
      '  File "sys_patch/patchsets/detect.py", line 6, in _detect',
      '    if VoodooAudio(None).present() is False:',
      '  File "sys_patch/patchsets/hardware/audio/voodoo_audio.py", line 6, in present',
      '    return self._constants.audio_type=="VoodooHDA" and not self._constants.voodoo_patch_already',
      "AttributeError: 'Constants' object has no attribute 'voodoo_patch_already'",
    ].join('\n'),
    runtime: 'python',
    runtime_version: '3.11',
  };

  const analysis = analyzeCrash(report, snapshot);
  const candidates = analysis?.source_analysis?.root_cause_candidates ?? [];
  assert.ok(candidates.length > 0, 'root cause candidates present');
  assert.equal(candidates[0].kind, 'missing-attribute');
  assert.equal(candidates[0].file_path, 'sys_patch/constants.py');
  assert.equal(candidates[0].line_number, 1);

  const path = analysis?.source_analysis?.crash_path ?? [];
  assert.equal(path.length, 5, '4 frames + terminal root-cause node');
  assert.equal(path[0].role, 'frame');
  assert.equal(path[0].file_path, 'qt_gui/gui_sys_patch.py', 'entry frame first');
  assert.equal(path[0].function_name, 'run');
  assert.equal(path[3].file_path, 'sys_patch/patchsets/hardware/audio/voodoo_audio.py', 'crash frame before the root node');
  assert.equal(path[3].function_name, 'present');
  assert.equal(path[4].role, 'root-cause');
  assert.equal(path[4].file_path, 'sys_patch/constants.py');
  assert.equal(path[4].line_number, 1);
  assert.equal(path[4].kind, 'missing-attribute');
  assert.ok(path[4].label.includes('Constants'), `label: ${path[4].label}`);
  assert.ok(path[4].label.includes('voodoo_patch_already'), `label: ${path[4].label}`);
});

test('Python crash with no matching snapshot file degrades gracefully', () => {
  const report = {
    id: 4,
    exception_type: 'AttributeError',
    exception_message: "'NoneType' object has no attribute 'x'",
    stack_trace: [
      'Traceback (most recent call last):',
      '  File "other_project/server.py", line 5, in handle',
      '    return x.y',
      "AttributeError: 'NoneType' object has no attribute 'x'",
    ].join('\n'),
    runtime: 'python',
    runtime_version: '3.11',
  };

  const analysis = analyzeCrash(report, loadSampleApp());
  assert.ok(analysis?.source_analysis, 'source analysis present');
  assert.deepEqual(analysis.source_analysis.root_cause_candidates ?? [], []);
  assert.ok((analysis.source_analysis.warnings ?? []).some(w => w.includes('not found in the source snapshot')));
});
