// ── Crash Analyzer ──
// Builds the complete crash analysis: file tree, trigger point, and color-coded stack chain.
// Supports C#, C++/C, Go, and Python stack traces.

import type {
  CrashAnalysis,
  FileTreeNode,
  RelatedFunction,
  RelatedSourceFile,
  SourceAnalysis,
  SourceLocation,
  SourceRelationship,
  StackFrame,
} from './types.js';
import { parseStackFrames, detectLanguage } from './parser.js';
import { pathsMatch } from '../source.js';

export interface AnalysisSourceFile {
  relative_path: string;
  language: string;
  content: string;
}

export interface AnalysisSourceSnapshot {
  project_name: string;
  requested_release: string;
  snapshot_release: string;
  snapshot_id: number;
  match_type: 'exact' | 'latest';
  files: AnalysisSourceFile[];
}

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
}, sourceSnapshot?: AnalysisSourceSnapshot): CrashAnalysis | null {
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

  const analysis: CrashAnalysis = {
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
  if (sourceSnapshot) analysis.source_analysis = analyzeSourceCode(sourceSnapshot, frames, triggerPoint);
  return analysis;
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

    const normalizedPath = frame.file_path
      .replace(/\\/g, '/')
      .replace(/\/{2,}/g, '/')
      .replace(/^\.\//, '')
      .replace(/\/$/, '');
    const parts = normalizedPath.split('/').filter(p => p);
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

// ── Uploaded Source Analysis ──

function analyzeSourceCode(
  snapshot: AnalysisSourceSnapshot,
  frames: StackFrame[],
  triggerPoint: CrashAnalysis['trigger_point']
): SourceAnalysis {
  const warnings: string[] = [];
  const sourceAnalysis: SourceAnalysis = {
    project_name: snapshot.project_name,
    requested_release: snapshot.requested_release,
    snapshot_release: snapshot.snapshot_release,
    snapshot_id: snapshot.snapshot_id,
    match_type: snapshot.match_type,
    files_scanned: snapshot.files.length,
    crash_source: null,
    function_definition: null,
    references: [],
    related_functions: [],
    related_files: [],
    warnings,
  };

  const documents = snapshot.files.map(file => ({ file, lines: file.content.split(/\r?\n/) }));
  const definitions = new Map<string, Array<{ file: AnalysisSourceFile; lines: string[]; line: number; name: string }>>();
  for (const document of documents) {
    for (let index = 0; index < document.lines.length; index++) {
      const name = declaredFunctionName(document.lines[index], document.file.language);
      if (!name) continue;
      const key = name.toLowerCase();
      const matches = definitions.get(key) ?? [];
      matches.push({ file: document.file, lines: document.lines, line: index + 1, name });
      definitions.set(key, matches);
    }
  }

  const triggerFrame = frames.find(frame => frame.file_path && frame.line_number) ?? frames[0];
  let triggerFile: AnalysisSourceFile | undefined;
  if (triggerFrame?.file_path) {
    const matches = snapshot.files.filter(file => pathsMatch(triggerFrame.file_path, file.relative_path));
    triggerFile = matches.sort((a, b) => pathMatchScore(triggerFrame.file_path, b.relative_path) - pathMatchScore(triggerFrame.file_path, a.relative_path))[0];
    if (triggerFile && triggerFrame.line_number) {
      const triggerLines = documents.find(document => document.file === triggerFile)?.lines ?? [];
      if (triggerFrame.line_number <= triggerLines.length) {
        sourceAnalysis.crash_source = sourceLocation(triggerFile, triggerFrame.line_number, triggerFrame.function_name, 6, triggerLines);
      } else {
        warnings.push(`Crash line ${triggerFrame.line_number} is outside ${triggerFile.relative_path}`);
      }
    } else if (!triggerFile) {
      warnings.push(`No uploaded source file matched ${triggerFrame.file_path}`);
    }
  }

  const functionName = cleanFunctionName(triggerPoint.function_name || triggerFrame?.function_name || '');
  if (!functionName) {
    warnings.push('No searchable crash function name was found');
    sourceAnalysis.related_files = buildRelatedFiles(sourceAnalysis, snapshot.files);
    return sourceAnalysis;
  }

  const preferredDefinition = chooseDefinition(
    definitions.get(functionName.toLowerCase()) ?? [],
    triggerFile,
    triggerFrame?.language || ''
  );
  if (preferredDefinition) {
    sourceAnalysis.function_definition = sourceLocation(
      preferredDefinition.file,
      preferredDefinition.line,
      preferredDefinition.name,
      4,
      preferredDefinition.lines
    );
  } else {
    const definitionPattern = definitionRegex(functionName, triggerFrame?.language || '');
    for (const document of documents) {
      const index = document.lines.findIndex(line => definitionPattern.test(line));
      if (index < 0) continue;
      sourceAnalysis.function_definition = sourceLocation(document.file, index + 1, functionName, 4, document.lines);
      break;
    }
  }

  const callPattern = new RegExp(`\\b${escapeRegExp(functionName)}\\s*\\(`);
  for (const document of documents) {
    for (let index = 0; index < document.lines.length && sourceAnalysis.references.length < 20; index++) {
      if (!callPattern.test(document.lines[index])) continue;
      const lineNumber = index + 1;
      if (sourceAnalysis.function_definition?.file_path === document.file.relative_path &&
          sourceAnalysis.function_definition.line_number === lineNumber) continue;
      sourceAnalysis.references.push(sourceLocation(document.file, lineNumber, functionName, 2, document.lines));

      const caller = enclosingDefinition(document.file, document.lines, lineNumber);
      if (caller && caller.name.toLowerCase() !== functionName.toLowerCase()) {
        addRelatedFunction(sourceAnalysis.related_functions, {
          ...sourceLocation(document.file, caller.line, caller.name, 3, document.lines),
          relationship: 'caller',
          language: document.file.language,
        });
      }
    }
    if (sourceAnalysis.references.length >= 20) break;
  }

  if (preferredDefinition) {
    const [start, end] = functionBodyRange(preferredDefinition.lines, preferredDefinition.line, preferredDefinition.file.language);
    const calledNames = new Set<string>();
    for (let line = start; line <= end && calledNames.size < 12; line++) {
      for (const calledName of calledFunctionNames(preferredDefinition.lines[line - 1] || '')) {
        const cleaned = cleanFunctionName(calledName);
        if (!cleaned || cleaned.toLowerCase() === functionName.toLowerCase() || !definitions.has(cleaned.toLowerCase())) continue;
        calledNames.add(cleaned);
      }
    }
    for (const calledName of calledNames) {
      const definition = chooseDefinition(definitions.get(calledName.toLowerCase()) ?? [], undefined, preferredDefinition.file.language);
      if (!definition) continue;
      addRelatedFunction(sourceAnalysis.related_functions, {
        ...sourceLocation(definition.file, definition.line, definition.name, 3, definition.lines),
        relationship: 'callee',
        language: definition.file.language,
      });
    }
  }

  for (const frame of frames.slice(1)) {
    const stackFunction = cleanFunctionName(frame.function_name);
    if (!stackFunction || stackFunction.toLowerCase() === functionName.toLowerCase()) continue;
    const definition = chooseDefinition(
      definitions.get(stackFunction.toLowerCase()) ?? [],
      frame.file_path ? snapshot.files.find(file => pathsMatch(frame.file_path, file.relative_path)) : undefined,
      frame.language
    );
    if (!definition) continue;
    addRelatedFunction(sourceAnalysis.related_functions, {
      ...sourceLocation(definition.file, definition.line, definition.name, 3),
      relationship: 'stack',
      language: definition.file.language,
    });
  }

  if (!sourceAnalysis.function_definition) warnings.push(`No likely definition found for ${functionName}`);
  if (sourceAnalysis.references.length === 20) warnings.push('Reference results were limited to the first 20 matches');
  sourceAnalysis.related_files = buildRelatedFiles(sourceAnalysis, snapshot.files);
  return sourceAnalysis;
}

type IndexedDefinition = {
  file: AnalysisSourceFile;
  lines: string[];
  line: number;
  name: string;
};

function declaredFunctionName(line: string, language: string): string {
  const patterns: Record<string, RegExp> = {
    python: /^\s*(?:async\s+)?def\s+([A-Za-z_$][\w$]*)\s*\(/,
    go: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)\s*\(/,
    rust: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_$][\w$]*)\s*\(/,
    ruby: /^\s*def\s+(?:self\.)?([A-Za-z_$][\w$]*[!?=]?)\b/,
    php: /^\s*(?:(?:public|protected|private|static|final|abstract)\s+)*function\s+([A-Za-z_$][\w$]*)\s*\(/i,
    lua: /^\s*(?:local\s+)?function\s+(?:[\w.:]+[.:])?([A-Za-z_$][\w$]*)\s*\(/,
    elixir: /^\s*defp?\s+([A-Za-z_$][\w$]*[!?]?)\s*\(/,
  };
  const direct = patterns[language]?.exec(line)?.[1];
  if (direct) return direct;

  if (['javascript', 'typescript'].includes(language)) {
    const arrow = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(line)?.[1];
    if (arrow) return arrow;
  }

  const generic = /^\s*(?:(?:public|protected|private|static|final|virtual|override|async|export|internal|extern|inline|constexpr|synchronized|abstract|sealed|partial|unsafe|new)\s+)*(?:[\w$<>\[\],.?*&:\s]+\s+)?([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?:\{|=>|throws\b)/.exec(line)?.[1] ?? '';
  return /^(?:if|for|while|switch|catch|using|return|throw|new)$/.test(generic) ? '' : generic;
}

function chooseDefinition(matches: IndexedDefinition[], preferredFile?: AnalysisSourceFile, language?: string): IndexedDefinition | undefined {
  return [...matches].sort((a, b) => {
    const aFile = preferredFile && a.file.relative_path === preferredFile.relative_path ? 2 : 0;
    const bFile = preferredFile && b.file.relative_path === preferredFile.relative_path ? 2 : 0;
    const aLanguage = language && a.file.language === language ? 1 : 0;
    const bLanguage = language && b.file.language === language ? 1 : 0;
    return (bFile + bLanguage) - (aFile + aLanguage);
  })[0];
}

function enclosingDefinition(file: AnalysisSourceFile, lines: string[], lineNumber: number): IndexedDefinition | null {
  const earliest = Math.max(0, lineNumber - 201);
  for (let index = lineNumber - 2; index >= earliest; index--) {
    const name = declaredFunctionName(lines[index], file.language);
    if (name) return { file, lines, line: index + 1, name };
  }
  return null;
}

function functionBodyRange(lines: string[], definitionLine: number, language: string): [number, number] {
  const maxEnd = Math.min(lines.length, definitionLine + 160);
  if (language === 'python') {
    const indent = (lines[definitionLine - 1].match(/^\s*/) || [''])[0].length;
    let end = definitionLine;
    for (let line = definitionLine + 1; line <= maxEnd; line++) {
      const text = lines[line - 1];
      if (text.trim() && (text.match(/^\s*/) || [''])[0].length <= indent) break;
      end = line;
    }
    return [definitionLine, end];
  }

  let depth = 0;
  let opened = false;
  for (let line = definitionLine; line <= maxEnd; line++) {
    const text = lines[line - 1];
    for (const char of text) {
      if (char === '{') { depth++; opened = true; }
      else if (char === '}') depth--;
    }
    if (opened && depth <= 0) return [definitionLine, line];
  }
  return [definitionLine, Math.min(maxEnd, definitionLine + 80)];
}

function calledFunctionNames(line: string): string[] {
  const names: string[] = [];
  const pattern = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  const ignored = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'throw', 'new', 'typeof', 'sizeof', 'nameof', 'isset', 'empty']);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    if (!ignored.has(match[1])) names.push(match[1]);
  }
  return names;
}

function addRelatedFunction(target: RelatedFunction[], candidate: RelatedFunction): void {
  if (target.length >= 24) return;
  const duplicate = target.some(item => item.relationship === candidate.relationship && item.file_path === candidate.file_path && item.line_number === candidate.line_number);
  if (!duplicate) target.push(candidate);
}

function buildRelatedFiles(source: SourceAnalysis, snapshotFiles: AnalysisSourceFile[]): RelatedSourceFile[] {
  const files = new Map<string, RelatedSourceFile>();
  const languages = new Map(snapshotFiles.map(file => [file.relative_path, file.language]));
  const add = (location: SourceLocation | null, relationship: SourceRelationship, functionName?: string) => {
    if (!location) return;
    const existing = files.get(location.file_path) ?? {
      file_path: location.file_path,
      language: languages.get(location.file_path) || '',
      relationships: [],
      functions: [],
      match_count: 0,
    };
    if (!existing.relationships.includes(relationship)) existing.relationships.push(relationship);
    if (functionName && !existing.functions.includes(functionName)) existing.functions.push(functionName);
    existing.match_count++;
    files.set(location.file_path, existing);
  };

  add(source.crash_source, 'crash', source.crash_source?.function_name);
  add(source.function_definition, 'definition', source.function_definition?.function_name);
  for (const reference of source.references) add(reference, 'caller', reference.function_name);
  for (const related of source.related_functions) {
    add(related, related.relationship, related.function_name);
    const file = files.get(related.file_path);
    if (file && !file.language) file.language = related.language;
  }
  return [...files.values()].sort((a, b) => {
    const priority = (file: RelatedSourceFile) => file.relationships.includes('crash') ? 3 : file.relationships.includes('definition') ? 2 : file.relationships.includes('stack') ? 1 : 0;
    return priority(b) - priority(a) || b.match_count - a.match_count || a.file_path.localeCompare(b.file_path);
  });
}

function sourceLocation(
  file: AnalysisSourceFile,
  lineNumber: number,
  functionName: string,
  context: number,
  sourceLines?: string[]
): SourceLocation {
  const lines = sourceLines ?? file.content.split(/\r?\n/);
  const start = Math.max(1, lineNumber - context);
  const end = Math.min(lines.length, lineNumber + context);
  const snippet: string[] = [];
  for (let line = start; line <= end; line++) {
    const marker = line === lineNumber ? '>' : ' ';
    snippet.push(`${marker} ${String(line).padStart(5, ' ')} | ${lines[line - 1]}`);
  }
  return { file_path: file.relative_path, line_number: lineNumber, function_name: functionName, snippet: snippet.join('\n') };
}

function definitionRegex(functionName: string, language: string): RegExp {
  const name = escapeRegExp(functionName);
  switch (language) {
    case 'python': return new RegExp(`^\\s*(?:async\\s+)?def\\s+${name}\\s*\\(`);
    case 'go': return new RegExp(`^\\s*func\\s+(?:\\([^)]*\\)\\s*)?${name}\\s*\\(`);
    case 'rust': return new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+${name}\\s*\\(`);
    case 'ruby': return new RegExp(`^\\s*def\\s+(?:self\\.)?${name}\\b`);
    case 'php': return new RegExp(`^\\s*(?:(?:public|protected|private|static|final|abstract)\\s+)*function\\s+${name}\\s*\\(`, 'i');
    case 'lua': return new RegExp(`^\\s*(?:local\\s+)?function\\s+(?:[\\w.:]+[.:])?${name}\\s*\\(`);
    case 'elixir': return new RegExp(`^\\s*defp?\\s+${name}\\s*\\(`);
    default: return new RegExp(`^\\s*(?:(?:public|protected|private|static|final|virtual|override|async|export|internal|extern|inline|constexpr|synchronized)\\s+)*(?:[\\w$<>\\[\\],.?*&:\\s]+\\s+)?${name}\\s*\\([^;]*\\)\\s*(?:\\{|=>|throws\\b)`);
  }
}

function cleanFunctionName(value: string): string {
  const withoutArgs = value.replace(/\(.*$/, '').trim();
  const parts = withoutArgs.split(/\.|::|->/);
  const name = parts[parts.length - 1]?.replace(/^<|>$/g, '') ?? '';
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : '';
}

function pathMatchScore(stackPath: string, sourcePath: string): number {
  const stack = stackPath.replace(/\\/g, '/').toLowerCase();
  const source = sourcePath.replace(/\\/g, '/').toLowerCase();
  if (stack === source) return 3;
  if (stack.endsWith('/' + source)) return 2;
  return 1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    node: 'Node.js',
    browser: 'Browser JavaScript',
    java: 'Java',
    kotlin: 'Kotlin',
    rust: 'Rust',
    ruby: 'Ruby',
    php: 'PHP',
    swift: 'Swift',
    dart: 'Dart / Flutter',
    elixir: 'Elixir',
    erlang: 'Erlang',
    lua: 'Lua',
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
    javascript: {
      TypeError: '类型错误，通常是对 null/undefined 访问属性或调用方法。使用可选链操作符 (?.) 或增加空值检查。Use optional chaining (?.) or guard against null/undefined.',
      ReferenceError: '引用了未定义的变量或标识符。检查变量是否在作用域内声明。Check if the variable is declared in the current scope.',
      SyntaxError: '代码语法错误。检查括号匹配、引号闭合和逗号是否正确。Review syntax around the reported location.',
      RangeError: '值超出有效范围，通常发生在数组长度、递归调用或数字转换。Check for infinite recursion or invalid array lengths.',
    },
    node: {
      TypeError: '类型错误，通常是对 null/undefined 访问属性或调用方法。使用可选链操作符 (?.) 或增加空值检查。Use optional chaining (?.) or guard against null/undefined.',
      ReferenceError: '引用了未定义的变量或标识符。检查变量是否在作用域内声明。Check if the variable is declared in the current scope.',
    },
    java: {
      NullPointerException: '空指针异常。在调用对象方法或访问字段前检查 null。Use Objects.requireNonNull() or add null guards before method calls.',
      ArrayIndexOutOfBoundsException: '数组索引越界。检查索引是否在 0 到 length-1 范围内。Verify the index is within array bounds.',
      ClassCastException: '类型转换错误。使用 instanceof 检查后再转换，或使用泛型避免。Use instanceof checks before casting, or use generics.',
      IllegalArgumentException: '传递了不合法或不适当的参数。添加输入验证和前置条件检查。Add input validation for method parameters.',
      ConcurrentModificationException: '在迭代集合时修改了集合。使用 Iterator.remove() 或并发集合类。Use ConcurrentHashMap or CopyOnWriteArrayList for concurrent access.',
    },
    rust: {
      'panicked at': '程序触发了 panic!，通常是不可恢复的错误。检查 unwrap/expect 调用或数组越界访问。Check unwrap/expect calls and array indexing.',
    },
    ruby: {
      NoMethodError: '调用了对象不存在的方法。使用 respond_to? 检查或确保对象类型正确。Check if the object responds to the method before calling.',
      NameError: '引用了未定义的变量或常量。检查拼写或确保定义在使用之前。Verify the variable/constant is defined.',
    },
    php: {
      'Fatal error': '致命错误，通常由未定义的类、函数或语法错误导致。检查类名前缀和函数拼写。Check class namespacing and function spelling.',
      'Uncaught Error': '未捕获的错误。使用 try/catch 块包裹可能出错的代码。Wrap the crash site in a try/catch block.',
      'Uncaught Exception': '未捕获的异常。添加 try/catch 处理或确保上层调用者有异常处理。Add exception handling around the reported location.',
    },
    swift: {
      'fatal error': '运行时致命错误，通常由强制解包 nil 可选值导致。避免使用 ! 强制解包，改用 if let 或 guard let。Avoid force-unwrapping optionals; use if let or guard let instead.',
      'EXC_BAD_ACCESS': '内存访问错误，通常访问了已释放或无效的内存。使用 Xcode Zombies 或 Address Sanitizer 调试。Use Xcode diagnostic tools to identify the memory issue.',
      SIGABRT: '程序异常终止，通常由未满足的前置条件或运行时检查失败。检查 assert/precondition 调用。',
    },
    dart: {
      NoSuchMethodError: '调用了不存在的方法。检查方法名拼写和参数类型。Verify the method name and argument types.',
      NullThrownError: '抛出了 null 值。确保抛出的是 Error 或 Exception 的子类。Throw a proper Error or Exception subclass.',
      TypeError: '类型不匹配。使用正确的泛型类型或添加类型检查。Use correct generic types or add type guards.',
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
    javascript: 'Review the stack trace above for the exact file path and line number. Use browser DevTools or Node.js inspector for debugging.',
    node: 'Review the stack trace above for the exact file path and line number. Use node --inspect or ndb for step-through debugging.',
    browser: 'Check the browser DevTools Sources panel at the reported file and line. Use source maps for minified code.',
    typescript: 'Check the stack trace for the exact source location. Use ts-node --inspect or source-map-support for accurate line numbers.',
    java: 'Check the stack trace for the exact class and line number. Use a Java debugger or set breakpoints in the reported method.',
    kotlin: 'Review the stack trace for the exact file and line. Use IntelliJ/Android Studio debugger for step-through analysis.',
    rust: 'Run with RUST_BACKTRACE=full for a complete stack trace. Use cargo test or a debugger (gdb/lldb) for detailed analysis.',
    ruby: 'Review the stack trace for file paths and line numbers. Use byebug or pry for step-through debugging.',
    php: 'Enable xdebug for detailed stack traces. Check the file and line reported in the stack trace for the error.',
    swift: 'Use Xcode debugger and Instruments to analyze the crash. Enable zombie objects and address sanitizer for memory issues.',
    dart: 'Use flutter analyze or dart analyze for static code checks. Run with --enable-asserts and use the Dart DevTools debugger.',
    elixir: 'Use IEx.pry or :debugger.start for debugging. Check the Mix/OTP stack trace for the exact module and line number.',
    erlang: 'Use :debugger.start() or dbg module for tracing. Check the Erlang stack trace for module:function/arity.',
    lua: 'Use lua-debug or mobdebug for remote debugging. Add pcall() wrappers around the crash site for graceful error handling.',
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

  // JavaScript/Node: Look for "at ... (file:line:col)" lines
  if (lang === 'node' || lang === 'javascript' || lang === 'browser' || lang === 'typescript') {
    const jsLines = lines.filter(l => l.trim().match(/^\s*at\s+/));
    if (jsLines.length > 0) return jsLines.join('\n');
  }

  // Java: Look for "at com.example.Class.method(File.java:42)" lines
  if (lang === 'java' || lang === 'kotlin') {
    const javaLines = lines.filter(l => l.trim().match(/^\s*at\s+/));
    if (javaLines.length > 0) return javaLines.join('\n');
  }

  // Rust: Look for numbered frames
  if (lang === 'rust') {
    const rsStart = lines.findIndex(l => l.includes('panicked at') || l.includes('stack backtrace:'));
    if (rsStart >= 0) {
      return lines.slice(rsStart, Math.min(lines.length, rsStart + 50)).join('\n');
    }
  }

  // Go: Look for panic section
  if (lang === 'go') {
    const panicIdx = lines.findIndex(l => l.includes('panic:') || l.includes('goroutine'));
    if (panicIdx >= 0) {
      return lines.slice(panicIdx, Math.min(lines.length, panicIdx + 40)).join('\n');
    }
  }

  // PHP: Look for stack trace section
  if (lang === 'php') {
    const stStart = lines.findIndex(l => l.includes('Stack trace:') || l.match(/^#\d+\s+\S+\.php/));
    if (stStart >= 0) {
      return lines.slice(stStart, Math.min(lines.length, stStart + 40)).join('\n');
    }
  }

  // Ruby: Look for "from ...rb:42:in ..." lines
  if (lang === 'ruby') {
    const rbLines = lines.filter(l => l.match(/\S+\.rb:\d+/));
    if (rbLines.length > 0) return rbLines.join('\n');
  }

  // Swift
  if (lang === 'swift') {
    const swiftStart = lines.findIndex(l => l.match(/^\d+\s+\S+\s+0x/));
    if (swiftStart >= 0) {
      return lines.slice(swiftStart, Math.min(lines.length, swiftStart + 50)).join('\n');
    }
  }

  // Dart
  if (lang === 'dart') {
    const dartLines = lines.filter(l => l.match(/^(package:|dart:)/));
    if (dartLines.length > 0) return dartLines.join('\n');
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
