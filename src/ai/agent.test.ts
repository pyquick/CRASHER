import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentLoopParams, AgentSseEvent, PersistEntry } from './agent.js';
import type { AiChatMessage, AiStreamEvent } from './types.js';

// Low context budget so tool-history trimming is easy to trigger. Must be
// set before the config-backed modules load.
process.env.AI_CONTEXT_MAX_CHARS = '1500';
const { runAgentLoop } = await import('./agent.js');
const { AiProviderError } = await import('./deepseek.js');

interface Harness {
  params: AgentLoopParams;
  emitted: AgentSseEvent[];
  persisted: PersistEntry[];
  calls: AiChatMessage[][];
}

function harness(respond: (messages: AiChatMessage[], model: string, tools: unknown[]) => AiStreamEvent[] | Promise<AiStreamEvent[]>, overrides: Partial<AgentLoopParams> = {}): Harness {
  const emitted: AgentSseEvent[] = [];
  const persisted: PersistEntry[] = [];
  const calls: AiChatMessage[][] = [];
  const params: AgentLoopParams = {
    stream: async function* (messages, model, tools) {
      calls.push(messages);
      for (const event of await respond(messages, model, tools)) yield event;
    },
    model: 'deepseek-chat',
    system: 'system',
    history: [],
    userMessage: 'question',
    workspaceDir: '/tmp/agent-test',
    loadSourceFiles: async () => [],
    emit: event => { emitted.push(event); },
    persist: entry => { persisted.push(entry); return persisted.length; },
    tasks: [],
    budget: { remaining: 5 },
    subagentCount: { count: 0 },
    maxSubagents: 2,
    allowSubagents: true,
    ...overrides,
  };
  return { params, emitted, persisted, calls };
}

const final = (content: string): AiStreamEvent[] => [{ type: 'delta', content }, { type: 'done' }];
const toolTurn = (id: string, name: string, args: unknown): AiStreamEvent[] => [
  { type: 'done', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] },
];

test('agent loop executes a tool turn and then returns the final answer', async () => {
  let turn = 0;
  const h = harness(async () => {
    turn++;
    if (turn === 1) return toolTurn('c1', 'read_source_file', { list: true });
    return final('the answer');
  });
  const result = await runAgentLoop(h.params);
  assert.equal(result.content, 'the answer');
  assert.equal(h.persisted.filter(entry => entry.kind === 'tool_call').length, 1);
  const resultEntry = h.persisted.find(entry => entry.kind === 'tool_result');
  assert.ok(resultEntry);
  assert.equal(resultEntry.status, 'ok');
  assert.equal(resultEntry.groupId, 1); // nests under the tool_call event
  // The second completion sees the tool message answering the call.
  const toolMessages = h.calls[1].filter(message => message.role === 'tool');
  assert.equal(toolMessages.length, 1);
  assert.equal(toolMessages[0].tool_call_id, 'c1');
});

test('agent loop executes multiple tool calls sequentially in order', async () => {
  let turn = 0;
  const h = harness(async () => {
    turn++;
    if (turn === 1) {
      return [{
        type: 'done',
        toolCalls: [
          { id: 'c1', name: 'update_tasks', arguments: JSON.stringify({ tasks: [{ id: 't1', title: 'first', status: 'in_progress' }] }) },
          { id: 'c2', name: 'read_source_file', arguments: JSON.stringify({ list: true }) },
        ],
      }];
    }
    return final('done');
  });
  const result = await runAgentLoop(h.params);
  assert.equal(result.content, 'done');
  const calls = h.persisted.filter(entry => entry.kind === 'tool_call');
  assert.deepEqual(calls.map(entry => entry.name), ['update_tasks', 'read_source_file']);
  assert.equal(h.persisted.filter(entry => entry.kind === 'task_update').length, 1);
  assert.equal(h.emitted.some(event => event.type === 'tasks'), true);
});

