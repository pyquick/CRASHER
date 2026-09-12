// ── Code-analysis learning: the learnable knowledge base ──
// The AI review distills durable, verified knowledge entries per exception
// type; the deterministic analysis then reuses them so the same problem
// type gets richer data and more accurate output over time.

import type { CrashAnalysis, FixSuggestion, LearnedKnowledgeItem, RootCauseCandidate, RootCauseKind } from '../analysis/types.js';

export type KnowledgeKind = 'suggestion' | 'root_cause' | 'hint' | 'quote';

export interface KnowledgeEntry {
  kind: KnowledgeKind;
  title: string;
  description: string;
  confidence: number;
  payload: Record<string, unknown>;
}

export const KNOWLEDGE_KINDS: readonly KnowledgeKind[] = ['suggestion', 'root_cause', 'hint', 'quote'] as const;

const ROOT_CAUSE_KINDS: readonly RootCauseKind[] = [
  'none-return', 'missing-attribute', 'missing-key', 'out-of-range', 'type-mismatch',
  'undefined-name', 'import-failure', 'recursion', 'generic',
] as const;

const MAX_KNOWLEDGE = 10;
const MAX_EVIDENCE = 20;

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
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function normalizeSuggestionPayload(value: unknown, index: number): Record<string, unknown> {
  const record = isRecord(value) ? value : {};
  const candidateIndex = typeof record.candidate_index === 'number' && Number.isInteger(record.candidate_index) && record.candidate_index >= 0
    ? record.candidate_index
    : index;
  return {
    candidate_index: candidateIndex,
    crash_site_snippet: asString(record.crash_site_snippet, 8000),
    fix_site_snippet: asString(record.fix_site_snippet, 8000),
    code_before: asString(record.code_before, 8000),
    code_after: asString(record.code_after, 8000),
  };
}

function normalizeQuotePayload(value: unknown): Record<string, unknown> | null {
  const record = isRecord(value) ? value : {};
  const quote = asString(record.quote, 1000);
  const meaning = asString(record.meaning, 2000);
  const source = asString(record.source, 500);
  if (!quote || !meaning || !source) return null;
  return { quote, meaning, source };
}
function normalizeRootCausePayload(value: unknown): Record<string, unknown> | null {
  const record = isRecord(value) ? value : {};
  if (!ROOT_CAUSE_KINDS.includes(record.kind as RootCauseKind)) return null;
  const evidence = Array.isArray(record.evidence)
    ? record.evidence.filter((entry): entry is string => typeof entry === 'string').map(entry => entry.slice(0, 2000)).slice(0, MAX_EVIDENCE)
    : [];
  const payload: Record<string, unknown> = {
    file_path: asString(record.file_path, 500),
    line_number: asLineNumber(record.line_number),
    function_name: asString(record.function_name, 200),
    reason: asString(record.reason, 4000),
    kind: record.kind,
    evidence,
  };
  if (typeof record.is_conclusive === 'boolean') payload.is_conclusive = record.is_conclusive;
  if (record.definition_kind === 'class' || record.definition_kind === 'function') payload.definition_kind = record.definition_kind;
  const definitionModule = asString(record.definition_module, 200);
  if (definitionModule) payload.definition_module = definitionModule;
  return payload;
}

/**
 * Coerces model output into durable knowledge entries. Entries without a
 * title or with an invalid kind/payload are dropped.
 */
export function normalizeKnowledge(raw: unknown): KnowledgeEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: KnowledgeEntry[] = [];
  for (const [index, item] of raw.entries()) {
    if (!isRecord(item)) continue;
    if (!KNOWLEDGE_KINDS.includes(item.kind as KnowledgeKind)) continue;
    const title = asString(item.title, 200);
    if (!title) continue;
    const kind = item.kind as KnowledgeKind;
    const payload = kind === 'suggestion'
      ? normalizeSuggestionPayload(item.payload ?? item, index)
      : kind === 'root_cause'
        ? normalizeRootCausePayload(item.payload ?? item)
        : kind === 'quote'
          ? normalizeQuotePayload(item.payload ?? item)
          : {};
    if (!payload) continue; // root-cause/quote payload outside the whitelist
    const key = `${kind}\u0000${title.toLocaleLowerCase()}`;
    if (out.some(entry => `${entry.kind}\u0000${entry.title.toLocaleLowerCase()}` === key)) continue;
    out.push({
      kind,
      title,
      description: asString(item.description, 4000),
      confidence: asConfidence(item.confidence),
      payload,
    });
  }
  return out.slice(0, MAX_KNOWLEDGE);
}

