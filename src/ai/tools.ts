// Agent tool definitions and executors for the AI crash assistant.
// Subagent execution lives in agent.ts and is injected via ToolContext to
// avoid a circular import.

import { spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { config } from '../config.js';
import { truncate } from '../shared/string.js';
import { readSourceFileContent } from '../service/dedup.js';
import { normalizeSourcePath } from '../source.js';
import { fetchWithSsrfProtection } from './ssrf.js';
import type { AiToolCall } from './types.js';
import type { AiAgentTask, SourceFile } from '../model.js';

export interface AgentToolResult {
  ok: boolean;
  output: string;
  tasks?: AiAgentTask[];
}

export interface ToolContext {
  convId: number;
  workspaceDir: string;
  signal?: AbortSignal;
  // Resolved by the caller (agent loop) so tools stay testable: current
  // state of the bound project's source files.
  loadSourceFiles: () => Promise<SourceFile[]>;
  spawnSubagent?: (prompt: string) => Promise<{ ok: boolean; output: string }>;
}

function cap(value: string, max: number): string {
  return truncate(value, max, '[truncated]');
}

// ----- read_source_file -----

async function readSourceFile(args: Record<string, unknown>, ctx: ToolContext): Promise<AgentToolResult> {
  const files = await ctx.loadSourceFiles();
  if (args.list === true) {
    const lines = files.map(file => `${file.relative_path} (${file.file_size} bytes, ${file.language})`);
    return { ok: true, output: lines.length ? lines.join('\n') : 'No source files are uploaded for this project.' };
  }
  const rawPath = typeof args.path === 'string' ? args.path : '';
  if (!rawPath) return { ok: false, output: 'path is required (use list:true to see available files)' };
  let path: string;
  try {
    path = normalizeSourcePath(rawPath);
  } catch {
    return { ok: false, output: `File not found: ${rawPath}` };
  }
  const match = files.find(file => file.relative_path === path || file.relative_path.toLowerCase() === path.toLowerCase());
  if (!match) return { ok: false, output: `File not found: ${rawPath}` };
  let content: string;
  try {
    content = readSourceFileContent(match);
  } catch {
    return { ok: false, output: `File content could not be read: ${rawPath}` };
  }
  const lines = content.split(/\r?\n/);
  const startLine = clampLine(args.start_line, 1);
  const endLine = clampLine(args.end_line, lines.length || 1);
  const start = Math.min(startLine, lines.length || 1);
  const end = Math.max(start, Math.min(endLine, lines.length || 1));
  const selected = lines.slice(start - 1, end)
    .map((line, index) => `${String(start + index).padStart(5)} | ${line}`)
    .join('\n');
  return {
    ok: true,
    output: cap(`${match.relative_path} — lines ${start}-${end} of ${lines.length}:\n${selected}`, config.aiToolResultMaxChars),
  };
}

function clampLine(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

// ----- web_fetch -----

async function webFetch(args: Record<string, unknown>, ctx: ToolContext): Promise<AgentToolResult> {
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  if (!url) return { ok: false, output: 'url is required' };
  try {
    const result = await fetchWithSsrfProtection(url, {
      timeoutMs: config.aiWebFetchTimeoutMs,
      maxBytes: config.aiWebFetchMaxBytes,
      signal: ctx.signal,
    });
    return {
      ok: result.status >= 200 && result.status < 400,
      output: cap(
        `status ${result.status}\nfinal URL: ${result.finalUrl}${result.truncated ? '\n[body truncated at server limit]' : ''}\n\n${result.text}`,
        config.aiToolResultMaxChars,
      ),
    };
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : 'Web fetch failed' };
  }
}

// ----- run_bash -----

// The base image may be Alpine (no /bin/bash); fall back to the POSIX shell.
const BASH_SHELL = existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';

function runBash(args: Record<string, unknown>, ctx: ToolContext): Promise<AgentToolResult> {
  const command = typeof args.command === 'string' ? args.command : '';
  if (!config.aiBashEnabled) {
    return Promise.resolve({ ok: false, output: 'The bash tool is disabled on this server (AI_BASH_ENABLED is not set).' });
  }
  if (!command.trim() || command.length > 4000) {
    return Promise.resolve({ ok: false, output: 'command is required and must be at most 4000 characters' });
  }
  mkdirSync(ctx.workspaceDir, { recursive: true });
  return new Promise<AgentToolResult>((resolve) => {
    const child = spawn(BASH_SHELL, ['-c', command], {
      cwd: ctx.workspaceDir,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: ctx.workspaceDir, LANG: 'C.UTF-8', TERM: 'dumb' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let truncated = false;
    let killed = false;
    const capture = (chunk: Buffer) => {
      const remaining = config.aiBashMaxOutput - Buffer.byteLength(output);
      if (remaining <= 0) {
        if (!truncated) { truncated = true; child.kill('SIGKILL'); killed = true; }
        return;
      }
      output += chunk.toString('utf-8', 0, Math.min(chunk.length, remaining));
      if (chunk.length > remaining) {
        truncated = true;
        killed = true;
        child.kill('SIGKILL');
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const timeout = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, config.aiBashTimeoutMs);
    const abortFromCaller = () => { killed = true; child.kill('SIGKILL'); };
    if (ctx.signal) {
      if (ctx.signal.aborted) abortFromCaller();
      else ctx.signal.addEventListener('abort', abortFromCaller, { once: true });
    }
    child.on('error', () => {
      clearTimeout(timeout);
      if (ctx.signal) ctx.signal.removeEventListener('abort', abortFromCaller);
      resolve({ ok: false, output: 'Failed to start the shell process' });
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (ctx.signal) ctx.signal.removeEventListener('abort', abortFromCaller);
      const notes: string[] = [`exit code: ${code === null ? 'killed' : code}`];
      if (truncated) notes.push('[output truncated at server limit]');
      if (ctx.signal?.aborted) notes.push('[stopped by user]');
      const body = output || '(no output)';
      const full = `${notes.join(' ')}\n${body}`;
      const timedOut = killed && !ctx.signal?.aborted && !truncated;
      // A killed process reports code null; if it exited 0 before the kill
      // landed, truncation still means the result is unusable.
      resolve({ ok: code === 0 && !truncated && !timedOut, output: cap(timedOut ? `timed out after ${config.aiBashTimeoutMs}ms\n${body}` : full, config.aiToolResultMaxChars) });
    });
  });
}

// ----- update_tasks -----

const MAX_TASKS = 500;
const TASK_STATUSES = new Set(['pending', 'in_progress', 'completed']);

function normalizeTasks(value: unknown): AiAgentTask[] | null {
  if (!Array.isArray(value) || value.length > MAX_TASKS) return null;
  const tasks: AiAgentTask[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null;
    const task = entry as Record<string, unknown>;
    if (typeof task.id !== 'string' || !task.id.trim() || task.id.length > 64) return null;
    if (typeof task.title !== 'string' || !task.title.trim() || task.title.length > 200) return null;
    if (typeof task.status !== 'string' || !TASK_STATUSES.has(task.status)) return null;
    if (task.notes !== undefined && (typeof task.notes !== 'string' || task.notes.length > 500)) return null;
    tasks.push({
      id: task.id.trim(),
      title: task.title.trim(),
      status: task.status as AiAgentTask['status'],
      ...(typeof task.notes === 'string' && task.notes.trim() ? { notes: task.notes.trim() } : {}),
    });
  }
  return tasks;
}

function updateTasks(args: Record<string, unknown>): AgentToolResult {
  const tasks = normalizeTasks(args.tasks);
  if (!tasks) {
    return { ok: false, output: 'tasks must be an array of {id, title, status (pending|in_progress|completed), notes?}' };
  }
  const summary = tasks.length
    ? tasks.map(task => `- [${task.status}] ${task.title}`).join('\n')
    : '(no tasks)';
  return { ok: true, tasks, output: `Task list updated (${tasks.length} tasks):\n${summary}` };
}

// ----- dispatcher + definitions -----

export async function runTool(call: AiToolCall, ctx: ToolContext): Promise<AgentToolResult> {
  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(call.arguments || '{}') as unknown;
    args = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return { ok: false, output: 'Tool arguments are not valid JSON' };
  }
  switch (call.name) {
    case 'read_source_file': return readSourceFile(args, ctx);
    case 'web_fetch': return webFetch(args, ctx);
    case 'run_bash': return runBash(args, ctx);
    case 'update_tasks': return updateTasks(args);
    case 'spawn_subagent': {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
      if (!prompt) return { ok: false, output: 'prompt is required' };
      if (!ctx.spawnSubagent) return { ok: false, output: 'Subagents are not available in this context' };
      const result = await ctx.spawnSubagent(prompt);
      return { ok: result.ok, output: result.output };
    }
    default:
      return { ok: false, output: `Unknown tool: ${call.name}` };
  }
}

function tool(name: string, description: string, parameters: Record<string, unknown>, required: string[]): unknown {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties: parameters, required } } };
}

