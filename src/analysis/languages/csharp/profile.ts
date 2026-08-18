// ── C# / Unity profile ──
// Detection rules, framework patterns, exception advice, and log extraction
// for C# (Unity / .NET) stack traces.

import type { LanguageProfile } from '../../types.js';

export const profile: LanguageProfile = {
  ids: ['csharp'],

  labels: {
    csharp: 'C# / Unity',
  },

  // runtime hint strings (lowercase) → detected language id
  runtimeHints: {
    unity: 'csharp',
    csharp: 'csharp',
    dotnet: 'csharp',
    '.net': 'csharp',
  },

  // Auto-detect from stack trace content
  detect: (stackTrace: string): string | null => {
    if (stackTrace.match(/at\s+[\w.<>]+.*in\s+.+:\d+/m)) return 'csharp';
    return null;
  },

  // Framework code recognition (severity classification)
  frameworkPatterns: {
    csharp: [/^System\./, /^UnityEngine\./, /^UnityEditor\./, /^Microsoft\./, /^mscorlib/, /^Mono\./, /^netstandard/],
  },

  // Exception type → advice
  advice: {
    csharp: {
      NullReferenceException: 'Check if the object reference is null before accessing its members.',
      ArgumentNullException: 'Ensure arguments passed to the method are not null.',
      IndexOutOfRangeException: 'Verify the index is within the valid bounds of the array or list.',
      InvalidOperationException: 'Ensure the operation preconditions are met (e.g. the collection is not modified during enumeration).',
      KeyNotFoundException: 'Check if the key exists before accessing the dictionary, or use TryGetValue.',
    },
  },

  defaultAdvice: {
    csharp: 'Reproduce the crash in a development build with full debug symbols. Check the C# stack trace above for the exact file and line number.',
  },

  // Source analysis: function declaration / definition regex
  functionDeclarations: {},
  definitionPatterns: {},

  // Extract stack trace from log text
  extractFromLog: (logText: string): string => {
    const lines = logText.split('\n');
    const atLines = lines.filter(l => l.trim().match(/^\s*at\s+/));
    if (atLines.length > 0) return atLines.join('\n');
    return '';
  },
};
