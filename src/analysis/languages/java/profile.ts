// ── Java / Kotlin profile ──
// Detection rules, framework patterns, exception advice, and log extraction
// for Java/Kotlin (JVM) stack traces.

import type { LanguageProfile } from '../../types.js';

export const profile: LanguageProfile = {
  ids: ['java', 'kotlin'],

  labels: {
    java: 'Java',
    kotlin: 'Kotlin',
  },

  // runtime hint strings (lowercase) → detected language id
  runtimeHints: {
    java: 'java',
    jvm: 'java',
    kotlin: 'kotlin',
  },

  // Auto-detect from stack trace content
  detect: (stackTrace: string): string | null => {
    if (stackTrace.match(/^\s*at\s+[\w$.]+\.[\w$<>]+\([\w$.]+\.(?:java|kt):\d+\)/m)) return 'java';
    return null;
  },

  // Framework code recognition (severity classification)
  frameworkPatterns: {
    java: [/^java\./, /^javax\./, /^jakarta\./, /^sun\./, /^jdk\./, /^org\.springframework\./, /^org\.hibernate\./],
    kotlin: [/^kotlin\./, /^java\./, /^javax\./],
  },

  // Exception type → advice
  advice: {
    java: {
      NullPointerException: 'Null pointer exception. Check for null before calling object methods or accessing fields. Use Objects.requireNonNull() or add null guards before method calls.',
      ArrayIndexOutOfBoundsException: 'Array index out of bounds. Verify the index is within the 0 to length-1 range.',
      ClassCastException: 'Type cast error. Use instanceof checks before casting, or use generics.',
      IllegalArgumentException: 'Illegal or inappropriate argument passed. Add input validation and precondition checks for method parameters.',
      ConcurrentModificationException: 'The collection was modified while iterating over it. Use Iterator.remove() or concurrent collection classes such as ConcurrentHashMap or CopyOnWriteArrayList.',
    },
  },

  defaultAdvice: {
    java: 'Check the stack trace for the exact class and line number. Use a Java debugger or set breakpoints in the reported method.',
    kotlin: 'Review the stack trace for the exact file and line. Use IntelliJ/Android Studio debugger for step-through analysis.',
  },

  // Source analysis: function declaration / definition regex
  functionDeclarations: {},
  definitionPatterns: {},

  // Extract stack trace from log text
  extractFromLog: (logText: string): string => {
    const lines = logText.split('\n');
    const javaLines = lines.filter(l => l.trim().match(/^\s*at\s+/));
    if (javaLines.length > 0) return javaLines.join('\n');
    return '';
  },
};
