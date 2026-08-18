// ── Dart / Flutter 分析表 ──
// Detection rules, framework patterns, exception advice, and log extraction
// for Dart/Flutter stack traces.

import type { LanguageProfile } from '../../types.js';

export const profile: LanguageProfile = {
  ids: ['dart'],

  labels: {
    dart: 'Dart / Flutter',
  },

  // runtime 字符串(小写)→ 检测出的语言 id
  runtimeHints: {
    dart: 'dart',
    flutter: 'dart',
  },

  // 按栈内容自动检测
  detect: (stackTrace: string): string | null => {
    if (stackTrace.match(/^package:\S+\.dart\s+\d+:\d+\s+/m) || stackTrace.match(/^dart:\S+\s+\d+:\d+\s+/m)) return 'dart';
    return null;
  },

  // 框架代码识别(severity 分类)
  frameworkPatterns: {
    dart: [/^dart:/, /^package:flutter/, /^package:meta/, /^package:collection/],
  },

  // 异常类型 → 修复建议
  advice: {
    dart: {
      NoSuchMethodError: '调用了不存在的方法。检查方法名拼写和参数类型。Verify the method name and argument types.',
      NullThrownError: '抛出了 null 值。确保抛出的是 Error 或 Exception 的子类。Throw a proper Error or Exception subclass.',
      TypeError: '类型不匹配。使用正确的泛型类型或添加类型检查。Use correct generic types or add type guards.',
    },
  },

  defaultAdvice: {
    dart: 'Use flutter analyze or dart analyze for static code checks. Run with --enable-asserts and use the Dart DevTools debugger.',
  },

  // 源码分析:函数声明 / 定义正则
  functionDeclarations: {},
  definitionPatterns: {},

  // 从日志文本提取栈
  extractFromLog: (logText: string): string => {
    const lines = logText.split('\n');
    const dartLines = lines.filter(l => l.match(/^(package:|dart:)/));
    if (dartLines.length > 0) return dartLines.join('\n');
    return '';
  },
};
