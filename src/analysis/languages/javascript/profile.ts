// ── JavaScript / TypeScript / Node.js / Browser 分析表 ──
// Detection rules, framework patterns, exception advice, and log extraction
// for JS-family stack traces.

import type { LanguageProfile } from '../../types.js';

export const profile: LanguageProfile = {
  ids: ['javascript', 'typescript', 'node', 'browser'],

  labels: {
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    node: 'Node.js',
    browser: 'Browser JavaScript',
  },

  // runtime 字符串(小写)→ 检测出的语言 id
  runtimeHints: {
    node: 'node',
    nodejs: 'node',
    'node.js': 'node',
    bun: 'node',
    deno: 'node',
    browser: 'browser',
    web: 'browser',
    frontend: 'browser',
    javascript: 'javascript',
    js: 'javascript',
    typescript: 'typescript',
    ts: 'typescript',
  },

  // 按栈内容自动检测
  detect: (stackTrace: string): string | null => {
    if (stackTrace.match(/^\s*at\s+.+\(.+:\d+:\d+\)/m) || stackTrace.match(/^\s*at\s+.+:\d+:\d+$/m)) {
      const jsFileMatch = stackTrace.match(/\.(?:js|mjs|cjs|ts|jsx|tsx|mts|cts):\d+/);
      if (jsFileMatch) return 'javascript';
      // Generic "at ... (file:line:col)" could also be Node/Browser with no ext
      const atCount = (stackTrace.match(/^\s*at\s+/gm) || []).length;
      if (atCount >= 2) return 'javascript';
    }
    return null;
  },

  // 框架代码识别(severity 分类)
  frameworkPatterns: {
    javascript: [/node:internal/, /node_modules/, /<anonymous>/, /processTicksAndRejections/, /^internal\//],
    node: [/node:internal/, /node_modules/, /<anonymous>/, /processTicksAndRejections/, /^internal\//],
    browser: [/^webpack/, /^__webpack/, /^\(index\)/, /^new\s+<anonymous>/, /@chrome-extension/],
  },

  // 异常类型 → 修复建议
  advice: {
    javascript: {
      TypeError: '类型错误，通常是对 null/undefined 访问属性或调用方法。使用可选链操作符 (?.) 或增加空值检查。Use optional chaining (?.) or guard against null/undefined.',
      ReferenceError: '引用了未定义的变量或标识符。检查变量是否在作用域内声明。Check if the variable is declared in the current scope.',
      SyntaxError: '代码语法错误。检查括号匹配、引号闭合和逗号是否正确。Review syntax around the reported location.',
      RangeError: '值超出有效范围，通常发生在数组长度、递归调用或数字转换。Check for infinite recursion or invalid array lengths.',
    },
    node: {
      TypeError: '类型错误，通常是对 null/undefined 访问属性或调用方法。使用可选链操作符 (?.) 或增加空值检查。Use optional chaining (?.) or guard against null/undefined.',
      ReferenceError: '引用了未定义的变量或标识符。检查变量是否在作用域内声明。Check if the variable is declared in the current scope.',
    },
  },

  defaultAdvice: {
    javascript: 'Review the stack trace above for the exact file path and line number. Use browser DevTools or Node.js inspector for debugging.',
    node: 'Review the stack trace above for the exact file path and line number. Use node --inspect or ndb for step-through debugging.',
    browser: 'Check the browser DevTools Sources panel at the reported file and line. Use source maps for minified code.',
    typescript: 'Check the stack trace for the exact source location. Use ts-node --inspect or source-map-support for accurate line numbers.',
  },

  // 源码分析:函数声明 / 定义正则(箭头函数)
  functionDeclarations: {
    javascript: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
    typescript: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  },
  definitionPatterns: {},

  // 从日志文本提取栈
  extractFromLog: (logText: string): string => {
    const lines = logText.split('\n');
    const jsLines = lines.filter(l => l.trim().match(/^\s*at\s+/));
    if (jsLines.length > 0) return jsLines.join('\n');
    return '';
  },
};
