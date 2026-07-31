// ── Stack Trace Parser ──
// Parses C#, C++/C, Go, Python, JavaScript/TypeScript (Node & Browser),
// Java/Kotlin, Rust, Ruby, PHP, Swift, Dart, Elixir/Erlang, Lua stack traces
// into structured StackFrame objects.

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
    case 'javascript':
    case 'node':
    case 'browser':
    case 'typescript':
      frames = parseJavaScript(lines, lang);
      break;
    case 'java':
    case 'kotlin':
      frames = parseJava(lines);
      break;
    case 'rust':
      frames = parseRust(lines);
      break;
    case 'ruby':
      frames = parseRuby(lines);
      break;
    case 'php':
      frames = parsePHP(lines);
      break;
    case 'swift':
      frames = parseSwift(lines);
      break;
    case 'dart':
      frames = parseDart(lines);
      break;
    case 'elixir':
    case 'erlang':
      frames = parseElixirErlang(lines, lang);
      break;
    case 'lua':
      frames = parseLua(lines);
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
  if (rt === 'node' || rt === 'nodejs' || rt === 'node.js' || rt === 'bun' || rt === 'deno') return 'node';
  if (rt === 'browser' || rt === 'web' || rt === 'frontend') return 'browser';
  if (rt === 'javascript' || rt === 'js') return 'javascript';
  if (rt === 'typescript' || rt === 'ts') return 'typescript';
  if (rt === 'java' || rt === 'jvm') return 'java';
  if (rt === 'kotlin') return 'kotlin';
  if (rt === 'rust' || rt === 'rs') return 'rust';
  if (rt === 'ruby' || rt === 'rb') return 'ruby';
  if (rt === 'php') return 'php';
  if (rt === 'swift') return 'swift';
  if (rt === 'dart' || rt === 'flutter') return 'dart';
  if (rt === 'elixir' || rt === 'exs') return 'elixir';
  if (rt === 'erlang' || rt === 'erl') return 'erlang';
  if (rt === 'lua') return 'lua';

  // Auto-detect from stack trace content
  const st = stackTrace;

  // Python: starts with "Traceback (most recent call last):" or has "File "...", line N, in func"
  if (st.startsWith('Traceback') || st.match(/File\s+".+?",\s+line\s+\d+,\s+in\s+/m)) return 'python';

  // Ruby: "from /path/to/file.rb:42:in `method_name'"
  if (st.match(/^\s*from\s+\/.+\.rb:\d+:in\s+`/) || st.match(/\S+\.rb:\d+:in\s+`/m)) return 'ruby';

  // PHP: "#N /path/file.php(line): Class->method()" or "PHP Fatal error:"
  if (st.match(/^#\d+\s+\/.+\.php\(\d+\)/) || st.match(/^(?:PHP\s+)?(?:Fatal|Parse|Warning|Notice)\s+error:/m)) return 'php';

  // Go: typical goroutine / panic format
  if (st.match(/^(goroutine\s+\d+|panic:)/m) || st.match(/^(\S+)\.(\w+)\(.*?\)\s*$/m)) {
    const goCount = (st.match(/^(\S+)\.(\w+)\(.*?\)$/gm) || []).length;
    if (goCount >= 2) return 'go';
  }

  // Java/Kotlin: "at com.example.Class.method(File.java:42)"
  if (st.match(/^\s*at\s+[\w$.]+\.[\w$<>]+\([\w$.]+\.(?:java|kt):\d+\)/m)) return 'java';

  // Rust: "panicked at '...', src/main.rs:42" or stack backtrace format
  if (st.match(/^thread\s+'.*?'\s+panicked\s+at/m) || st.match(/^\s+\d+:\s+0x[0-9a-f]+\s+-/m)) {
    if (st.includes('.rs:') || st.includes('mod.rs:') || st.includes('lib.rs:')) return 'rust';
  }

  // C# / Unity: "at Class.Method () [0x...] in <path>:line N:col"
  if (st.match(/at\s+[\w.<>]+.*in\s+.+:\d+/m)) return 'csharp';

  // C++/C: native backtrace with addresses, or "Class::Method" patterns
  if (st.match(/#\d+\s+0x[0-9a-fA-F]+/m) || st.match(/\(\w+::\w+[\+\d+]*\)/m)) return 'cpp';

  // Swift: thread backtrace format with binary image names
  if (st.match(/^\d+\s+\S+\s+0x[0-9a-fA-F]+\s+\S+\s+\+\s+\d+/m) && st.includes('Thread')) return 'swift';

  // Dart/Flutter: "package:xxx/yyy.dart 42:7  Class.method"
  if (st.match(/^package:\S+\.dart\s+\d+:\d+\s+/m) || st.match(/^dart:\S+\s+\d+:\d+\s+/m)) return 'dart';

  // Elixir/Erlang: "(module) function/N" or "Test@mod/0 in :elixir_compiler"
  if (st.match(/^\s*\([\w.]+\)\s+\w+\/\d+\s/m) || st.match(/@\w+\/\d+\s+in\s+/m)) return 'elixir';

  // Lua: "stack traceback:", "file.lua:42: in function 'func'"
  if (st.match(/^stack\s+traceback:/m) || st.match(/\S+\.lua:\d+:\s+in\s+/m)) return 'lua';

  // JavaScript/Node: "at func (file:line:col)"
  if (st.match(/^\s*at\s+.+\(.+:\d+:\d+\)/m) || st.match(/^\s*at\s+.+:\d+:\d+$/m)) {
    const jsFileMatch = st.match(/\.(?:js|mjs|cjs|ts|jsx|tsx|mts|cts):\d+/);
    if (jsFileMatch) return 'javascript';
    // Generic "at ... (file:line:col)" could also be Node/Browser with no ext
    const atCount = (st.match(/^\s*at\s+/gm) || []).length;
    if (atCount >= 2) return 'javascript';
  }

  return 'unknown';
}

// ── JavaScript / TypeScript / Node.js / Browser Stack Trace Parser ──
// Format: at ClassName.methodName (file.js:42:15)
//         at methodName (file.js:42:15)
//         at file:///path/to/file.js:42:15
//         at async ClassName.methodName (file.ts:42:15)
//         at processTicksAndRejections (node:internal/process/task_queues:95:5)

function parseJavaScript(lines: string[], _lang: string): StackFrame[] {
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

// ── Java / Kotlin Stack Trace Parser ──
// Format: at com.example.MyClass.myMethod(MyClass.java:42)
//         at com.example.MyClass.<init>(MyClass.java:15)
// Caused by: java.lang.NullPointerException: message
//         ... 23 more

function parseJava(lines: string[]): StackFrame[] {
  const frames: StackFrame[] = [];
  let index = 0;

  // Java frame: "at pkg.Class.method(File.java:42)"
  const frameRegex = /^\s*at\s+([\w$.]+)\.([\w$<>]+)\(([\w$.]+\.(?:java|kt|scala|groovy|clj))(?::(\d+))?\)/;
  // Java caused-by chain: "Caused by: ExceptionClass: message"
  const causedRegex = /^(?:Caused\s+by:\s+)?([\w.]+(?:\.[\w.]+)*(?:Exception|Error|Throwable))(?::\s*(.*))?/;
  // Java suppressed: "Suppressed: ..."
  const suppressRegex = /^\s*\.\.\.\s+\d+\s+(?:more|common frames omitted)/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || suppressRegex.test(trimmed)) continue;

    const m = trimmed.match(frameRegex);
    if (m) {
      frames.push({
        index: index++,
        language: 'java',
        file_path: normalizePath(m[3]),
        line_number: m[4] ? parseInt(m[4], 10) : null,
        column_number: null,
        function_name: m[2],
        module_name: m[1],
        address: '',
        raw_line: trimmed,
        severity: 'unknown',
      });
    }
  }

  return frames;
}

// ── Rust Stack Trace Parser ──
// Format: panicked at 'message', src/main.rs:42:15
//   0: rust_begin_unwind
//   1: core::panicking::panic
//   2: my_crate::main
//              at src/main.rs:42:15

function parseRust(lines: string[]): StackFrame[] {
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

// ── Ruby Stack Trace Parser ──
// Format: from /path/to/file.rb:42:in `method_name'
//         /path/to/file.rb:42:in `block in method_name'

function parseRuby(lines: string[]): StackFrame[] {
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

// ── PHP Stack Trace Parser ──
// Format: #0 /path/to/file.php(42): ClassName->method(args)
//         #1 /path/to/file.php(100): include('/some/file.php')
//         PHP Fatal error:  Uncaught Exception: message in /path/file.php:42

function parsePHP(lines: string[]): StackFrame[] {
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

// ── Swift Stack Trace Parser ──
// Format: 0   MyApp                   0x10a2b3c4d main + 42  (main.swift:15)
//         1   libdyld.dylib           0x7fff6a2b3c4d start + 1

function parseSwift(lines: string[]): StackFrame[] {
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

// ── Dart / Flutter Stack Trace Parser ──
// Format: package:my_app/src/main.dart 42:7  Class.method

function parseDart(lines: string[]): StackFrame[] {
  const frames: StackFrame[] = [];
  let index = 0;

  // Dart frame: "package:xxx/file.dart 42:7  Class.method"
  //             "dart:core 123:45  Class.method"
  //             "#0      Class.method (package:xxx/file.dart:42:7)"
  const dartRegex = /^(?:package:|dart:)(\S+\.dart)\s+(\d+):(\d+)\s+(.+)$/;
  const dartHashRegex = /^#\d+\s+(.+?)\s+\((package:|dart:)(\S+\.dart):(\d+):(\d+)\)/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Try the hash format first
    let m = trimmed.match(dartHashRegex);
    if (m) {
      const func = m[1] || '';
      const dotIdx = func.lastIndexOf('.');
      frames.push({
        index: index++,
        language: 'dart',
        file_path: normalizePath(m[3]),
        line_number: parseInt(m[4], 10),
        column_number: parseInt(m[5], 10),
        function_name: dotIdx > 0 ? func.substring(dotIdx + 1) : func,
        module_name: dotIdx > 0 ? func.substring(0, dotIdx) : '',
        address: '',
        raw_line: trimmed,
        severity: 'unknown',
      });
      continue;
    }

    m = trimmed.match(dartRegex);
    if (m) {
      const func = m[4] || '';
      const dotIdx = func.lastIndexOf('.');
      frames.push({
        index: index++,
        language: 'dart',
        file_path: normalizePath(m[1]),
        line_number: parseInt(m[2], 10),
        column_number: parseInt(m[3], 10),
        function_name: dotIdx > 0 ? func.substring(dotIdx + 1) : func,
        module_name: dotIdx > 0 ? func.substring(0, dotIdx) : '',
        address: '',
        raw_line: trimmed,
        severity: 'unknown',
      });
    }
  }

  return frames;
}

// ── Elixir / Erlang Stack Trace Parser ──
// Format: (elixir 1.15.0) lib/enum.ex:2510: Enum.reduce/3
//         (stdlib 4.2) lists.erl:1462: :lists.do_map/2

function parseElixirErlang(lines: string[], _lang: string): StackFrame[] {
  const frames: StackFrame[] = [];
  let index = 0;

  const beRegex = /^\(([^)]+)\)\s+(.+?\.(?:ex|exs|erl)):(\d+):\s+(.+?\/\d+)$/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const m = trimmed.match(beRegex);
    if (m) {
      const moduleAndArity = m[4] || '';
      const slashIdx = moduleAndArity.lastIndexOf('/');
      const func = slashIdx > 0 ? moduleAndArity.substring(0, slashIdx) : moduleAndArity;
      const modParts = func.split('.');
      const funcName = modParts.length > 1 ? modParts[modParts.length - 1] : func;
      const moduleName = modParts.length > 1 ? modParts.slice(0, -1).join('.') : m[1];

      frames.push({
        index: index++,
        language: 'elixir',
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

  return frames;
}

// ── Lua Stack Trace Parser ──
// Format: stack traceback:
//         file.lua:42: in function 'method'
//         [C]: in function 'error'

function parseLua(lines: string[]): StackFrame[] {
  const frames: StackFrame[] = [];
  let index = 0;

  const luaRegex = /^(.+?\.lua):(\d+):\s+in\s+(?:function\s+)?'?(.+?)'?\s*$/;
  const cFuncRegex = /^\[C\]:\s+in\s+function\s+'(.+)'/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === 'stack traceback:') continue;

    let m = trimmed.match(luaRegex);
    if (m) {
      frames.push({
        index: index++,
        language: 'lua',
        file_path: normalizePath(m[1]),
        line_number: parseInt(m[2], 10),
        column_number: null,
        function_name: m[3],
        module_name: extractModuleFromPath(m[1]),
        address: '',
        raw_line: trimmed,
        severity: 'unknown',
      });
      continue;
    }

    m = trimmed.match(cFuncRegex);
    if (m) {
      frames.push({
        index: index++,
        language: 'lua',
        file_path: '[C]',
        line_number: null,
        column_number: null,
        function_name: m[1],
        module_name: 'C',
        address: '',
        raw_line: trimmed,
        severity: 'unknown',
      });
    }
  }

  return frames;
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

  // Framework patterns for different languages
  const frameworkPatterns: Record<string, RegExp[]> = {
    csharp: [/^System\./, /^UnityEngine\./, /^UnityEditor\./, /^Microsoft\./, /^mscorlib/, /^Mono\./, /^netstandard/],
    cpp: [/^std::/, /^__/, /^libc/, /^lib\w+\.so/, /\.dylib/, /\.dll/, /^glibc/, /^pthread/, /^boost::/, /^absl::/],
    c: [/^libc/, /^lib\w+\.so/, /\.dylib/, /\.dll/],
    go: [/^runtime\./, /^sync\./, /^internal\//, /^reflect\./, /^syscall\./],
    python: [/^site-packages/, /^lib\/python/, /\/python\d[\d.]*\//, /<frozen/, /<built-in/],
    javascript: [/node:internal/, /node_modules/, /<anonymous>/, /processTicksAndRejections/, /^internal\//],
    node: [/node:internal/, /node_modules/, /<anonymous>/, /processTicksAndRejections/, /^internal\//],
    browser: [/^webpack/, /^__webpack/, /^\(index\)/, /^new\s+<anonymous>/, /@chrome-extension/],
    java: [/^java\./, /^javax\./, /^jakarta\./, /^sun\./, /^jdk\./, /^org\.springframework\./, /^org\.hibernate\./],
    kotlin: [/^kotlin\./, /^java\./, /^javax\./],
    rust: [/^std::/, /^core::/, /^alloc::/, /^rust_begin_unwind/, /^panic_unwind/, /<\w+ as core::/],
    ruby: [/^\/gems\//, /^\/ruby\//, /^\/usr\/lib\/ruby/, /<internal:/],
    php: [/^\/vendor\//, /^\/var\/www/, /^\[internal/, /^(?:require|include|eval|spl_autoload)/],
    swift: [/^libdispatch/, /^libobjc/, /^libsystem/, /^libswift/, /^CoreFoundation/, /^Foundation/, /^UIKit/, /^SwiftUI/, /^Combine/],
    dart: [/^dart:/, /^package:flutter/, /^package:meta/, /^package:collection/],
    elixir: [/^\(elixir\s/, /^\(stdlib\s/, /^\(kernel\s/, /^\(mix\s/, /^\:erlang\./],
    erlang: [/^\(stdlib\s/, /^\(kernel\s/, /^\(erts\s/],
    lua: [/^\[C\]/, /\/?.+?\/lua\//, /\/?.+?\/luajit\//],
  };

  const fwPatterns = frameworkPatterns[lang] || [];
  const userFrames: number[] = [];

  // Identify user code vs framework code
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const path = (frame.file_path || '').toLowerCase();
    const module = (frame.module_name || '').toLowerCase();
    const fullQualified = (module ? module + '.' + frame.function_name : frame.function_name || '').toLowerCase();

    let isFramework = false;
    for (const pat of fwPatterns) {
      if (pat.test(fullQualified) || pat.test(path) || pat.test(module)) {
        isFramework = true;
        break;
      }
    }

    frame.severity = isFramework ? 'framework' : 'unknown';
    if (!isFramework) userFrames.push(i);
  }

  // Color-code user frames
  if (userFrames.length === 0) {
    // All framework — mark first as trigger
    if (frames.length > 0) frames[0].severity = 'trigger';
    return;
  }

  // Trigger: first user frame (innermost, index 0 or earliest in userFrames)
  const triggerIdx = userFrames[0];
  frames[triggerIdx].severity = 'trigger';

  // Source: last user frame (outermost, root cause)
  const sourceIdx = userFrames[userFrames.length - 1];
  if (sourceIdx !== triggerIdx) {
    frames[sourceIdx].severity = 'source';
  }

  // Propagation: middle user frames
  for (let i = 1; i < userFrames.length - 1; i++) {
    frames[userFrames[i]].severity = 'propagation';
  }
}

// ── Shared Helpers ──

function normalizePath(filePath: string): string {
  if (!filePath) return '';

  let normalized = filePath.replace(/\\/g, '/');

  // Strip <angled brackets> from Unity paths like "<1234567890>"
  normalized = normalized.replace(/<[^>]+>/g, '').trim();

  // Handle file:// URLs (Node.js)
  if (normalized.startsWith('file://')) {
    try {
      normalized = decodeURIComponent(normalized.replace('file://', ''));
    } catch {
      normalized = normalized.replace('file://', '');
    }
    // Strip Windows drive letter leading slash
    if (/^\/[A-Za-z]:/.test(normalized)) {
      normalized = normalized.substring(1);
    }
  }

  // Make absolute paths relative by stripping common prefixes
  const prefixes = [
    '/app/', '/src/', '/home/', '/Users/', '/root/',
    '/var/www/', '/opt/', '/usr/local/', '/usr/',
    '/go/src/', '/go/pkg/',
    '/build/', '/dist/',
    '/workspace/', '/project/', '/Projects/',
  ];

  for (const prefix of prefixes) {
    const idx = normalized.indexOf(prefix);
    if (idx >= 0) {
      // Keep the meaningful part after the base prefix
      const after = normalized.substring(idx + prefix.length);
      // If there's a recognizable project structure, return relative
      if (after.length > 0) return after;
    }
  }

  // Strip leading path separators and common prefixes for known structures
  normalized = normalized.replace(/^[A-Za-z]:[/\\]/, ''); // Windows drive
  normalized = normalized.replace(/^\/+/, ''); // Leading slashes

  // For paths like "Owner/repo/folder/file.ext", strip first 0-1 segments
  // if the result looks like a well-known project root
  const segments = normalized.split('/');
  if (segments.length >= 3) {
    const knownRoots = ['src', 'lib', 'app', 'pkg', 'internal', 'cmd', 'main', 'test', 'tests'];
    for (let i = 0; i < Math.min(2, segments.length - 2); i++) {
      if (knownRoots.includes(segments[i])) {
        return segments.slice(i).join('/');
      }
    }
  }

  return normalized;
}

function extractModuleFromPath(filePath: string): string {
  if (!filePath) return '';

  const parts = filePath.replace(/\\/g, '/').split('/').filter(p => p);
  if (parts.length === 0) return '';

  // Remove file extension and return the last directory or filename
  const last = parts[parts.length - 1];
  const name = last.replace(/\.[^.]+$/, '');

  // If the path has a parent directory, use "parentName/fileName"
  if (parts.length >= 2) {
    const parent = parts[parts.length - 2];
    return `${parent}/${name}`;
  }

  return name;
}
