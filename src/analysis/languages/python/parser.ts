// ── Python Stack Trace Parser ──
// Format: Traceback (most recent call last):
//           File "/path/to/file.py", line 42, in function_name
//             some_code_line()
//         ExceptionType: Error message

import type { StackFrame } from '../../types.js';
import { normalizePath, extractModuleFromPath } from '../../common/paths.js';

export function parse(lines: string[]): StackFrame[] {
  const frames: StackFrame[] = [];
  let index = 0;

  // Python file line: "  File "/path/to/file.py", line 42, in function_name"
  const fileRegex = /^\s*File\s+"(.+?)",\s+line\s+(\d+),?\s+in\s+(.+)$/;
  // Exception line: "ExceptionType: message"
  const excRegex = /^([\w.]+(?:\.[\w.]+)*):\s*(.*)/;

  let exceptionType = '';
  let exceptionMsg = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed || trimmed === 'Traceback (most recent call last):') continue;

    const fileMatch = line.match(fileRegex);
    if (fileMatch) {
      frames.push({
        index: index++,
        language: 'python',
        file_path: normalizePath(fileMatch[1]),
        line_number: parseInt(fileMatch[2], 10),
        column_number: null,
        function_name: fileMatch[3] || '',
        module_name: extractModuleFromPath(fileMatch[1]),
        address: '',
        raw_line: trimmed,
        severity: 'unknown',
      });
      continue;
    }

    // Check for exception line (last significant line)
    const excMatch = trimmed.match(excRegex);
    if (excMatch && frames.length > 0 && !trimmed.startsWith('File ')) {
      exceptionType = excMatch[1];
      exceptionMsg = excMatch[2];
    }
  }

  // Standard Python tracebacks are printed innermost (crash) first — keep
  // that order so frames[0] is always the crash frame.
  frames.forEach((f, i) => { f.index = i; });

  // Store exception info on the first frame (the crash point)
  if (frames.length > 0) {
    const crashFrame = frames[0];
    if (exceptionType && !crashFrame.raw_line.includes(exceptionType)) {
      crashFrame.raw_line = `${exceptionType}: ${exceptionMsg}\n  ${crashFrame.raw_line}`;
    }
  }

  return frames;
}
