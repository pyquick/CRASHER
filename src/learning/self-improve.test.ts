import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { runSelfImproveCrash, runSelfImproveJob, SELF_IMPROVE_SYSTEM_PROMPT, SelfImproveError, type SelfImproveCrashOutcome } from './self-improve.js';
import { config } from '../config.js';
import { getDb, initDb } from '../database/connection.js';
import * as store from '../store.js';
import type { AuthenticatedUser } from '../model.js';
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
const noSources = () => Promise.resolve([]);

function sse(...lines: unknown[]): Response {
  const body = lines.map(line => `data: ${JSON.stringify(line)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200 });
}

function textTurn(content: string): Response {
  return sse({ choices: [{ delta: { content } }] });
}

function toolTurn(): Response {
  return sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read_source_file', arguments: '{"path":"src/a.ts"}' } }] } }] });
}

function queueFetch(responses: Response[]): AiFetch {
  return (async () => responses.shift() ?? textTurn('{}')) as AiFetch;
}

const VALID_PAYLOAD = JSON.stringify({
  language: 'typescript',
  knowledge: [
    { kind: 'hint', title: 'init order', description: 'services initialized after use', confidence: 0.8, payload: {} },
    { kind: 'suggestion', title: 'guard lookup', description: 'use optional chaining', confidence: 0.9, payload: { candidate_index: 0, crash_site_snippet: '', fix_site_snippet: '', code_before: 'x.y', code_after: 'x?.y' } },
  ],
});

test('runSelfImproveCrash runs the agent loop with tools and returns language + knowledge', async () => {
  const uses: number[] = [];
  const outcome = await runSelfImproveCrash(fakeContext(), 'deepseek-chat', keys, NOW, {
    loadSourceFiles: noSources,
    fetchImpl: queueFetch([toolTurn(), textTurn(VALID_PAYLOAD)]),
    onUse: (keyId) => uses.push(keyId),
  });
  assert.equal(outcome.language, 'typescript');
  assert.equal(outcome.knowledge.length, 2);
  assert.equal(outcome.knowledge[1].payload.code_after, 'x?.y');
  assert.deepEqual(uses, [1]);
});

test('runSelfImproveCrash rotates to the next key on auth failures', async () => {
  const failures: { keyId: number; code: string }[] = [];
  const responses = [textTurn(VALID_PAYLOAD)];
  const fetchImpl: AiFetch = (async (_url: string, init?: RequestInit) => {
    const auth = String((init?.headers as Record<string, string>)?.authorization ?? '');
    if (auth.includes('sk-1')) return new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 });
    return responses.shift() ?? textTurn(VALID_PAYLOAD);
  }) as AiFetch;
  const outcome = await runSelfImproveCrash(fakeContext(), 'deepseek-chat', keys, NOW, {
    loadSourceFiles: noSources,
    fetchImpl,
    onFailure: (keyId, code) => failures.push({ keyId, code }),
  });
  assert.equal(outcome.knowledge.length, 2);
  assert.deepEqual(failures, [{ keyId: 1, code: 'AI_PROVIDER_AUTH' }]);
});

test('runSelfImproveCrash retries once when the output is not valid JSON', async () => {
  const bodies: string[] = [];
  const fetchImpl: AiFetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ''));
    return bodies.length === 1 ? textTurn('not json') : textTurn(VALID_PAYLOAD);
  }) as AiFetch;
  const outcome = await runSelfImproveCrash(fakeContext(), 'deepseek-chat', [keys[0]], NOW, { loadSourceFiles: noSources, fetchImpl });
  assert.equal(outcome.knowledge.length, 2);
  assert.equal(bodies.length, 2);
});

test('runSelfImproveCrash fails with 502 when the output stays invalid', async () => {
  await assert.rejects(
    runSelfImproveCrash(fakeContext(), 'deepseek-chat', [keys[0]], NOW, { loadSourceFiles: noSources, fetchImpl: queueFetch([textTurn('nope'), textTurn('still nope')]) }),
    (error: unknown) => error instanceof SelfImproveError && error.code === 'AI_PROVIDER_RESPONSE' && error.status === 502,
  );
});

test('runSelfImproveCrash reports the raw output snippet when the response stays invalid', async () => {
  await assert.rejects(
    runSelfImproveCrash(fakeContext(), 'deepseek-chat', [keys[0]], NOW, { loadSourceFiles: noSources, fetchImpl: queueFetch([textTurn('nope'), textTurn('raw <toolcalls> garbage')]) }),
    (error: unknown) => error instanceof SelfImproveError
      && error.code === 'AI_PROVIDER_RESPONSE'
      && error.message.includes('raw <toolcalls> garbage'),
  );
});

test('runSelfImproveCrash picks the last JSON object that carries the knowledge array', async () => {
  const content = '{"plan": "read the file first"}\n' + VALID_PAYLOAD;
  const outcome = await runSelfImproveCrash(fakeContext(), 'deepseek-chat', [keys[0]], NOW, { loadSourceFiles: noSources, fetchImpl: queueFetch([textTurn(content)]) });
  assert.equal(outcome.language, 'typescript');
  assert.equal(outcome.knowledge.length, 2);
});

test('runSelfImproveCrash skips earlier knowledge-less objects and accepts a trailing payload', async () => {
  const content = '{"step": 1}\n{"step": 2}\n' + VALID_PAYLOAD;
  const outcome = await runSelfImproveCrash(fakeContext(), 'deepseek-chat', [keys[0]], NOW, { loadSourceFiles: noSources, fetchImpl: queueFetch([textTurn(content)]) });
  assert.equal(outcome.knowledge.length, 2);
});

test('runSelfImproveCrash throws 409 when no keys are configured', async () => {
  await assert.rejects(
    runSelfImproveCrash(fakeContext(), undefined, [], NOW, { loadSourceFiles: noSources }),
    (error: unknown) => error instanceof SelfImproveError && error.code === 'AI_PROVIDER_NOT_CONFIGURED' && error.status === 409,
  );
});

test('runSelfImproveCrash surfaces non-rotatable provider errors as 502', async () => {
  const fetchImpl: AiFetch = (async () => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 })) as AiFetch;
  await assert.rejects(
    runSelfImproveCrash(fakeContext(), 'deepseek-chat', [keys[0]], NOW, { loadSourceFiles: noSources, fetchImpl }),
    (error: unknown) => error instanceof SelfImproveError && error.code === 'AI_PROVIDER_HTTP' && error.status === 502,
  );
});

test('the self-improve prompt includes the knowledge schema and tool guidance', async () => {
  let firstBody = '';
  const fetchImpl: AiFetch = (async (_url: string, init?: RequestInit) => {
    if (!firstBody) firstBody = String(init?.body ?? '');
    return textTurn(VALID_PAYLOAD);
  }) as AiFetch;
  await runSelfImproveCrash(fakeContext(), 'deepseek-chat', [keys[0]], NOW, { loadSourceFiles: noSources, fetchImpl });
  const parsed = JSON.parse(firstBody);
  assert.equal(parsed.messages[0].content, SELF_IMPROVE_SYSTEM_PROMPT);
  assert.ok(parsed.messages[0].content.includes('knowledge'));
  assert.ok(parsed.messages[0].content.includes('read_source_file'));
  assert.ok(parsed.messages[1].content.includes('deterministic_analysis'));
});

// ── Background job loop (in-memory DB) ──

let dbInitialized = false;
function initTestDb(): void {
  if (dbInitialized) return;
  dbInitialized = true;
  config.dbPath = ':memory:';
  config.symbolsDir = os.tmpdir();
  config.attachmentsDir = os.tmpdir();
  config.sourcesDir = os.tmpdir();
  initDb();
  getDb().prepare("INSERT INTO users (username, password_hash, role) VALUES ('tester', 'h', 'ultraadmin')").run();
}

const USER = { id: 1, username: 'tester', role: 'ultraadmin', container_id: null } as AuthenticatedUser;
const OK_OUTCOME: SelfImproveCrashOutcome = {
  language: 'typescript',
  knowledge: [{ kind: 'hint', title: 'init order', description: 'services initialized after use', confidence: 0.8, payload: {} }],
  model: 'deepseek-chat',
};

function insertReport(exceptionType: string, hash: string, groupId: number | null): number {
  const db = getDb();
  const result = db.prepare(`INSERT INTO crash_reports (group_id, exception_type, exception_message, stack_trace, runtime)
    VALUES (?, ?, 'x is undefined', 'at load (/app/src/a.ts:1:2)', 'typescript')`).run(groupId, exceptionType);
  return Number(result.lastInsertRowid);
}

function insertGroup(hash: string): number {
  const db = getDb();
  const result = db.prepare(`INSERT INTO crash_groups (crash_hash, exception_type, first_seen, last_seen)
    VALUES (?, 'TypeError', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`).run(hash);
  return Number(result.lastInsertRowid);
}

function jobOptions(runCrash: typeof runSelfImproveCrash) {
  return {
    model: 'deepseek-chat',
    keys,
    loadSourceFiles: () => Promise.resolve([]),
    isCancelled: () => false,
    runCrash,
  };
}

test('runSelfImproveJob marks learned crashes, upserts knowledge and completes', async () => {
  initTestDb();
  const groupId = insertGroup('hash-job-1');
  const reportA = insertReport('TypeError', 'hash-job-1', groupId);
  const reportB = insertReport('TypeError', 'hash-job-1', null); // no group: skipped without an agent run
  let crashCalls = 0;
  const job = store.createAnalysisLearningJob(USER.id, null, 'deepseek-chat', 2, NOW);
  await runSelfImproveJob(job, USER, undefined, jobOptions((async () => {
    crashCalls += 1;
    return OK_OUTCOME;
  }) as typeof runSelfImproveCrash));

  assert.equal(crashCalls, 1);
  assert.equal(store.getReportById(reportA)?.analysis_learned, 1);
  assert.equal(store.getReportById(reportB)?.analysis_learned, 1);
  assert.equal(store.listUnlearnedReports(undefined).length, 0);
  assert.equal(store.listAnalysisKnowledge('TypeError', 'typescript').length, 1);
  const finished = store.getAnalysisLearningJob(job.id);
  assert.equal(finished?.status, 'completed');
  assert.equal(finished?.processed_count, 2);
  assert.equal(finished?.knowledge_count, 1);
});

test('runSelfImproveJob retries a failed crash 5 times, then skips it without marking learned', async () => {
  initTestDb();
  const groupId = insertGroup('hash-job-2');
  const failingReport = insertReport('KeyError', 'hash-job-2', groupId);
  const noGroupReport = insertReport('KeyError', 'hash-job-2', null);
  let crashCalls = 0;
  const job = store.createAnalysisLearningJob(USER.id, null, 'deepseek-chat', 2, NOW);
  await runSelfImproveJob(job, USER, undefined, jobOptions((async () => {
    crashCalls += 1;
    throw new SelfImproveError('The AI self-improvement returned an invalid response: raw <toolcalls>', 'AI_PROVIDER_RESPONSE', 502);
  }) as typeof runSelfImproveCrash));

  assert.equal(crashCalls, 5); // 5 attempts, then skipped within the same run
  assert.equal(store.getReportById(failingReport)?.analysis_learned, 0); // stays unlearned for the next run
  assert.equal(store.getReportById(noGroupReport)?.analysis_learned, 1);
  const unlearned = store.listUnlearnedReports(undefined);
  assert.equal(unlearned.length, 1);
  assert.equal(unlearned[0].id, failingReport);
  const finished = store.getAnalysisLearningJob(job.id);
  assert.equal(finished?.status, 'completed');
  assert.equal(finished?.processed_count, 1);
  assert.equal(finished?.knowledge_count, 0);
  assert.ok(finished?.error_message?.includes('invalid response'));
  const logs = store.listAnalysisLearningJobLogs(job.id);
  assert.ok(logs.some(entry => entry.message.includes('job started')));
  assert.ok(logs.some(entry => entry.report_id === failingReport && entry.message.includes('attempt 1/5 failed')));
  assert.ok(logs.some(entry => entry.report_id === failingReport && entry.message.includes('failed after 5 attempts')));
  assert.ok(logs.some(entry => entry.report_id === noGroupReport && entry.message.includes('no crash group')));
  assert.ok(logs.some(entry => entry.message.includes('job completed')));
  // Fixture cleanup: the intentionally-unlearned report must not leak into later tests.
  getDb().prepare('DELETE FROM crash_reports WHERE id = ?').run(failingReport);
});

test('updateReportException overwrites the stored exception values with review corrections', () => {
  initTestDb();
  const groupId = insertGroup('hash-job-4');
  const reportId = insertReport('TypeError', 'hash-job-4', groupId);
  assert.equal(store.updateReportException(reportId, { exceptionType: 'NullRefException', exceptionMessage: 'fixed message', now: NOW }), true);
  const updated = store.getReportById(reportId);
  assert.equal(updated?.exception_type, 'NullRefException');
  assert.equal(updated?.exception_message, 'fixed message');
  assert.equal(store.updateReportException(reportId, { exceptionType: 'OnlyType', now: NOW }), true);
  assert.equal(store.getReportById(reportId)?.exception_type, 'OnlyType');
  assert.equal(store.getReportById(reportId)?.exception_message, 'fixed message'); // untouched when omitted
  getDb().prepare('DELETE FROM crash_reports WHERE id = ?').run(reportId);
});

test('runSelfImproveJob stops promptly when cancelled mid-crash and leaves the report unlearned', async () => {
  initTestDb();
  const groupId = insertGroup('hash-job-5');
  const reportId = insertReport('ValueError', 'hash-job-5', groupId);
  const controller = new AbortController();
  let cancelled = false;
  const job = store.createAnalysisLearningJob(USER.id, null, 'deepseek-chat', 1, NOW);
  store.updateAnalysisLearningJob(job.id, { status: 'cancelled', now: NOW }); // what the cancel endpoint does
  let crashCalls = 0;
  const runJob = runSelfImproveJob(job, USER, undefined, {
    model: 'deepseek-chat',
    keys,
    loadSourceFiles: () => Promise.resolve([]),
    isCancelled: () => cancelled,
    signal: controller.signal,
    runCrash: (async (_context, _model, _keys, _now, opts) => {
      crashCalls += 1;
      await new Promise<void>((resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new SelfImproveError('AI generation was stopped', 'AI_CANCELLED', 502)), { once: true });
      });
      return OK_OUTCOME;
    }) as typeof runSelfImproveCrash,
  });
  await new Promise(resolve => setTimeout(resolve, 50)); // let the attempt start
  cancelled = true;
  controller.abort();
  await runJob;

  assert.equal(crashCalls, 1);
  assert.equal(store.getReportById(reportId)?.analysis_learned, 0); // never learned
  assert.equal(store.getAnalysisLearningJob(job.id)?.status, 'cancelled'); // not overwritten
  const logs = store.listAnalysisLearningJobLogs(job.id);
  assert.ok(!logs.some(entry => entry.message.includes('attempt 1/5 failed'))); // quiet exit
  getDb().prepare('DELETE FROM crash_reports WHERE id = ?').run(reportId);
});

test('runSelfImproveJob marks the crash learned once an attempt succeeds', async () => {
  initTestDb();
  const groupId = insertGroup('hash-job-3');
  const retriedReport = insertReport('IndexError', 'hash-job-3', groupId);
  let crashCalls = 0;
  const job = store.createAnalysisLearningJob(USER.id, null, 'deepseek-chat', 1, NOW);
  await runSelfImproveJob(job, USER, undefined, jobOptions((async () => {
    crashCalls += 1;
    if (crashCalls < 3) throw new SelfImproveError('transient failure', 'AI_PROVIDER_RESPONSE', 502);
    return OK_OUTCOME;
  }) as typeof runSelfImproveCrash));

  assert.equal(crashCalls, 3); // succeeded on attempt 3
  assert.equal(store.getReportById(retriedReport)?.analysis_learned, 1);
  const finished = store.getAnalysisLearningJob(job.id);
  assert.equal(finished?.status, 'completed');
  assert.equal(finished?.processed_count, 1);
  assert.equal(finished?.knowledge_count, 1);
  const logs = store.listAnalysisLearningJobLogs(job.id);
  assert.ok(logs.some(entry => entry.report_id === retriedReport && entry.message.includes('attempt 2/5 failed')));
  assert.ok(logs.some(entry => entry.report_id === retriedReport && entry.message.includes('learned 1 knowledge entry')));
});
