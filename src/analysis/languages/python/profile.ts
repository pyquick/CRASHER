// ── Python 分析表 ──
// Detection rules, framework patterns, exception advice, and log extraction
// for Python stack traces.

import type { LanguageProfile } from '../../types.js';

export const profile: LanguageProfile = {
  ids: ['python'],

  labels: {
    python: 'Python',
  },

  // runtime 字符串(小写)→ 检测出的语言 id
  runtimeHints: {
    python: 'python',
    python3: 'python',
  },

  // 按栈内容自动检测
  detect: (stackTrace: string): string | null => {
    if (stackTrace.startsWith('Traceback') || stackTrace.match(/File\s+".+?",\s+line\s+\d+,\s+in\s+/m)) return 'python';
    return null;
  },

  // 框架代码识别(severity 分类)
  frameworkPatterns: {
    python: [/^site-packages/, /^lib\/python/, /\/python\d[\d.]*\//, /<frozen/, /<built-in/],
  },

  // 异常类型 → 修复建议
  advice: {
    python: {
      AttributeError: '对象没有该属性。使用 hasattr() 或 try/except 进行防护。Check if the attribute exists before accessing it.',
      KeyError: '字典中缺少该键。使用 dict.get() 安全访问或 in 操作符检查。Use dict.get() instead of direct key access.',
      IndexError: '列表/元组索引越界。检查索引是否在有效范围内。Verify the index is within the valid list/tuple bounds.',
      ValueError: '传入的值类型正确但值不合理。添加输入验证。Add input validation for the problematic value.',
      TypeError: '对不兼容的类型执行了操作。检查变量类型，使用 isinstance() 或类型注解。Check variable types before performing operations.',
    },
  },

  defaultAdvice: {
    python: 'Add try/except blocks around the crash site. Use pdb or a debugger to step through the code at the crash point.',
  },

  // 源码分析:函数声明 / 定义正则
  functionDeclarations: {
    python: /^\s*(?:async\s+)?def\s+([A-Za-z_$][\w$]*)\s*\(/,
  },
  definitionPatterns: {
    python: (name: string) => new RegExp(`^\\s*(?:async\\s+)?def\\s+${name}\\s*\\(`),
  },

  // 从日志文本提取栈
  extractFromLog: (logText: string): string => {
    const lines = logText.split('\n');
    const tbStart = lines.findIndex(l => l.trim().startsWith('Traceback'));
    if (tbStart >= 0) {
      const tbLines: string[] = [];
      for (let i = tbStart; i < Math.min(lines.length, tbStart + 50); i++) {
        tbLines.push(lines[i]);
        if (lines[i].trim().match(/^[\w.]+:\s/)) break; // Exception line ends traceback
      }
      return tbLines.join('\n');
    }
    return '';
  },
};
