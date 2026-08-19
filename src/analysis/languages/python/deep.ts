// ── Python Deep Analysis Entry ──
// Builds the snapshot code model, attributes the root cause, generates fix
// suggestions and a dependency summary. Called from the source-analysis
// layer when the crash language is Python.

import type {
  AnalysisSourceSnapshot,
  CrashPathStep,
  DependencySummary,
  FixSuggestion,
  RootCauseCandidate,
  SourceLocation,
  StackFrame,
} from '../../types.js';
import { buildSnapshotModel, MODEL_LIMITS } from './code-model/index.js';
import { buildCallGraph, callersOf } from './dependencies/call-graph.js';
import { transitiveSubclasses } from './dependencies/class-graph.js';
import { fileOfFunction } from './dependencies/imports.js';
import { findAssignmentSites } from './dependencies/dataflow.js';
import { analyzePythonRootCause, matchCrashFile, findCrashFunc, type CrashContext, crashLineText } from './root-cause/index.js';
import { suggestFixes, sourceLocationFor } from './solutions/index.js';
import { extractReceiver } from './root-cause/evidence.js';

export interface PythonDeepResult {
  root_cause_candidates: RootCauseCandidate[];
  fixes: FixSuggestion[];
  dependency_summary: DependencySummary;
  crash_path: CrashPathStep[];
  warnings: string[];
}

export function analyzePythonDeep(
  snapshot: AnalysisSourceSnapshot,
  frames: StackFrame[],
  exception: { type: string; message: string }
): PythonDeepResult {
  const warnings: string[] = [];
  const empty: PythonDeepResult = {
    root_cause_candidates: [],
    fixes: [],
    dependency_summary: { callers: [], subclass_chain: [], variable_definitions: [] },
    crash_path: [],
    warnings,
  };

  const model = buildSnapshotModel(snapshot);
  if (model.files.length === 0) {
    warnings.push('Python deep analysis skipped: snapshot contains no Python source files');
    return empty;
  }
  if (model.truncated) {
    warnings.push(
      `Python deep analysis was limited to the first ${MODEL_LIMITS.maxFiles} files / ${MODEL_LIMITS.maxFunctions} functions ` +
      `(${model.skipped_files} Python files skipped) — results may be incomplete for large snapshots`
    );
  }

  const crashFrame = frames.find(frame => frame.file_path && frame.line_number) ?? frames[0];
  if (!crashFrame?.file_path) {
    warnings.push('Python deep analysis skipped: crash frame has no file path');
    return empty;
  }

  const crashFile = matchCrashFile(model, crashFrame);
  if (!crashFile) {
    warnings.push(`Python deep analysis skipped: '${crashFrame.file_path}' not found in the source snapshot`);
    return empty;
  }

  const crashLine = crashFrame.line_number ?? 1;
  const { func: crashFunc, cls: crashClass } = findCrashFunc(crashFile, crashFrame);

  const ctx: CrashContext = { model, crashFile, crashFunc, crashLine, exception, frames };

  const rootCauseCandidates = analyzePythonRootCause(model, frames, exception);

  const fixes: FixSuggestion[] = [];
  for (let index = 0; index < Math.min(rootCauseCandidates.length, 3); index++) {
    fixes.push(...suggestFixes(rootCauseCandidates[index], ctx, index));
  }

  const dependencySummary = buildDependencySummary(model, ctx, crashClass);
  const crashPath = buildCrashPath(frames, rootCauseCandidates);

  return {
    root_cause_candidates: rootCauseCandidates,
    fixes,
    dependency_summary: dependencySummary,
    crash_path: crashPath,
    warnings,
  };
}

/**
 * Build the crash-path flow: frames from entry point to crash site
 * (tracebacks list innermost first, so reverse), then the terminal
 * root-cause node the analysis points at (e.g. a class definition).
 */
function buildCrashPath(frames: StackFrame[], candidates: RootCauseCandidate[]): CrashPathStep[] {
  const steps: CrashPathStep[] = [...frames].reverse()
    .filter(frame => frame.file_path)
    .map(frame => ({
      file_path: frame.file_path,
      line_number: frame.line_number,
      function_name: frame.function_name,
      label: frame.function_name || frame.file_path,
      role: 'frame' as const,
      severity: frame.severity,
    }));

  const top = candidates[0];
  if (top) {
    steps.push({
      file_path: top.file_path,
      line_number: top.line_number,
      function_name: top.function_name,
      label: rootCauseStepLabel(top),
      role: 'root-cause' as const,
      kind: top.kind,
    });
  }
  return steps;
}

function rootCauseStepLabel(candidate: RootCauseCandidate): string {
  const attr = candidate.reason.match(/^'([^']+)' is never assigned/)?.[1];
  if (candidate.kind === 'missing-attribute' && attr) {
    return `${candidate.function_name} (class) — '${attr}' is never assigned`;
  }
  const sentence = candidate.reason.split('.')[0] ?? candidate.reason;
  return `${candidate.function_name} — ${sentence}`;
}

function buildDependencySummary(
  model: ReturnType<typeof buildSnapshotModel>,
  ctx: CrashContext,
  crashClass: ReturnType<typeof findCrashFunc>['cls']
): DependencySummary {
  const summary: DependencySummary = { callers: [], subclass_chain: [], variable_definitions: [] };
  const { crashFile, crashFunc, crashLine } = ctx;

  if (crashFunc) {
    const edges = buildCallGraph(model);
    for (const edge of callersOf(edges, crashFunc).slice(0, 10)) {
      const file = fileOfFunction(edge.caller, model);
      if (!file) continue;
      summary.callers.push(sourceLocationFor(file, edge.line, edge.caller.qualified_name));
    }
  }

  if (crashClass) {
    summary.subclass_chain = [crashClass.qualified_name, ...transitiveSubclasses(crashClass, model)];
  }

  const receiver = extractReceiver(ctx);
  if (receiver && crashFunc) {
    const sites = findAssignmentSites(crashFunc, receiver);
    for (const assignment of sites.slice(0, 5)) {
      summary.variable_definitions.push(sourceLocationFor(crashFile, assignment.line, crashFunc.qualified_name));
    }
  } else if (crashFunc) {
    // No receiver identified: show the crash line itself for context.
    summary.variable_definitions.push({
      file_path: crashFile.file_path,
      line_number: crashLine,
      function_name: crashFunc.qualified_name,
      snippet: crashLineText(ctx),
    });
  }

  return summary;
}
