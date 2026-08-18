// ── JavaScript / TypeScript / Node.js / Browser Stack Trace Parser ──
// Format: at ClassName.methodName (file.js:42:15)
//         at methodName (file.js:42:15)
//         at file:///path/to/file.js:42:15
//         at async ClassName.methodName (file.ts:42:15)
//         at processTicksAndRejections (node:internal/process/task_queues:95:5)

import type { StackFrame } from '../../types.js';
import { normalizePath, extractModuleFromPath } from '../../common/paths.js';

export function parse(lines: string[]): StackFrame[] {
  const frames: StackFrame[] = [];
  let index = 0;

  // JS regex: "at [async ]functionName (path:line:col)"
  const jsRegex = /^\s*at\s+(?:async\s+)?(.+?)(?:\s+\((.+?):(\d+):(\d+)\))?$/;
  // Simple regex: "at path:line:col" (anonymous, no function)
  const simpleRegex = /^\s*at\s+(.+?):(\d+):(\d+)$/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('Error:') || trimmed.startsWith('TypeError:') ||
        trimmed.startsWith('ReferenceError:') || trimmed.startsWith('SyntaxError:')) continue;

    // Try simple regex first (anonymous frame)
    let m = trimmed.match(simpleRegex);
    if (m) {
      frames.push({
        index: index++,
        language: 'javascript',
        file_path: normalizePath(m[1]),
        line_number: parseInt(m[2], 10),
        column_number: parseInt(m[3], 10),
        function_name: '<anonymous>',
        module_name: extractModuleFromPath(m[1]),
        address: '',
        raw_line: trimmed,
        severity: 'unknown',
      });
      continue;
    }

    m = trimmed.match(jsRegex);
    if (m) {
      let funcPart = m[1] || '<anonymous>';
      let filePath = m[2] || '';
      const lineNum = m[3] ? parseInt(m[3], 10) : null;
      const colNum = m[4] ? parseInt(m[4], 10) : null;

      // If there's no file:line:col, funcPart might actually be a file:line:col
      if (!filePath) {
        const altMatch = funcPart.match(/^(.+?):(\d+):(\d+)$/);
        if (altMatch) {
          filePath = altMatch[1];
          funcPart = '<anonymous>';
        }
      }

      // Split class and method: "ClassName.methodName" or "new ClassName"
      let funcName = funcPart;
      let moduleName = '';
      const dotIdx = funcName.lastIndexOf('.');
      if (dotIdx > 0) {
        moduleName = funcName.substring(0, dotIdx);
        funcName = funcName.substring(dotIdx + 1);
      }

      frames.push({
        index: index++,
        language: 'javascript',
        file_path: normalizePath(filePath),
        line_number: lineNum,
        column_number: colNum,
        function_name: funcName || '<anonymous>',
        module_name: moduleName,
        address: '',
        raw_line: trimmed,
        severity: 'unknown',
      });
    }
  }

  return frames;
}
