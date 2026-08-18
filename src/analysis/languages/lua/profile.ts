// ── Lua profile ──
// Detection rules, framework patterns, exception advice, and log extraction
// for Lua stack traces.

import type { LanguageProfile } from '../../types.js';

export const profile: LanguageProfile = {
  ids: ['lua'],

  labels: {
    lua: 'Lua',
  },

  // runtime hint strings (lowercase) → detected language id
  runtimeHints: {
    lua: 'lua',
  },

  // Auto-detect from stack trace content
  detect: (stackTrace: string): string | null => {
    if (stackTrace.match(/^stack\s+traceback:/m) || stackTrace.match(/\S+\.lua:\d+:\s+in\s+/m)) return 'lua';
    return null;
  },

  // Framework code recognition (severity classification)
  frameworkPatterns: {
    lua: [/^\[C\]/, /\/?.+?\/lua\//, /\/?.+?\/luajit\//],
  },

  // Exception type → advice (no language-specific advice; default only)
  advice: {},

  defaultAdvice: {
    lua: 'Use lua-debug or mobdebug for remote debugging. Add pcall() wrappers around the crash site for graceful error handling.',
  },

  // Source analysis: function declaration / definition regex
  functionDeclarations: {
    lua: /^\s*(?:local\s+)?function\s+(?:[\w.:]+[.:])?([A-Za-z_$][\w$]*)\s*\(/,
  },
  definitionPatterns: {
    lua: (name: string) => new RegExp(`^\\s*(?:local\\s+)?function\\s+(?:[\\w.:]+[.:])?${name}\\s*\\(`),
  },

  // Extract stack trace from log text (no language-specific branch; falls back to generic extraction)
  extractFromLog: (): string => '',
};
