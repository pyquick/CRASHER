// ── Code-analysis learning: AI review payload validation & merging ──
// The AI review response is untrusted model output. Everything here coerces
// or rejects it into the exact deterministic-analysis shapes
// (RootCauseCandidate / CrashPathStep / FixSuggestion) so the UI and the
// knowledge pipeline never see fields outside those schemas.

import type { CrashAnalysis, CrashPathStep, FixSuggestion, RootCauseCandidate, RootCauseKind } from '../analysis/types.js';

export const ROOT_CAUSE_KINDS: readonly RootCauseKind[] = [
  'none-return',
  'missing-attribute',
  'missing-key',
  'out-of-range',
  'type-mismatch',
  'undefined-name',
  'import-failure',
  'recursion',
  'generic',
] as const;

const FRAME_SEVERITIES = ['trigger', 'propagation', 'source', 'framework', 'unknown'] as const;

const MAX_SUGGESTIONS = 10;
const MAX_ROOT_CAUSES = 10;
const MAX_CRASH_PATH = 20;
const MAX_EVIDENCE = 20;
const MAX_STACK_CHAIN = 50;
const MAX_FILE_TREE_UPDATES = 200;

export type FrameSeverity = 'trigger' | 'propagation' | 'source' | 'framework' | 'unknown';
export type TreeSeverity = 'red' | 'orange' | 'yellow' | 'gray';

export interface TriggerPointCorrection {
  file_path: string;
  line_number: number | null;
  function_name: string;
  message: string;
  raw_snippet: string;
}

export interface StackFrameCorrection {
  index: number;
  language: string;
  file_path: string;
  line_number: number | null;
  column_number: number | null;
  function_name: string;
  module_name: string;
  address: string;
  raw_line: string;
  severity: FrameSeverity;
}

export interface FileTreeUpdate {
  path: string;
  is_crash_site?: boolean;
  line_number?: number;
  severity?: TreeSeverity;
}

/** Every field of the deterministic analysis the review may correct. */
export interface ReviewCorrections {
  exception_type?: string;
  exception_message?: string;
  detected_language?: string;
  runtime?: string;
  runtime_version?: string;
  summary?: string;
  root_cause_candidates?: RootCauseCandidate[];
  crash_path?: CrashPathStep[];
  trigger_point?: TriggerPointCorrection;
  stack_chain?: StackFrameCorrection[];
  file_tree_updates?: FileTreeUpdate[];
}

