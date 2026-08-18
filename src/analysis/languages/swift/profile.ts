// ── Swift profile ──
// Detection rules, framework patterns, exception advice, and log extraction
// for Swift (Apple crash report) stack traces.

import type { LanguageProfile } from '../../types.js';

export const profile: LanguageProfile = {
  ids: ['swift'],

  labels: {
    swift: 'Swift',
  },

  // runtime hint strings (lowercase) → detected language id
  runtimeHints: {
    swift: 'swift',
  },

  // Auto-detect from stack trace content
  detect: (stackTrace: string): string | null => {
    if (stackTrace.match(/^\d+\s+\S+\s+0x[0-9a-fA-F]+\s+\S+\s+\+\s+\d+/m) && stackTrace.includes('Thread')) return 'swift';
    return null;
  },

  // Framework code recognition (severity classification)
  frameworkPatterns: {
    swift: [/^libdispatch/, /^libobjc/, /^libsystem/, /^libswift/, /^CoreFoundation/, /^Foundation/, /^UIKit/, /^SwiftUI/, /^Combine/],
  },

  // Exception type → advice
  advice: {
    swift: {
      'fatal error': 'A runtime fatal error, usually caused by force-unwrapping a nil optional. Avoid force-unwrapping optionals; use if let or guard let instead.',
      'EXC_BAD_ACCESS': 'A memory access error, usually accessing freed or invalid memory. Use Xcode diagnostic tools such as Zombies or Address Sanitizer to identify the memory issue.',
      SIGABRT: 'The program terminated abnormally, usually due to an unmet precondition or failed runtime check. Check assert/precondition calls.',
    },
  },

  defaultAdvice: {
    swift: 'Use Xcode debugger and Instruments to analyze the crash. Enable zombie objects and address sanitizer for memory issues.',
  },

  // Source analysis: function declaration / definition regex
  functionDeclarations: {},
  definitionPatterns: {},

  // Extract stack trace from log text
  extractFromLog: (logText: string): string => {
    const lines = logText.split('\n');
    const swiftStart = lines.findIndex(l => l.match(/^\d+\s+\S+\s+0x/));
    if (swiftStart >= 0) {
      return lines.slice(swiftStart, Math.min(lines.length, swiftStart + 50)).join('\n');
    }
    return '';
  },
};
