import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completeWithDeepSeek, streamDeepSeek, AiProviderError } from './deepseek.js';
import type { AiFetch } from './deepseek.js';
import type { AiStreamEvent } from './types.js';

const request = { messages: [{ role: 'user' as const, content: 'question' }] };

test('DeepSeek adapter preserves the original answer and provider reasoning', async () => {
  const fakeFetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: ' answer ', reasoning_content: ' evidence-based reasoning ' } }],
  }), { status: 200 });

  const result = await completeWithDeepSeek('test-key', request, fakeFetch);
  assert.deepEqual(result, { content: ' answer ', reasoning: 'evidence-based reasoning' });
});

test('DeepSeek adapter does not fabricate missing reasoning', async () => {
  const fakeFetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'answer' } }] }), { status: 200 });
  const result = await completeWithDeepSeek('test-key', request, fakeFetch);
  assert.equal(result.reasoning, null);
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
