// ── Severity Classification ──
// Language-independent severity classification; the framework-code patterns
// for each language come from that language's profile (分析表).

import type { StackFrame } from '../types.js';
import { profileFor } from '../registry.js';

/**
 * Classify each frame's severity for color-coded display.
 *
 * Color scheme:
 * - RED (#dc2626):   trigger point — the exact crash site (innermost frame / index 0)
 * - ORANGE (#ea580c): propagation — frames that passed the error along (middle of user code)
 * - YELLOW (#ca8a04): source — root cause / entry point (outermost user-code frame)
 * - GRAY (#6b7280):   framework — library/platform code
 */
export function classifySeverity(frames: StackFrame[], lang: string): void {
  if (frames.length === 0) return;

  const fwPatterns = profileFor(lang)?.frameworkPatterns[lang] || [];
  const userFrames: number[] = [];

  // Identify user code vs framework code
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const path = (frame.file_path || '').toLowerCase();
    const module = (frame.module_name || '').toLowerCase();
    const fullQualified = (module ? module + '.' + frame.function_name : frame.function_name || '').toLowerCase();

    let isFramework = false;
    for (const pat of fwPatterns) {
      if (pat.test(fullQualified) || pat.test(path) || pat.test(module)) {
        isFramework = true;
        break;
      }
    }

    frame.severity = isFramework ? 'framework' : 'unknown';
    if (!isFramework) userFrames.push(i);
  }

  // Color-code user frames
  if (userFrames.length === 0) {
    // All framework — mark first as trigger
    if (frames.length > 0) frames[0].severity = 'trigger';
    return;
  }

  // Trigger: first user frame (innermost, index 0 or earliest in userFrames)
  const triggerIdx = userFrames[0];
  frames[triggerIdx].severity = 'trigger';

  // Source: last user frame (outermost, root cause)
  const sourceIdx = userFrames[userFrames.length - 1];
  if (sourceIdx !== triggerIdx) {
    frames[sourceIdx].severity = 'source';
  }

  // Propagation: middle user frames
  for (let i = 1; i < userFrames.length - 1; i++) {
    frames[userFrames[i]].severity = 'propagation';
  }
}
