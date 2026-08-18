// ── Elixir / Erlang 分析表 ──
// Detection rules, framework patterns, exception advice, and log extraction
// for Elixir/Erlang (BEAM) stack traces.

import type { LanguageProfile } from '../../types.js';

export const profile: LanguageProfile = {
  ids: ['elixir', 'erlang'],

  labels: {
    elixir: 'Elixir',
    erlang: 'Erlang',
  },

  // runtime 字符串(小写)→ 检测出的语言 id
  runtimeHints: {
    elixir: 'elixir',
    exs: 'elixir',
    erlang: 'erlang',
    erl: 'erlang',
  },

  // 按栈内容自动检测
  detect: (stackTrace: string): string | null => {
    if (stackTrace.match(/^\s*\([\w.]+\)\s+\w+\/\d+\s/m) || stackTrace.match(/@\w+\/\d+\s+in\s+/m)) return 'elixir';
    return null;
  },

  // 框架代码识别(severity 分类)
  frameworkPatterns: {
    elixir: [/^\(elixir\s/, /^\(stdlib\s/, /^\(kernel\s/, /^\(mix\s/, /^\:erlang\./],
    erlang: [/^\(stdlib\s/, /^\(kernel\s/, /^\(erts\s/],
  },

  // 异常类型 → 修复建议(无专属建议,仅默认)
  advice: {},

  defaultAdvice: {
    elixir: 'Use IEx.pry or :debugger.start for debugging. Check the Mix/OTP stack trace for the exact module and line number.',
    erlang: 'Use :debugger.start() or dbg module for tracing. Check the Erlang stack trace for module:function/arity.',
  },

  // 源码分析:函数声明 / 定义正则
  functionDeclarations: {
    elixir: /^\s*defp?\s+([A-Za-z_$][\w$]*[!?]?)\s*\(/,
  },
  definitionPatterns: {
    elixir: (name: string) => new RegExp(`^\\s*defp?\\s+${name}\\s*\\(`),
  },

  // 从日志文本提取栈(无专属分支,直接走通用提取)
  extractFromLog: (): string => '',
};
