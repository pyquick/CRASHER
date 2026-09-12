import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_SYSTEM_PROMPT, ReviewError, runReview } from './review.js';
import type { AiFetch } from '../ai/deepseek.js';
import type { ScopedCrashContext } from '../ai/types.js';

function fakeContext(): ScopedCrashContext {
  return {
    group: { id: 1, project_name: 'demo', exception_type: 'TypeError', exception_message: 'x is undefined', total_count: 1, first_seen: '2026-01-01 00:00:00', last_seen: '2026-01-01 00:00:00' },
    report: { id: 7, runtime: 'typescript', runtime_version: '5.9', release: 'abc', platform: 'web', app_version: '1.0', exception_type: 'TypeError', exception_message: 'x is undefined', stack_trace: 'at load (/app/src/a.ts:1:2)', symbolicated_stack: null, log_text: null, dump_info: null },
    analysis: {
      report_id: 7, exception_type: 'TypeError', exception_message: 'x is undefined', detected_language: 'typescript',
      file_tree: [],
      trigger_point: { file_path: 'src/a.ts', line_number: 1, function_name: 'load', message: 'm', raw_snippet: '' },
      stack_chain: [],
      summary: 'the engine summary',
      runtime: 'typescript', runtime_version: '5.9',
      crash_path: [],
      suggestions: [],
    },
    sourceAvailable: false,
    sourceSnapshotId: null,
    sourceFiles: [],
  } as unknown as ScopedCrashContext;
}

const keys = [{ id: 1, key: 'sk-1' }, { id: 2, key: 'sk-2' }];
const NOW = '2026-09-05 10:00:00';

function okFetch(content: string): AiFetch {
  return (async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })) as AiFetch;
}

const VALID_PAYLOAD = JSON.stringify({
  correct: true,
  notes: '分析正确',
  corrections: {},
  suggestions: [{ candidate_index: 0, title: 't', description: 'd', crash_site_snippet: '', fix_site_snippet: '', code_before: '', code_after: '', confidence: 0.9 }],
});

test('runReview returns the validated payload and records key use', async () => {
  const uses: number[] = [];
  const outcome = await runReview(fakeContext(), 'deepseek-chat', keys, NOW, {
    fetchImpl: okFetch(VALID_PAYLOAD),
    onUse: (keyId) => uses.push(keyId),
  });
  assert.equal(outcome.model, 'deepseek-chat');
  assert.equal(outcome.review.correct, true);
  assert.equal(outcome.review.notes, '分析正确');
  assert.equal(outcome.review.suggestions.length, 1);
  assert.deepEqual(uses, [1]);
});

test('runReview retries once with feedback when the first output is not valid JSON', async () => {
  const bodies: string[] = [];
  let attempt = 0;
  const fetchImpl: AiFetch = (async (_url: string, init?: RequestInit) => {
    attempt += 1;
    bodies.push(String(init?.body ?? ''));
    const content = attempt === 1 ? 'sorry, no JSON here' : VALID_PAYLOAD;
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }) as AiFetch;
  const outcome = await runReview(fakeContext(), undefined, [keys[0]], NOW, { fetchImpl });
  assert.equal(outcome.review.correct, true);
  assert.equal(bodies.length, 2);
  const retryBody = JSON.parse(bodies[1]);
  assert.ok(retryBody.messages[3].content.includes('not valid JSON'));
});

test('runReview fails with 502 when both attempts are invalid', async () => {
  await assert.rejects(
    runReview(fakeContext(), undefined, [keys[0]], NOW, { fetchImpl: okFetch('still not json') }),
    (error: unknown) => error instanceof ReviewError && error.code === 'AI_PROVIDER_RESPONSE' && error.status === 502,
  );
});

test('runReview picks the first JSON object that matches the review schema', async () => {
  const content = '{"summary": "a stray plan object"}\n' + VALID_PAYLOAD;
  const outcome = await runReview(fakeContext(), undefined, [keys[0]], NOW, { fetchImpl: okFetch(content) });
  assert.equal(outcome.review.correct, true);
  assert.equal(outcome.review.notes, '分析正确');
});

test('runReview normalizes the full correction schema including exception fields', async () => {
  const payload = JSON.stringify({
    correct: false,
    notes: 'wrong type',
    corrections: {
      exception_type: '  NullReferenceException  ',
      exception_message: 'obj was null',
      detected_language: 'csharp',
      runtime: 'dotnet',
      runtime_version: '8.0',
      summary: 'new summary',
    },
    suggestions: [],
  });
  const outcome = await runReview(fakeContext(), undefined, [keys[0]], NOW, { fetchImpl: okFetch(payload) });
  assert.equal(outcome.review.corrections.exception_type, 'NullReferenceException');
  assert.equal(outcome.review.corrections.exception_message, 'obj was null');
  assert.equal(outcome.review.corrections.detected_language, 'csharp');
  assert.equal(outcome.review.corrections.runtime, 'dotnet');
  assert.equal(outcome.review.corrections.runtime_version, '8.0');
  assert.equal(outcome.review.corrections.summary, 'new summary');
});