test('malformed tool arguments produce an error result and the loop continues', async () => {
  let turn = 0;
  const h = harness(async () => {
    turn++;
    if (turn === 1) return [{ type: 'done', toolCalls: [{ id: 'c1', name: 'update_tasks', arguments: 'not-json' }] }];
    return final('recovered');
  });
  const result = await runAgentLoop(h.params);
  assert.equal(result.content, 'recovered');
  const resultEntry = h.persisted.find(entry => entry.kind === 'tool_result');
  assert.ok(resultEntry);
  assert.equal(resultEntry.status, 'error');
});

test('provider errors become a visible recommendation instead of interrupting the workflow', async () => {
  const h = harness(async () => { throw new AiProviderError('provider unavailable', 'AI_PROVIDER_UNAVAILABLE'); });
  const result = await runAgentLoop(h.params);
  assert.match(result.content, /Recommendation:/);
  assert.match(result.content, /provider unavailable/);
  assert.equal(result.recoveredError, 'provider unavailable');
  assert.ok(h.emitted.some(event => event.type === 'delta' && event.content.includes('Recommendation:')));
});

test('empty provider answers become a visible recommendation', async () => {
  const h = harness(async () => [{ type: 'done' }]);
  const result = await runAgentLoop(h.params);
  assert.match(result.content, /before producing text/);
  assert.match(result.content, /Recommendation:/);
});

test('interim content alongside tool calls streams as deltas', async () => {
  let turn = 0;
  const h = harness(async () => {
    turn++;
    if (turn === 1) {
      return [
        { type: 'delta', content: 'Let me check the sources.' },
        { type: 'done', toolCalls: [{ id: 'c1', name: 'read_source_file', arguments: JSON.stringify({ list: true }) }] },
      ];
    }
    return final('final');
  });
  await runAgentLoop(h.params);
  assert.ok(h.emitted.some(event => event.type === 'delta' && event.content === 'Let me check the sources.'));
});

test('tool call offsets and the full transcript are recorded for interleaved replay', async () => {
  let turn = 0;
  const h = harness(async () => {
    turn++;
    if (turn === 1) {
      return [
        { type: 'delta', content: 'Checking.' },
        { type: 'done', toolCalls: [{ id: 'c1', name: 'read_source_file', arguments: JSON.stringify({ list: true }) }] },
      ];
    }
    return final('all good');
  });
  const result = await runAgentLoop(h.params);
  assert.equal(result.content, 'all good');
  assert.equal(result.transcript, 'Checking.all good');
  const callEntry = h.persisted.find(entry => entry.kind === 'tool_call');
  assert.ok(callEntry);
  assert.equal((callEntry.payload as { at?: number }).at, 'Checking.'.length);
});

test('step budget exhaustion reserves a tool-free turn for the final recommendation', async () => {
  const h = harness(async (_messages, _model, tools) => {
    if (tools.length > 0) return toolTurn('c1', 'read_source_file', { list: true });
    return final('final recommendation');
  }, { budget: { remaining: 2 } });
  const result = await runAgentLoop(h.params);
  assert.equal(result.content, 'final recommendation');
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].filter(message => message.role === 'tool').length, 2);
});

test('step budget counts each tool call and skips calls beyond the limit', async () => {
  let turn = 0;
  const h = harness(async (_messages, _model, tools) => {
    turn++;
    if (turn === 1) return [{ type: 'done', toolCalls: [
      { id: 'c1', name: 'read_source_file', arguments: '{"list":true}' },
      { id: 'c2', name: 'read_source_file', arguments: '{"list":true}' },
      { id: 'c3', name: 'read_source_file', arguments: '{"list":true}' },
    ] }];
    assert.equal(tools.length, 0);
    return final('bounded recommendation');
  }, { budget: { remaining: 2 } });
  const result = await runAgentLoop(h.params);
  assert.equal(result.content, 'bounded recommendation');
  assert.deepEqual(h.persisted.filter(entry => entry.kind === 'tool_call').map(entry => entry.name), ['read_source_file', 'read_source_file']);
  assert.deepEqual(h.calls[1].filter(message => message.role === 'tool').map(message => message.tool_call_id), ['c1', 'c2']);
});

