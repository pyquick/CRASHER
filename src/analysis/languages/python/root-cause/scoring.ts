// ── Python Root-Cause Scoring ──
// Converts evidence items into ranked RootCauseCandidate objects.
// Confidence combines evidence weight with proximity: proximity is measured
// in call-graph hops from the crash function (a None-returning callee one
// hop away is a very plausible culprit), falling back to stack distance.

import type { RootCauseCandidate, StackFrame } from '../../../types.js';
import { pathsMatch } from '../../../../source.js';
import type { PyFunction, PySnapshotModel } from '../code-model/types.js';
import { buildCallGraph, findDependencyChain } from '../dependencies/call-graph.js';
import type { Evidence } from './evidence.js';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function proximityFor(
  evidence: Evidence,
  crashFunc: PyFunction | null,
  model: PySnapshotModel,
  frames: StackFrame[],
  edges: ReturnType<typeof buildCallGraph>
): number {
  // Definition-site evidence on a class (e.g. missing-attribute): the
  // exception message directly implicates the class, so proximity is 1.
  const evidenceClassName = evidence.function_name.split('.').pop()?.toLowerCase() ?? '';
  if (evidenceClassName && model.classes_by_name.has(evidenceClassName)) return 1;

  const evidenceFunc = model.qualified_functions.get(evidence.function_name);
  if (evidenceFunc && crashFunc && evidenceFunc !== crashFunc) {
    const chains = findDependencyChain(edges, crashFunc, evidenceFunc, 4, 1);
    if (chains.length > 0) {
      const hops = chains[0].length - 1;
      return hops <= 1 ? 1 : hops <= 3 ? 0.7 : 0.4;
    }
    return 0.5; // plausible but not directly reachable (dynamic dispatch etc.)
  }

  const index = frames.findIndex(frame => frame.file_path && pathsMatch(frame.file_path, evidence.file_path));
  if (index >= 0) return 1 / (index + 1);
  return 0.5;
}

export function scoreEvidence(
  evidence: Evidence[],
  crashFunc: PyFunction | null,
  model: PySnapshotModel,
  frames: StackFrame[]
): RootCauseCandidate[] {
  if (evidence.length === 0) return [];
  const edges = buildCallGraph(model);

  const scored = evidence.map(item => ({
    item,
    confidence: item.is_conclusive
      ? 1
      : clamp(proximityFor(item, crashFunc, model, frames, edges) * (0.4 + 0.2 * item.weight), 0.05, 0.95),
  }));

  // Group by (file, line, kind): merge reasons, keep the highest confidence.
  const grouped = new Map<string, RootCauseCandidate>();
  for (const { item, confidence } of scored) {
    const key = `${item.kind}|${item.file_path}|${item.line_number ?? 0}`;
    const existing = grouped.get(key);
    if (existing) {
      if (!existing.evidence.includes(item.reason)) existing.evidence.push(item.reason);
      existing.confidence = Math.max(existing.confidence, confidence);
      existing.reason = existing.evidence[0];
      if (item.is_conclusive) existing.is_conclusive = true;
      existing.definition_kind ??= item.definition_kind;
      existing.definition_module ??= item.definition_module;
    } else {
      grouped.set(key, {
        file_path: item.file_path,
        line_number: item.line_number,
        function_name: item.function_name,
        reason: item.reason,
        confidence,
        kind: item.kind,
        evidence: [item.reason],
        ...(item.is_conclusive ? { is_conclusive: true } : {}),
        ...(item.definition_kind ? { definition_kind: item.definition_kind } : {}),
        ...(item.definition_module ? { definition_module: item.definition_module } : {}),
      });
    }
  }

  return [...grouped.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 5);
}
