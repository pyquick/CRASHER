// ── Ruby profile ──
// Detection rules, framework patterns, exception advice, and log extraction
// for Ruby stack traces.

import type { LanguageProfile } from '../../types.js';

export const profile: LanguageProfile = {
  ids: ['ruby'],

  labels: {
    ruby: 'Ruby',
  },

  // runtime hint strings (lowercase) → detected language id
  runtimeHints: {
    ruby: 'ruby',
    rb: 'ruby',
  },

  // Auto-detect from stack trace content
  detect: (stackTrace: string): string | null => {
    if (stackTrace.match(/^\s*from\s+\/.+\.rb:\d+:in\s+`/) || stackTrace.match(/\S+\.rb:\d+:in\s+`/m)) return 'ruby';
    return null;
  },

  // Framework code recognition (severity classification)
  frameworkPatterns: {
    ruby: [/^\/gems\//, /^\/ruby\//, /^\/usr\/lib\/ruby/, /<internal:/],
  },

  // Exception type → advice
  advice: {
    ruby: {
      NoMethodError: 'A method that does not exist on the object was called. Use respond_to? to check or ensure the object type is correct.',
      NameError: 'An undefined variable or constant was referenced. Check the spelling and verify the variable/constant is defined before use.',
    },
  },

  defaultAdvice: {
    ruby: 'Review the stack trace for file paths and line numbers. Use byebug or pry for step-through debugging.',
  },

  // Source analysis: function declaration / definition regex
  functionDeclarations: {
    ruby: /^\s*def\s+(?:self\.)?([A-Za-z_$][\w$]*[!?=]?)\b/,
  },
  definitionPatterns: {
    ruby: (name: string) => new RegExp(`^\\s*def\\s+(?:self\\.)?${name}\\b`),
  },

  // Extract stack trace from log text
  extractFromLog: (logText: string): string => {
    const lines = logText.split('\n');
    const rbLines = lines.filter(l => l.match(/\S+\.rb:\d+/));
    if (rbLines.length > 0) return rbLines.join('\n');
    return '';
  },
};
