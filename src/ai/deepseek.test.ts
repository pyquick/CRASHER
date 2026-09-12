import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completeWithDeepSeek, streamDeepSeek, AiProviderError, parseDsmlToolCalls } from './deepseek.js';
import type { AiFetch } from './deepseek.js';
import type { AiStreamEvent } from './types.js';

const request = { messages: [{ role: 'user' as const, content: 'question' }] };

test('DeepSeek adapter preserves the original answer and provider reasoning', async () => {
  const fakeFetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: ' answer ', reasoning_content: ' evidence-based reasoning ' } }],
  }), { status: 200 });

  const result = await completeWithDeepSeek('test-key', request, fakeFetch);
  assert.deepEqual(result, { content: ' answer ', reasoning: 'evidence-based reasoning', toolCalls: null });
});

test('DeepSeek adapter does not fabricate missing reasoning', async () => {
  const fakeFetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'answer' } }] }), { status: 200 });
  const result = await completeWithDeepSeek('test-key', request, fakeFetch);
  assert.equal(result.reasoning, null);
});

test('DeepSeek adapter parses tool calls and tolerates empty content on tool turns', async () => {
  const fakeFetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: '', tool_calls: [
      { id: 'call-1', type: 'function', function: { name: 'read_source_file', arguments: '{"path":"a.cs"}' } },
      { id: 'call-2', type: 'function', function: { name: 'web_fetch', arguments: '{"url":"https://example.com"}' } },
    ] } }],
  }), { status: 200 });
  const result = await completeWithDeepSeek('test-key', request, fakeFetch);
  assert.equal(result.content, '');
  assert.deepEqual(result.toolCalls, [
    { id: 'call-1', name: 'read_source_file', arguments: '{"path":"a.cs"}' },
    { id: 'call-2', name: 'web_fetch', arguments: '{"url":"https://example.com"}' },
  ]);
});

test('DeepSeek adapter returns content and tool calls together when both are present', async () => {
  const fakeFetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: 'checking…', tool_calls: [
      { id: 'call-1', type: 'function', function: { name: 'update_tasks', arguments: '{"tasks":[]}' } },
    ] } }],
  }), { status: 200 });
  const result = await completeWithDeepSeek('test-key', request, fakeFetch);
  assert.equal(result.content, 'checking…');
  assert.equal(result.toolCalls?.length, 1);
});

test('DeepSeek adapter rejects empty responses without tool calls', async () => {
  const fakeFetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 });
  await assert.rejects(
    completeWithDeepSeek('test-key', request, fakeFetch),
    (error: unknown) => error instanceof AiProviderError && error.code === 'AI_PROVIDER_RESPONSE',
  );
});

test('DeepSeek adapter sends the thinking object per the official v4 API', async () => {
  let capturedBody = '';
  const fakeFetch = async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = String(init?.body ?? '');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  };
  // Enabled: thinking {"type":"enabled"}.
  await completeWithDeepSeek('test-key', { ...request, thinking: true }, fakeFetch);
  const enabledBody = JSON.parse(capturedBody) as { thinking?: { type: string } };
  assert.deepEqual(enabledBody.thinking, { type: 'enabled' });

  // Disabled: the provider defaults to enabled, so the toggle must be explicit.
  await completeWithDeepSeek('test-key', { ...request, thinking: false }, fakeFetch);
  const disabledBody = JSON.parse(capturedBody) as { thinking?: { type: string } };
  assert.deepEqual(disabledBody.thinking, { type: 'disabled' });

  // Unset: no field at all.
  await completeWithDeepSeek('test-key', request, fakeFetch);
  const omittingBody = JSON.parse(capturedBody) as { thinking?: unknown };
  assert.ok(!('thinking' in omittingBody));
});

test('DeepSeek adapter sends tools and tool_choice only when provided', async () => {
  let capturedBody = '';
  const fakeFetch = async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = String(init?.body ?? '');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  };
  await completeWithDeepSeek('test-key', { ...request, tools: [{ type: 'function', function: { name: 't' } }] }, fakeFetch);
  assert.ok(capturedBody.includes('"tools"'));
  assert.ok(capturedBody.includes('"tool_choice":"auto"'));

  await completeWithDeepSeek('test-key', request, fakeFetch);
  assert.ok(!capturedBody.includes('"tools"'));
  assert.ok(!capturedBody.includes('"tool_choice"'));

  await completeWithDeepSeek('test-key', { ...request, tools: [] }, fakeFetch);
  assert.ok(!capturedBody.includes('"tools"'));
  assert.ok(!capturedBody.includes('"tool_choice"'));
});

