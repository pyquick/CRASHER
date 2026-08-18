// ── Dart / Flutter Stack Trace Parser ──
// Format: package:my_app/src/main.dart 42:7  Class.method

import type { StackFrame } from '../../types.js';
import { normalizePath } from '../../common/paths.js';

export function parse(lines: string[]): StackFrame[] {
  const frames: StackFrame[] = [];
  let index = 0;

  // Dart frame: "package:xxx/file.dart 42:7  Class.method"
  //             "dart:core 123:45  Class.method"
  //             "#0      Class.method (package:xxx/file.dart:42:7)"
  const dartRegex = /^(?:package:|dart:)(\S+\.dart)\s+(\d+):(\d+)\s+(.+)$/;
  const dartHashRegex = /^#\d+\s+(.+?)\s+\((package:|dart:)(\S+\.dart):(\d+):(\d+)\)/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Try the hash format first
    let m = trimmed.match(dartHashRegex);
    if (m) {
      const func = m[1] || '';
      const dotIdx = func.lastIndexOf('.');
      frames.push({
        index: index++,
        language: 'dart',
        file_path: normalizePath(m[3]),
        line_number: parseInt(m[4], 10),
        column_number: parseInt(m[5], 10),
        function_name: dotIdx > 0 ? func.substring(dotIdx + 1) : func,
        module_name: dotIdx > 0 ? func.substring(0, dotIdx) : '',
        address: '',
        raw_line: trimmed,
        severity: 'unknown',
      });
      continue;
    }

    m = trimmed.match(dartRegex);
    if (m) {
      const func = m[4] || '';
      const dotIdx = func.lastIndexOf('.');
      frames.push({
        index: index++,
        language: 'dart',
        file_path: normalizePath(m[1]),
        line_number: parseInt(m[2], 10),
        column_number: parseInt(m[3], 10),
        function_name: dotIdx > 0 ? func.substring(dotIdx + 1) : func,
        module_name: dotIdx > 0 ? func.substring(0, dotIdx) : '',
        address: '',
        raw_line: trimmed,
        severity: 'unknown',
      });
    }
  }

  return frames;
}
