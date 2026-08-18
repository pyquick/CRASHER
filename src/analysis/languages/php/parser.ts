// ── PHP Stack Trace Parser ──
// Format: #0 /path/to/file.php(42): ClassName->method(args)
//         #1 /path/to/file.php(100): include('/some/file.php')
//         PHP Fatal error:  Uncaught Exception: message in /path/file.php:42

import type { StackFrame } from '../../types.js';
import { normalizePath } from '../../common/paths.js';

export function parse(lines: string[]): StackFrame[] {
  const frames: StackFrame[] = [];
  let index = 0;

  // PHP numbered frame: "#N /path/file.php(line): Class->method(args)"
  const frameRegex = /^#(\d+)\s+(.+?\.php)\((\d+)\):\s+(.+)/;
  // PHP error line: "PHP Fatal error: ... in /path/file.php on line 42"
  const errorRegex = /(?:Uncaught\s+)?(?:Exception|Error|Throwable)\b.*?\sin\s+(.+?\.php)(?:\s+on\s+line\s+(\d+))?/i;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const m = trimmed.match(frameRegex);
    if (m) {
      let called = m[4];
      // Parse "Class->method" or "Class::method" or "function"
      let funcName = called;
      let moduleName = '';
      const arrowIdx = called.lastIndexOf('->');
      const colonIdx = called.lastIndexOf('::');
      const sepIdx = arrowIdx > colonIdx ? arrowIdx : colonIdx;
      if (sepIdx > 0) {
        moduleName = called.substring(0, sepIdx);
        funcName = called.substring(sepIdx + 2);
      }

      frames.push({
        index: index++,
        language: 'php',
        file_path: normalizePath(m[2]),
        line_number: parseInt(m[3], 10),
        column_number: null,
        function_name: funcName,
        module_name: moduleName,
        address: '',
        raw_line: trimmed,
        severity: 'unknown',
      });
    }
  }

  // If no frames parsed, try the error format
  if (frames.length === 0) {
    for (const line of lines) {
      const m = line.match(errorRegex);
      if (m) {
        frames.push({
          index: index++,
          language: 'php',
          file_path: normalizePath(m[1]),
          line_number: m[2] ? parseInt(m[2], 10) : null,
          column_number: null,
          function_name: '',
          module_name: '',
          address: '',
          raw_line: line.trim(),
          severity: 'unknown',
        });
      }
    }
  }

  return frames;
}
