// ── Rust 分析表 ──
// Detection rules, framework patterns, exception advice, and log extraction
// for Rust stack traces.

import type { LanguageProfile } from '../../types.js';

export const profile: LanguageProfile = {
  ids: ['rust'],

  labels: {
    rust: 'Rust',
  },

  // runtime 字符串(小写)→ 检测出的语言 id
  runtimeHints: {
    rust: 'rust',
    rs: 'rust',
  },

  // 按栈内容自动检测
  detect: (stackTrace: string): string | null => {
    if (stackTrace.match(/^thread\s+'.*?'\s+panicked\s+at/m) || stackTrace.match(/^\s+\d+:\s+0x[0-9a-f]+\s+-/m)) {
      if (stackTrace.includes('.rs:') || stackTrace.includes('mod.rs:') || stackTrace.includes('lib.rs:')) return 'rust';
    }
    return null;
  },

  // 框架代码识别(severity 分类)
  frameworkPatterns: {
    rust: [/^std::/, /^core::/, /^alloc::/, /^rust_begin_unwind/, /^panic_unwind/, /<\w+ as core::/],
  },

  // 异常类型 → 修复建议
  advice: {
    rust: {
      'panicked at': '程序触发了 panic!，通常是不可恢复的错误。检查 unwrap/expect 调用或数组越界访问。Check unwrap/expect calls and array indexing.',
    },
  },

  defaultAdvice: {
    rust: 'Run with RUST_BACKTRACE=full for a complete stack trace. Use cargo test or a debugger (gdb/lldb) for detailed analysis.',
  },

  // 源码分析:函数声明 / 定义正则
  functionDeclarations: {
    rust: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_$][\w$]*)\s*\(/,
  },
  definitionPatterns: {
    rust: (name: string) => new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+${name}\\s*\\(`),
  },

  // 从日志文本提取栈
  extractFromLog: (logText: string): string => {
    const lines = logText.split('\n');
    const rsStart = lines.findIndex(l => l.includes('panicked at') || l.includes('stack backtrace:'));
    if (rsStart >= 0) {
      return lines.slice(rsStart, Math.min(lines.length, rsStart + 50)).join('\n');
    }
    return '';
  },
};
