// ── Java / Kotlin 分析表 ──
// Detection rules, framework patterns, exception advice, and log extraction
// for Java/Kotlin (JVM) stack traces.

import type { LanguageProfile } from '../../types.js';

export const profile: LanguageProfile = {
  ids: ['java', 'kotlin'],

  labels: {
    java: 'Java',
    kotlin: 'Kotlin',
  },

  // runtime 字符串(小写)→ 检测出的语言 id
  runtimeHints: {
    java: 'java',
    jvm: 'java',
    kotlin: 'kotlin',
  },

  // 按栈内容自动检测
  detect: (stackTrace: string): string | null => {
    if (stackTrace.match(/^\s*at\s+[\w$.]+\.[\w$<>]+\([\w$.]+\.(?:java|kt):\d+\)/m)) return 'java';
    return null;
  },

  // 框架代码识别(severity 分类)
  frameworkPatterns: {
    java: [/^java\./, /^javax\./, /^jakarta\./, /^sun\./, /^jdk\./, /^org\.springframework\./, /^org\.hibernate\./],
    kotlin: [/^kotlin\./, /^java\./, /^javax\./],
  },

  // 异常类型 → 修复建议
  advice: {
    java: {
      NullPointerException: '空指针异常。在调用对象方法或访问字段前检查 null。Use Objects.requireNonNull() or add null guards before method calls.',
      ArrayIndexOutOfBoundsException: '数组索引越界。检查索引是否在 0 到 length-1 范围内。Verify the index is within array bounds.',
      ClassCastException: '类型转换错误。使用 instanceof 检查后再转换，或使用泛型避免。Use instanceof checks before casting, or use generics.',
      IllegalArgumentException: '传递了不合法或不适当的参数。添加输入验证和前置条件检查。Add input validation for method parameters.',
      ConcurrentModificationException: '在迭代集合时修改了集合。使用 Iterator.remove() 或并发集合类。Use ConcurrentHashMap or CopyOnWriteArrayList for concurrent access.',
    },
  },

  defaultAdvice: {
    java: 'Check the stack trace for the exact class and line number. Use a Java debugger or set breakpoints in the reported method.',
    kotlin: 'Review the stack trace for the exact file and line. Use IntelliJ/Android Studio debugger for step-through analysis.',
  },

  // 源码分析:函数声明 / 定义正则
  functionDeclarations: {},
  definitionPatterns: {},

  // 从日志文本提取栈
  extractFromLog: (logText: string): string => {
    const lines = logText.split('\n');
    const javaLines = lines.filter(l => l.trim().match(/^\s*at\s+/));
    if (javaLines.length > 0) return javaLines.join('\n');
    return '';
  },
};