export const AGENT_TOOLS: unknown[] = [
  tool(
    'read_source_file',
    'Read a source file of the project bound to the current crash. Use list:true to list every uploaded file path. Use path with optional start_line/end_line (1-based, inclusive) to read a line range. Only files uploaded to this project are readable.',
    {
      path: { type: 'string', description: 'Relative path of the file to read (use list:true first to discover paths)' },
      list: { type: 'boolean', description: 'When true, list all available file paths instead of reading' },
      start_line: { type: 'integer', minimum: 1, description: 'First line to read (default 1)' },
      end_line: { type: 'integer', minimum: 1, description: 'Last line to read (default: end of file)' },
    },
    [],
  ),
  tool(
    'web_fetch',
    'Fetch a public web page (http/https). Use this to look up official documentation, language specifications, or library references when the analysis needs authoritative conventions. Internal/private addresses are blocked.',
    { url: { type: 'string', description: 'Full http(s) URL to fetch' } },
    ['url'],
  ),
  tool(
    'run_bash',
    'Run a shell command in an isolated per-conversation workspace directory to reproduce the crash or verify a hypothesis. Only the workspace is writable; do not touch server files. Prefer running uploaded code or small test snippets. May be disabled on the server.',
    { command: { type: 'string', description: 'Shell command to run in the workspace directory' } },
    ['command'],
  ),
  tool(
    'update_tasks',
    'Maintain your own task list for the current analysis. Provide the full replacement list; tasks are small steps like "read the crashing file", "check the official spec", "reproduce locally". Update statuses as you work.',
    {
      tasks: {
        type: 'array',
        description: 'Full replacement task list',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Stable short identifier, e.g. "t1"' },
            title: { type: 'string', description: 'Short task title' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Current status' },
            notes: { type: 'string', description: 'Optional short note' },
          },
          required: ['id', 'title', 'status'],
        },
      },
    },
    ['tasks'],
  ),
  tool(
    'spawn_subagent',
    'Dispatch a sub-agent with your own prompt to investigate a focused sub-problem (for example: "trace every caller of function X in the uploaded sources"). The sub-agent can read sources, fetch the web, and update tasks, and returns a written report. Use it to decompose large analyses; keep prompts focused.',
    {
      prompt: { type: 'string', description: 'Focused task description for the sub-agent, including what to investigate and what to report' },
    },
    ['prompt'],
  ),
];
