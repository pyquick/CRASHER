// ── Crash Analyzer ──
// Builds the complete crash analysis: file tree, trigger point, and color-coded stack chain.
// Supports C#, C++/C, Go, and Python stack traces.

import type { CrashAnalysis, FileTreeNode, StackFrame } from './types.js';
import { parseStackFrames, detectLanguage } from './parser.js';

/**
 * Analyze a crash report's stack trace to produce a structured analysis.
 *
 * The analysis includes:
 * 1. File tree diagram (relative paths shown intuitively)
 * 2. Trigger point (exact file:line where the exception originated)
 * 3. Color-coded stack chain (red=crash, orange=propagation, yellow=source, gray=framework)
 * 4. Auto-detected programming language
 * 5. Human-readable summary
 */
export function analyzeCrash(report: {
  id: number;
  exception_type: string;
  exception_message: string;
  stack_trace: string;
  log_text?: string;
  runtime: string;
  runtime_version: string;
  symbolicated_stack?: string;
}): CrashAnalysis | null {
  const { id, exception_type, exception_message, stack_trace, log_text, runtime, runtime_version, symbolicated_stack } = report;

  // Determine which stack trace to use (prefer symbolicated for Unity)
  let rawStack = stack_trace || '';
  const lang = detectLanguage(rawStack, runtime);

  // For Unity/C#, use symbolicated stack if available
  if ((lang === 'csharp') && symbolicated_stack && symbolicated_stack.trim()) {
    rawStack = symbolicated_stack;
  }

  // If stack trace is empty, try extracting from log_text
  if (!rawStack.trim() && log_text) {
    rawStack = extractStackFromLog(log_text, lang);
  }

  if (!rawStack.trim()) {
    // Create minimal analysis with just exception info
    return createMinimalAnalysis(id, exception_type, exception_message, runtime, runtime_version, lang);
  }

  // Parse stack frames
  const frames = parseStackFrames(rawStack, runtime);

  if (frames.length === 0) {
    return createMinimalAnalysis(id, exception_type, exception_message, runtime, runtime_version, lang);
  }

  // Build the file tree
  const fileTree = buildFileTree(frames);

  // Identify the trigger point
  const triggerFrame = frames[0]; // innermost frame = crash site
  const triggerPoint = buildTriggerPoint(triggerFrame, exception_type, exception_message, frames);

  // Generate summary
  const summary = buildSummary(frames, exception_type, exception_message, lang);

  return {
    report_id: id,
    exception_type,
    exception_message,
    detected_language: lang,
    file_tree: fileTree,
    trigger_point: triggerPoint,
    stack_chain: frames,
    summary,
    runtime,
    runtime_version,
  };
}

// ── File Tree Builder ──

/**
 * Build a tree diagram showing the file paths involved in the crash.
 * The tree looks like:
 * └── src/
 *     └── controllers/
 *         └── player.js  ← crash here (line 42)
 */
function buildFileTree(frames: StackFrame[]): FileTreeNode[] {
  const rootNodes: FileTreeNode[] = [];

  for (const frame of frames) {
    if (!frame.file_path) continue;

    const parts = frame.file_path.split('/').filter(p => p);
    if (parts.length === 0) continue;

    let siblings = rootNodes;
    let currentPath = '';

    for (let depth = 0; depth < parts.length; depth++) {
      const part = parts[depth];
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isLast = depth === parts.length - 1;

      // Find existing node at this level by name
      let existing: FileTreeNode | undefined;
      for (const child of siblings) {
        if (child.name === part) {
          existing = child;
          break;
        }
      }

      if (existing) {
        // If we're at the file level and this frame is a crash trigger, upgrade it
        if (isLast && frame.severity === 'trigger') {
          existing.is_crash_site = true;
          existing.line_number = frame.line_number ?? existing.line_number;
          existing.severity = 'red';
        } else if (isLast && frame.severity !== 'trigger' && !existing.is_crash_site) {
          // Update severity to the highest priority
          const sevPriority = { red: 4, orange: 3, yellow: 2, gray: 1 };
          const newSev = severityToColor(frame.severity);
          if ((sevPriority[newSev] || 0) > (sevPriority[existing.severity] || 0)) {
            existing.severity = newSev;
          }
          if (frame.line_number && !existing.line_number) {
            existing.line_number = frame.line_number;
          }
        }
        siblings = existing.children;
      } else {
        // Create new node
        const severity: FileTreeNode['severity'] = isLast
          ? severityToColor(frame.severity)
          : 'gray';

        const node: FileTreeNode = {
          name: part,
          path: currentPath,
          is_file: isLast,
          is_crash_site: isLast && frame.severity === 'trigger',
          line_number: isLast ? frame.line_number : null,
          severity,
          children: [],
        };

        siblings.push(node);
        siblings = node.children;
      }
    }
  }

  // Sort: directories before files, crash-site files first, then alphabetically
  return sortTreeNodes(rootNodes);
}

