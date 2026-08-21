// ── Python Root-Cause Evidence Collectors ──
// Exception-type-driven evidence gathering. Each collector produces
// Evidence items pointing at code that plausibly CAUSED the crash — which
// is often not the crashing line itself.

import { pathsMatch } from '../../../../source.js';
import { tokenizeLine } from '../code-model/tokenizer.js';
import type { PyClass, PyFileModel, PyFunction, PySnapshotModel } from '../code-model/types.js';
import type { RootCauseKind, StackFrame } from '../../../types.js';
import { buildCallGraph, findCyclesContaining } from '../dependencies/call-graph.js';
import { attributeDefinitionSites, resolveAttributeReceiverClass } from '../dependencies/class-graph.js';
import {
  enclosingClass,
  fileOfClass,
  fileOfFunction,
  namedDefinitions,
  resolveName,
  resolveNamedDefinition,
  type PyNamedDefinition,
} from '../dependencies/imports.js';
import { noneReturningCallees, type NoneReturningCallee } from '../dependencies/dataflow.js';

export interface Evidence {
  kind: RootCauseKind;
  file_path: string;
  line_number: number | null;
  function_name: string;
  reason: string;
  weight: number; // 1 (hint) .. 3 (strong causal link)
  is_conclusive?: boolean;
  definition_kind?: 'class' | 'function';
  definition_module?: string;
}

export interface CrashContext {
  model: PySnapshotModel;
  crashFile: PyFileModel;
  crashFunc: PyFunction | null;
  crashLine: number;
  exception: { type: string; message: string };
  frames: StackFrame[];
}

export function crashLineText(ctx: CrashContext): string {
  return (ctx.crashFile.lines[ctx.crashLine - 1] ?? '').trim();
}

/**
 * Find the function containing the crash line: frame function name first
 * (tracebacks are reliable), then body-range containment (innermost wins).
 */
export function findCrashFunc(file: PyFileModel, frame: StackFrame): { func: PyFunction | null; cls: PyClass | null } {
  const line = frame.line_number ?? 0;
  const all = [...file.functions, ...file.classes.flatMap(cls => cls.methods)];
  const name = frame.function_name?.toLowerCase();

  if (name && name !== '<module>') {
    const byName = all.filter(func => func.name.toLowerCase() === name);
    const inRange = byName.filter(func => func.body.start <= line && line <= func.body.end);
    const chosen = inRange[0] ?? byName[0];
    if (chosen) return { func: chosen, cls: classOf(file, chosen) };
  }

  const inRange = all.filter(func => func.body.start <= line && line <= func.body.end);
  if (inRange.length === 0) return { func: null, cls: null };
  inRange.sort((a, b) => (a.body.end - a.body.start) - (b.body.end - b.body.start));
  const innermost = inRange[0];
  return { func: innermost, cls: classOf(file, innermost) };
}

function classOf(file: PyFileModel, func: PyFunction): PyClass | null {
  return file.classes.find(cls => cls.methods.includes(func)) ?? null;
}

/**
 * Extract the receiver variable involved in the crash line, based on the
 * exception message shape.
 */
export function extractReceiver(ctx: CrashContext): string | null {
  const text = crashLineText(ctx);
  const message = ctx.exception.message;

  const attrMatch = message.match(/has no attribute '([^']+)'/);
  if (attrMatch) {
    const attr = attrMatch[1];
    const tokens = tokenizeLine(text);
    const hit = tokens.attrs.find(access => access.attr === attr);
    if (hit) return hit.receiver;
    return null;
  }
  if (message.includes('not callable')) {
    const tokens = tokenizeLine(text);
    const call = tokens.receiverCalls[0];
    return call?.receiver ?? null;
  }
  if (message.includes('not subscriptable') || message.includes('unsupported operand')) {
    const match = text.match(/([A-Za-z_]\w*)\s*\[/);
    return match?.[1] ?? null;
  }
  return null;
}

