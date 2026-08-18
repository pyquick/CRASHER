// ── PHP 分析表 ──
// Detection rules, framework patterns, exception advice, and log extraction
// for PHP stack traces.

import type { LanguageProfile } from '../../types.js';

export const profile: LanguageProfile = {
  ids: ['php'],

  labels: {
    php: 'PHP',
  },

  // runtime 字符串(小写)→ 检测出的语言 id
  runtimeHints: {
    php: 'php',
  },

  // 按栈内容自动检测
  detect: (stackTrace: string): string | null => {
    if (stackTrace.match(/^#\d+\s+\/.+\.php\(\d+\)/) || stackTrace.match(/^(?:PHP\s+)?(?:Fatal|Parse|Warning|Notice)\s+error:/m)) return 'php';
    return null;
  },

  // 框架代码识别(severity 分类)
  frameworkPatterns: {
    php: [/^\/vendor\//, /^\/var\/www/, /^\[internal/, /^(?:require|include|eval|spl_autoload)/],
  },

  // 异常类型 → 修复建议
  advice: {
    php: {
      'Fatal error': '致命错误，通常由未定义的类、函数或语法错误导致。检查类名前缀和函数拼写。Check class namespacing and function spelling.',
      'Uncaught Error': '未捕获的错误。使用 try/catch 块包裹可能出错的代码。Wrap the crash site in a try/catch block.',
      'Uncaught Exception': '未捕获的异常。添加 try/catch 处理或确保上层调用者有异常处理。Add exception handling around the reported location.',
    },
  },

  defaultAdvice: {
    php: 'Enable xdebug for detailed stack traces. Check the file and line reported in the stack trace for the error.',
  },

  // 源码分析:函数声明 / 定义正则
  functionDeclarations: {
    php: /^\s*(?:(?:public|protected|private|static|final|abstract)\s+)*function\s+([A-Za-z_$][\w$]*)\s*\(/i,
  },
  definitionPatterns: {
    php: (name: string) => new RegExp(`^\\s*(?:(?:public|protected|private|static|final|abstract)\\s+)*function\\s+${name}\\s*\\(`, 'i'),
  },

  // 从日志文本提取栈
  extractFromLog: (logText: string): string => {
    const lines = logText.split('\n');
    const stStart = lines.findIndex(l => l.includes('Stack trace:') || l.match(/^#\d+\s+\S+\.php/));
    if (stStart >= 0) {
      return lines.slice(stStart, Math.min(lines.length, stStart + 40)).join('\n');
    }
    return '';
  },
};
