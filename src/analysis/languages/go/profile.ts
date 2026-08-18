// ── Go 分析表 ──
// Detection rules, framework patterns, exception advice, and log extraction
// for Go stack traces.

import type { LanguageProfile } from '../../types.js';

export const profile: LanguageProfile = {
  ids: ['go'],

  labels: {
    go: 'Go',
  },

  // runtime 字符串(小写)→ 检测出的语言 id
  runtimeHints: {
    go: 'go',
    golang: 'go',
  },

  // 按栈内容自动检测
  detect: (stackTrace: string): string | null => {
    if (stackTrace.match(/^(goroutine\s+\d+|panic:)/m) || stackTrace.match(/^(\S+)\.(\w+)\(.*?\)\s*$/m)) {
      const goCount = (stackTrace.match(/^(\S+)\.(\w+)\(.*?\)$/gm) || []).length;
      if (goCount >= 2) return 'go';
    }
    return null;
  },

  // 框架代码识别(severity 分类)
  frameworkPatterns: {
    go: [/^runtime\./, /^sync\./, /^internal\//, /^reflect\./, /^syscall\./],
  },

  // 异常类型 → 修复建议
  advice: {
    go: {
      'panic': '检查是否有 nil 指针解引用、越界切片访问或类型断言失败。Use defer/recover for graceful error handling.',
      'runtime error': '运行时错误通常是 nil 指针、越界访问或并发问题。检查 goroutine 中的共享状态访问。',
    },
  },

  defaultAdvice: {
    go: 'Run the failing test with -race flag to detect data races. Use delve (dlv) debugger for step-through debugging.',
  },

  // 源码分析:函数声明 / 定义正则
  functionDeclarations: {
    go: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)\s*\(/,
  },
  definitionPatterns: {
    go: (name: string) => new RegExp(`^\\s*func\\s+(?:\\([^)]*\\)\\s*)?${name}\\s*\\(`),
  },

  // 从日志文本提取栈
  extractFromLog: (logText: string): string => {
    const lines = logText.split('\n');
    const panicIdx = lines.findIndex(l => l.includes('panic:') || l.includes('goroutine'));
    if (panicIdx >= 0) {
      return lines.slice(panicIdx, Math.min(lines.length, panicIdx + 40)).join('\n');
    }
    return '';
  },
};
