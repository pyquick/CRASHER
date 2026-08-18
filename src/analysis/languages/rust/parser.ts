// ── Rust Stack Trace Parser ──
// Format: panicked at 'message', src/main.rs:42:15
//   0: rust_begin_unwind
//   1: core::panicking::panic
//   2: my_crate::main
//              at src/main.rs:42:15

import type { StackFrame } from '../../types.js';
import { normalizePath } from '../../common/paths.js';

export function parse(lines: string[]): StackFrame[] {
  const frames: StackFrame[] = [];
  let index = 0;

  // Rust numbered frame: "   N: function::path"
  const numRegex = /^\s*(\d+):\s+(.+)$/;
  // Rust at line: "             at path:line[:col]"
  const atRegex = /^\s+at\s+(.+?):(\d+)(?::(\d+))?$/;

  let pendingFunc = '';

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Try numbered frame
    const numMatch = trimmed.match(numRegex);
    if (numMatch && !trimmed.startsWith('note:') && !trimmed.startsWith('help:')) {
      pendingFunc = numMatch[2].trim();
      continue;
    }

    // Try "at path:line" following a numbered frame
    const atMatch = lines[i].match(atRegex);
    if (atMatch) {
      const func = pendingFunc || '';
      pendingFunc = '';
      const moduleName = func.includes('::')
        ? func.substring(0, func.lastIndexOf('::')) : '';
      const funcName = func.includes('::')
        ? func.substring(func.lastIndexOf('::') + 2) : func;

      frames.push({
        index: index++,
        language: 'rust',
        file_path: normalizePath(atMatch[1]),
        line_number: parseInt(atMatch[2], 10),
        column_number: atMatch[3] ? parseInt(atMatch[3], 10) : null,
        function_name: funcName || func || '<unknown>',
        module_name: moduleName,
        address: '',
        raw_line: lines[i],
        severity: 'unknown',
      });
      continue;
    }

    // Inline "panicked at '...', path:line:col"
    const panicMatch = trimmed.match(/panicked\s+at\s+'[^']*',\s+(.+?):(\d+)(?::(\d+))?/);
    if (panicMatch) {
      frames.push({
        index: index++,
        language: 'rust',
        file_path: normalizePath(panicMatch[1]),
        line_number: parseInt(panicMatch[2], 10),
        column_number: panicMatch[3] ? parseInt(panicMatch[3], 10) : null,
        function_name: 'panic',
        module_name: '',
        address: '',
        raw_line: trimmed,
        severity: 'unknown',
      });
    }
  }

  return frames;
}