test('aborting the turn marks the in-flight tool cancelled and stops the loop', async () => {
  const controller = new AbortController();
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = harness(
    async () => toolTurn('c1', 'read_source_file', { list: true }),
    {
      signal: controller.signal,
      loadSourceFiles: async () => {
        await gate; // hold the tool open until the abort fires
        return [];
      },
    },
  );
  const pending = runAgentLoop(h.params);
  // Wait until the tool call has been recorded, then abort mid-tool.
  while (h.persisted.filter(entry => entry.kind === 'tool_call').length === 0) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  controller.abort();
  release();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof AiProviderError && error.code === 'AI_CANCELLED',
  );
  const resultEntry = h.persisted.find(entry => entry.kind === 'tool_result');
  assert.ok(resultEntry);
  assert.equal(resultEntry.status, 'cancelled');
});

test('tool output beyond the context budget drops the oldest tool messages', async () => {
  // Note: config clamps AI_CONTEXT_MAX_CHARS to a 10000 minimum, so the
  // first tool output must exceed that.
  const manyTasks = Array.from({ length: 300 }, (_, index) => ({ id: `t${index}`, title: `task number ${index} with a fairly long title`, status: 'pending' }));
  let turn = 0;
  const h = harness(async () => {
    turn++;
    if (turn === 1) return toolTurn('big', 'update_tasks', { tasks: manyTasks });
    if (turn === 2) return toolTurn('small', 'read_source_file', { list: true });
    return final('finished');
  });
  await runAgentLoop(h.params);
  // The third completion only retains the most recent tool pair.
  const thirdCall = h.calls[2];
  const toolMessages = thirdCall.filter(message => message.role === 'tool');
  assert.equal(toolMessages.length, 1);
  assert.equal(toolMessages[0].tool_call_id, 'small');
});

test('spawn_subagent runs a restricted loop and reports back', async () => {
  let mainTurns = 0;
  const h = harness(async (messages, _model, tools) => {
    if (tools.length < 5) {
      // Sub-agent (restricted tool set): answer directly.
      assert.equal(messages[0].role, 'system');
      return final('sub report: the bug is on line 3');
    }
    mainTurns++;
    if (mainTurns === 1) return toolTurn('sub1', 'spawn_subagent', { prompt: 'trace callers of Bug()' });
    return final('main answer');
  });
  const result = await runAgentLoop(h.params);
  assert.equal(result.content, 'main answer');
  const subagentEntries = h.persisted.filter(entry => entry.kind === 'subagent');
  assert.equal(subagentEntries.length, 2);
  assert.equal(subagentEntries[0].status, 'running');
  assert.equal(subagentEntries[1].status, 'ok');
  assert.ok(h.emitted.some(event => event.type === 'subagent' && event.status === 'ok' && event.summary === 'sub report: the bug is on line 3'));
  const toolResult = h.persisted.find(entry => entry.kind === 'tool_result' && entry.name === 'spawn_subagent');
  assert.ok(toolResult);
  assert.equal(toolResult.status, 'ok');
  // The subagent's outcome event nests under its own running event.
  assert.equal(subagentEntries[1].groupId, 2);
});

test('subagent provider errors are reported but the main agent continues', async () => {
  let mainTurns = 0;
  const h = harness(async (_messages, _model, tools) => {
    if (tools.length < 5) throw new AiProviderError('subagent provider failed', 'AI_PROVIDER_UNAVAILABLE');
    mainTurns++;
    if (mainTurns === 1) return toolTurn('sub1', 'spawn_subagent', { prompt: 'investigate difficult branch' });
    return final('main recommendation after subagent failure');
  });
  const result = await runAgentLoop(h.params);
  assert.equal(result.content, 'main recommendation after subagent failure');
  assert.ok(h.emitted.some(event => event.type === 'subagent' && event.status === 'error'));
  const toolResult = h.persisted.find(entry => entry.kind === 'tool_result' && entry.name === 'spawn_subagent');
  assert.equal(toolResult?.status, 'error');
});