function sortTreeNodes(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes
    .sort((a, b) => {
      // Crash site files first
      if (a.is_crash_site && !b.is_crash_site) return -1;
      if (!a.is_crash_site && b.is_crash_site) return 1;
      // Directories before files
      if (!a.is_file && b.is_file) return -1;
      if (a.is_file && !b.is_file) return 1;
      // Alphabetically
      return a.name.localeCompare(b.name);
    })
    .map(node => ({
      ...node,
      children: sortTreeNodes(node.children),
    }));
}

// ── Trigger Point ──

/**
 * Build the trigger point — the exact line and function where the crash occurred.
 */
function buildTriggerPoint(
  frame: StackFrame,
  exceptionType: string,
  exceptionMessage: string,
  allFrames: StackFrame[]
): CrashAnalysis['trigger_point'] {
  // Use the first frame with a file path, falling back to index 0
  let triggerFrame = frame;
  for (const f of allFrames) {
    if (f.file_path) {
      triggerFrame = f;
      break;
    }
  }

  // Build a descriptive message
  let message = `${exceptionType}`;
  if (exceptionMessage) {
    message += `: ${exceptionMessage}`;
  }
  if (triggerFrame.function_name) {
    message += `\nIn function: ${triggerFrame.module_name ? triggerFrame.module_name + '.' : ''}${triggerFrame.function_name}()`;
  }
  if (triggerFrame.file_path && triggerFrame.line_number) {
    message += `\nat ${triggerFrame.file_path}:${triggerFrame.line_number}`;
  }

  // Extract the raw snippet (the line from the stack trace that shows the crash)
  const rawSnippet = triggerFrame.raw_line || allFrames[0]?.raw_line || '';

  return {
    file_path: triggerFrame.file_path || '(unknown)',
    line_number: triggerFrame.line_number,
    function_name: triggerFrame.function_name || exceptionType,
    message,
    raw_snippet: rawSnippet,
  };
}

// ── Summary Builder ──

/**
 * Build a human-readable summary of the crash analysis.
 */
function buildSummary(
  frames: StackFrame[],
  exceptionType: string,
  exceptionMessage: string,
  lang: string
): string {
  const langLabel = languageLabel(lang);
  const trigger = frames[0];
  const sourceFrame = frames.find(f => f.severity === 'source') || frames[frames.length - 1];

  let summary = `## Crash Analysis (${langLabel})\n\n`;

  // Exception description
  summary += `**Exception**: \`${exceptionType}\``;
  if (exceptionMessage) {
    summary += ` — ${exceptionMessage}`;
  }
  summary += '\n\n';

  // Trigger point
  if (trigger.file_path) {
    summary += `**Crash Site**: \`${trigger.file_path}`;
    if (trigger.line_number) {
      summary += `:${trigger.line_number}`;
    }
    summary += '`';
    if (trigger.function_name) {
      summary += ` in \`${trigger.function_name}()\``;
    }
    summary += '\n\n';
  }

  // Root cause / source
  if (sourceFrame && sourceFrame.file_path && sourceFrame !== trigger) {
    summary += `**Likely Root Cause**: The error originated in \`${sourceFrame.file_path}`;
    if (sourceFrame.line_number) {
      summary += `:${sourceFrame.line_number}`;
    }
    summary += '`';
    if (sourceFrame.function_name) {
      summary += ` at \`${sourceFrame.function_name}()\``;
    }
    summary += `, and propagated through ${frames.length - 2} intermediate frame(s) before manifesting at the crash site.`;
    summary += '\n\n';
  }

  // Frame count
  summary += `**Stack Depth**: ${frames.length} frames\n\n`;

  // Language-specific advice
  const advice = getLanguageAdvice(lang, exceptionType);
  if (advice) {
    summary += `**Suggested Action**: ${advice}\n`;
  }

  return summary;
}

// ── Minimal Analysis (fallback when no stack trace) ──

/**
 * Create a minimal analysis when there's no usable stack trace.
 */
function createMinimalAnalysis(
  id: number,
  exceptionType: string,
  exceptionMessage: string,
  runtime: string,
  runtimeVersion: string,
  lang: string
): CrashAnalysis {
  return {
    report_id: id,
    exception_type: exceptionType,
    exception_message: exceptionMessage || '',
    detected_language: lang,
    file_tree: [],
    trigger_point: {
      file_path: '(no stack trace available)',
      line_number: null,
      function_name: exceptionType,
      message: exceptionMessage
        ? `${exceptionType}: ${exceptionMessage}`
        : exceptionType,
      raw_snippet: '',
    },
    stack_chain: [],
    summary: `## Crash Analysis\n\n**Exception**: \`${exceptionType}\`${exceptionMessage ? ` — ${exceptionMessage}` : ''}\n\nNo stack trace was submitted with this crash report. Upload a crash log or stack trace for detailed analysis.`,
    runtime,
    runtime_version: runtimeVersion,
  };
}

// ── Helpers ──

function severityToColor(severity: StackFrame['severity']): FileTreeNode['severity'] {
  switch (severity) {
    case 'trigger': return 'red';
    case 'propagation': return 'orange';
    case 'source': return 'yellow';
    case 'framework': return 'gray';
    default: return 'gray';
  }
}