test('runReview throws 409 when no keys are configured', async () => {
  await assert.rejects(
    runReview(fakeContext(), undefined, [], NOW),
    (error: unknown) => error instanceof ReviewError && error.code === 'AI_PROVIDER_NOT_CONFIGURED' && error.status === 409,
  );
});

test('runReview rotates to the next key on auth failures', async () => {
  const failures: { keyId: number; code: string }[] = [];
  const uses: number[] = [];
  const fetchImpl: AiFetch = (async (_url: string, init?: RequestInit) => {
    const key = String((init?.headers as Record<string, string>)?.authorization ?? '');
    if (key.includes('sk-1')) return new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 });
    return new Response(JSON.stringify({ choices: [{ message: { content: VALID_PAYLOAD } }] }), { status: 200 });
  }) as AiFetch;
  const outcome = await runReview(fakeContext(), undefined, keys, NOW, {
    fetchImpl,
    onUse: (keyId) => uses.push(keyId),
    onFailure: (keyId, code) => failures.push({ keyId, code }),
  });
  assert.equal(outcome.review.correct, true);
  assert.deepEqual(uses, [2]);
  assert.deepEqual(failures, [{ keyId: 1, code: 'AI_PROVIDER_AUTH' }]);
});

test('runReview surfaces non-rotatable provider errors as 502', async () => {
  const fetchImpl: AiFetch = (async () => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 })) as AiFetch;
  await assert.rejects(
    runReview(fakeContext(), undefined, [keys[0]], NOW, { fetchImpl }),
    (error: unknown) => error instanceof ReviewError && error.code === 'AI_PROVIDER_HTTP' && error.status === 502,
  );
});

test('review keeps deterministic source matching facts and prioritizes relevant source excerpts', async () => {
  let capturedBody = '';
  const context = fakeContext();
  context.analysis = {
    ...context.analysis!,
    stack_chain: [{ index: 0, language: 'typescript', file_path: 'src/target.ts', line_number: 1, column_number: null, function_name: 'load', module_name: '', address: '', raw_line: '', severity: 'trigger' }],
    source_analysis: {
      project_name: 'demo', requested_release: 'abc', snapshot_release: 'abc', snapshot_id: 9, match_type: 'exact',
      files_scanned: 25,
      crash_source: { file_path: 'src/target.ts', line_number: 1, function_name: 'load', snippet: '> 1 | crash' },
      function_definition: null, references: [], related_functions: [], related_files: [], warnings: [],
    },
  };
  context.sourceAvailable = true;
  context.sourceSnapshotId = 9;
  context.sourceFiles = Array.from({ length: 25 }, (_, index) => ({
    relative_path: index === 24 ? 'src/target.ts' : `src/other-${index}.ts`,
    language: 'typescript',
    content: index === 24 ? 'target source' : `other source ${index}`,
  }));
  const fetchImpl: AiFetch = (async (_url: string, init?: RequestInit) => {
    capturedBody = String(init?.body ?? '');
    return new Response(JSON.stringify({ choices: [{ message: { content: VALID_PAYLOAD } }] }), { status: 200 });
  }) as AiFetch;
  await runReview(context, undefined, [keys[0]], NOW, { fetchImpl });
  const request = JSON.parse(capturedBody);
  assert.equal(request.tools, undefined);
  assert.equal(request.messages.length, 2);
  const prompt = JSON.parse(request.messages[1].content);
  assert.equal(prompt.deterministic_analysis.source_analysis.match_type, 'exact');
  assert.equal(prompt.deterministic_analysis.source_analysis.snapshot_id, 9);
  assert.equal(prompt.uploaded_source_files[0].path, 'src/target.ts');
});

test('the review prompt includes the deterministic analysis, the full correction schema and NO knowledge contract', async () => {
  let capturedBody = '';
  const fetchImpl: AiFetch = (async (_url: string, init?: RequestInit) => {
    capturedBody = String(init?.body ?? '');
    return new Response(JSON.stringify({ choices: [{ message: { content: VALID_PAYLOAD } }] }), { status: 200 });
  }) as AiFetch;
  await runReview(fakeContext(), undefined, [keys[0]], NOW, { fetchImpl });
  const parsed = JSON.parse(capturedBody);
  assert.equal(parsed.messages[0].content, REVIEW_SYSTEM_PROMPT);
  assert.ok(!parsed.messages[0].content.includes('knowledge'));
  for (const field of ['exception_type', 'exception_message', 'detected_language', 'runtime', 'runtime_version', 'summary', 'trigger_point', 'stack_chain', 'crash_path', 'root_cause_candidates', 'file_tree_updates', 'suggestions']) {
    assert.ok(parsed.messages[0].content.includes(field), `prompt missing ${field}`);
  }
  assert.ok(parsed.messages[1].content.includes('deterministic_analysis'));
});
