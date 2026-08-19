// ── Python Structure Parser ──
// Lightweight, in-house Python structure parser. Uses indentation as the
// single block-structure authority, joins logical lines across parentheses,
// and records imports, classes, functions, calls, assignments, attribute
// accesses, returns and raises. No expression trees by design.

import type { AnalysisSourceFile } from '../../../types.js';
import type {
  PyAssignment,
  PyCall,
  PyClass,
  PyFileModel,
  PyFunction,
  PyImport,
  PyRhsKind,
} from './types.js';
import { stripLine, tokenizeLine, type StringState } from './tokenizer.js';

interface LogicalLine {
  text: string;
  line: number;   // 1-based line number of the statement start
  indent: number; // leading whitespace width of the statement start
}

interface Scope {
  indent: number;
  kind: 'module' | 'function' | 'class';
  func?: PyFunction;
  cls?: PyClass;
  openerLine: number;
  lastBodyLine: number;
}

const DEF_RE = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:->\s*[^:]*?)?\s*(?::\s*(.*))?$/;
const CLASS_RE = /^class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*(?::\s*(.*))?$/;
const IMPORT_RE = /^import\s+(.+)$/;
const FROM_IMPORT_RE = /^from\s+(\.*[\w.]*)\s+import\s+(.+)$/;
const DECORATOR_RE = /^@(.+)$/;
const RETURN_RE = /^return(?:\s+(.*))?$/;
const RAISE_RE = /^raise\s+([A-Za-z_]\w*)/;
// 'x = ...' (and 'x: int = ...', 'self.x = ...'); '=(?!=)' excludes 'x == 1'.
const ASSIGNMENT_RE = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*(?::\s*[^=]+?)?\s*=(?!=)\s*(.*)$/;

function indentOf(rawLine: string): number {
  const expanded = rawLine.replace(/\t/g, '    ');
  return expanded.length - expanded.trimStart().length;
}

/**
 * Join raw lines into logical lines. A logical line continues while its
 * parenthesized depth is unbalanced or a triple-quoted string is open.
 */
