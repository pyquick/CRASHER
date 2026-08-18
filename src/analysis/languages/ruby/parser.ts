// ── Ruby Stack Trace Parser ──
// Format: from /path/to/file.rb:42:in `method_name'
//         /path/to/file.rb:42:in `block in method_name'

import type { StackFrame } from '../../types.js';
import { normalizePath, extractModuleFromPath } from '../../common/paths.js';

export function parse(lines: string[]): StackFrame[] {
  const frames: StackFrame[] = [];
  let index = 0;

  // Ruby frame: "from /path/to/file.rb:42:in `method_name'"
  //             "/path/to/file.rb:42:in `method_name'"
  const rbRegex = /^(?:from\s+)?(.+?\.rb):(\d+):in\s+`([^']+)'/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const m = trimmed.match(rbRegex);
    if (m) {
      frames.push({
        index: index++,
        language: 'ruby',
        file_path: normalizePath(m[1]),
        line_number: parseInt(m[2], 10),
        column_number: null,
        function_name: m[3],
        module_name: extractModuleFromPath(m[1]),
        address: '',
        raw_line: trimmed,
        severity: 'unknown',
      });
    }
  }

  return frames;
}
