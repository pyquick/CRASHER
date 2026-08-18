// ── Elixir / Erlang profile ──
// Detection rules, framework patterns, exception advice, and log extraction
// for Elixir/Erlang (BEAM) stack traces.

import type { LanguageProfile } from '../../types.js';

export const profile: LanguageProfile = {
  ids: ['elixir', 'erlang'],

  labels: {
    elixir: 'Elixir',
    erlang: 'Erlang',
  },

  // runtime hint strings (lowercase) → detected language id
  runtimeHints: {
    elixir: 'elixir',
    exs: 'elixir',
    erlang: 'erlang',
    erl: 'erlang',
  },

  // Auto-detect from stack trace content
  detect: (stackTrace: string): string | null => {
    if (stackTrace.match(/^\s*\([\w.]+\)\s+\w+\/\d+\s/m) || stackTrace.match(/@\w+\/\d+\s+in\s+/m)) return 'elixir';
    return null;
  },

  // Framework code recognition (severity classification)
  frameworkPatterns: {
    elixir: [/^\(elixir\s/, /^\(stdlib\s/, /^\(kernel\s/, /^\(mix\s/, /^\:erlang\./],
    erlang: [/^\(stdlib\s/, /^\(kernel\s/, /^\(erts\s/],
  },

  // Exception type → advice (no language-specific advice; default only)
  advice: {},

  defaultAdvice: {
    elixir: 'Use IEx.pry or :debugger.start for debugging. Check the Mix/OTP stack trace for the exact module and line number.',
    erlang: 'Use :debugger.start() or dbg module for tracing. Check the Erlang stack trace for module:function/arity.',
  },

  // Source analysis: function declaration / definition regex
  functionDeclarations: {
    elixir: /^\s*defp?\s+([A-Za-z_$][\w$]*[!?]?)\s*\(/,
  },
  definitionPatterns: {
    elixir: (name: string) => new RegExp(`^\\s*defp?\\s+${name}\\s*\\(`),
  },

  // Extract stack trace from log text (no language-specific branch; falls back to generic extraction)
  extractFromLog: (): string => '',
};