export interface ReviewPayload {
  correct: boolean;
  notes: string;
  corrections: ReviewCorrections;
  suggestions: FixSuggestion[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function asLineNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function asConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function asOptionalBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function normalizeRootCauses(value: unknown): RootCauseCandidate[] {
  if (!Array.isArray(value)) return [];
  const out: RootCauseCandidate[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const kind = ROOT_CAUSE_KINDS.includes(item.kind as RootCauseKind) ? (item.kind as RootCauseKind) : null;
    if (!kind) continue; // The UI only renders the 9 known kinds — reject unknown ones.
    const evidence = Array.isArray(item.evidence)
      ? item.evidence.filter((entry): entry is string => typeof entry === 'string').map(entry => entry.slice(0, 2000)).slice(0, MAX_EVIDENCE)
      : [];
    const candidate: RootCauseCandidate = {
      file_path: asString(item.file_path, 500),
      line_number: asLineNumber(item.line_number),
      function_name: asString(item.function_name, 200),
      reason: asString(item.reason, 4000),
      confidence: asConfidence(item.confidence),
      kind,
      evidence,
    };
    const isConclusive = asOptionalBool(item.is_conclusive);
    if (isConclusive !== undefined) candidate.is_conclusive = isConclusive;
    if (item.definition_kind === 'class' || item.definition_kind === 'function') candidate.definition_kind = item.definition_kind;
    const definitionModule = asString(item.definition_module, 200);
    if (definitionModule) candidate.definition_module = definitionModule;
    out.push(candidate);
  }
  return out.slice(0, MAX_ROOT_CAUSES);
}

function normalizeCrashPath(value: unknown): CrashPathStep[] {
  if (!Array.isArray(value)) return [];
  const out: CrashPathStep[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (item.role !== 'frame' && item.role !== 'root-cause') continue;
    const step: CrashPathStep = {
      file_path: asString(item.file_path, 500),
      line_number: asLineNumber(item.line_number),
      function_name: asString(item.function_name, 200),
      label: asString(item.label, 500),
      role: item.role,
    };
    if (item.role === 'frame' && FRAME_SEVERITIES.includes(item.severity as typeof FRAME_SEVERITIES[number])) {
      step.severity = item.severity as CrashPathStep['severity'];
    }
    if (item.role === 'root-cause' && ROOT_CAUSE_KINDS.includes(item.kind as RootCauseKind)) {
      step.kind = item.kind as RootCauseKind;
    }
    out.push(step);
  }
  return out.slice(0, MAX_CRASH_PATH);
}

const FRAME_SEVERITY_VALUES: readonly FrameSeverity[] = FRAME_SEVERITIES as readonly FrameSeverity[];
const TREE_SEVERITIES = ['red', 'orange', 'yellow', 'gray'] as const;

function normalizeTriggerPoint(value: unknown): TriggerPointCorrection | undefined {
  if (!isRecord(value)) return undefined;
  const filePath = asString(value.file_path, 500);
  if (!filePath) return undefined;
  return {
    file_path: filePath,
    line_number: asLineNumber(value.line_number),
    function_name: asString(value.function_name, 200),
    message: asString(value.message, 4000),
    raw_snippet: asString(value.raw_snippet, 8000),
  };
}

function normalizeStackChain(value: unknown): StackFrameCorrection[] {
  if (!Array.isArray(value)) return [];
  const out: StackFrameCorrection[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) continue;
    out.push({
      index: typeof item.index === 'number' && Number.isInteger(item.index) && item.index >= 0 ? item.index : index,
      language: asString(item.language, 50),
      file_path: asString(item.file_path, 500),
      line_number: asLineNumber(item.line_number),
      column_number: typeof item.column_number === 'number' && Number.isInteger(item.column_number) && item.column_number >= 0 ? item.column_number : null,
      function_name: asString(item.function_name, 200),
      module_name: asString(item.module_name, 200),
      address: asString(item.address, 100),
      raw_line: asString(item.raw_line, 2000),
      severity: FRAME_SEVERITY_VALUES.includes(item.severity as FrameSeverity) ? item.severity as FrameSeverity : 'unknown',
    });
  }
  return out.slice(0, MAX_STACK_CHAIN);
}

function normalizeFileTreeUpdates(value: unknown): FileTreeUpdate[] {
  if (!Array.isArray(value)) return [];
  const out: FileTreeUpdate[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const path = asString(item.path, 500);
    if (!path) continue;
    const update: FileTreeUpdate = { path };
    if (typeof item.is_crash_site === 'boolean') update.is_crash_site = item.is_crash_site;
    if (typeof item.line_number === 'number' && Number.isInteger(item.line_number) && item.line_number > 0) update.line_number = item.line_number;
    if (TREE_SEVERITIES.includes(item.severity as TreeSeverity)) update.severity = item.severity as TreeSeverity;
    out.push(update);
  }
  return out.slice(0, MAX_FILE_TREE_UPDATES);
}

function normalizeSuggestions(value: unknown): FixSuggestion[] {
  if (!Array.isArray(value)) return [];
  const out: FixSuggestion[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) continue;
    const candidateIndex = typeof item.candidate_index === 'number' && Number.isInteger(item.candidate_index) && item.candidate_index >= 0
      ? item.candidate_index
      : index;
    out.push({
      candidate_index: candidateIndex,
      title: asString(item.title, 200),
      description: asString(item.description, 4000),
      crash_site_snippet: asString(item.crash_site_snippet, 8000),
      fix_site_snippet: asString(item.fix_site_snippet, 8000),
      code_before: asString(item.code_before, 8000),
      code_after: asString(item.code_after, 8000),
      confidence: asConfidence(item.confidence),
    });
  }
  return out.slice(0, MAX_SUGGESTIONS);
}

/**
 * Coerces raw model output into the strict review payload. Returns null when
 * the payload is unusable (missing the required `correct` boolean), which
 * triggers a retry with feedback.
 */
export function normalizeReviewPayload(raw: unknown): ReviewPayload | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.correct !== 'boolean') return null;
  const correctionsValue = isRecord(raw.corrections) ? raw.corrections : {};
  const corrections: ReviewCorrections = {};
  const exceptionType = asString(correctionsValue.exception_type, 200);
  if (exceptionType) corrections.exception_type = exceptionType;
  const exceptionMessage = asString(correctionsValue.exception_message, 8000);
  if (exceptionMessage) corrections.exception_message = exceptionMessage;
  const detectedLanguage = asString(correctionsValue.detected_language, 50);
  if (detectedLanguage) corrections.detected_language = detectedLanguage;
  const runtime = asString(correctionsValue.runtime, 50);
  if (runtime) corrections.runtime = runtime;
  const runtimeVersion = asString(correctionsValue.runtime_version, 50);
  if (runtimeVersion) corrections.runtime_version = runtimeVersion;
  const summary = asString(correctionsValue.summary, 8000);
  if (summary) corrections.summary = summary;
  const rootCauses = normalizeRootCauses(correctionsValue.root_cause_candidates);
  if (rootCauses.length) corrections.root_cause_candidates = rootCauses;
  const crashPath = normalizeCrashPath(correctionsValue.crash_path);
  if (crashPath.length) corrections.crash_path = crashPath;
  const triggerPoint = normalizeTriggerPoint(correctionsValue.trigger_point);
  if (triggerPoint) corrections.trigger_point = triggerPoint;
  const stackChain = normalizeStackChain(correctionsValue.stack_chain);
  if (stackChain.length) corrections.stack_chain = stackChain;
  const fileTreeUpdates = normalizeFileTreeUpdates(correctionsValue.file_tree_updates);
  if (fileTreeUpdates.length) corrections.file_tree_updates = fileTreeUpdates;
  return {
    correct: raw.correct,
    notes: asString(raw.notes, 2000),
    corrections,
    suggestions: normalizeSuggestions(raw.suggestions),
  };
}

