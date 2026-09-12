import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReviewToAnalysis, extractJsonObjects, normalizeReviewPayload } from './review-validate.js';
import { applyKnowledgeToAnalysis, normalizeKnowledge } from './knowledge.js';
import type { CrashAnalysis } from '../analysis/types.js';

test('extractJsonObjects parses plain, fenced and prose-wrapped JSON', () => {
  assert.deepEqual(extractJsonObjects('{"correct":true}'), [{ correct: true }]);
  assert.deepEqual(extractJsonObjects('```json\n{"correct":false}\n```'), [{ correct: false }]);
  assert.deepEqual(extractJsonObjects('Here is the verdict:\n{"correct":true,"notes":"ok"} trailing prose'), [{ correct: true, notes: 'ok' }]);
  assert.deepEqual(extractJsonObjects('no json here'), []);
  assert.deepEqual(extractJsonObjects(''), []);
});

test('extractJsonObjects collects every parseable object and skips broken fragments', () => {
  const objects = extractJsonObjects('plan: {"step": 1}\n{broken fragment}\nfinal: {"correct": false, "notes": "n"}');
  assert.deepEqual(objects, [{ step: 1 }, { correct: false, notes: 'n' }]);
});

test('extractJsonObjects tolerates nested braces and escaped quotes', () => {
  const objects = extractJsonObjects('{"correct": true, "notes": "says \\"hi\\" {brace}"}');
  assert.deepEqual(objects, [{ correct: true, notes: 'says "hi" {brace}' }]);
});

test('normalizeReviewPayload rejects payloads without a boolean correct', () => {
  assert.equal(normalizeReviewPayload(null), null);
  assert.equal(normalizeReviewPayload([]), null);
  assert.equal(normalizeReviewPayload({}), null);
  assert.equal(normalizeReviewPayload({ correct: 'yes' }), null);
});

test('normalizeReviewPayload coerces fields and clamps confidence', () => {
  const review = normalizeReviewPayload({
    correct: true,
    notes: '  看起来正确  ',
    corrections: { summary: 'better summary' },
    suggestions: [{
      candidate_index: 2,
      title: 't',
      description: 'd',
      crash_site_snippet: 'c',
      fix_site_snippet: 'f',
      code_before: 'b',
      code_after: 'a',
      confidence: 7,
    }],
  });
  assert.ok(review);
  assert.equal(review.correct, true);
  assert.equal(review.notes, '看起来正确');
  assert.equal(review.corrections.summary, 'better summary');
  assert.equal(review.suggestions[0].confidence, 1);
});

test('normalizeReviewPayload enforces the root-cause kind whitelist', () => {
  const review = normalizeReviewPayload({
    correct: false,
    notes: '',
    corrections: {
      root_cause_candidates: [
        { file_path: 'a.py', line_number: 1, function_name: 'f', reason: 'r', confidence: 0.8, kind: 'none-return', evidence: ['e'] },
        { file_path: 'b.py', line_number: 2, function_name: 'g', reason: 'r2', confidence: 0.5, kind: 'made-up-kind', evidence: [] },
        { file_path: 'c.py', line_number: null, function_name: 'h', reason: 'r3', confidence: -3, kind: 'generic', evidence: [42] },
      ],
    },
  });
  assert.ok(review);
  assert.equal(review.corrections.root_cause_candidates?.length, 2); // unknown kind dropped
  assert.equal(review.corrections.root_cause_candidates?.[1].confidence, 0); // -3 clamped to 0
  assert.deepEqual(review.corrections.root_cause_candidates?.[1].evidence, []); // non-strings dropped
});

test('normalizeReviewPayload caps arrays and fills candidate_index', () => {
  const suggestions = Array.from({ length: 12 }, (_, i) => ({ title: `t${i}`, confidence: 0.5 }));
  const review = normalizeReviewPayload({ correct: true, notes: '', suggestions });
  assert.ok(review);
  assert.equal(review.suggestions.length, 10);
  assert.equal(review.suggestions[0].candidate_index, 0);
  assert.equal(review.suggestions[9].candidate_index, 9);
});

function baseAnalysis(): CrashAnalysis {
  return {
    report_id: 7,
    exception_type: 'TypeError',
    exception_message: 'x',
    detected_language: 'python',
    file_tree: [],
    trigger_point: { file_path: 'a.py', line_number: 1, function_name: 'f', message: 'm', raw_snippet: '' },
    stack_chain: [],
    summary: 'original summary',
    runtime: 'python',
    runtime_version: '3.12',
    suggestions: [{ candidate_index: 0, title: 'original', description: '', crash_site_snippet: '', fix_site_snippet: '', code_before: '', code_after: '', confidence: 0.5 }],
  };
}

