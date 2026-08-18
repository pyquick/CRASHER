// ── Lua 分析表 ──
// Detection rules, framework patterns, exception advice, and log extraction
// for Lua stack traces.

import type { LanguageProfile } from '../../types.js';

export const profile: LanguageProfile = {
  ids: ['lua'],

  labels: {
    lua: 'Lua',
  },

  // runtime 字符串(小写)→ 检测出的语言 id
  runtimeHints: {
    lua: 'lua',
  },

  // 按栈内容自动检测
  detect: (stackTrace: string): string | null => {
    if (stackTrace.match(/^stack\s+traceback:/m) || stackTrace.match(/\S+\.lua:\d+:\s+in\s+/m)) return 'lua';
    return null;
  },

  // 框架代码识别(severity 分类)
  frameworkPatterns: {
    lua: [/^\[C\]/, /\/?.+?\/lua\//, /\/?.+?\/luajit\//],
  },

  // 异常类型 → 修复建议(无专属建议,仅默认)
  advice: {},

  defaultAdvice: {
    lua: 'Use lua-debug or mobdebug for remote debugging. Add pcall() wrappers around the crash site for graceful error handling.',
  },

  // 源码分析:函数声明 / 定义正则
  functionDeclarations: {
    lua: /^\s*(?:local\s+)?function\s+(?:[\w.:]+[.:])?([A-Za-z_$][\w$]*)\s*\(/,
  },
  definitionPatterns: {
    lua: (name: string) => new RegExp(`^\\s*(?:local\\s+)?function\\s+(?:[\\w.:]+[.:])?${name}\\s*\\(`),
  },

  // 从日志文本提取栈(无专属分支,直接走通用提取)
  extractFromLog: (): string => '',
};