/**
 * Extracts every parseable balanced JSON object from model output (strips
 * code fences, tolerates prose before/after and fragmented objects). Callers
 * pick the object that matches their expected schema.
 */
export function extractJsonObjects(content: string): unknown[] {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  if (!candidate) return [];
  try {
    return [JSON.parse(candidate)];
  } catch {
    // Fall back to a balanced-brace scan of every object in the text.
  }
  const objects: unknown[] = [];
  let cursor = 0;
  while (cursor < candidate.length) {
    const start = candidate.indexOf('{', cursor);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < candidate.length; i += 1) {
      const char = candidate[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) break;
    try {
      objects.push(JSON.parse(candidate.slice(start, end + 1)));
    } catch {}
    cursor = end + 1;
  }
  return objects;
}

/**
 * Merges a validated review into a deterministic analysis. Suggestions are
 * appended to the array the UI actually renders (source_analysis.fixes when
 * present, otherwise top-level suggestions); corrections overwrite the wrong
 * fields only when the review judged the analysis incorrect.
 */
function applyFileTreeUpdates(nodes: CrashAnalysis['file_tree'], updates: FileTreeUpdate[]): CrashAnalysis['file_tree'] {
  return nodes.map(node => {
    const update = updates.find(entry => entry.path === node.path);
    if (!update) return { ...node, children: applyFileTreeUpdates(node.children, updates) };
    const next = { ...node, children: applyFileTreeUpdates(node.children, updates) };
    if (update.is_crash_site !== undefined) next.is_crash_site = update.is_crash_site;
    if (update.line_number !== undefined) next.line_number = update.line_number;
    if (update.severity !== undefined) next.severity = update.severity;
    return next;
  });
}

export function applyReviewToAnalysis(analysis: CrashAnalysis, review: ReviewPayload): CrashAnalysis {
  const out: CrashAnalysis = { ...analysis };
  const corrections = review.corrections;
  if (corrections.exception_type) out.exception_type = corrections.exception_type;
  if (corrections.exception_message) out.exception_message = corrections.exception_message;
  if (corrections.detected_language) out.detected_language = corrections.detected_language;
  if (corrections.runtime) out.runtime = corrections.runtime;
  if (corrections.runtime_version) out.runtime_version = corrections.runtime_version;
  if (corrections.summary) out.summary = corrections.summary;
  if (corrections.trigger_point) {
    out.trigger_point = { ...out.trigger_point, ...corrections.trigger_point };
    if (out.source_analysis?.crash_source) {
      out.source_analysis = { ...out.source_analysis, crash_source: { ...out.source_analysis.crash_source, file_path: corrections.trigger_point.file_path, line_number: corrections.trigger_point.line_number ?? out.source_analysis.crash_source.line_number, function_name: corrections.trigger_point.function_name, snippet: corrections.trigger_point.raw_snippet || out.source_analysis.crash_source.snippet } };
    }
  }
  if (corrections.stack_chain?.length) out.stack_chain = corrections.stack_chain;
  if (corrections.file_tree_updates?.length && out.file_tree.length) {
    out.file_tree = applyFileTreeUpdates(out.file_tree, corrections.file_tree_updates);
  }
  if (corrections.root_cause_candidates?.length) {
    if (out.source_analysis) out.source_analysis = { ...out.source_analysis, root_cause_candidates: corrections.root_cause_candidates };
  }
  if (corrections.crash_path?.length) {
    out.crash_path = corrections.crash_path;
    if (out.source_analysis) out.source_analysis = { ...out.source_analysis, crash_path: corrections.crash_path };
  }
  if (review.suggestions.length) {
    if (out.source_analysis) {
      out.source_analysis = { ...out.source_analysis, fixes: [...(out.source_analysis.fixes ?? []), ...review.suggestions].slice(0, MAX_SUGGESTIONS) };
    } else {
      out.suggestions = [...(out.suggestions ?? []), ...review.suggestions].slice(0, MAX_SUGGESTIONS);
    }
  }
  return out;
}
