// ── Uploaded Source Analysis ──
// Language-independent source snapshot analysis. Function declaration and
// definition regexes per source language come from each language's profile
// (分析表); the generic fallback patterns live here.

import type {
  AnalysisSourceFile,
  AnalysisSourceSnapshot,
  CrashAnalysis,
  RelatedFunction,
  RelatedSourceFile,
  SourceAnalysis,
  SourceLocation,
  SourceRelationship,
  StackFrame,
} from '../types.js';
import { pathsMatch } from '../../source.js';
import { LANGUAGE_PROFILES } from '../registry.js';

export function analyzeSourceCode(
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
  for (const profile of LANGUAGE_PROFILES) {
    const pattern = profile.functionDeclarations[language];
    const direct = pattern?.exec(line)?.[1];
    if (direct) return direct;
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
  for (const profile of LANGUAGE_PROFILES) {
    const factory = profile.definitionPatterns[language];
    if (factory) return factory(name);
  }
  return new RegExp(`^\\s*(?:(?:public|protected|private|static|final|virtual|override|async|export|internal|extern|inline|constexpr|synchronized)\\s+)*(?:[\\w$<>\\[\\],.?*&:\\s]+\\s+)?${name}\\s*\\([^;]*\\)\\s*(?:\\{|=>|throws\\b)`);
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
