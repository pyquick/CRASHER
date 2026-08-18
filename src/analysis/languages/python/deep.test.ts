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
      '  File "app.py", line 12, in main',
      '    print(user.name)',
      '  File "app.py", line 10, in main',
      '    user = get_user(user_id)',
      '  File "app.py", line 16, in <module>',
      "    main(int(os.environ.get('USER_ID', '1')))",
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