test('subagent limit turns further dispatches into an error result', async () => {
  let turn = 0;
  const h = harness(async () => {
    turn++;
    if (turn === 1) return toolTurn('s1', 'spawn_subagent', { prompt: 'first' });
    if (turn === 2) return toolTurn('s2', 'spawn_subagent', { prompt: 'second' });
    return final('done');
  }, { maxSubagents: 1 });
  await runAgentLoop(h.params);
  const second = h.persisted.find(entry => entry.kind === 'tool_result' && entry.name === 'spawn_subagent' && entry.groupId !== 1);
  assert.ok(second);
  assert.equal(second.status, 'error');
});

test('reasoning after a tool turn is persisted between that tool and the next tool call', async () => {
  let turn = 0;
  const h = harness(async () => {
    turn++;
    if (turn === 1) return toolTurn('c1', 'read_source_file', { list: true });
    if (turn === 2) {
      return [
        { type: 'reasoning', content: 'The list looks incomplete, checking more.' },
        { type: 'delta', content: 'Digging deeper.' },
        { type: 'done', toolCalls: [{ id: 'c2', name: 'update_tasks', arguments: JSON.stringify({ tasks: [{ id: 't1', title: 'verify', status: 'in_progress' }] }) }] },
      ];
    }
    return final('done');
  });
  const result = await runAgentLoop(h.params);
  assert.equal(result.content, 'done');
  const reasoningEntries = h.persisted.filter(entry => entry.kind === 'reasoning');
  assert.equal(reasoningEntries.length, 1);
  assert.deepEqual(reasoningEntries[0].payload, { text: 'The list looks incomplete, checking more.' });
  // The reasoning row lands after c1's events and before c2's tool_call, so
  // replay attaches it to the previous tool step.
  const reasoningIndex = h.persisted.findIndex(entry => entry.kind === 'reasoning');
  const callIndexes = h.persisted
    .map((entry, index) => entry.kind === 'tool_call' ? index : -1)
    .filter(index => index >= 0);
  assert.ok(reasoningIndex > callIndexes[0], 'reasoning must follow the first tool call');
  assert.ok(reasoningIndex < callIndexes[1], 'reasoning must precede the next tool call');
});

test('reasoning before any tool call is not persisted', async () => {
  let turn = 0;
  const h = harness(async () => {
    turn++;
    if (turn === 1) {
      return [
        { type: 'reasoning', content: 'initial thinking' },
        { type: 'delta', content: 'Let me check the sources.' },
        { type: 'done', toolCalls: [{ id: 'c1', name: 'read_source_file', arguments: JSON.stringify({ list: true }) }] },
      ];
    }
    return final('done');
  });
  await runAgentLoop(h.params);
  assert.equal(h.persisted.filter(entry => entry.kind === 'reasoning').length, 0);
});

test('sub-agent reasoning is not persisted', async () => {
  let mainTurns = 0;
  const h = harness(async (_messages, _model, tools) => {
    if (tools.length < 5) {
      return [
        { type: 'reasoning', content: 'sub thinking' },
        { type: 'delta', content: 'sub report: the bug is on line 3' },
        { type: 'done' },
      ];
    }
    mainTurns++;
    if (mainTurns === 1) return toolTurn('sub1', 'spawn_subagent', { prompt: 'trace callers of Bug()' });
    return [{ type: 'reasoning', content: 'main thinking after the sub-agent' }, ...final('main answer')];
  });
  await runAgentLoop(h.params);
  const reasoningEntries = h.persisted.filter(entry => entry.kind === 'reasoning');
  assert.equal(reasoningEntries.length, 1);
  assert.deepEqual(reasoningEntries[0].payload, { text: 'main thinking after the sub-agent' });
});
