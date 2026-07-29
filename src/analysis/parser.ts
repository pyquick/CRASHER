// ── Stack Trace Parser ──
// Parses C#, C++/C, Go, and Python stack traces into structured StackFrame objects.

import type { StackFrame } from './types.js';

/**
 * Parse a raw stack trace into structured frames, auto-detecting the language.
 */
export function parseStackFrames(stackTrace: string, runtime: string): StackFrame[] {
  if (!stackTrace?.trim()) return [];

  const lines = stackTrace.split('\n');

  // Detect language from runtime hint or stack trace patterns
  const lang = detectLanguage(stackTrace, runtime);

  let frames: StackFrame[];

  switch (lang) {
    case 'csharp':
      frames = parseCSharp(lines);
      break;
    case 'cpp':
    case 'c':
      frames = parseCppC(lines);
      break;
    case 'go':
      frames = parseGo(lines);
      break;
    case 'python':
      frames = parsePython(lines);
      break;
    default:
      frames = parseGeneric(lines);
      break;
  }

  // Classify severity for each frame
  classifySeverity(frames, lang);

  return frames;
}

// ── Language Detection ──

/**
 * Detect the programming language from runtime hint and stack trace content.
 */
export function detectLanguage(stackTrace: string, runtime: string): string {
  // Use runtime hint first
  const rt = runtime.toLowerCase();
  if (rt === 'unity' || rt === 'csharp' || rt === 'dotnet' || rt === '.net') return 'csharp';
  if (rt === 'cpp' || rt === 'c++' || rt === 'unreal' || rt === 'native') return 'cpp';
  if (rt === 'c') return 'c';
  if (rt === 'go' || rt === 'golang') return 'go';
  if (rt === 'python' || rt === 'python3') return 'python';

  // Auto-detect from stack trace content
  const st = stackTrace;

  // Python: starts with "Traceback (most recent call last):" or has "File "...", line N, in func"
  if (st.startsWith('Traceback') || st.match(/File\s+".+?",\s+line\s+\d+,\s+in\s+/m)) return 'python';

  // Go: typical goroutine / panic format
  if (st.match(/^(goroutine\s+\d+|panic:)/m) || st.match(/^(\S+)\.(\w+)\(.*?\)\s*$/m)) {
    // Go has distinct patterns like "pkg.Func(args)" on its own line
    const goCount = (st.match(/^(\S+)\.(\w+)\(.*?\)$/gm) || []).length;
    if (goCount >= 2) return 'go';
  }

  // C# / Unity: "at Class.Method () [0x...] in <path>:line N:col"
  if (st.match(/at\s+[\w.<>]+.*in\s+.+:\d+/m)) return 'csharp';

  // C++/C: native backtrace with addresses, or "Class::Method" patterns
  if (st.match(/#\d+\s+0x[0-9a-fA-F]+/m) || st.match(/\(\w+::\w+[\+\d+]*\)/m)) return 'cpp';

  return 'unknown';
}

// ── C# / Unity Stack Trace Parser ──
// Format: at Namespace.Class.Method () [0x00000] in /path/to/File.cs:line 42
//          at Namespace.Class.Method (System.Object arg) [0x00000] in <hash>:0

function parseCSharp(lines: string[]): StackFrame[] {
  const frames: StackFrame[] = [];
  let index = 0;

  // C# regex: at Namespace.Class.Method(arguments) [0xADDR] in PATH:LINE[:COL]
  const csharpRegex = /^\s*at\s+([\w.<>+]+(?:\[.*?\])?)\s*\(.*?\)\s*(?:\[0x[0-9a-fA-F]+\]\s*)?(?:in\s+(.+?):(line\s+)?(\d+)(?::(\d+))?)?/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('===') || trimmed.startsWith('---')) continue;

    const m = trimmed.match(csharpRegex);
    if (m) {
      const func = m[1] || 'Unknown';
      let filePath = m[2] || '';
      const lineNum = m[4] ? parseInt(m[4], 10) : null;
      const colNum = m[5] ? parseInt(m[5], 10) : null;

      // Extract module/assembly from function name
      const dotIdx = func.lastIndexOf('.');
      const moduleName = dotIdx > 0 ? func.substring(0, dotIdx) : '';
      const funcName = dotIdx > 0 ? func.substring(dotIdx + 1) : func;

      // Normalize file path to relative
      filePath = normalizePath(filePath);

      frames.push({
        index: index++,
        language: 'csharp',
        file_path: filePath,
        line_number: lineNum,
        column_number: colNum,
        function_name: funcName,
        module_name: moduleName,
        address: '',
        raw_line: trimmed,
        severity: 'unknown',
      });
    }
  }

  // Also catch simple "at Class.Method ()" without file info (from Unity)
  if (frames.length === 0) {
    const simpleRegex = /^\s*at\s+([\w.<>+]+)\s*\([^)]*\)/;
    for (const line of lines) {
      const trimmed = line.trim();
      const m = trimmed.match(simpleRegex);
      if (m) {
        const func = m[1];
        const dotIdx = func.lastIndexOf('.');
        frames.push({
          index: index++,
          language: 'csharp',
          file_path: '',
          line_number: null,
          column_number: null,
          function_name: dotIdx > 0 ? func.substring(dotIdx + 1) : func,
          module_name: dotIdx > 0 ? func.substring(0, dotIdx) : '',
          address: '',
          raw_line: trimmed,
          severity: 'unknown',
        });
      }
    }
  }

  return frames;
}

