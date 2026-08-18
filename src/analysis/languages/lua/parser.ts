// ── Lua Stack Trace Parser ──
// Format: stack traceback:
//         file.lua:42: in function 'method'
//         [C]: in function 'error'

import type { StackFrame } from '../../types.js';
import { normalizePath, extractModuleFromPath } from '../../common/paths.js';

export function parse(lines: string[]): StackFrame[] {
  const frames: StackFrame[] = [];
  let index = 0;

  const luaRegex = /^(.+?\.lua):(\d+):\s+in\s+(?:function\s+)?'?(.+?)'?\s*$/;
  const cFuncRegex = /^\[C\]:\s+in\s+function\s+'(.+)'/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === 'stack traceback:') continue;

    let m = trimmed.match(luaRegex);
    if (m) {
      frames.push({
        index: index++,
        language: 'lua',
        file_path: normalizePath(m[1]),
        line_number: parseInt(m[2], 10),
        column_number: null,
        function_name: m[3],
        module_name: extractModuleFromPath(m[1]),
        address: '',
        raw_line: trimmed,
        severity: 'unknown',
      });
      continue;
    }

    m = trimmed.match(cFuncRegex);
    if (m) {
      frames.push({
        index: index++,
        language: 'lua',
        file_path: '[C]',
        line_number: null,
        column_number: null,
        function_name: m[1],
        module_name: 'C',
        address: '',
        raw_line: trimmed,
        severity: 'unknown',
      });
    }
  }

  return frames;
}
