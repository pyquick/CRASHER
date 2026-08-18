// ── Generic / Fallback Parser ──
// Language-independent fallback when no specific language is detected,
// and generic stack frame extraction from raw log text.

import type { StackFrame } from '../types.js';
import { normalizePath, extractModuleFromPath } from './paths.js';

export function parseGeneric(lines: string[]): StackFrame[] {
  const frames: StackFrame[] = [];
  let index = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Try common patterns
    // "at func (file:line:col)" - JS/Node/Browser
    const jsMatch = trimmed.match(/at\s+(.+?)(?:\s+\((.+?)(?::(\d+)(?::(\d+))?)?\))?$/);
    if (jsMatch) {
      const func = jsMatch[1] || 'unknown';
      const path = jsMatch[2] || '';
      frames.push({
        index: index++,
        language: 'unknown',
        file_path: normalizePath(path),
        line_number: jsMatch[3] ? parseInt(jsMatch[3], 10) : null,
        column_number: jsMatch[4] ? parseInt(jsMatch[4], 10) : null,
        function_name: func,
        module_name: extractModuleFromPath(path),
        address: '',
        raw_line: trimmed,
        severity: 'unknown',
      });
      continue;
    }

    // Zend/PHP format: "#N /path/file(line): Class->method()"
    const phpMatch = trimmed.match(/^#\d+\s+(.+?)(?:\((\d+)\))?:\s+(.+)$/);
    if (phpMatch) {
      frames.push({
        index: index++,
        language: 'unknown',
        file_path: normalizePath(phpMatch[1]),
        line_number: phpMatch[2] ? parseInt(phpMatch[2], 10) : null,
        column_number: null,
        function_name: phpMatch[3],
        module_name: '',
        address: '',
        raw_line: trimmed,
        severity: 'unknown',
      });
      continue;
    }

    // Any line with "file:line" pattern
    const fileLineMatch = trimmed.match(/(?:^|\()(.+?):(\d+)(?::(\d+))?(?:\))?$/);
    if (fileLineMatch && !trimmed.startsWith('  File ') && !trimmed.startsWith('at ')) {
      frames.push({
        index: index++,
        language: 'unknown',
        file_path: normalizePath(fileLineMatch[1]),
        line_number: parseInt(fileLineMatch[2], 10),
        column_number: fileLineMatch[3] ? parseInt(fileLineMatch[3], 10) : null,
        function_name: '',
        module_name: '',
        address: '',
        raw_line: trimmed,
        severity: 'unknown',
      });
      continue;
    }

    // Last resort: include the line as-is
    frames.push({
      index: index++,
      language: 'unknown',
      file_path: '',
      line_number: null,
      column_number: null,
      function_name: trimmed.substring(0, 120),
      module_name: '',
      address: '',
      raw_line: trimmed,
      severity: 'unknown',
    });
  }

  return frames;
}

/**
 * Extract lines that look like stack frames from arbitrary log text.
 * Used when no language-specific extraction matched.
 */
export function extractGenericStackFrames(logText: string): string {
  const lines = logText.split('\n');
  const framePatterns = [
    /^\s*at\s+/,
    /File\s+".+",\s+line\s+\d+/,
    /^\s+#\d+\s+/,
    /^\t.+\:\d+\s+/,
    /\S+\.go:\d+/,
    /0x[0-9a-fA-F]+/,
  ];

  const frameLines: string[] = [];
  for (const line of lines) {
    for (const pat of framePatterns) {
      if (pat.test(line)) {
        frameLines.push(line);
        break;
      }
    }
  }

  return frameLines.join('\n');
}
