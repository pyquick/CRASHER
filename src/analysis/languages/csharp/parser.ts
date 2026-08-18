// ── C# / Unity Stack Trace Parser ──
// Format: at Namespace.Class.Method () [0x00000] in /path/to/File.cs:line 42
//          at Namespace.Class.Method (System.Object arg) [0x00000] in <hash>:0

import type { StackFrame } from '../../types.js';
import { normalizePath } from '../../common/paths.js';

export function parse(lines: string[]): StackFrame[] {
  const frames: StackFrame[] = [];
  let index = 0;

  // C# regex: at Namespace.Class.Method(arguments) [0xADDR] in PATH:LINE[:COL]
  const csharpRegex = /^\s*at\s+([\w.<>+]+(?:\[.*?\])?)\s*\(.*?\)\s*(?:\[0x[0-9a-fA-F]+\]\s*)?(?:in\s+(.+?):(line\s+)?(\d+)(?::(\d+))?)?/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('===') || trimmed.startsWith('---')) continue;

    const m = trimmed.match(csharpRegex);
    if (m) {
      const func = m[1] || 'Unknown';
      let filePath = m[2] || '';
      const lineNum = m[4] ? parseInt(m[4], 10) : null;
      const colNum = m[5] ? parseInt(m[5], 10) : null;

      // Extract module/assembly from function name
      const dotIdx = func.lastIndexOf('.');
      const moduleName = dotIdx > 0 ? func.substring(0, dotIdx) : '';
      const funcName = dotIdx > 0 ? func.substring(dotIdx + 1) : func;

      // Normalize file path to relative
      filePath = normalizePath(filePath);

      frames.push({
        index: index++,
        language: 'csharp',
        file_path: filePath,
        line_number: lineNum,
        column_number: colNum,
        function_name: funcName,
        module_name: moduleName,
        address: '',
        raw_line: trimmed,
        severity: 'unknown',
      });
    }
  }

  // Also catch simple "at Class.Method ()" without file info (from Unity)
  if (frames.length === 0) {
    const simpleRegex = /^\s*at\s+([\w.<>+]+)\s*\([^)]*\)/;
    for (const line of lines) {
      const trimmed = line.trim();
      const m = trimmed.match(simpleRegex);
      if (m) {
        const func = m[1];
        const dotIdx = func.lastIndexOf('.');
        frames.push({
          index: index++,
          language: 'csharp',
          file_path: '',
          line_number: null,
          column_number: null,
          function_name: dotIdx > 0 ? func.substring(dotIdx + 1) : func,
          module_name: dotIdx > 0 ? func.substring(0, dotIdx) : '',
          address: '',
          raw_line: trimmed,
          severity: 'unknown',
        });
      }
    }
  }

  return frames;
}
