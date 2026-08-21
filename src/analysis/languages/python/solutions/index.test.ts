import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { buildSnapshotModel } from '../code-model/index.js';
import type { AnalysisSourceSnapshot, AnalysisSourceFile, RootCauseCandidate, StackFrame } from '../../../types.js';
import { analyzePythonRootCause, matchCrashFile, findCrashFunc, type CrashContext } from '../root-cause/index.js';
import { suggestFixes, suggestExceptionAdvice, snippetAround } from './index.js';

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

function crashContext(
  model: ReturnType<typeof buildSnapshotModel>,
  filePath: string,
  line: number,
  functionName: string,
  exception: { type: string; message: string }
): { ctx: CrashContext; candidates: RootCauseCandidate[] } {
  const frames: StackFrame[] = [{
    index: 0, language: 'python', file_path: filePath, line_number: line, column_number: null,
    function_name: functionName, module_name: '', address: '', raw_line: '', severity: 'trigger',
  }];
  const candidates = analyzePythonRootCause(model, frames, exception);
  const crashFile = matchCrashFile(model, frames[0])!;
  const { func: crashFunc } = findCrashFunc(crashFile, frames[0]);
  const ctx: CrashContext = { model, crashFile, crashFunc, crashLine: line, exception, frames };
  return { ctx, candidates };
}

test('none-return candidate yields a default-value fix and a guard fix', () => {
  const model = buildSnapshotModel(loadSampleApp());
  const { ctx, candidates } = crashContext(model, 'app.py', 12, 'main', {
    type: 'AttributeError',
    message: "'NoneType' object has no attribute 'name'",
  });
  const top = candidates.find(candidate => candidate.kind === 'none-return');
  assert.ok(top, 'none-return candidate present');

  const fixes = suggestFixes(top, ctx, 0);
  assert.ok(fixes.length >= 2, `expected 2 fixes, got ${fixes.length}`);
  assert.equal(fixes[0].candidate_index, 0);

  const defaultFix = fixes.find(item => item.title.includes('default'));
  assert.ok(defaultFix, 'default-value fix present');
  assert.equal(defaultFix.code_before, 'return None');
  assert.ok(defaultFix.code_after.includes('default'), `code_after: ${defaultFix.code_after}`);
  assert.ok(defaultFix.fix_site_snippet.includes('>'), 'fix site snippet has a marker');

  const guardFix = fixes.find(item => item.title.includes('Guard'));
  assert.ok(guardFix, 'guard fix present');
  assert.ok(guardFix.code_after.includes('is None'), `code_after: ${guardFix.code_after}`);
  assert.ok(guardFix.crash_site_snippet.includes('print(user.name)'), 'crash snippet shows the crash line');
});

test('undefined-name candidate yields a typo correction', () => {
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
  const { ctx, candidates } = crashContext(model, 'run.py', 4, 'run', {
    type: 'NameError',
    message: "name 'SETTTINGS' is not defined",
  });
  const top = candidates.find(candidate => candidate.kind === 'undefined-name');
  assert.ok(top, 'undefined-name candidate present');

  const fixes = suggestFixes(top, ctx, 0);
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].code_before, "return SETTTINGS['host']");
  assert.equal(fixes[0].code_after, "    return SETTINGS['host']");
});

test('missing-key candidate yields a .get() fix', () => {
  const model = buildSnapshotModel(loadSampleApp());
  const { ctx, candidates } = crashContext(model, 'config.py', 10, 'get_setting', {
    type: 'KeyError',
    message: "'setting'",
  });
  const top = candidates.find(candidate => candidate.kind === 'missing-key');
  assert.ok(top, 'missing-key candidate present');

  const fixes = suggestFixes(top, ctx, 0);
  assert.ok(fixes.length >= 1);
  assert.equal(fixes[0].code_before, 'return SETTINGS[key]');
  assert.equal(fixes[0].code_after, "    return SETTINGS.get(key, <default>)");
});

test('missing-attribute candidate yields a fix at the class definition', () => {
  const sourceFiles = {
    'constants.py': ['class Constants:', "    audio_type = 'VoodooHDA'"].join('\n'),
    'voodoo_audio.py': [
      'class VoodooAudio:',
      '    def __init__(self, constants):',
      '        self._constants = constants',
      '',
      '    def present(self):',
      '        return not self._constants.voodoo_patch_already',
    ].join('\n'),
  };
  const snapshot: AnalysisSourceSnapshot = {
    project_name: 'audio_app',
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
  const model = buildSnapshotModel(snapshot);
  const { ctx, candidates } = crashContext(model, 'voodoo_audio.py', 6, 'present', {
    type: 'AttributeError',
    message: "'Constants' object has no attribute 'voodoo_patch_already'",
  });
  const top = candidates.find(candidate => candidate.kind === 'missing-attribute');
  assert.ok(top, 'missing-attribute candidate present');

  const fixes = suggestFixes(top, ctx, 0);
  assert.equal(fixes.length, 1);
  assert.ok(fixes[0].fix_site_snippet.includes('class Constants'), 'fix site shows the class definition');
  assert.equal(fixes[0].code_before, 'class Constants:');
  assert.equal(fixes[0].code_after, 'class Constants:\n    voodoo_patch_already = <default_value>');
});

test('snippetAround marks the target line', () => {
  const model = buildSnapshotModel(loadSampleApp());
  const app = model.by_path.get('app.py')!;
  const snippet = snippetAround(app, 12);
  const lines = snippet.split('\n');
  assert.ok(lines.some(line => line.startsWith('>') && line.includes('print(user.name)')));
  assert.equal(lines.length, 5);
});

test('suggestExceptionAdvice maps known exception types to a suggestion', () => {
  const [suggestion] = suggestExceptionAdvice({ type: 'KeyError', message: "'setting'" });
  assert.equal(suggestion.candidate_index, -1);
  assert.ok(suggestion.title.length > 0);
  assert.ok(suggestion.description.includes('.get('), `description: ${suggestion.description}`);
  assert.equal(suggestion.code_before, '');
  assert.equal(suggestion.code_after, '');
});

test('suggestExceptionAdvice prefers the most specific exception type', () => {
  const [module] = suggestExceptionAdvice({ type: 'ModuleNotFoundError', message: "No module named 'requests'" });
  assert.ok(module.title.toLowerCase().includes('module'), `title: ${module.title}`);
  const [importer] = suggestExceptionAdvice({ type: 'ImportError', message: 'cannot import name' });
  assert.notEqual(module.title, importer.title, 'ModuleNotFoundError has its own entry');
});

test('suggestExceptionAdvice falls back to a default for unknown types', () => {
  const [suggestion] = suggestExceptionAdvice({ type: 'SomeWeirdError', message: 'boom' });
  assert.ok(suggestion.title.length > 0);
  assert.ok(suggestion.description.length > 0);
  assert.equal(suggestion.candidate_index, -1);
});