test('applyReviewToAnalysis preserves deterministic source match metadata after review', () => {
  const analysis = baseAnalysis();
  analysis.source_analysis = {
    project_name: 'demo', requested_release: 'r', snapshot_release: 'r', snapshot_id: 17, match_type: 'latest',
    files_scanned: 99, crash_source: { file_path: 'src/a.py', line_number: 1, function_name: 'f', snippet: '' },
    function_definition: null, references: [], related_functions: [], related_files: [], warnings: [],
  };
  const out = applyReviewToAnalysis(analysis, {
    correct: false, notes: 'fix summary only', corrections: { summary: 'corrected' }, suggestions: [],
  });
  assert.equal(out.source_analysis?.snapshot_id, 17);
  assert.equal(out.source_analysis?.match_type, 'latest');
  assert.equal(out.source_analysis?.crash_source?.file_path, 'src/a.py');
});

test('applyReviewToAnalysis applies corrections even when review is marked correct', () => {
  const out = applyReviewToAnalysis(baseAnalysis(), {
    correct: true, notes: '', corrections: { summary: 'reviewed', exception_type: 'ValueError' }, suggestions: [],
  });
  assert.equal(out.summary, 'reviewed');
  assert.equal(out.exception_type, 'ValueError');
});
test('applyReviewToAnalysis appends suggestions at top level', () => {
  const out = applyReviewToAnalysis(baseAnalysis(), {
    correct: true,
    notes: 'n',
    corrections: {},
    suggestions: [{ candidate_index: 1, title: 'ai fix', description: '', crash_site_snippet: '', fix_site_snippet: '', code_before: '', code_after: '', confidence: 0.9 }],
  });
  assert.equal(out.suggestions?.length, 2);
  assert.equal(out.suggestions?.[1].title, 'ai fix');
  assert.equal(out.summary, 'original summary');
});

test('applyReviewToAnalysis appends to source_analysis.fixes when present', () => {
  const analysis = baseAnalysis();
  analysis.source_analysis = {
    project_name: 'demo', requested_release: 'r', snapshot_release: 'r', snapshot_id: 1, match_type: 'exact',
    files_scanned: 1, crash_source: null, function_definition: null,
    references: [], related_functions: [], related_files: [], warnings: [],
    root_cause_candidates: [], fixes: [{ candidate_index: 0, title: 'existing', description: '', crash_site_snippet: '', fix_site_snippet: '', code_before: '', code_after: '', confidence: 0.5 }],
    crash_path: [],
  } as never;
  const out = applyReviewToAnalysis(analysis, {
    correct: true, notes: '', corrections: {},
    suggestions: [{ candidate_index: 1, title: 'ai fix', description: '', crash_site_snippet: '', fix_site_snippet: '', code_before: '', code_after: '', confidence: 0.9 }],
  });
  assert.equal(out.source_analysis?.fixes?.length, 2);
  assert.equal(out.source_analysis?.fixes?.[1].title, 'ai fix');
  assert.equal(out.suggestions?.length, 1); // top-level untouched
});

test('applyReviewToAnalysis overlays corrections only when incorrect', () => {
  const analysis = baseAnalysis();
  analysis.source_analysis = {
    project_name: 'demo', requested_release: 'r', snapshot_release: 'r', snapshot_id: 1, match_type: 'exact',
    files_scanned: 1, crash_source: null, function_definition: null,
    references: [], related_functions: [], related_files: [], warnings: [],
    root_cause_candidates: [], fixes: [], crash_path: [],
  } as never;
  const review = {
    correct: false,
    notes: 'wrong',
    corrections: {
      summary: 'corrected summary',
      root_cause_candidates: [{ file_path: 'z.py', line_number: 9, function_name: 'z', reason: 'r', confidence: 0.9, kind: 'none-return', evidence: [] } as const],
      crash_path: [{ file_path: 'z.py', line_number: 9, function_name: 'z', label: 'l', role: 'root-cause' } as const],
    },
    suggestions: [],
  };
  const out = applyReviewToAnalysis(analysis, review);
  assert.equal(out.summary, 'corrected summary');
  assert.equal(out.source_analysis?.root_cause_candidates?.length, 1);
  assert.equal(out.source_analysis?.crash_path?.length, 1);

  // corrections are applied regardless of the model's overall correctness flag
  const untouched = applyReviewToAnalysis(analysis, { ...review, correct: true });
  assert.equal(untouched.summary, 'corrected summary');
  assert.equal(untouched.source_analysis?.root_cause_candidates?.length, 1);
});