function buildLogicalLines(content: string): LogicalLine[] {
  const rawLines = content.split(/\r?\n/);
  const logical: LogicalLine[] = [];
  let current = '';
  let startLine = 0;
  let startIndent = 0;
  let depth = 0;
  const state: StringState = { delimiter: '' };

  const emit = (endLine: number) => {
    const text = current.trim();
    if (text) logical.push({ text, line: startLine + 1, indent: startIndent });
    current = '';
    depth = 0;
  };

  for (let index = 0; index < rawLines.length; index++) {
    const raw = rawLines[index];
    const code = stripLine(raw, state);
    if (current === '') {
      startLine = index;
      startIndent = indentOf(raw);
    }
    current += (current ? ' ' : '') + code.trim();

    if (state.delimiter) continue; // still inside a triple-quoted string

    for (const ch of code) {
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    }
    if (depth <= 0) emit(index);
  }
  if (current.trim()) emit(rawLines.length - 1);
  return logical;
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(' || ch === '[' || ch === '{') { depth++; current += ch; }
    else if (ch === ')' || ch === ']' || ch === '}') { depth--; current += ch; }
    else if (ch === ',' && depth === 0) { parts.push(current.trim()); current = ''; }
    else current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseImportStatement(rest: string, filePath: string, line: number, isFrom: boolean, module: string): PyImport[] {
  const imports: PyImport[] = [];
  const unwrapped = rest.trim().replace(/^\((.*)\)$/, '$1');
  for (const item of splitTopLevel(unwrapped)) {
    const match = item.match(/^([\w.]+)(?:\s+as\s+([A-Za-z_]\w*))?$/);
    if (!match) continue;
    const imported = match[1];
    const alias = match[2];
    const parts = imported.split('.');
    imports.push({
      file_path: filePath,
      line,
      module: isFrom ? module : imported,
      imported_name: isFrom ? parts[parts.length - 1] : imported,
      name: alias ?? (isFrom ? parts[parts.length - 1] : parts[0]),
      ...(alias ? { alias } : {}),
      is_from: isFrom,
    });
  }
  return imports;
}

function classifyRhs(rhs: string, calls: string[]): { rhs_calls: string[]; rhs_kind: PyRhsKind } {
  const trimmed = rhs.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('dict(')) {
    return { rhs_calls: calls, rhs_kind: 'dict' };
  }
  if (trimmed.startsWith('[') || trimmed.startsWith('list(')) {
    return { rhs_calls: calls, rhs_kind: 'list' };
  }
  if (calls.length > 0) return { rhs_calls: calls, rhs_kind: 'call' };
  if (trimmed.includes('.')) return { rhs_calls: [], rhs_kind: 'attr' };
  if (/^(?:None|True|False|\d|['"f])/.test(trimmed) || /^[-+]?\d/.test(trimmed)) {
    return { rhs_calls: [], rhs_kind: 'literal' };
  }
  if (/^[A-Za-z_]\w*$/.test(trimmed)) return { rhs_calls: [], rhs_kind: 'other' };
  return { rhs_calls: [], rhs_kind: 'other' };
}

function recordStatementTokens(scope: Scope, text: string, line: number): void {
  if (scope.kind !== 'function') return;
  const func = scope.func!;
  const tokens = tokenizeLine(text);
  for (const chain of tokens.calls) {
    const parts = chain.split('.');
    func.calls.push({
      name: chain,
      ...(parts.length > 1 ? { receiver: parts.slice(0, -1).join('.') } : {}),
      line,
    });
  }
  for (const attr of tokens.attrs) {
    func.attr_accesses.push({ receiver: attr.receiver, attr: attr.attr, line });
  }
}

function recordAssignment(scope: Scope, name: string, rhs: string, line: number, fileModel: PyFileModel): void {
  const tokens = tokenizeLine(rhs);
  const classified = classifyRhs(rhs, tokens.calls);
  if (scope.kind === 'function') {
    scope.func!.assignments.push({ name, line, ...classified });
    return;
  }
  if (scope.kind === 'class') {
    scope.cls!.assignments.push({ name, line, ...classified });
    return;
  }
  if (scope.kind === 'module') {
    fileModel.module_assignments.push({ name, line, ...classified });
    const key = name.toLowerCase();
    const locations = fileModel.name_defs.get(key) ?? [];
    locations.push({ name, file_path: fileModel.file_path, line });
    fileModel.name_defs.set(key, locations);
  }
  // Class-level assignments are intentionally not recorded (see plan).
}

export function parsePythonSource(relativePath: string, content: string): PyFileModel {
  const lines = content.split(/\r?\n/);
  const fileModel: PyFileModel = {
    file_path: relativePath,
    lines,
    imports: [],
    classes: [],
    functions: [],
    module_assignments: [],
    name_defs: new Map(),
  };

  const scopes: Scope[] = [{ indent: -1, kind: 'module', openerLine: 0, lastBodyLine: 0 }];
  let pendingDecorators: string[] = [];

  const top = () => scopes[scopes.length - 1];

  const closeScope = (): void => {
    const scope = scopes.pop()!;
    const end = Math.max(scope.openerLine, scope.lastBodyLine);
    const body = { start: scope.openerLine + 1, end };
    if (body.end < body.start) body.start = body.end;
    if (scope.kind === 'function') {
      scope.func!.body = body;
    } else if (scope.kind === 'class') {
      scope.cls!.body = body;
    }
  };

  const qualifiedParent = (): string => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i].kind === 'class') return scopes[i].cls!.qualified_name;
      if (scopes[i].kind === 'function') return scopes[i].func!.qualified_name;
    }
    return '';
  };

  const processLine = (logical: LogicalLine): void => {
    const text = logical.text;

    // Dedent: close scopes whose indent is >= this line's indent.
    while (scopes.length > 1 && logical.indent <= top().indent) {
      closeScope();
    }
    top().lastBodyLine = logical.line;

    // Decorator line: buffer for the next def/class.
    const decorator = text.match(DECORATOR_RE);
    if (decorator) {
      pendingDecorators.push(decorator[1].trim());
      return;
    }

    // Import statements.
    const fromImport = text.match(FROM_IMPORT_RE);
    if (fromImport) {
      for (const item of parseImportStatement(fromImport[2], relativePath, logical.line, true, fromImport[1])) {
        fileModel.imports.push(item);
        const key = item.name.toLowerCase();
        const locations = fileModel.name_defs.get(key) ?? [];
        locations.push({ name: item.name, file_path: relativePath, line: logical.line });
        fileModel.name_defs.set(key, locations);
      }
      pendingDecorators = [];
      return;
    }
    const plainImport = text.match(IMPORT_RE);
    if (plainImport) {
      for (const item of parseImportStatement(plainImport[1], relativePath, logical.line, false, '')) {
        fileModel.imports.push(item);
        const key = item.name.toLowerCase();
        const locations = fileModel.name_defs.get(key) ?? [];
        locations.push({ name: item.name, file_path: relativePath, line: logical.line });
        fileModel.name_defs.set(key, locations);
      }
      pendingDecorators = [];
      return;
    }

    // Class definition.
    const classMatch = text.match(CLASS_RE);
    if (classMatch) {
      const cls: PyClass = {
        name: classMatch[1],
        qualified_name: classMatch[1],
        bases: classMatch[2] ? splitTopLevel(classMatch[2]).filter(Boolean) : [],
        line: logical.line,
        body: { start: logical.line + 1, end: logical.line },
        methods: [],
        assignments: [],
      };
      fileModel.classes.push(cls);
      const key = cls.name.toLowerCase();
      const locations = fileModel.name_defs.get(key) ?? [];
      locations.push({ name: cls.name, file_path: relativePath, line: logical.line });
      fileModel.name_defs.set(key, locations);
      scopes.push({ indent: logical.indent, kind: 'class', cls, openerLine: logical.line, lastBodyLine: logical.line });
      pendingDecorators = [];
      if (classMatch[3]) processLine({ text: classMatch[3], line: logical.line, indent: logical.indent + 1 });
      return;
    }

    // Function definition.
    const defMatch = text.match(DEF_RE);
    if (defMatch) {
      const parent = top();
      const isAsync = /^async\b/.test(text);
      const isMethod = parent.kind === 'class';
      const parentQName = qualifiedParent();
      const func: PyFunction = {
        name: defMatch[1],
        qualified_name: parentQName ? `${parentQName}.${defMatch[1]}` : defMatch[1],
        line: logical.line,
        kind: isAsync ? (isMethod ? 'async_method' : 'async_function') : (isMethod ? 'method' : 'function'),
        params: splitTopLevel(defMatch[2]).map(param => param.trim()).filter(Boolean),
        decorators: pendingDecorators,
        body: { start: logical.line + 1, end: logical.line },
        calls: [],
        assignments: [],
        attr_accesses: [],
        returns: [],
        raises: [],
      };
      pendingDecorators = [];
      if (isMethod) {
        parent.cls!.methods.push(func);
      } else {
        fileModel.functions.push(func);
      }
      const key = func.name.toLowerCase();
      const locations = fileModel.name_defs.get(key) ?? [];
      locations.push({ name: func.name, file_path: relativePath, line: logical.line });
      fileModel.name_defs.set(key, locations);
      scopes.push({ indent: logical.indent, kind: 'function', func, openerLine: logical.line, lastBodyLine: logical.line });
      if (defMatch[3]) processLine({ text: defMatch[3], line: logical.line, indent: logical.indent + 1 });
      return;
    }

    // Everything else is a statement inside the current scope.
    const scope = top();
    recordStatementTokens(scope, text, logical.line);

    const returnMatch = text.match(RETURN_RE);
    if (returnMatch && scope.kind === 'function') {
      const value = returnMatch[1]?.trim() ?? '';
      scope.func!.returns.push({
        line: logical.line,
        is_none: value === 'None',
        is_bare: value === '',
      });
      return;
    }

    const raiseMatch = text.match(RAISE_RE);
    if (raiseMatch && scope.kind === 'function') {
      scope.func!.raises.push(raiseMatch[1]);
      return;
    }

    const assignment = text.match(ASSIGNMENT_RE);
    if (assignment) {
      recordAssignment(scope, assignment[1], assignment[2], logical.line, fileModel);
    }
  };

  for (const logical of buildLogicalLines(content)) {
    processLine(logical);
  }
  while (scopes.length > 1) closeScope();

  return fileModel;
}

export function parsePythonFile(file: AnalysisSourceFile): PyFileModel {
  return parsePythonSource(file.relative_path, file.content);
}
