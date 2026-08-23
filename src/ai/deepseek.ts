import { config } from '../config.js';
import type { AiProviderRequest, AiProviderResponse, AiStreamEvent, AiToolCall } from './types.js';

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
    // In-memory messages keep tool calls flattened; the provider wire format
    // nests them under type/function and carries tool_call_id separately.
    messages: request.messages.map(message => ({
      role: message.role,
      content: message.content,
      ...(message.tool_calls
        ? {
            tool_calls: message.tool_calls.map(call => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    })),
    temperature: 0.2,
    max_tokens: 4096,
    stream,
    ...(request.tools?.length ? { tools: request.tools, tool_choice: request.tool_choice ?? 'auto' } : {}),
  });
}

function parseToolCalls(message: Record<string, unknown> | null | undefined): AiToolCall[] | null {
  const raw = message?.tool_calls;
  if (!Array.isArray(raw)) return null;
  const calls: AiToolCall[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.id !== 'string') return null;
    const fn = entry.function;
    if (!isRecord(fn) || typeof fn.name !== 'string' || typeof fn.arguments !== 'string') return null;
    calls.push({ id: entry.id, name: fn.name, arguments: fn.arguments });
  }
  return calls;
}

const DSML_TOOL_BLOCK_START = '<｜｜DSML｜｜toolcalls>';
const DSML_TOOL_BLOCK_END = /<\/｜｜DSML｜｜tool(?:calls|[_-]calls|▁calls)>/;
const DSML_INVOKE_RE = /<｜｜DSML｜｜invoke\b([^>]*)>([\s\S]*?)<\/｜｜DSML｜｜invoke>/g;
const DSML_PARAMETER_RE = /<｜｜DSML｜｜parameter\b([^>]*)>([\s\S]*?)<\/｜｜DSML｜｜parameter>/g;
const DSML_NAME_ALIASES: Record<string, string> = {
  readsourcefile: 'read_source_file',
  webfetch: 'web_fetch',
  runbash: 'run_bash',
  updatetasks: 'update_tasks',
  spawnsubagent: 'spawn_subagent',
};

function dsmlStartPrefixLength(value: string): number {
  const max = Math.min(value.length, DSML_TOOL_BLOCK_START.length - 1);
  for (let length = max; length > 0; length--) {
    if (value.endsWith(DSML_TOOL_BLOCK_START.slice(0, length))) return length;
  }
  return 0;
}

function decodeDsmlText(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function dsmlParameterName(value: string): string {
  return ({ startline: 'start_line', endline: 'end_line' }[value.replace(/[_-]/g, '').toLowerCase()] ?? value);
}

function dsmlParameterValue(raw: string, attributes: Record<string, string>): unknown {
  const value = decodeDsmlText(raw.trim());
  if (attributes.string !== 'false') return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function dsmlAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) attributes[match[1]] = decodeDsmlText(match[2]);
  return attributes;
}

/**
 * DeepSeek-compatible models can sometimes emit the older DSML function-call
 * protocol as assistant content instead of OpenAI-compatible tool_calls.
 * Convert that protocol before the agent sees it, otherwise the loop treats
 * the invocation as a completed text answer and stops after the first call.
 */