test('applyReviewToAnalysis without source_analysis overlays crash_path at top level', () => {
  const analysis = baseAnalysis();
  const out = applyReviewToAnalysis(analysis, {
    correct: false,
    notes: '',
    corrections: { crash_path: [{ file_path: 'a.py', line_number: 2, function_name: 'f', label: 'l', role: 'frame' }] },
    suggestions: [],
  });
  assert.equal(out.crash_path?.length, 1);
});

test('normalizeReviewPayload validates trigger_point, stack_chain and file_tree_updates', () => {
  const review = normalizeReviewPayload({
    correct: false,
    notes: '',
    corrections: {
      trigger_point: { file_path: 'src/a.ts', line_number: 9, function_name: 'load', message: 'm', raw_snippet: 'raw' },
      stack_chain: [
        { index: 0, language: 'typescript', file_path: 'src/a.ts', line_number: 9, column_number: 2, function_name: 'load', module_name: 'svc', address: '', raw_line: 'r', severity: 'trigger' },
        { index: 'x', language: 'typescript', file_path: 'src/b.ts', line_number: 0, column_number: -1, function_name: 'run', module_name: '', address: '', raw_line: '', severity: 'bogus' },
      ],
      file_tree_updates: [
        { path: 'src/a.ts', is_crash_site: true, line_number: 9, severity: 'red' },
        { path: '', severity: 'red' },
        { path: 'src/b.ts', is_crash_site: 'yes', line_number: -2, severity: 'pink' },
      ],
    },
  });
  assert.ok(review);
  assert.equal(review.corrections.trigger_point?.file_path, 'src/a.ts');
  assert.equal(review.corrections.stack_chain?.length, 2);
  assert.equal(review.corrections.stack_chain?.[1].index, 1); // invalid index falls back to position
  assert.equal(review.corrections.stack_chain?.[1].line_number, null); // 0 invalid
  assert.equal(review.corrections.stack_chain?.[1].severity, 'unknown'); // bogus severity coerced
  assert.equal(review.corrections.file_tree_updates?.length, 2); // empty path dropped; invalid optional fields ignored
  assert.deepEqual(review.corrections.file_tree_updates?.[0], { path: 'src/a.ts', is_crash_site: true, line_number: 9, severity: 'red' });
  assert.deepEqual(review.corrections.file_tree_updates?.[1], { path: 'src/b.ts' });
});

test('normalizeReviewPayload drops trigger_point without a file path', () => {
  const review = normalizeReviewPayload({ correct: false, notes: '', corrections: { trigger_point: { file_path: '  ' } } });
  assert.ok(review);
  assert.equal(review.corrections.trigger_point, undefined);
});

test('applyReviewToAnalysis overlays trigger_point, stack_chain and file_tree updates when incorrect', () => {
  const analysis = baseAnalysis();
  analysis.file_tree = [
    { name: 'a.ts', path: 'src/a.ts', is_file: true, is_crash_site: false, line_number: null, severity: 'gray', children: [] },
    { name: 'dir', path: 'src/dir', is_file: false, is_crash_site: false, line_number: null, severity: 'gray', children: [
      { name: 'b.ts', path: 'src/dir/b.ts', is_file: true, is_crash_site: false, line_number: null, severity: 'gray', children: [] },
    ] },
  ];
  const out = applyReviewToAnalysis(analysis, {
    correct: false,
    notes: '',
    corrections: {
      trigger_point: { file_path: 'src/a.ts', line_number: 42, function_name: 'load', message: 'boom', raw_snippet: 'raw' },
      stack_chain: [{ index: 0, language: 'typescript', file_path: 'src/a.ts', line_number: 42, column_number: null, function_name: 'load', module_name: '', address: '', raw_line: 'r', severity: 'trigger' }],
      file_tree_updates: [
        { path: 'src/a.ts', is_crash_site: true, line_number: 42, severity: 'red' },
        { path: 'src/dir/b.ts', severity: 'orange' },
      ],
    },
    suggestions: [],
  });
  assert.equal(out.trigger_point.line_number, 42);
  assert.equal(out.stack_chain.length, 1);
  const a = out.file_tree[0];
  assert.equal(a.is_crash_site, true);
  assert.equal(a.line_number, 42);
  assert.equal(a.severity, 'red');
  const b = (out.file_tree[1] as { children: Array<{ severity: string; is_crash_site: boolean }> }).children[0];
  assert.equal(b.severity, 'orange');
  assert.equal(b.is_crash_site, false); // untouched
});

