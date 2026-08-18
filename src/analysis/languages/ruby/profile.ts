// ── Ruby 分析表 ──
// Detection rules, framework patterns, exception advice, and log extraction
// for Ruby stack traces.

import type { LanguageProfile } from '../../types.js';

export const profile: LanguageProfile = {
  ids: ['ruby'],

  labels: {
    ruby: 'Ruby',
  },

  // runtime 字符串(小写)→ 检测出的语言 id
  runtimeHints: {
    ruby: 'ruby',
    rb: 'ruby',
  },

  // 按栈内容自动检测
  detect: (stackTrace: string): string | null => {
    if (stackTrace.match(/^\s*from\s+\/.+\.rb:\d+:in\s+`/) || stackTrace.match(/\S+\.rb:\d+:in\s+`/m)) return 'ruby';
    return null;
  },

  // 框架代码识别(severity 分类)
  frameworkPatterns: {
    ruby: [/^\/gems\//, /^\/ruby\//, /^\/usr\/lib\/ruby/, /<internal:/],
  },

  // 异常类型 → 修复建议
  advice: {
    ruby: {
      NoMethodError: '调用了对象不存在的方法。使用 respond_to? 检查或确保对象类型正确。Check if the object responds to the method before calling.',
      NameError: '引用了未定义的变量或常量。检查拼写或确保定义在使用之前。Verify the variable/constant is defined.',
    },
  },

  defaultAdvice: {
    ruby: 'Review the stack trace for file paths and line numbers. Use byebug or pry for step-through debugging.',
  },

  // 源码分析:函数声明 / 定义正则
  functionDeclarations: {
    ruby: /^\s*def\s+(?:self\.)?([A-Za-z_$][\w$]*[!?=]?)\b/,
  },
  definitionPatterns: {
    ruby: (name: string) => new RegExp(`^\\s*def\\s+(?:self\\.)?${name}\\b`),
  },

  // 从日志文本提取栈
  extractFromLog: (logText: string): string => {
    const lines = logText.split('\n');
    const rbLines = lines.filter(l => l.match(/\S+\.rb:\d+/));
    if (rbLines.length > 0) return rbLines.join('\n');
    return '';
  },
};
