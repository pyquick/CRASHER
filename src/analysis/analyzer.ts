// ── Crash Analyzer (Entry) ──
// Orchestrates the complete crash analysis: language detection → frame
// parsing → file tree → trigger point → summary → optional source analysis.
// Language-specific logic lives in languages/<lang>/; shared logic in common/.

import type {
  AnalysisSourceSnapshot,
  CrashAnalysis,
} from './types.js';
import { parseStackFrames, detectLanguage } from './parser.js';
import { profileFor } from './registry.js';
import { buildFileTree } from './common/tree.js';
import { buildTriggerPoint, buildSummary } from './common/summary.js';
import { analyzeSourceCode } from './common/source.js';
import { extractGenericStackFrames } from './common/generic.js';

export type { AnalysisSourceFile, AnalysisSourceSnapshot } from './types.js';

/**
 * Analyze a crash report's stack trace to produce a structured analysis.
 *
 * The analysis includes:
 * 1. File tree diagram (relative paths shown intuitively)
 * 2. Trigger point (exact file:line where the exception originated)
 * 3. Color-coded stack chain (red=crash, orange=propagation, yellow=source, gray=framework)
 * 4. Auto-detected programming language
 * 5. Human-readable summary
 */
export function analyzeCrash(report: {
  id: number;
  exception_type: string;
  exception_message: string;
  stack_trace: string;
  log_text?: string;
  runtime: string;
  runtime_version: string;
  symbolicated_stack?: string;
}, sourceSnapshot?: AnalysisSourceSnapshot): CrashAnalysis | null {
  const { id, exception_type, exception_message, stack_trace, log_text, runtime, runtime_version, symbolicated_stack } = report;

  // Determine which stack trace to use (prefer symbolicated for Unity)
  let rawStack = stack_trace || '';
  const lang = detectLanguage(rawStack, runtime);

  // For Unity/C#, use symbolicated stack if available
  if ((lang === 'csharp') && symbolicated_stack && symbolicated_stack.trim()) {
    rawStack = symbolicated_stack;
  }

  // If stack trace is empty, try extracting from log_text
  if (!rawStack.trim() && log_text) {
    rawStack = extractStackFromLog(log_text, lang);
  }

  if (!rawStack.trim()) {
    // Create minimal analysis with just exception info
    return createMinimalAnalysis(id, exception_type, exception_message, runtime, runtime_version, lang);
  }

  // Parse stack frames
  const frames = parseStackFrames(rawStack, runtime);

  if (frames.length === 0) {
    return createMinimalAnalysis(id, exception_type, exception_message, runtime, runtime_version, lang);
  }

  // Build the file tree
  const fileTree = buildFileTree(frames);

  // Identify the trigger point
  const triggerFrame = frames[0]; // innermost frame = crash site
  const triggerPoint = buildTriggerPoint(triggerFrame, exception_type, exception_message, frames);

  // Generate summary
  const summary = buildSummary(frames, exception_type, exception_message, lang);

  const analysis: CrashAnalysis = {
    report_id: id,
    exception_type,
    exception_message,
    detected_language: lang,
    file_tree: fileTree,
    trigger_point: triggerPoint,
    stack_chain: frames,
    summary,
    runtime,
    runtime_version,
  };
  if (sourceSnapshot) analysis.source_analysis = analyzeSourceCode(sourceSnapshot, frames, triggerPoint);
  return analysis;
}

// ── Minimal Analysis (fallback when no stack trace) ──

/**
 * Create a minimal analysis when there's no usable stack trace.
 */
function createMinimalAnalysis(
  id: number,
  exceptionType: string,
  exceptionMessage: string,
  runtime: string,
  runtimeVersion: string,
  lang: string
): CrashAnalysis {
  return {
    report_id: id,
    exception_type: exceptionType,
    exception_message: exceptionMessage || '',
    detected_language: lang,
    file_tree: [],
    trigger_point: {
      file_path: '(no stack trace available)',
      line_number: null,
      function_name: exceptionType,
      message: exceptionMessage
        ? `${exceptionType}: ${exceptionMessage}`
        : exceptionType,
      raw_snippet: '',
    },
    stack_chain: [],
    summary: `## Crash Analysis\n\n**Exception**: \`${exceptionType}\`${exceptionMessage ? ` — ${exceptionMessage}` : ''}\n\nNo stack trace was submitted with this crash report. Upload a crash log or stack trace for detailed analysis.`,
    runtime,
    runtime_version: runtimeVersion,
  };
}

// ── Log Extraction Dispatch ──

/**
 * Try to extract a stack trace from log text when stack_trace is empty.
 * Language-specific extraction comes from each language's profile (分析表);
 * falls back to generic frame-pattern extraction.
 */
function extractStackFromLog(logText: string, lang: string): string {
  if (!logText) return '';

  const profile = profileFor(lang);
  if (profile) {
    const extracted = profile.extractFromLog(logText, lang);
    if (extracted) return extracted;
  }

  return extractGenericStackFrames(logText);
}
