// ── Java / Kotlin Stack Trace Parser ──
// Format: at com.example.MyClass.myMethod(MyClass.java:42)
//         at com.example.MyClass.<init>(MyClass.java:15)
// Caused by: java.lang.NullPointerException: message
//         ... 23 more

import type { StackFrame } from '../../types.js';
import { normalizePath } from '../../common/paths.js';

export function parse(lines: string[]): StackFrame[] {
  const frames: StackFrame[] = [];
  let index = 0;

  // Java frame: "at pkg.Class.method(File.java:42)"
  const frameRegex = /^\s*at\s+([\w$.]+)\.([\w$<>]+)\(([\w$.]+\.(?:java|kt|scala|groovy|clj))(?::(\d+))?\)/;
  // Java caused-by chain: "Caused by: ExceptionClass: message"
  const causedRegex = /^(?:Caused\s+by:\s+)?([\w.]+(?:\.[\w.]+)*(?:Exception|Error|Throwable))(?::\s*(.*))?/;
  // Java suppressed: "Suppressed: ..."
  const suppressRegex = /^\s*\.\.\.\s+\d+\s+(?:more|common frames omitted)/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || suppressRegex.test(trimmed)) continue;

    const m = trimmed.match(frameRegex);
    if (m) {
      frames.push({
        index: index++,
        language: 'java',
        file_path: normalizePath(m[3]),
        line_number: m[4] ? parseInt(m[4], 10) : null,
        column_number: null,
        function_name: m[2],
        module_name: m[1],
        address: '',
        raw_line: trimmed,
        severity: 'unknown',
      });
    }
  }

  return frames;
}
