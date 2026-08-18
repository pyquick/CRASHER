// ── Stack Trace Parser (Entry) ──
// Thin dispatcher: detects the language (via the registry) and
// delegates frame parsing to the matching language folder. The generic
// fallback and severity classification live in common/.

import type { StackFrame } from './types.js';
import { LANGUAGE_PROFILES, PARSERS } from './registry.js';
import { classifySeverity } from './common/severity.js';
import { parseGeneric } from './common/generic.js';

/**
 * Parse a raw stack trace into structured frames, auto-detecting the language.
 */
export function parseStackFrames(stackTrace: string, runtime: string): StackFrame[] {
  if (!stackTrace?.trim()) return [];

  const lines = stackTrace.split('\n');

  // Detect language from runtime hint or stack trace patterns
  const lang = detectLanguage(stackTrace, runtime);

  const parser = PARSERS[lang];
  const frames = parser ? parser(lines) : parseGeneric(lines);

  // Classify severity for each frame
  classifySeverity(frames, lang);

  return frames;
}

/**
 * Detect the programming language from runtime hint and stack trace content.
 */
export function detectLanguage(stackTrace: string, runtime: string): string {
  // Use runtime hints first
  const rt = runtime.toLowerCase();
  for (const profile of LANGUAGE_PROFILES) {
    const id = profile.runtimeHints[rt];
    if (id) return id;
  }

  // Auto-detect from stack trace content
  for (const profile of LANGUAGE_PROFILES) {
    const id = profile.detect(stackTrace);
    if (id) return id;
  }

  return 'unknown';
}