/** Variable subscripted on the crash line — used for KeyError/IndexError. */
export function subscriptVariable(ctx: CrashContext): string | null {
  const match = crashLineText(ctx).match(/([A-Za-z_]\w*)\s*\[/);
  return match?.[1] ?? null;
}

/** Name from "name 'x' is not defined". */
export function undefinedName(message: string): string | null {
  return message.match(/name '([^']+)' is not defined/)?.[1] ?? null;
}

/** Module from "No module named 'x'". */
export function missingModule(message: string): string | null {
  return message.match(/No module named '([^']+)/)?.[1] ?? null;
}

// ── Collectors ──

const NONE_RETURN_TEXT: Record<NoneReturningCallee['reason'], string> = {
  'explicit-none': 'has an explicit `return None`',
  'bare-return': 'has a bare `return` (implicitly returns None)',
  'no-return': 'falls off the end without a return statement (implicitly returns None)',
  'dict-get': 'is a dict.get() call without a default, which returns None for missing keys',
};

export function collectNoneReturn(ctx: CrashContext, receiver: string): Evidence[] {
  if (!ctx.crashFunc) return [];
  const items = noneReturningCallees(ctx.model, ctx.crashFunc, receiver);
  const evidence: Evidence[] = [];

  for (const item of items) {
    if (item.callee) {
      const returnLine = item.callee.returns.find(ret => ret.is_none || ret.is_bare)?.line ?? item.callee.body.end;
      const file = fileOfFunction(item.callee, ctx.model);
      if (!file) continue;
      evidence.push({
        kind: 'none-return',
        file_path: file.file_path,
        line_number: returnLine,
        function_name: item.callee.qualified_name,
        weight: 3,
        reason:
          `'${receiver}' is assigned the result of ${item.callee.qualified_name} at ` +
          `${ctx.crashFile.file_path}:${item.assignment.line}, and that function ` +
          `${NONE_RETURN_TEXT[item.reason]} — so '${receiver}' can be None when it is ` +
          `dereferenced at the crash line ${ctx.crashLine}.`,
      });
    } else {
      evidence.push({
        kind: 'none-return',
        file_path: ctx.crashFile.file_path,
        line_number: item.assignment.line,
        function_name: ctx.crashFunc.qualified_name,
        weight: 2,
        reason:
          `'${receiver}' comes from ${item.call}, which ${NONE_RETURN_TEXT[item.reason]} — ` +
          `it is dereferenced at the crash line ${ctx.crashLine}.`,
      });
    }
  }
  return evidence;
}

