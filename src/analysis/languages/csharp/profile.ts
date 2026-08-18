// ── C# / Unity 分析表 ──
// Detection rules, framework patterns, exception advice, and log extraction
// for C# (Unity / .NET) stack traces.

import type { LanguageProfile } from '../../types.js';

export const profile: LanguageProfile = {
  ids: ['csharp'],

  labels: {
    csharp: 'C# / Unity',
  },

  // runtime 字符串(小写)→ 检测出的语言 id
  runtimeHints: {
    unity: 'csharp',
    csharp: 'csharp',
    dotnet: 'csharp',
    '.net': 'csharp',
  },

  // 按栈内容自动检测
  detect: (stackTrace: string): string | null => {
    if (stackTrace.match(/at\s+[\w.<>]+.*in\s+.+:\d+/m)) return 'csharp';
    return null;
  },

  // 框架代码识别(severity 分类)
  frameworkPatterns: {
    csharp: [/^System\./, /^UnityEngine\./, /^UnityEditor\./, /^Microsoft\./, /^mscorlib/, /^Mono\./, /^netstandard/],
  },

  // 异常类型 → 修复建议
  advice: {
    csharp: {
      NullReferenceException: '检查引用是否为 null，在访问对象成员前加入判空逻辑。Check if the object reference is null before accessing its members.',
      ArgumentNullException: '确保传递给方法的参数不为 null。Ensure arguments passed to the method are not null.',
      IndexOutOfRangeException: '检查数组/列表索引是否在有效范围内。Verify the index is within the valid bounds of the array or list.',
      InvalidOperationException: '检查操作的前提条件是否满足（如集合在枚举时未被修改）。Ensure the operation preconditions are met.',
      KeyNotFoundException: '访问字典前检查 key 是否存在，或使用 TryGetValue。Check if the key exists before accessing the dictionary.',
    },
  },

  defaultAdvice: {
    csharp: 'Reproduce the crash in a development build with full debug symbols. Check the C# stack trace above for the exact file and line number.',
  },

  // 源码分析:函数声明 / 定义正则
  functionDeclarations: {},
  definitionPatterns: {},

  // 从日志文本提取栈
  extractFromLog: (logText: string): string => {
    const lines = logText.split('\n');
    const atLines = lines.filter(l => l.trim().match(/^\s*at\s+/));
    if (atLines.length > 0) return atLines.join('\n');
    return '';
  },
};
