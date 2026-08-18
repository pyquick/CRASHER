// ── Swift 分析表 ──
// Detection rules, framework patterns, exception advice, and log extraction
// for Swift (Apple crash report) stack traces.

import type { LanguageProfile } from '../../types.js';

export const profile: LanguageProfile = {
  ids: ['swift'],

  labels: {
    swift: 'Swift',
  },

  // runtime 字符串(小写)→ 检测出的语言 id
  runtimeHints: {
    swift: 'swift',
  },

  // 按栈内容自动检测
  detect: (stackTrace: string): string | null => {
    if (stackTrace.match(/^\d+\s+\S+\s+0x[0-9a-fA-F]+\s+\S+\s+\+\s+\d+/m) && stackTrace.includes('Thread')) return 'swift';
    return null;
  },

  // 框架代码识别(severity 分类)
  frameworkPatterns: {
    swift: [/^libdispatch/, /^libobjc/, /^libsystem/, /^libswift/, /^CoreFoundation/, /^Foundation/, /^UIKit/, /^SwiftUI/, /^Combine/],
  },

  // 异常类型 → 修复建议
  advice: {
    swift: {
      'fatal error': '运行时致命错误，通常由强制解包 nil 可选值导致。避免使用 ! 强制解包，改用 if let 或 guard let。Avoid force-unwrapping optionals; use if let or guard let instead.',
      'EXC_BAD_ACCESS': '内存访问错误，通常访问了已释放或无效的内存。使用 Xcode Zombies 或 Address Sanitizer 调试。Use Xcode diagnostic tools to identify the memory issue.',
      SIGABRT: '程序异常终止，通常由未满足的前置条件或运行时检查失败。检查 assert/precondition 调用。',
    },
  },

  defaultAdvice: {
    swift: 'Use Xcode debugger and Instruments to analyze the crash. Enable zombie objects and address sanitizer for memory issues.',
  },

  // 源码分析:函数声明 / 定义正则
  functionDeclarations: {},
  definitionPatterns: {},

  // 从日志文本提取栈
  extractFromLog: (logText: string): string => {
    const lines = logText.split('\n');
    const swiftStart = lines.findIndex(l => l.match(/^\d+\s+\S+\s+0x/));
    if (swiftStart >= 0) {
      return lines.slice(swiftStart, Math.min(lines.length, swiftStart + 50)).join('\n');
    }
    return '';
  },
};
