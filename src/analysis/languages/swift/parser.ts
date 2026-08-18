// ── Swift Stack Trace Parser ──
// Format: 0   MyApp                   0x10a2b3c4d main + 42  (main.swift:15)
//         1   libdyld.dylib           0x7fff6a2b3c4d start + 1

import type { StackFrame } from '../../types.js';
import { normalizePath } from '../../common/paths.js';

export function parse(lines: string[]): StackFrame[] {
  const frames: StackFrame[] = [];
  let index = 0;

  // Swift frame: "N  ModuleName  0xADDR  function + offset  (file.swift:line)"
  const swiftRegex = /^(\d+)\s+(\S+)\s+(0x[0-9a-fA-F]+)\s+(.+?)\s+\+\s+\d+(?:\s+\((.+?):(\d+)(?::(\d+))?\))?/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const m = trimmed.match(swiftRegex);
    if (m) {
      frames.push({
        index: index++,
        language: 'swift',
        file_path: normalizePath(m[5] || ''),
        line_number: m[6] ? parseInt(m[6], 10) : null,
        column_number: m[7] ? parseInt(m[7], 10) : null,
        function_name: (m[4] || '').trim(),
        module_name: m[2],
        address: m[3],
        raw_line: trimmed,
        severity: 'unknown',
      });
    }
  }

  return frames;
}
