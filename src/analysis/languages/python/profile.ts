// ── Python profile ──
// Detection rules, framework patterns, exception advice, and log extraction
// for Python stack traces.

import type { LanguageProfile } from '../../types.js';

export const profile: LanguageProfile = {
  ids: ['python'],

  labels: {
    python: 'Python',
  },

  // runtime hint strings (lowercase) → detected language id
  runtimeHints: {
    python: 'python',
    python3: 'python',
  },

  // Auto-detect from stack trace content
  detect: (stackTrace: string): string | null => {
    if (stackTrace.startsWith('Traceback') || stackTrace.match(/File\s+".+?",\s+line\s+\d+,\s+in\s+/m)) return 'python';
    return null;
  },

  // Framework code recognition (severity classification)
  frameworkPatterns: {
    python: [/^site-packages/, /^lib\/python/, /\/python\d[\d.]*\//, /<frozen/, /<built-in/],
  },

  // Exception type → advice
  advice: {
    python: {
      AttributeError: 'The object does not have this attribute. Use hasattr() or try/except to guard access.',
      KeyError: 'The key is missing from the dictionary. Use dict.get() for safe access or check with the in operator.',
      IndexError: 'List/tuple index out of bounds. Verify the index is within the valid list/tuple bounds.',
      ValueError: 'The value has the correct type but is invalid. Add input validation for the problematic value.',
      TypeError: 'An operation was performed on incompatible types. Check variable types with isinstance() or type annotations.',
    },
  },

  defaultAdvice: {
    python: 'Add try/except blocks around the crash site. Use pdb or a debugger to step through the code at the crash point.',
  },

  // Source analysis: function declaration / definition regex
  functionDeclarations: {
    python: /^\s*(?:async\s+)?def\s+([A-Za-z_$][\w$]*)\s*\(/,
  },
  definitionPatterns: {
    python: (name: string) => new RegExp(`^\\s*(?:async\\s+)?def\\s+${name}\\s*\\(`),
  },

  // Extract stack trace from log text
  extractFromLog: (logText: string): string => {
    const lines = logText.split('\n');
    const tbStart = lines.findIndex(l => l.trim().startsWith('Traceback'));
    if (tbStart >= 0) {
      const tbLines: string[] = [];
      for (let i = tbStart; i < Math.min(lines.length, tbStart + 50); i++) {
        tbLines.push(lines[i]);
        if (lines[i].trim().match(/^[\w.]+:\s/)) break; // Exception line ends traceback
      }
      return tbLines.join('\n');
    }
    return '';
  },
};
