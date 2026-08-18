// ── C++/C profile ──
// Detection rules, framework patterns, exception advice, and log extraction
// for native C++/C stack traces.

import type { LanguageProfile } from '../../types.js';

export const profile: LanguageProfile = {
  ids: ['cpp', 'c'],

  labels: {
    cpp: 'C++',
    c: 'C',
  },

  // runtime hint strings (lowercase) → detected language id
  runtimeHints: {
    cpp: 'cpp',
    'c++': 'cpp',
    unreal: 'cpp',
    native: 'cpp',
    c: 'c',
  },

  // Auto-detect from stack trace content
  detect: (stackTrace: string): string | null => {
    if (stackTrace.match(/#\d+\s+0x[0-9a-fA-F]+/m) || stackTrace.match(/\(\w+::\w+[\+\d+]*\)/m)) return 'cpp';
    return null;
  },

  // Framework code recognition (severity classification)
  frameworkPatterns: {
    cpp: [/^std::/, /^__/, /^libc/, /^lib\w+\.so/, /\.dylib/, /\.dll/, /^glibc/, /^pthread/, /^boost::/, /^absl::/],
    c: [/^libc/, /^lib\w+\.so/, /\.dylib/, /\.dll/],
  },

  // Exception type → advice
  advice: {
    cpp: {
      SIGSEGV: 'A segmentation fault is usually caused by null pointer dereference, access to freed memory, or stack overflow. Use AddressSanitizer (ASan) or Valgrind to locate the specific memory issue.',
      SIGABRT: 'The program explicitly called abort(). Check for failed assertions or unhandled C++ exceptions.',
      SIGFPE: 'Arithmetic exception (division by zero or integer overflow). Check division operations and floating-point conversions.',
    },
  },

  defaultAdvice: {
    cpp: 'Compile with debug symbols (-g) and use a debugger (gdb/lldb) or AddressSanitizer to identify the exact memory issue.',
  },

  // Source analysis: function declaration / definition regex
  functionDeclarations: {},
  definitionPatterns: {},

  // Extract stack trace from log text (no language-specific branch; falls back to generic extraction)
  extractFromLog: (): string => '',
};
