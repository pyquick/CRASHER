// ── PHP profile ──
// Detection rules, framework patterns, exception advice, and log extraction
// for PHP stack traces.

import type { LanguageProfile } from '../../types.js';

export const profile: LanguageProfile = {
  ids: ['php'],

  labels: {
    php: 'PHP',
  },

  // runtime hint strings (lowercase) → detected language id
  runtimeHints: {
    php: 'php',
  },

  // Auto-detect from stack trace content
  detect: (stackTrace: string): string | null => {
    if (stackTrace.match(/^#\d+\s+\/.+\.php\(\d+\)/) || stackTrace.match(/^(?:PHP\s+)?(?:Fatal|Parse|Warning|Notice)\s+error:/m)) return 'php';
    return null;
  },

  // Framework code recognition (severity classification)
  frameworkPatterns: {
    php: [/^\/vendor\//, /^\/var\/www/, /^\[internal/, /^(?:require|include|eval|spl_autoload)/],
  },

  // Exception type → advice
  advice: {
    php: {
      'Fatal error': 'A fatal error, usually caused by an undefined class, function, or syntax error. Check class namespacing and function spelling.',
      'Uncaught Error': 'Uncaught error. Wrap the code that may fail in a try/catch block.',
      'Uncaught Exception': 'Uncaught exception. Add exception handling around the reported location, or ensure callers handle the exception.',
    },
  },

  defaultAdvice: {
    php: 'Enable xdebug for detailed stack traces. Check the file and line reported in the stack trace for the error.',
  },

  // Source analysis: function declaration / definition regex
  functionDeclarations: {
    php: /^\s*(?:(?:public|protected|private|static|final|abstract)\s+)*function\s+([A-Za-z_$][\w$]*)\s*\(/i,
  },
  definitionPatterns: {
    php: (name: string) => new RegExp(`^\\s*(?:(?:public|protected|private|static|final|abstract)\\s+)*function\\s+${name}\\s*\\(`, 'i'),
  },

  // Extract stack trace from log text
  extractFromLog: (logText: string): string => {
    const lines = logText.split('\n');
    const stStart = lines.findIndex(l => l.includes('Stack trace:') || l.match(/^#\d+\s+\S+\.php/));
    if (stStart >= 0) {
      return lines.slice(stStart, Math.min(lines.length, stStart + 40)).join('\n');
    }
    return '';
  },
};
