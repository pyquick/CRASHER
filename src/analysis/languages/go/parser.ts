// ── Go Stack Trace Parser ──
// Format: goroutine 1 [running]:
//         pkg/subpkg.Func(args)
//             /go/src/pkg/subpkg/file.go:42 +0x123

import type { StackFrame } from '../../types.js';
import { normalizePath } from '../../common/paths.js';

export function parse(lines: string[]): StackFrame[] {
  const frames: StackFrame[] = [];
  let index = 0;

  // Go function line: "pkg/subpkg.Func(args)"
  const funcRegex = /^([\w.\/-]+)\.(\w+)\(.*?\)$/;
  // Go file line: "\t/path/to/file.go:42 +0x123"
  const fileRegex = /^\t(.+?):(\d+)(?:\s+\+0x[0-9a-fA-F]+)?/;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('goroutine') || trimmed.startsWith('panic:') ||
        trimmed.startsWith('[') || trimmed.startsWith('created by')) continue;

    let funcName = '';
    let moduleName = '';
    let filePath = '';
    let lineNumber: number | null = null;
    let fullLine = trimmed;

    // Try function pattern
    const funcMatch = trimmed.match(funcRegex);
    if (funcMatch) {
      moduleName = funcMatch[1] || '';
      funcName = funcMatch[2] || '';
      fullLine = trimmed;

      // Check if next line is the file reference
      if (i + 1 < lines.length) {
        const fileMatch = lines[i + 1].match(fileRegex);
        if (fileMatch) {
          filePath = normalizePath(fileMatch[1]);
          lineNumber = parseInt(fileMatch[2], 10);
          i++; // consume the file line
        }
      }

      frames.push({
        index: index++,
        language: 'go',
        file_path: filePath,
        line_number: lineNumber,
        column_number: null,
        function_name: funcName,
        module_name: moduleName,
        address: '',
        raw_line: fullLine,
        severity: 'unknown',
      });
    }
  }

  return frames;
}
