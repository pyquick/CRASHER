// ── C++/C 分析表 ──
// Detection rules, framework patterns, exception advice, and log extraction
// for native C++/C stack traces.

import type { LanguageProfile } from '../../types.js';

export const profile: LanguageProfile = {
  ids: ['cpp', 'c'],

  labels: {
    cpp: 'C++',
    c: 'C',
  },

  // runtime 字符串(小写)→ 检测出的语言 id
  runtimeHints: {
    cpp: 'cpp',
    'c++': 'cpp',
    unreal: 'cpp',
    native: 'cpp',
    c: 'c',
  },

  // 按栈内容自动检测
  detect: (stackTrace: string): string | null => {
    if (stackTrace.match(/#\d+\s+0x[0-9a-fA-F]+/m) || stackTrace.match(/\(\w+::\w+[\+\d+]*\)/m)) return 'cpp';
    return null;
  },

  // 框架代码识别(severity 分类)
  frameworkPatterns: {
    cpp: [/^std::/, /^__/, /^libc/, /^lib\w+\.so/, /\.dylib/, /\.dll/, /^glibc/, /^pthread/, /^boost::/, /^absl::/],
    c: [/^libc/, /^lib\w+\.so/, /\.dylib/, /\.dll/],
  },

  // 异常类型 → 修复建议
  advice: {
    cpp: {
      SIGSEGV: '段错误通常由空指针解引用、访问已释放内存或栈溢出引起。使用 AddressSanitizer (ASan) 或 Valgrind 定位具体的内存问题。',
      SIGABRT: '程序主动调用了 abort()。检查 assert 失败或未捕获的 C++ 异常。Check for failed assertions or unhandled exceptions.',
      SIGFPE: '算术异常（除零或整数溢出）。检查除法运算和浮点数转换。Check for division by zero or integer overflow.',
    },
  },

  defaultAdvice: {
    cpp: 'Compile with debug symbols (-g) and use a debugger (gdb/lldb) or AddressSanitizer to identify the exact memory issue.',
  },

  // 源码分析:函数声明 / 定义正则
  functionDeclarations: {},
  definitionPatterns: {},

  // 从日志文本提取栈(无专属分支,直接走通用提取)
  extractFromLog: (): string => '',
};