// ── C++/C Stack Trace Parser ──
// Format: #0  0x00007f... in function () from /lib/libc.so
//         #1  0x00007f... in Class::Method() at /path/file.cpp:42
//         Class::Method() at /path/file.cpp:42
//         /path/module.so(+0x12345) [0x7f...]

function parseCppC(lines: string[]): StackFrame[] {
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

// ── Go Stack Trace Parser ──
// Format: goroutine 1 [running]:
//         pkg/subpkg.Func(args)
//             /go/src/pkg/subpkg/file.go:42 +0x123

function parseGo(lines: string[]): StackFrame[] {
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

// ── Python Stack Trace Parser ──
// Format: Traceback (most recent call last):
//           File "/path/to/file.py", line 42, in function_name
//             some_code_line()
//         ExceptionType: Error message

function parsePython(lines: string[]): StackFrame[] {
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

  // Python tracebacks are printed from outermost to innermost, so reverse
  frames.reverse();
  frames.forEach((f, i) => { f.index = i; });

  // Store exception info on the last frame (crash point)
  if (frames.length > 0) {
    const lastFrame = frames[frames.length - 1];
    if (exceptionType && !lastFrame.raw_line.includes(exceptionType)) {
      lastFrame.raw_line = `${exceptionType}: ${exceptionMsg}\n  ${lastFrame.raw_line}`;
    }
  }

  return frames;
}

// ── Generic / Fallback Parser ──

function parseGeneric(lines: string[]): StackFrame[] {
  const frames: StackFrame[] = [];
  let index = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Try common patterns
    // "at func (file:line)" - JS/Node
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

    // Any line with "file:line" pattern
    const fileLineMatch = trimmed.match(/(?:^|\()(.+?):(\d+)(?::(\d+))?(?:\))?$/);
    if (fileLineMatch) {
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

// ── Severity Classification ──

/**
 * Classify each frame's severity for color-coded display.
 *
 * Color scheme:
 * - RED (#dc2626):   trigger point — the exact crash site (innermost frame / index 0)
 * - ORANGE (#ea580c): propagation — frames that passed the error along (middle of user code)
 * - YELLOW (#ca8a04): source — root cause / entry point (outermost user-code frame)
 * - GRAY (#6b7280):   framework — library/platform code
 */
function classifySeverity(frames: StackFrame[], lang: string): void {
  if (frames.length === 0) return;

  const fn = frames[frames.length - 1];

  // First frame (innermost) = crash trigger
  if (frames.length >= 1) {
    frames[0].severity = 'trigger';
  }

  // Last frame (outermost) with a file path = potential source
  if (frames.length >= 2) {
    let sourceIdx = frames.length - 1;
    // Walk backward to find the first frame with user code
    for (let i = frames.length - 1; i >= 0; i--) {
      if (!isFrameworkCode(frames[i], lang)) {
        sourceIdx = i;
        break;
      }
    }
    if (sourceIdx > 0 && sourceIdx !== 0) {
      frames[sourceIdx].severity = 'source';
    }
  }

  // Middle frames
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].severity !== 'unknown') continue;

    if (isFrameworkCode(frames[i], lang)) {
      frames[i].severity = 'framework';
    } else if (i > 0 && i < frames.findIndex(f => f.severity === 'source')) {
      frames[i].severity = 'propagation';
    } else {
      frames[i].severity = 'propagation';
    }
  }

  // Ensure index 0 is always trigger
  if (frames.length > 0) {
    frames[0].severity = 'trigger';
    // If the trigger is in framework code, note it
    if (isFrameworkCode(frames[0], lang) && frames.length > 1) {
      // Find the first user-code frame
      for (let i = 1; i < frames.length; i++) {
        if (!isFrameworkCode(frames[i], lang)) {
          frames[i].severity = 'propagation';
          break;
        }
      }
    }
  }
}

// ── Helpers ──

/**
 * Normalize an absolute path to a relative one for tree display.
 */
function normalizePath(filePath: string): string {
  if (!filePath) return '';

  let normalized = filePath.replace(/\\/g, '/');

  // Remove common prefixes to make it relative
  const prefixes = [
    '/app/', '/src/', '/go/src/', '/usr/src/', '/usr/local/',
    '/home/', '/Users/', '/var/www/', '/opt/',
    'C:/', 'D:/', 'E:/',
    'Assets/', 'Packages/',
  ];

  for (const prefix of prefixes) {
    const idx = normalized.indexOf(prefix);
    if (idx >= 0) {
      normalized = normalized.substring(idx + prefix.length);
      break;
    }
  }

  // Remove leading slashes
  normalized = normalized.replace(/^\/+/, '');
  return normalized;
}

/**
 * Extract a module/package name from a file path.
 */
function extractModuleFromPath(filePath: string): string {
  if (!filePath) return '';
  const parts = filePath.replace(/\\/g, '/').replace(/^\/+/, '').split('/');
  // Return the top-level directory or just the filename stem
  if (parts.length >= 2) return parts[0];
  if (parts.length === 1) return parts[0].replace(/\.[^.]+$/, '');
  return parts[0] || '';
}

/**
 * Determine if a frame is likely framework/library code.
 */
function isFrameworkCode(frame: StackFrame, _lang: string): boolean {
  const path = frame.file_path;
  const fn = frame.function_name;
  const module = frame.module_name;

  // Common framework paths
  const fwPatterns = [
    /^node_modules\//, /^lib\//, /\/lib\//,
    /^usr\//, /System\./, /^Microsoft\./,
    /^UnityEngine\./, /^UnityEditor\./,
    /^Unity\./, /\.Internal\./, /^System\./,
    /^GOROOT\//, /^\/usr\/lib\//, /^\/lib\//,
    /^site-packages\//, /dist-packages\//,
    /^boost\//, /^std\//, /C\/Windows\//,
    /libc\./, /libstdc\+\+/, /libm\./,
    /^Assembly-CSharp-firstpass/, /mscorlib/,
  ];

  for (const pat of fwPatterns) {
    if (pat.test(path)) return true;
    if (pat.test(fn)) return true;
    if (pat.test(module)) return true;
  }

  // Check if it's a native library
  if (path.endsWith('.so') || path.endsWith('.dll') || path.endsWith('.dylib')) return true;
  if (module.endsWith('.so') || module.endsWith('.dll') || module.endsWith('.dylib')) return true;

  // Go stdlib
  if (module.startsWith('runtime/') || module.startsWith('internal/') ||
      module.startsWith('sync/') || module.startsWith('net/') ||
      module === 'runtime' || module === 'main' && fn === 'main') return true;

  return false;
}