function moduleNameForFile(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/\.py$/i, '')
    .replace(/\/__init__$/i, '')
    .replace(/^\.\//, '')
    .replace(/\//g, '.');
}

function constructorDefinitions(
  ctx: CrashContext,
  receiver: string,
  expectedName: string
): PyNamedDefinition[] {
  const definitions: PyNamedDefinition[] = [];
  const seen = new Set<string>();
  const addFromAssignments = (file: PyFileModel, assignments: PyFunction['assignments']): void => {
    for (const assignment of assignments) {
      for (const call of assignment.rhs_calls) {
        const definition = resolveNamedDefinition(ctx.model, file, call, expectedName);
        if (!definition) continue;
        const key = `${definition.kind}|${definition.file.file_path}|${definition.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        definitions.push(definition);
      }
    }
  };

  if (receiver.startsWith('self.') || receiver.startsWith('cls.')) {
    const receiverAttribute = receiver.split('.')[1];
    const owner = enclosingClass(ctx.model, ctx.crashFunc ?? undefined);
    if (receiverAttribute && owner) {
      for (const site of attributeDefinitionSites(owner, receiverAttribute, ctx.model)) {
        const file = fileOfClass(site.cls, ctx.model);
        if (file) addFromAssignments(file, [site.assignment]);
      }
    }
  } else if (receiver && ctx.crashFunc) {
    const rootReceiver = receiver.split('.')[0].toLowerCase();
    addFromAssignments(
      ctx.crashFile,
      ctx.crashFunc.assignments.filter(assignment => assignment.name.toLowerCase() === rootReceiver)
    );
  }

  return definitions;
}

function exceptionNamedDefinition(
  ctx: CrashContext,
  receiver: string,
  expectedName: string
): PyNamedDefinition | null {
  const fromAssignment = constructorDefinitions(ctx, receiver, expectedName);
  if (fromAssignment.length > 0) return fromAssignment[0];

  const definitions = namedDefinitions(ctx.model, expectedName);

  // Walk every stack file and its imports before falling back to a global
  // name scan. This disambiguates projects that define several Constants.
  for (const frame of ctx.frames) {
    const file = ctx.model.files.find(candidate =>
      frame.file_path && pathsMatch(frame.file_path, candidate.file_path)
    );
    if (!file) continue;

    const local = definitions.find(item => item.file === file);
    if (local) return local;

    for (const binding of file.imports) {
      const namesRuntimeType = binding.name.toLowerCase() === expectedName.toLowerCase()
        || binding.imported_name.toLowerCase() === expectedName.toLowerCase();
      const references = namesRuntimeType
        ? [binding.name, `${binding.name}.${expectedName}`]
        : [`${binding.name}.${expectedName}`];
      for (const reference of references) {
        const definition = resolveNamedDefinition(ctx.model, file, reference, expectedName);
        if (definition) return definition;
      }
    }
  }

  return definitions.length === 1 ? definitions[0] : null;
}

export function collectMissingAttribute(ctx: CrashContext, receiver: string, attr: string): Evidence[] {
  // Direct answer: resolve the runtime type named by the exception message
  // (through the stack/import chain when it lives in another file), then
  // point at its definition if the attribute is absent. Nothing else.
  const runtimeType = ctx.exception.message.match(
    /^'([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)' object has no attribute/
  )?.[1]?.split('.').pop();

  if (runtimeType) {
    const definition = exceptionNamedDefinition(ctx, receiver, runtimeType);
    if (definition) {
      if (definition.cls && attributeDefinitionSites(definition.cls, attr, ctx.model).length > 0) {
        return [];
      }

      const bases = definition.cls
        ? ctx.model.class_edges.get(definition.cls.qualified_name)?.bases ?? []
        : [];
      return [{
        kind: 'missing-attribute',
        file_path: definition.file.file_path,
        line_number: definition.line,
        function_name: definition.qualified_name,
        weight: 3,
        is_conclusive: true,
        definition_kind: definition.kind,
        definition_module: moduleNameForFile(definition.file.file_path),
        reason:
          `'${runtimeType}' from ${definition.file.file_path}:${definition.line} never defines '${attr}'` +
          `${bases.length > 0 ? ` (or its bases: ${bases.join(', ')})` : ''} — ` +
          `the access at ${ctx.crashFile.file_path}:${ctx.crashLine} crashes.`,
      }];
    }
  }

  // Fallback when the runtime type is absent from the snapshot: resolve the
  // crash-line receiver's class.
  const cls = resolveAttributeReceiverClass(ctx, receiver);
  if (!cls) return [];
  if (attributeDefinitionSites(cls, attr, ctx.model).length > 0) return [];

  const file = fileOfClass(cls, ctx.model);
  if (!file) return [];
  const bases = ctx.model.class_edges.get(cls.qualified_name)?.bases ?? [];
  return [{
    kind: 'missing-attribute',
    file_path: file.file_path,
    line_number: cls.line,
    function_name: cls.qualified_name,
    weight: 3,
    is_conclusive: true,
    definition_kind: 'class',
    definition_module: moduleNameForFile(file.file_path),
    reason:
      `'${attr}' is never assigned on ${cls.qualified_name}` +
      `${bases.length > 0 ? ` or its bases (${bases.join(', ')})` : ''} — ` +
      `the access at ${ctx.crashFile.file_path}:${ctx.crashLine} crashes.`,
  }];
}

export function collectMissingKey(ctx: CrashContext, variable: string): Evidence[] {
  const evidence: Evidence[] = [];
  const keyMatch = ctx.exception.message.match(/'([^']+)'/);
  const key = keyMatch?.[1] ?? 'the key';
  const sites = ctx.crashFunc
    ? ctx.crashFunc.assignments.filter(assignment => assignment.name.toLowerCase() === variable.toLowerCase())
    : [];
  const moduleSites = ctx.crashFile.module_assignments.filter(assignment => assignment.name.toLowerCase() === variable.toLowerCase());
  for (const assignment of [...sites, ...moduleSites]) {
    if (assignment.rhs_kind !== 'dict' && assignment.rhs_kind !== 'call') continue;
    evidence.push({
      kind: 'missing-key',
      file_path: ctx.crashFile.file_path,
      line_number: assignment.line,
      function_name: ctx.crashFunc?.qualified_name ?? '<module>',
      weight: 2,
      reason:
        `'${variable}' is built at line ${assignment.line} and does not contain '${key}'; ` +
        `the subscript at the crash line ${ctx.crashLine} fails because the key is missing.`,
    });
  }
  return evidence;
}

export function collectOutOfRange(ctx: CrashContext, variable: string): Evidence[] {
  const evidence: Evidence[] = [];
  const sites = ctx.crashFunc
    ? ctx.crashFunc.assignments.filter(assignment => assignment.name.toLowerCase() === variable.toLowerCase())
    : [];
  const moduleSites = ctx.crashFile.module_assignments.filter(assignment => assignment.name.toLowerCase() === variable.toLowerCase());
  for (const assignment of [...sites, ...moduleSites]) {
    if (assignment.rhs_kind !== 'list' && assignment.rhs_kind !== 'call') continue;
    evidence.push({
      kind: 'out-of-range',
      file_path: ctx.crashFile.file_path,
      line_number: assignment.line,
      function_name: ctx.crashFunc?.qualified_name ?? '<module>',
      weight: 2,
      reason:
        `'${variable}' is built at line ${assignment.line}; the index used at the crash ` +
        `line ${ctx.crashLine} can fall outside its bounds.`,
    });
  }
  return evidence;
}

/** Levenshtein distance for typo suggestions (small strings only). */
function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

export function collectUndefinedName(ctx: CrashContext, name: string): Evidence[] {
  const key = name.toLowerCase();
  if (ctx.crashFile.name_defs.has(key)) return [];

  // Defined in the same snapshot but not imported here?
  for (const [definedKey, defs] of ctx.crashFile.name_defs) {
    if (editDistance(key, definedKey) <= 2 && defs.length > 0) {
      const site = defs[0];
      return [{
        kind: 'undefined-name',
        file_path: site.file_path,
        line_number: site.line,
        function_name: site.name,
        weight: 2,
        reason:
          `'${name}' is not defined in this scope — did you mean '${site.name}' ` +
          `(defined at ${site.file_path}:${site.line})?`,
      }];
    }
  }

  const elsewhere = ctx.model.functions_by_name.get(key) ?? ctx.model.imports_by_name.get(key);
  if (elsewhere && elsewhere.length > 0) {
    const file = fileOfFunction((elsewhere[0] as PyFunction), ctx.model);
    const site = file
      ? { file_path: file.file_path, line: (elsewhere[0] as PyFunction).body.start }
      : null;
    return [{
      kind: 'undefined-name',
      file_path: ctx.crashFile.file_path,
      line_number: ctx.crashLine,
      function_name: ctx.crashFunc?.qualified_name ?? '<module>',
      weight: 2,
      reason:
        `'${name}' is defined in ${site?.file_path ?? 'another module'} but is not ` +
        `imported or in scope at the crash line ${ctx.crashLine}.`,
    }];
  }

  return [];
}

export function collectImportFailure(ctx: CrashContext, moduleName: string | null): Evidence[] {
  const normalized = moduleName?.toLowerCase();
  const candidates = ctx.crashFile.imports.filter(item => {
    if (!normalized) return true;
    const moduleKey = item.module.toLowerCase();
    return moduleKey === normalized || moduleKey.endsWith('.' + normalized) || normalized.endsWith('.' + moduleKey);
  });
  if (candidates.length === 0) return [];
  const item = candidates[0];
  return [{
    kind: 'import-failure',
    file_path: item.file_path,
    line_number: item.line,
    function_name: '<module>',
    weight: 2,
    is_conclusive: true,
    reason:
      `The import '${item.module}' at ${item.file_path}:${item.line} cannot be resolved — ` +
      `the module is missing from the project or the environment.`,
  }];
}

export function collectRecursion(ctx: CrashContext): Evidence[] {
  if (!ctx.crashFunc) return [];
  const edges = buildCallGraph(ctx.model);
  const cycles = findCyclesContaining(edges, ctx.crashFunc);
  if (cycles.length === 0) return [];
  return [{
    kind: 'recursion',
    file_path: ctx.crashFile.file_path,
    line_number: ctx.crashLine,
    function_name: ctx.crashFunc.qualified_name,
    weight: 3,
    reason:
      `Recursion detected: ${cycles[0].join(' → ')}. The function calls itself ` +
      `without a working base case, so the recursion never terminates.`,
  }];
}

export function collectGeneric(ctx: CrashContext): Evidence[] {
  // Outermost user frame mirrors the engine's existing 'source' heuristic.
  const outermost = [...ctx.frames].reverse().find(frame =>
    frame.severity === 'source' || (frame.file_path && frame.language === 'python' && frame !== ctx.frames[0])
  ) ?? ctx.frames[ctx.frames.length - 1] ?? ctx.frames[0];
  return [{
    kind: 'generic',
    file_path: outermost.file_path || ctx.crashFile.file_path,
    line_number: outermost.line_number,
    function_name: outermost.function_name || ctx.crashFunc?.qualified_name || '<module>',
    weight: 1,
    reason:
      `The error propagated from this function (the outermost user frame). ` +
      `Review the data it passes toward the crash site at ` +
      `${ctx.crashFile.file_path}:${ctx.crashLine}.`,
  }];
}

// ── Dispatch ──

export function collectEvidence(ctx: CrashContext): Evidence[] {
  const type = ctx.exception.type.toLowerCase();
  const message = ctx.exception.message;

  if (type.includes('recursionerror')) {
    const evidence = collectRecursion(ctx);
    return evidence.length > 0 ? evidence : collectGeneric(ctx);
  }

  if (type.includes('attributeerror')) {
    // Concise by design: locate the missing attribute's definition site, or
    // the None-returning callee when the type is unresolvable. No other
    // analysis — the crash chain is shown separately.
    const attr = message.match(/has no attribute '([^']+)'/)?.[1];
    const receiver = extractReceiver(ctx) ?? '';
    if (attr) {
      const missingAttribute = collectMissingAttribute(ctx, receiver, attr);
      if (missingAttribute.length > 0) return missingAttribute;
      return receiver ? collectNoneReturn(ctx, receiver) : [];
    }
    return receiver ? collectNoneReturn(ctx, receiver) : [];
  }

  if (type.includes('typeerror')) {
    const receiver = extractReceiver(ctx);
    const evidence = receiver ? collectNoneReturn(ctx, receiver) : [];
    return evidence.length > 0 ? evidence : collectGeneric(ctx);
  }

  if (type.includes('keyerror')) {
    const variable = subscriptVariable(ctx);
    const evidence = variable ? collectMissingKey(ctx, variable) : [];
    return evidence.length > 0 ? evidence : collectGeneric(ctx);
  }

  if (type.includes('indexerror')) {
    const variable = subscriptVariable(ctx);
    const evidence = variable ? collectOutOfRange(ctx, variable) : [];
    return evidence.length > 0 ? evidence : collectGeneric(ctx);
  }

  if (type.includes('importerror') || type.includes('modulenotfounderror')) {
    const evidence = collectImportFailure(ctx, missingModule(message));
    return evidence.length > 0 ? evidence : collectGeneric(ctx);
  }

  if (type.includes('nameerror')) {
    const name = undefinedName(message);
    const evidence = name ? collectUndefinedName(ctx, name) : [];
    return evidence.length > 0 ? evidence : collectGeneric(ctx);
  }

  return collectGeneric(ctx);
}