function suggestionFromEntry(entry: KnowledgeEntry): FixSuggestion {
  return {
    candidate_index: typeof entry.payload.candidate_index === 'number' ? entry.payload.candidate_index : 0,
    title: entry.title,
    description: entry.description,
    crash_site_snippet: asString(entry.payload.crash_site_snippet, 8000),
    fix_site_snippet: asString(entry.payload.fix_site_snippet, 8000),
    code_before: asString(entry.payload.code_before, 8000),
    code_after: asString(entry.payload.code_after, 8000),
    confidence: entry.confidence,
  };
}

function rootCauseFromEntry(entry: KnowledgeEntry): RootCauseCandidate {
  return {
    file_path: asString(entry.payload.file_path, 500),
    line_number: asLineNumber(entry.payload.line_number),
    function_name: asString(entry.payload.function_name, 200),
    reason: entry.description || asString(entry.payload.reason, 4000),
    confidence: entry.confidence,
    kind: (entry.payload.kind as RootCauseKind) ?? 'generic',
    evidence: Array.isArray(entry.payload.evidence) ? entry.payload.evidence.filter((e): e is string => typeof e === 'string') : [],
    ...(typeof entry.payload.is_conclusive === 'boolean' ? { is_conclusive: entry.payload.is_conclusive } : {}),
    ...(entry.payload.definition_kind === 'class' || entry.payload.definition_kind === 'function'
      ? { definition_kind: entry.payload.definition_kind as 'class' | 'function' } : {}),
    ...(asString(entry.payload.definition_module, 200) ? { definition_module: asString(entry.payload.definition_module, 200) } : {}),
  };
}

/**
 * Enriches a deterministic analysis with matching knowledge-base entries:
 * suggestion entries join the fix list the UI renders (identical structure),
 * root-cause entries join the source analysis when present, and everything
 * is summarized in the top-level `learned` array.
 */
export function applyKnowledgeToAnalysis(analysis: CrashAnalysis, entries: KnowledgeEntry[]): CrashAnalysis {
  if (!entries.length) return analysis;
  const out: CrashAnalysis = { ...analysis };
  const suggestions = entries.filter(entry => entry.kind === 'suggestion');
  if (suggestions.length) {
    const fixes = suggestions.map(suggestionFromEntry);
    if (out.source_analysis) {
      out.source_analysis = { ...out.source_analysis, fixes: [...(out.source_analysis.fixes ?? []), ...fixes].slice(0, 10) };
    } else {
      out.suggestions = [...(out.suggestions ?? []), ...fixes].slice(0, 10);
    }
  }
  const rootCauses = entries.filter(entry => entry.kind === 'root_cause');
  if (rootCauses.length && out.source_analysis) {
    out.source_analysis = {
      ...out.source_analysis,
      root_cause_candidates: [...(out.source_analysis.root_cause_candidates ?? []), ...rootCauses.map(rootCauseFromEntry)].slice(0, 10),
    };
  }
  const learned: LearnedKnowledgeItem[] = entries.map(entry => ({
    kind: entry.kind,
    title: entry.title,
    description: entry.description,
    confidence: entry.confidence,
    ...(entry.kind === 'quote' ? {
      quote: asString(entry.payload.quote, 1000),
      meaning: asString(entry.payload.meaning, 2000),
      source: asString(entry.payload.source, 500),
    } : {}),
  }));
  out.learned = learned;
  return out;
}
