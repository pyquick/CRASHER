// ── Dart / Flutter profile ──
// Detection rules, framework patterns, exception advice, and log extraction
// for Dart/Flutter stack traces.

import type { LanguageProfile } from '../../types.js';

export const profile: LanguageProfile = {
  ids: ['dart'],

  labels: {
    dart: 'Dart / Flutter',
  },

  // runtime hint strings (lowercase) → detected language id
  runtimeHints: {
    dart: 'dart',
    flutter: 'dart',
  },

  // Auto-detect from stack trace content
  detect: (stackTrace: string): string | null => {
    if (stackTrace.match(/^package:\S+\.dart\s+\d+:\d+\s+/m) || stackTrace.match(/^dart:\S+\s+\d+:\d+\s+/m)) return 'dart';
    return null;
  },

  // Framework code recognition (severity classification)
  frameworkPatterns: {
    dart: [/^dart:/, /^package:flutter/, /^package:meta/, /^package:collection/],
  },

  // Exception type → advice
  advice: {
    dart: {
      NoSuchMethodError: 'A method that does not exist was called. Verify the method name and argument types.',
      NullThrownError: 'A null value was thrown. Throw a proper Error or Exception subclass.',
      TypeError: 'Type mismatch. Use correct generic types or add type guards.',
    },
  },

  defaultAdvice: {
    dart: 'Use flutter analyze or dart analyze for static code checks. Run with --enable-asserts and use the Dart DevTools debugger.',
  },

  // Source analysis: function declaration / definition regex
  functionDeclarations: {},
  definitionPatterns: {},

  // Extract stack trace from log text
  extractFromLog: (logText: string): string => {
    const lines = logText.split('\n');
    const dartLines = lines.filter(l => l.match(/^(package:|dart:)/));
    if (dartLines.length > 0) return dartLines.join('\n');
    return '';
  },
};