test('applyReviewToAnalysis applies trigger_point/stack_chain/file_tree even when correct', () => {
  const analysis = baseAnalysis();
  analysis.file_tree = [{ name: 'a.ts', path: 'src/a.ts', is_file: true, is_crash_site: false, line_number: null, severity: 'gray', children: [] }];
  const out = applyReviewToAnalysis(analysis, {
    correct: true,
    notes: '',
    corrections: {
      trigger_point: { file_path: 'x.ts', line_number: 1, function_name: 'x', message: '', raw_snippet: '' },
      stack_chain: [{ index: 0, language: 'ts', file_path: 'x.ts', line_number: 1, column_number: null, function_name: 'x', module_name: '', address: '', raw_line: '', severity: 'trigger' }],
      file_tree_updates: [{ path: 'src/a.ts', is_crash_site: true }],
    },
    suggestions: [],
  });
  assert.equal(out.trigger_point.file_path, 'x.ts');
  assert.equal(out.file_tree[0].is_crash_site, true);
});

test('normalizeKnowledge keeps valid kinds, drops invalid ones and requires a title', () => {
  const entries = normalizeKnowledge([
    { kind: 'hint', title: '  keep this  ', description: 'd', confidence: 2 },
    { kind: 'bogus', title: 'drop' },
    { kind: 'suggestion', title: '', description: 'drop' },
    { kind: 'suggestion', title: 's1', description: 'desc', confidence: 0.9, payload: { candidate_index: 3, code_before: 'a', code_after: 'b' } },
    { kind: 'root_cause', title: 'rc', description: 'reason', confidence: 0.7, payload: { file_path: 'x.py', line_number: 5, function_name: 'f', kind: 'none-return', evidence: ['e'] } },
    { kind: 'root_cause', title: 'bad kind', payload: { kind: 'made-up' } },
  ]);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], { kind: 'hint', title: 'keep this', description: 'd', confidence: 1, payload: {} });
  assert.equal(entries[1].payload.candidate_index, 3);
  assert.equal(entries[2].payload.kind, 'none-return');
});

test('normalizeKnowledge validates, deduplicates and preserves quote entries', () => {
  const entries = normalizeKnowledge([
    { kind: 'quote', title: 'Definition', description: 'meaning', confidence: 0.8, payload: { quote: 'x is absent', meaning: 'lookup failed', source: 'src/a.ts:4' } },
    { kind: 'quote', title: ' definition ', description: 'duplicate', confidence: 0.9, payload: { quote: 'other', meaning: 'other', source: 'other' } },
    { kind: 'quote', title: 'Incomplete', description: 'drop', payload: { quote: 'x', meaning: '', source: 'src' } },
  ]);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].payload, { quote: 'x is absent', meaning: 'lookup failed', source: 'src/a.ts:4' });
});
test('applyKnowledgeToAnalysis exposes validated quote payloads to the UI', () => {
  const out = applyKnowledgeToAnalysis(baseAnalysis(), [
    { kind: 'quote', title: 'Definition', description: 'meaning', confidence: 0.8, payload: { quote: 'x is absent', meaning: 'lookup failed', source: 'src/a.ts:4' } },
  ]);
  assert.deepEqual(out.learned, [{
    kind: 'quote', title: 'Definition', description: 'meaning', confidence: 0.8,
    quote: 'x is absent', meaning: 'lookup failed', source: 'src/a.ts:4',
  }]);
});

test('normalizeReviewPayload ignores unknown knowledge field', () => {
  const review = normalizeReviewPayload({
    correct: true,
    notes: '',
    knowledge: [{ kind: 'hint', title: 't', description: 'd', confidence: 0.8 }],
  });
  assert.ok(review);
  assert.equal((review as Record<string, unknown>).knowledge, undefined);
});

