import { config } from '../config.js';
import type { AiProviderRequest, AiProviderResponse, AiStreamEvent } from './types.js';

const DEEPSEEK_ENDPOINT = () => config.aiDeepseekEndpoint;

export type AiFetch = typeof fetch;

export class AiProviderError extends Error {
  constructor(
    message: string,
    public readonly code = 'AI_PROVIDER_ERROR',
    public readonly status?: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function buildRequestBody(request: AiProviderRequest, stream: boolean): string {
  return JSON.stringify({
    model: (request.model || config.aiDeepseekModel).replace('[1m]', ''),
    messages: request.messages,
    temperature: 0.2,
    max_tokens: 4096,
    stream,
  });
}

async function classifyHttpError(response: Response): Promise<AiProviderError> {
  let providerMessage = '';
  try {
    const errorPayload = await response.json() as unknown;
    if (isRecord(errorPayload) && isRecord(errorPayload.error) && typeof errorPayload.error.message === 'string') providerMessage = errorPayload.error.message;
  } catch {}
  const retryAfterHeader = response.headers.get('retry-after');
  const retryAfterSeconds = retryAfterHeader && /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) : undefined;
  const message = providerMessage ? `The AI provider rejected the request: ${providerMessage}` : 'The AI provider rejected the request';
  const code = response.status === 401 || response.status === 403 ? 'AI_PROVIDER_AUTH'
    : response.status === 402 ? 'AI_PROVIDER_QUOTA'
      : response.status === 429 ? 'AI_PROVIDER_RATE_LIMIT'
        : 'AI_PROVIDER_HTTP';
  return new AiProviderError(message, code, response.status, retryAfterSeconds);
}

function abortError(externalSignal: AbortSignal | undefined, timedOut: boolean): AiProviderError {
  if (externalSignal?.aborted && !timedOut) return new AiProviderError('AI generation was stopped', 'AI_CANCELLED');
  return new AiProviderError('The AI provider request timed out', 'AI_PROVIDER_TIMEOUT');
}

export async function completeWithDeepSeek(
  apiKey: string,
  request: AiProviderRequest,
  fetchImpl: AiFetch = fetch,
  externalSignal?: AbortSignal,
): Promise<AiProviderResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const abortExternal = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', abortExternal, { once: true });
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.aiRequestTimeoutMs);
  try {
    const response = await fetchImpl(DEEPSEEK_ENDPOINT(), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: buildRequestBody(request, false),
      signal: controller.signal,
    });
    if (!response.ok) throw await classifyHttpError(response);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AiProviderError('The AI provider returned an invalid response', 'AI_PROVIDER_RESPONSE');
    }
    const choices = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices : [];
    const first = choices[0];
    const message = isRecord(first) && isRecord(first.message) ? first.message.content : undefined;
    const reasoning = isRecord(first) && isRecord(first.message) && typeof first.message.reasoning_content === 'string' && first.message.reasoning_content.trim()
      ? first.message.reasoning_content.trim()
      : null;
    if (typeof message !== 'string' || !message.trim()) {
      throw new AiProviderError('The AI provider returned no answer', 'AI_PROVIDER_RESPONSE');
    }
    return { content: message, reasoning };
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw abortError(externalSignal, timedOut);
    throw new AiProviderError('The AI provider could not be reached', 'AI_PROVIDER_UNAVAILABLE');
  } finally {
    if (externalSignal) externalSignal.removeEventListener('abort', abortExternal);
    clearTimeout(timeout);
  }
}

export async function* streamDeepSeek(
  apiKey: string,
  request: AiProviderRequest,
  fetchImpl: AiFetch = fetch,
  externalSignal?: AbortSignal,
): AsyncGenerator<AiStreamEvent, void> {
  const controller = new AbortController();
  let timedOut = false;
  const abortExternal = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', abortExternal, { once: true });
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.aiRequestTimeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(DEEPSEEK_ENDPOINT(), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: buildRequestBody(request, true),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw abortError(externalSignal, timedOut);
      throw new AiProviderError('The AI provider could not be reached', 'AI_PROVIDER_UNAVAILABLE');
    }
    if (!response.ok) throw await classifyHttpError(response);
    if (!response.body) throw new AiProviderError('The AI provider returned no stream', 'AI_PROVIDER_RESPONSE');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let receivedDone = false;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { receivedDone = true; break; }
        let payload: unknown;
        try { payload = JSON.parse(data); } catch { continue; }
        const choices = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices : [];
        const first = choices[0];
        const delta = isRecord(first) && isRecord(first.delta) ? first.delta : null;
        if (!delta) continue;
        const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
        const content = typeof delta.content === 'string' ? delta.content : '';
        if (reasoning) yield { type: 'reasoning', content: reasoning };
        if (content) yield { type: 'delta', content };
      }
      if (receivedDone) break;
    }
    if (!receivedDone) throw new AiProviderError('The AI provider stream ended unexpectedly', 'AI_PROVIDER_RESPONSE');
    yield { type: 'done' };
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw abortError(externalSignal, timedOut);
    throw error;
  } finally {
    clearTimeout(timeout);
    if (externalSignal) externalSignal.removeEventListener('abort', abortExternal);
  }
}
