// ── Rust profile ──
// Detection rules, framework patterns, exception advice, and log extraction
// for Rust stack traces.

import type { LanguageProfile } from '../../types.js';

export const profile: LanguageProfile = {
  ids: ['rust'],

  labels: {
    rust: 'Rust',
  },

  // runtime hint strings (lowercase) → detected language id
  runtimeHints: {
    rust: 'rust',
    rs: 'rust',
  },

  // Auto-detect from stack trace content
  detect: (stackTrace: string): string | null => {
    if (stackTrace.match(/^thread\s+'.*?'\s+panicked\s+at/m) || stackTrace.match(/^\s+\d+:\s+0x[0-9a-f]+\s+-/m)) {
      if (stackTrace.includes('.rs:') || stackTrace.includes('mod.rs:') || stackTrace.includes('lib.rs:')) return 'rust';
    }
    return null;
  },

  // Framework code recognition (severity classification)
  frameworkPatterns: {
    rust: [/^std::/, /^core::/, /^alloc::/, /^rust_begin_unwind/, /^panic_unwind/, /<\w+ as core::/],
  },

  // Exception type → advice
  advice: {
    rust: {
      'panicked at': 'The program triggered a panic!, usually an unrecoverable error. Check unwrap/expect calls and array indexing.',
    },
  },

  defaultAdvice: {
    rust: 'Run with RUST_BACKTRACE=full for a complete stack trace. Use cargo test or a debugger (gdb/lldb) for detailed analysis.',
  },

  // Source analysis: function declaration / definition regex
  functionDeclarations: {
    rust: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_$][\w$]*)\s*\(/,
  },
  definitionPatterns: {
    rust: (name: string) => new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+${name}\\s*\\(`),
  },

  // Extract stack trace from log text
  extractFromLog: (logText: string): string => {
    const lines = logText.split('\n');
    const rsStart = lines.findIndex(l => l.includes('panicked at') || l.includes('stack backtrace:'));
    if (rsStart >= 0) {
      return lines.slice(rsStart, Math.min(lines.length, rsStart + 50)).join('\n');
    }
    return '';
  },
};
