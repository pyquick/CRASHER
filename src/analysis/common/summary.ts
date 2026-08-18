// ── Trigger Point & Summary Builder ──
// Language-independent crash trigger point and summary construction;
// language labels and advice come from each language's profile (分析表).

import type { CrashAnalysis, StackFrame } from '../types.js';
import { profileFor } from '../registry.js';

/**
 * Build the trigger point — the exact line and function where the crash occurred.
 */
export function buildTriggerPoint(
  frame: StackFrame,
  exceptionType: string,
  exceptionMessage: string,
  allFrames: StackFrame[]
): CrashAnalysis['trigger_point'] {
  // Use the first frame with a file path, falling back to index 0
  let triggerFrame = frame;
  for (const f of allFrames) {
    if (f.file_path) {
      triggerFrame = f;
      break;
    }
  }

  // Build a descriptive message
  let message = `${exceptionType}`;
  if (exceptionMessage) {
    message += `: ${exceptionMessage}`;
  }
  if (triggerFrame.function_name) {
    message += `\nIn function: ${triggerFrame.module_name ? triggerFrame.module_name + '.' : ''}${triggerFrame.function_name}()`;
  }
  if (triggerFrame.file_path && triggerFrame.line_number) {
    message += `\nat ${triggerFrame.file_path}:${triggerFrame.line_number}`;
  }

  // Extract the raw snippet (the line from the stack trace that shows the crash)
  const rawSnippet = triggerFrame.raw_line || allFrames[0]?.raw_line || '';

  return {
    file_path: triggerFrame.file_path || '(unknown)',
    line_number: triggerFrame.line_number,
    function_name: triggerFrame.function_name || exceptionType,
    message,
    raw_snippet: rawSnippet,
  };
}

/**
 * Build a human-readable summary of the crash analysis.
 */
export function buildSummary(
  frames: StackFrame[],
  exceptionType: string,
  exceptionMessage: string,
  lang: string
): string {
  const langLabel = languageLabel(lang);
  const trigger = frames[0];
  const sourceFrame = frames.find(f => f.severity === 'source') || frames[frames.length - 1];

  let summary = `## Crash Analysis (${langLabel})\n\n`;

  // Exception description
  summary += `**Exception**: \`${exceptionType}\``;
  if (exceptionMessage) {
    summary += ` — ${exceptionMessage}`;
  }
  summary += '\n\n';

  // Trigger point
  if (trigger.file_path) {
    summary += `**Crash Site**: \`${trigger.file_path}`;
    if (trigger.line_number) {
      summary += `:${trigger.line_number}`;
    }
    summary += '`';
    if (trigger.function_name) {
      summary += ` in \`${trigger.function_name}()\``;
    }
    summary += '\n\n';
  }

  // Root cause / source
  if (sourceFrame && sourceFrame.file_path && sourceFrame !== trigger) {
    summary += `**Likely Root Cause**: The error originated in \`${sourceFrame.file_path}`;
    if (sourceFrame.line_number) {
      summary += `:${sourceFrame.line_number}`;
    }
    summary += '`';
    if (sourceFrame.function_name) {
      summary += ` at \`${sourceFrame.function_name}()\``;
    }
    summary += `, and propagated through ${frames.length - 2} intermediate frame(s) before manifesting at the crash site.`;
    summary += '\n\n';
  }

  // Frame count
  summary += `**Stack Depth**: ${frames.length} frames\n\n`;

  // Language-specific advice
  const advice = getLanguageAdvice(lang, exceptionType);
  if (advice) {
    summary += `**Suggested Action**: ${advice}\n`;
  }

  return summary;
}

const DEFAULT_ADVICE = 'Review the stack trace above and check the file paths and line numbers for the root cause.';

export function languageLabel(lang: string): string {
  return profileFor(lang)?.labels[lang] || (lang === 'unknown' ? 'Unknown' : lang.toUpperCase());
}

export function getLanguageAdvice(lang: string, exceptionType: string): string {
  const profile = profileFor(lang);

  // Check language-specific advice
  const langAdvice = profile?.advice[lang];
  if (langAdvice) {
    // Try exact match
    if (langAdvice[exceptionType]) return langAdvice[exceptionType];
    // Try partial match (e.g., "panic: runtime error" contains "panic")
    for (const [key, advice] of Object.entries(langAdvice)) {
      if (exceptionType.toLowerCase().includes(key.toLowerCase())) {
        return advice;
      }
    }
  }

  // Default advice
  return profile?.defaultAdvice[lang] || DEFAULT_ADVICE;
}
