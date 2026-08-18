// ── Go profile ──
// Detection rules, framework patterns, exception advice, and log extraction
// for Go stack traces.

import type { LanguageProfile } from '../../types.js';

export const profile: LanguageProfile = {
  ids: ['go'],

  labels: {
    go: 'Go',
  },

  // runtime hint strings (lowercase) → detected language id
  runtimeHints: {
    go: 'go',
    golang: 'go',
  },

  // Auto-detect from stack trace content
  detect: (stackTrace: string): string | null => {
    if (stackTrace.match(/^(goroutine\s+\d+|panic:)/m) || stackTrace.match(/^(\S+)\.(\w+)\(.*?\)\s*$/m)) {
      const goCount = (stackTrace.match(/^(\S+)\.(\w+)\(.*?\)$/gm) || []).length;
      if (goCount >= 2) return 'go';
    }
    return null;
  },

  // Framework code recognition (severity classification)
  frameworkPatterns: {
    go: [/^runtime\./, /^sync\./, /^internal\//, /^reflect\./, /^syscall\./],
  },

  // Exception type → advice
  advice: {
    go: {
      'panic': 'Check for nil pointer dereference, slice out-of-bounds access, or failed type assertions. Use defer/recover for graceful error handling.',
      'runtime error': 'Runtime errors are usually caused by nil pointers, out-of-bounds access, or concurrency issues. Check shared state access in goroutines.',
    },
  },

  defaultAdvice: {
    go: 'Run the failing test with -race flag to detect data races. Use delve (dlv) debugger for step-through debugging.',
  },

  // Source analysis: function declaration / definition regex
  functionDeclarations: {
    go: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)\s*\(/,
  },
  definitionPatterns: {
    go: (name: string) => new RegExp(`^\\s*func\\s+(?:\\([^)]*\\)\\s*)?${name}\\s*\\(`),
  },

  // Extract stack trace from log text
  extractFromLog: (logText: string): string => {
    const lines = logText.split('\n');
    const panicIdx = lines.findIndex(l => l.includes('panic:') || l.includes('goroutine'));
    if (panicIdx >= 0) {
      return lines.slice(panicIdx, Math.min(lines.length, panicIdx + 40)).join('\n');
    }
    return '';
  },
};