test('DeepSeek adapter serializes in-loop tool messages in provider wire format', async () => {
  let capturedBody = '';
  const fakeFetch = async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = String(init?.body ?? '');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  };
  const withTools: typeof request = {
    messages: [
      { role: 'assistant', content: '', tool_calls: [{ id: 'call-9', name: 'read_source_file', arguments: '{"list":true}' }] },
      { role: 'tool', content: 'result text', tool_call_id: 'call-9' },
      { role: 'user', content: 'go on' },
    ],
  };
  await completeWithDeepSeek('test-key', withTools, fakeFetch);
  const body = JSON.parse(capturedBody) as { messages: Array<Record<string, unknown>> };
  assert.deepEqual(body.messages[0].tool_calls, [
    { id: 'call-9', type: 'function', function: { name: 'read_source_file', arguments: '{"list":true}' } },
  ]);
  assert.equal(body.messages[1].tool_call_id, 'call-9');
  assert.equal(body.messages[1].role, 'tool');
});

test('DeepSeek adapter classifies provider authentication failures', async () => {
  const fakeFetch = async () => new Response('bad', { status: 401 });
  await assert.rejects(
    completeWithDeepSeek('test-key', request, fakeFetch),
    (error: unknown) => error instanceof AiProviderError && error.code === 'AI_PROVIDER_AUTH' && error.status === 401,
  );
});

test('DeepSeek adapter preserves rate-limit retry metadata', async () => {
  const fakeFetch = async () => new Response(JSON.stringify({ error: { message: 'slow down' } }), {
    status: 429,
    headers: { 'retry-after': '45' },
  });
  await assert.rejects(
    completeWithDeepSeek('test-key', request, fakeFetch),
    (error: unknown) => error instanceof AiProviderError
      && error.code === 'AI_PROVIDER_RATE_LIMIT'
      && error.retryAfterSeconds === 45,
  );
});

test('DeepSeek adapter forwards cancellation and reports it separately', async () => {
  let receivedSignal: AbortSignal | undefined;
  const fakeFetch = async (_input: string | URL | Request, init?: RequestInit) => {
    receivedSignal = init?.signal ?? undefined;
    return await new Promise<Response>((_resolve, reject) => {
      receivedSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  };
  const controller = new AbortController();
  const pending = completeWithDeepSeek('test-key', request, fakeFetch, controller.signal);
  controller.abort();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof AiProviderError && error.code === 'AI_CANCELLED',
  );
  assert.equal(receivedSignal?.aborted, true);
});

test('DeepSeek adapter rejects malformed successful responses', async () => {
  const fakeFetch = async () => new Response(JSON.stringify({ choices: [] }), { status: 200 });
  await assert.rejects(
    completeWithDeepSeek('test-key', request, fakeFetch),
    (error: unknown) => error instanceof AiProviderError && error.code === 'AI_PROVIDER_RESPONSE',
  );
});

// ── Streaming ──

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

async function collectStream(fetchImpl: AiFetch, signal?: AbortSignal): Promise<AiStreamEvent[]> {
  const events: AiStreamEvent[] = [];
  for await (const event of streamDeepSeek('test-key', request, fetchImpl, signal)) events.push(event);
  return events;
}

test('streamDeepSeek parses content and reasoning deltas across split frames', async () => {
  const fakeFetch = async () => sseResponse([
    'data: {"choices":[{"delta":{"content":"Hel',
    'lo"}}]}\n\ndata: {"choices":[{"delta":{"reasoning_content":"why"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\ndata: [DONE]\n\n',
  ]);
  const events = await collectStream(fakeFetch);
  assert.deepEqual(events, [
    { type: 'delta', content: 'Hello' },
    { type: 'reasoning', content: 'why' },
    { type: 'delta', content: ' world' },
    { type: 'done' },
  ]);
});

test('streamDeepSeek classifies pre-stream HTTP quota failures', async () => {
  const fakeFetch = async () => new Response(JSON.stringify({ error: { message: 'balance' } }), { status: 402 });
  await assert.rejects(
    collectStream(fakeFetch),
    (error: unknown) => error instanceof AiProviderError && error.code === 'AI_PROVIDER_QUOTA',
  );
});

test('streamDeepSeek rejects streams that end without [DONE]', async () => {
  const fakeFetch = async () => sseResponse(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n']);
  await assert.rejects(
    collectStream(fakeFetch),
    (error: unknown) => error instanceof AiProviderError && error.code === 'AI_PROVIDER_RESPONSE',
  );
});

test('streamDeepSeek skips malformed frames and ignores empty deltas', async () => {
  const fakeFetch = async () => sseResponse([
    'data: not-json\n\ndata: {"choices":[{"delta":{}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
  ]);
  const events = await collectStream(fakeFetch);
  assert.deepEqual(events, [{ type: 'delta', content: 'ok' }, { type: 'done' }]);
});

test('streamDeepSeek accumulates fragmented tool-call deltas', async () => {
  const fakeFetch = async () => sseResponse([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"read_source_file","arguments":"{\\"path\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.cs\\"}"}}]}}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  const events = await collectStream(fakeFetch);
  assert.deepEqual(events, [
    { type: 'done', toolCalls: [{ id: 'call-1', name: 'read_source_file', arguments: '{"path":"a.cs"}' }] },
  ]);
});