function languageLabel(lang: string): string {
  const labels: Record<string, string> = {
    csharp: 'C# / Unity',
    cpp: 'C++',
    c: 'C',
    go: 'Go',
    python: 'Python',
    node: 'Node.js',
    browser: 'Browser JS',
    unknown: 'Unknown',
  };
  return labels[lang] || lang.toUpperCase();
}

function getLanguageAdvice(lang: string, exceptionType: string): string {
  const adviceMap: Record<string, Record<string, string>> = {
    csharp: {
      NullReferenceException: '检查引用是否为 null，在访问对象成员前加入判空逻辑。Check if the object reference is null before accessing its members.',
      ArgumentNullException: '确保传递给方法的参数不为 null。Ensure arguments passed to the method are not null.',
      IndexOutOfRangeException: '检查数组/列表索引是否在有效范围内。Verify the index is within the valid bounds of the array or list.',
      InvalidOperationException: '检查操作的前提条件是否满足（如集合在枚举时未被修改）。Ensure the operation preconditions are met.',
      KeyNotFoundException: '访问字典前检查 key 是否存在，或使用 TryGetValue。Check if the key exists before accessing the dictionary.',
    },
    cpp: {
      SIGSEGV: '段错误通常由空指针解引用、访问已释放内存或栈溢出引起。使用 AddressSanitizer (ASan) 或 Valgrind 定位具体的内存问题。',
      SIGABRT: '程序主动调用了 abort()。检查 assert 失败或未捕获的 C++ 异常。Check for failed assertions or unhandled exceptions.',
      SIGFPE: '算术异常（除零或整数溢出）。检查除法运算和浮点数转换。Check for division by zero or integer overflow.',
    },
    go: {
      'panic': '检查是否有 nil 指针解引用、越界切片访问或类型断言失败。Use defer/recover for graceful error handling.',
      'runtime error': '运行时错误通常是 nil 指针、越界访问或并发问题。检查 goroutine 中的共享状态访问。',
    },
    python: {
      AttributeError: '对象没有该属性。使用 hasattr() 或 try/except 进行防护。Check if the attribute exists before accessing it.',
      KeyError: '字典中缺少该键。使用 dict.get() 安全访问或 in 操作符检查。Use dict.get() instead of direct key access.',
      IndexError: '列表/元组索引越界。检查索引是否在有效范围内。Verify the index is within the valid list/tuple bounds.',
      ValueError: '传入的值类型正确但值不合理。添加输入验证。Add input validation for the problematic value.',
      TypeError: '对不兼容的类型执行了操作。检查变量类型，使用 isinstance() 或类型注解。Check variable types before performing operations.',
    },
  };

  // Check language-specific advice
  const langAdvice = adviceMap[lang];
  if (langAdvice) {
    // Try exact match
    if (langAdvice[exceptionType]) return langAdvice[exceptionType];
    // Try partial match (e.g., "panic: runtime error" contains "panic")
    for (const [key, advice] of Object.entries(langAdvice)) {
      if (exceptionType.toLowerCase().includes(key.toLowerCase())) {
        return advice;
      }
    }
  }

  // Default advice
  const defaults: Record<string, string> = {
    csharp: 'Reproduce the crash in a development build with full debug symbols. Check the C# stack trace above for the exact file and line number.',
    cpp: 'Compile with debug symbols (-g) and use a debugger (gdb/lldb) or AddressSanitizer to identify the exact memory issue.',
    go: 'Run the failing test with -race flag to detect data races. Use delve (dlv) debugger for step-through debugging.',
    python: 'Add try/except blocks around the crash site. Use pdb or a debugger to step through the code at the crash point.',
  };
  return defaults[lang] || 'Review the stack trace above and check the file paths and line numbers for the root cause.';
}

/**
 * Try to extract a stack trace from log text when stack_trace is empty.
 */
function extractStackFromLog(logText: string, lang: string): string {
  if (!logText) return '';

  const lines = logText.split('\n');

  // Python: Look for traceback block
  if (lang === 'python') {
    const tbStart = lines.findIndex(l => l.trim().startsWith('Traceback'));
    if (tbStart >= 0) {
      const tbLines: string[] = [];
      for (let i = tbStart; i < Math.min(lines.length, tbStart + 50); i++) {
        tbLines.push(lines[i]);
        if (lines[i].trim().match(/^[\w.]+:\s/)) break; // Exception line ends traceback
      }
      return tbLines.join('\n');
    }
  }

  // C# / Unity: Look for stack trace section
  if (lang === 'csharp') {
    const atLines = lines.filter(l => l.trim().match(/^\s*at\s+/));
    if (atLines.length > 0) return atLines.join('\n');
  }

  // Go: Look for panic section
  if (lang === 'go') {
    const panicIdx = lines.findIndex(l => l.includes('panic:') || l.includes('goroutine'));
    if (panicIdx >= 0) {
      return lines.slice(panicIdx, Math.min(lines.length, panicIdx + 40)).join('\n');
    }
  }

  // Generic: Find lines that look like stack frames
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