export function parseDsmlToolCalls(content: string): { content: string; toolCalls: AiToolCall[] } | null {
  const start = content.indexOf(DSML_TOOL_BLOCK_START);
  if (start < 0) return null;
  const endMatch = DSML_TOOL_BLOCK_END.exec(content.slice(start + DSML_TOOL_BLOCK_START.length));
  if (!endMatch) return null;
  const blockEnd = start + DSML_TOOL_BLOCK_START.length + endMatch.index + endMatch[0].length;
  const block = content.slice(start + DSML_TOOL_BLOCK_START.length, blockEnd - endMatch[0].length);
  const toolCalls: AiToolCall[] = [];
  for (const invoke of block.matchAll(DSML_INVOKE_RE)) {
    const invokeAttributes = dsmlAttributes(invoke[1]);
    const name = DSML_NAME_ALIASES[invokeAttributes.name?.replace(/[_-]/g, '').toLowerCase()] ?? invokeAttributes.name;
    if (!name) continue;
    const args: Record<string, unknown> = {};
    for (const parameter of invoke[2].matchAll(DSML_PARAMETER_RE)) {
      const attributes = dsmlAttributes(parameter[1]);
      if (attributes.name) {
        const name = dsmlParameterName(attributes.name);
        const value = dsmlParameterValue(parameter[2], attributes);
        args[name] = (name === 'start_line' || name === 'end_line') && typeof value === 'string' && /^\d+$/.test(value)
          ? Number(value)
          : value;
      }
    }
    toolCalls.push({ id: `dsml-${toolCalls.length + 1}`, name, arguments: JSON.stringify(args) });
  }
  if (!toolCalls.length) return null;
  const withoutBlock = `${content.slice(0, start)}${content.slice(blockEnd)}`.trim();
  return { content: withoutBlock, toolCalls };
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
    const firstMessage = isRecord(first) && isRecord(first.message) ? first.message : null;
    const message = typeof firstMessage?.content === 'string' ? firstMessage.content : '';
    const reasoning = typeof firstMessage?.reasoning_content === 'string' && firstMessage.reasoning_content.trim()
      ? firstMessage.reasoning_content.trim()
      : null;
    const dsml = parseDsmlToolCalls(message);
    const toolCalls = parseToolCalls(firstMessage) ?? dsml?.toolCalls ?? null;
    const visibleMessage = dsml?.content ?? message;
    // Tool-call turns legitimately have empty content; they only fail when
    // neither content nor tool calls came back.
    if (!visibleMessage.trim() && !toolCalls?.length) {
      throw new AiProviderError('The AI provider returned no answer', 'AI_PROVIDER_RESPONSE');
    }
    return { content: visibleMessage, reasoning, toolCalls };
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
    let streamedContent = '';
    let emittedContentLength = 0;
    // Tool-call deltas arrive as fragments keyed by index; accumulate them.
    const toolParts = new Map<number, { id: string; name: string; args: string }>();
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
        if (Array.isArray(delta.tool_calls)) {
          for (const entry of delta.tool_calls) {
            if (!isRecord(entry) || typeof entry.index !== 'number') continue;
            const fn = isRecord(entry.function) ? entry.function : null;
            const part = toolParts.get(entry.index) ?? { id: '', name: '', args: '' };
            if (typeof entry.id === 'string' && entry.id) part.id = entry.id;
            if (typeof fn?.name === 'string' && fn.name) part.name = fn.name;
            if (typeof fn?.arguments === 'string' && fn.arguments) part.args += fn.arguments;
            toolParts.set(entry.index, part);
          }
        }
        if (reasoning) yield { type: 'reasoning', content: reasoning };
        if (content) {
          streamedContent += content;
          const dsmlStart = streamedContent.indexOf(DSML_TOOL_BLOCK_START);
          if (dsmlStart < 0) {
            const safeLength = streamedContent.length - dsmlStartPrefixLength(streamedContent);
            if (safeLength > emittedContentLength) {
              yield { type: 'delta', content: streamedContent.slice(emittedContentLength, safeLength) };
              emittedContentLength = safeLength;
            }
          } else if (dsmlStart > emittedContentLength) {
            yield { type: 'delta', content: streamedContent.slice(emittedContentLength, dsmlStart) };
            emittedContentLength = dsmlStart;
          }
        }
      }
      if (receivedDone) break;
    }
    if (!receivedDone) throw new AiProviderError('The AI provider stream ended unexpectedly', 'AI_PROVIDER_RESPONSE');
      const toolCalls = [...toolParts.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, part]) => ({ id: part.id, name: part.name, arguments: part.args }));
      const dsml = parseDsmlToolCalls(streamedContent);
      if (dsml) {
        // DSML invocations are encoded in content, so remove the protocol
        // markup from the visible transcript and expose real tool calls.
        const visibleTail = dsml.content.slice(emittedContentLength);
        if (visibleTail) yield { type: 'delta', content: visibleTail };
        toolCalls.push(...dsml.toolCalls);
      } else if (streamedContent.length > emittedContentLength) {
        yield { type: 'delta', content: streamedContent.slice(emittedContentLength) };
      }
      if (toolCalls.length > 0) yield { type: 'done', toolCalls };
      else yield { type: 'done' };
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw abortError(externalSignal, timedOut);
    throw error;
  } finally {
    clearTimeout(timeout);
    if (externalSignal) externalSignal.removeEventListener('abort', abortExternal);
  }
}