test('DeepSeek adapter parses the plain DSML dialect the model emits (leaked tool-call text)', () => {
  const leaked = '<toolcalls><invoke name="readsourcefile"> <parameter name="path" string="true">detections/deviceprobe.py</parameter> <parameter name="startline" string="false">1100</parameter> <parameter name="endline" string="false">1225</parameter> </invoke> </toolcalls>';
  const result = parseDsmlToolCalls(leaked);
  assert.deepEqual(result, {
    content: '',
    toolCalls: [{ id: 'dsml-1', name: 'read_source_file', arguments: '{"path":"detections/deviceprobe.py","start_line":1100,"end_line":1225}' }],
  });
});

test('DeepSeek adapter parses the official special-token DSML dialect', () => {
  const official = 'Check the docs.<\uFF5Ctool\u2581calls\u2581begin\uFF5C><\uFF5Ctool\u2581call\u2581begin\uFF5C>web_fetch<\uFF5Ctool\u2581sep\uFF5C>{"url":"https://example.com/docs"}<\uFF5Ctool\u2581call\u2581end\uFF5C><\uFF5Ctool\u2581calls\u2581end\uFF5C>';
  const result = parseDsmlToolCalls(official);
  assert.deepEqual(result, {
    content: 'Check the docs.',
    toolCalls: [{ id: 'dsml-1', name: 'web_fetch', arguments: '{"url":"https://example.com/docs"}' }],
  });
});

test('DSML parsing strips the protocol block but keeps surrounding prose', () => {
  const result = parseDsmlToolCalls('Before.<toolcalls><invoke name="webfetch"><parameter name="url" string="true">https://a.b</parameter></invoke></toolcalls>After.');
  assert.deepEqual(result, {
    content: 'Before.After.',
    toolCalls: [{ id: 'dsml-1', name: 'web_fetch', arguments: '{"url":"https://a.b"}' }],
  });
});

test('DeepSeek adapter parses DSML tool calls from a streamed content turn without leaking the markup', async () => {
  const dsml = 'Let me look at the file.<toolcalls><invoke name="readsourcefile"><parameter name="path">appentry.py</parameter></invoke></toolcalls>';
  const fakeFetch = async () => sseResponse([
    `data: {"choices":[{"delta":{"content":${JSON.stringify(dsml.slice(0, 90))}}}]}

`,
    `data: {"choices":[{"delta":{"content":${JSON.stringify(dsml.slice(90))}}}]}

`,
    'data: [DONE]\n\n',
  ]);
  const events = await collectStream(fakeFetch);
  assert.deepEqual(events, [
    { type: 'delta', content: 'Let me look at the file.' },
    { type: 'done', toolCalls: [{ id: 'dsml-1', name: 'read_source_file', arguments: '{"path":"appentry.py"}' }] },
  ]);
});

test('streamDeepSeek holds back and converts the official special-token DSML dialect', async () => {
  const dsml = 'Checking.<\uFF5Ctool\u2581calls\u2581begin\uFF5C><\uFF5Ctool\u2581call\u2581begin\uFF5C>web_fetch<\uFF5Ctool\u2581sep\uFF5C>{"url":"https://example.com"}<\uFF5Ctool\u2581call\u2581end\uFF5C><\uFF5Ctool\u2581calls\u2581end\uFF5C>';
  const fakeFetch = async () => sseResponse([
    `data: {"choices":[{"delta":{"content":${JSON.stringify(dsml.slice(0, 40))}}}]}

`,
    `data: {"choices":[{"delta":{"content":${JSON.stringify(dsml.slice(40))}}}]}

`,
    'data: [DONE]\n\n',
  ]);
  const events = await collectStream(fakeFetch);
  assert.deepEqual(events, [
    { type: 'delta', content: 'Checking.' },
    { type: 'done', toolCalls: [{ id: 'dsml-1', name: 'web_fetch', arguments: '{"url":"https://example.com"}' }] },
  ]);
});

test('completeWithDeepSeek converts DSML content into tool calls', async () => {
  const fakeFetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: '<toolcalls><invoke name="runbash"><parameter name="command" string="true">ls</parameter></invoke></toolcalls>' } }],
  }), { status: 200 });
  const result = await completeWithDeepSeek('test-key', request, fakeFetch);
  assert.equal(result.content, '');
  assert.deepEqual(result.toolCalls, [{ id: 'dsml-1', name: 'run_bash', arguments: '{"command":"ls"}' }]);
});

test('streamDeepSeek reports client cancellation separately', async () => {
  const fakeFetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
      },
    });
    return new Response(stream, { status: 200 });
  };
  const controller = new AbortController();
  const pending = collectStream(fakeFetch, controller.signal);
  controller.abort();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof AiProviderError && error.code === 'AI_CANCELLED',
  );
});
