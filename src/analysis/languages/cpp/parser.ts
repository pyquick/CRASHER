// ── C++/C Stack Trace Parser ──
// Format: #0  0x00007f... in function () from /lib/libc.so
//         #1  0x00007f... in Class::Method() at /path/file.cpp:42
//         Class::Method() at /path/file.cpp:42
//         /path/module.so(+0x12345) [0x7f...]

import type { StackFrame } from '../../types.js';
import { normalizePath, extractModuleFromPath } from '../../common/paths.js';

export function parse(lines: string[]): StackFrame[] {
  const frames: StackFrame[] = [];
  let index = 0;

  // Pattern 1: "#N 0xADDR in Function () from Module"
  const gdbRegex = /^#(\d+)\s+(0x[0-9a-fA-F]+)\s+in\s+(.+?)\s*(?:\(\))?\s*(?:from\s+(.+))?$/;

  // Pattern 2: "Function() at Path:Line[:Col]"
  const atRegex = /^(.+?)\s+at\s+(.+?):(\d+)(?::(\d+))?/;

  // Pattern 3: "Module(+offset) [addr]"
  const addrRegex = /^(.+?)\(([+\-]0x[0-9a-fA-F]+)\)\s*\[(0x[0-9a-fA-F]+)\]/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let matched = false;

    // Try GDB format first
    let m = trimmed.match(gdbRegex);
    if (m) {
      const func = m[3] || 'Unknown';
      const moduleFrom = m[4] || '';
      const addr = m[2] || '';
      const { funcName, moduleName, fileName } = splitCppFunc(func, moduleFrom);

      frames.push({
        index: index++,
        language: 'cpp',
        file_path: normalizePath(fileName),
        line_number: null,
        column_number: null,
        function_name: funcName,
        module_name: moduleName,
        address: addr,
        raw_line: trimmed,
        severity: 'unknown',
      });
      matched = true;
    }

    // Try "at path:line" format
    if (!matched) {
      m = trimmed.match(atRegex);
      if (m) {
        const func = m[1];
        const { funcName, moduleName, fileName } = splitCppFunc(func, m[2]);
        frames.push({
          index: index++,
          language: 'cpp',
          file_path: normalizePath(fileName || m[2]),
          line_number: m[3] ? parseInt(m[3], 10) : null,
          column_number: m[4] ? parseInt(m[4], 10) : null,
          function_name: funcName || func,
          module_name: moduleName,
          address: '',
          raw_line: trimmed,
          severity: 'unknown',
        });
        matched = true;
      }
    }

    // Try address pattern
    if (!matched) {
      m = trimmed.match(addrRegex);
      if (m) {
        frames.push({
          index: index++,
          language: 'cpp',
          file_path: '',
          line_number: null,
          column_number: null,
          function_name: '',
          module_name: m[1],
          address: m[3] || '',
          raw_line: trimmed,
          severity: 'unknown',
        });
        matched = true;
      }
    }

    // Try "Module!Function" pattern (Windows crash dump)
    if (!matched) {
      m = trimmed.match(/^(\S+)!(\S+)/);
      if (m) {
        frames.push({
          index: index++,
          language: 'cpp',
          file_path: '',
          line_number: null,
          column_number: null,
          function_name: m[2],
          module_name: m[1],
          address: '',
          raw_line: trimmed,
          severity: 'unknown',
        });
        matched = true;
      }
    }
  }

  return frames;
}

/**
 * Split a C++ function signature into function name, module, and file name.
 * Examples: "Server::ProcessRequest()" → func=ProcessRequest, module=Server
 *           "GameEngine.dll!Player::Update()" → func=Update, module=Player, class=GameEngine
 */
function splitCppFunc(func: string, module: string): { funcName: string; moduleName: string; fileName: string } {
  let funcName = func;
  let moduleName = module;
  let fileName = '';

  // Handle "Class::Method" pattern
  const colonIdx = func.lastIndexOf('::');
  if (colonIdx > 0) {
    moduleName = moduleName || func.substring(0, colonIdx);
    funcName = func.substring(colonIdx + 2);
  }

  // Remove parentheses and arguments
  funcName = funcName.replace(/\(.*\)\s*$/, '').replace(/\(\)$/, '').trim();

  // If module looks like a file path, extract it
  if (moduleName.match(/\//) || moduleName.match(/\\/)) {
    fileName = moduleName;
    moduleName = extractModuleFromPath(fileName);
  }

  return { funcName, moduleName, fileName };
}