test('applyKnowledgeToAnalysis appends suggestions to the rendered list and sets learned', () => {
  const analysis = baseAnalysis();
  const out = applyKnowledgeToAnalysis(analysis, [
    { kind: 'suggestion', title: 'learned fix', description: 'use guard', confidence: 0.9, payload: { candidate_index: 5, code_before: 'x', code_after: 'y' } },
    { kind: 'hint', title: 'learned hint', description: 'check env', confidence: 0.7, payload: {} },
  ]);
  assert.equal(out.suggestions?.length, 2);
  assert.equal(out.suggestions?.[1].title, 'learned fix');
  assert.equal(out.suggestions?.[1].candidate_index, 5);
  assert.deepEqual(out.learned?.map(entry => entry.kind), ['suggestion', 'hint']);
});

test('applyKnowledgeToAnalysis merges into source_analysis when present', () => {
  const analysis = baseAnalysis();
  analysis.source_analysis = {
    project_name: 'demo', requested_release: 'r', snapshot_release: 'r', snapshot_id: 1, match_type: 'exact',
    files_scanned: 1, crash_source: null, function_definition: null,
    references: [], related_functions: [], related_files: [], warnings: [],
    root_cause_candidates: [], fixes: [], crash_path: [],
  } as never;
  const out = applyKnowledgeToAnalysis(analysis, [
    { kind: 'suggestion', title: 'sf', description: '', confidence: 0.5, payload: {} },
    { kind: 'root_cause', title: 'rc', description: 'real reason', confidence: 0.8, payload: { file_path: 'z.py', line_number: 3, function_name: 'z', kind: 'out-of-range', evidence: [] } },
  ]);
  assert.equal(out.source_analysis?.fixes?.length, 1);
  assert.equal(out.source_analysis?.root_cause_candidates?.length, 1);
  assert.equal(out.source_analysis?.root_cause_candidates?.[0].kind, 'out-of-range');
  assert.equal(out.suggestions?.length, 1); // top-level untouched
});

test('applyKnowledgeToAnalysis without source_analysis keeps root causes out of the UI-critical fields', () => {
  const analysis = baseAnalysis();
  const out = applyKnowledgeToAnalysis(analysis, [
    { kind: 'root_cause', title: 'rc', description: 'reason', confidence: 0.8, payload: { file_path: 'z.py', line_number: 3, function_name: 'z', kind: 'generic', evidence: [] } },
  ]);
  assert.equal(out.source_analysis, undefined); // no fake source_analysis created
  assert.equal(out.suggestions?.length, 1); // only the deterministic one
  assert.equal(out.learned?.length, 1); // still surfaced as learned
});

test('normalizeReviewPayload accepts and trims the exception identity corrections', () => {
  const review = normalizeReviewPayload({
    correct: false,
    notes: '',
    corrections: {
      exception_type: '  NullReferenceException ',
      exception_message: ' obj was null ',
      detected_language: ' csharp ',
      runtime: ' dotnet ',
      runtime_version: ' 8.0 ',
      summary: ' rewritten summary ',
    },
    suggestions: [],
  });
  assert.ok(review);
  assert.equal(review.corrections.exception_type, 'NullReferenceException');
  assert.equal(review.corrections.exception_message, 'obj was null');
  assert.equal(review.corrections.detected_language, 'csharp');
  assert.equal(review.corrections.runtime, 'dotnet');
  assert.equal(review.corrections.runtime_version, '8.0');
  assert.equal(review.corrections.summary, 'rewritten summary');
});

test('applyReviewToAnalysis overwrites exception identity fields only when incorrect', () => {
  const review = {
    correct: false,
    notes: '',
    corrections: {
      exception_type: 'NullReferenceException',
      exception_message: 'obj was null',
      detected_language: 'csharp',
      runtime: 'dotnet',
      runtime_version: '8.0',
      summary: 'rewritten summary',
    },
    suggestions: [],
  };
  const out = applyReviewToAnalysis(baseAnalysis(), review);
  assert.equal(out.exception_type, 'NullReferenceException');
  assert.equal(out.exception_message, 'obj was null');
  assert.equal(out.detected_language, 'csharp');
  assert.equal(out.runtime, 'dotnet');
  assert.equal(out.runtime_version, '8.0');
  assert.equal(out.summary, 'rewritten summary');

  const untouched = applyReviewToAnalysis(baseAnalysis(), { ...review, correct: true });
  assert.equal(untouched.exception_type, 'NullReferenceException');
  assert.equal(untouched.exception_message, 'obj was null');
  assert.equal(untouched.detected_language, 'csharp');
  assert.equal(untouched.runtime, 'dotnet');
  assert.equal(untouched.summary, 'rewritten summary');
});
