// ── Python Name Resolution ──
// Resolves a called name to its definition: function scope → same file →
// imports → cross-snapshot by simple name. Receiver-based calls ('self.x',
// 'cls.x') resolve through the enclosing class hierarchy.

import type {
  PyClass,
  PyFileModel,
  PyFunction,
  PyImport,
  PySnapshotModel,
} from '../code-model/types.js';
import { classNamed, functionNamed } from '../code-model/index.js';

export interface NameContext {
  file: PyFileModel;
  func?: PyFunction;
}

export interface PyResolution {
  kind: 'local' | 'method' | 'import' | 'global' | 'none';
  func?: PyFunction;
  cls?: PyClass;
  import?: PyImport;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

/**
 * Find the file whose relative path corresponds to a dotted module path
 * (e.g. 'services.user_service' → 'services/user_service.py').
 */
export function fileForModule(
  model: PySnapshotModel,
  module: string,
  importingFilePath = ''
): PyFileModel | undefined {
  const leadingDots = module.match(/^\.+/)?.[0].length ?? 0;
  const moduleName = module.slice(leadingDots).replace(/\./g, '/');
  const candidates: string[] = [];

  if (leadingDots > 0 && importingFilePath) {
    const packageParts = normalizePath(importingFilePath).split('/').slice(0, -1);
    const baseParts = packageParts.slice(0, Math.max(0, packageParts.length - (leadingDots - 1)));
    candidates.push([...baseParts, ...moduleName.split('/').filter(Boolean)].join('/'));
  }
  if (moduleName) candidates.push(moduleName);

  for (const candidate of candidates) {
    const normalizedCandidate = normalizePath(candidate);
    for (const file of model.files) {
      const normalized = normalizePath(file.file_path).replace(/\.py$/, '');
      if (normalized === normalizedCandidate || normalized.endsWith('/' + normalizedCandidate)) return file;
      if (normalized === normalizedCandidate + '/__init__' || normalized.endsWith('/' + normalizedCandidate + '/__init__')) return file;
    }
  }
  return undefined;
}

export interface PyNamedDefinition {
  kind: 'class' | 'function';
  qualified_name: string;
  line: number;
  file: PyFileModel;
  cls?: PyClass;
}

function definitionsInFile(file: PyFileModel, name: string): PyNamedDefinition[] {
  const key = name.toLowerCase();
  const definitions: PyNamedDefinition[] = [];
  for (const cls of file.classes) {
    if (cls.name.toLowerCase() !== key) continue;
    definitions.push({
      kind: 'class',
      qualified_name: cls.qualified_name,
      line: cls.line,
      file,
      cls,
    });
  }
  for (const func of file.functions) {
    if (func.name.toLowerCase() !== key) continue;
    definitions.push({
      kind: 'function',
      qualified_name: func.qualified_name,
      line: func.line,
      file,
    });
  }
  return definitions;
}

/** Scan every indexed Python file for a class or function with this name. */
export function namedDefinitions(model: PySnapshotModel, name: string): PyNamedDefinition[] {
  return model.files.flatMap(file => definitionsInFile(file, name));
}

/**
 * Resolve a class/function reference through local definitions and imports.
 * `expectedName` is the runtime type from the exception and lets aliases such
 * as `Constants as AppConstants` resolve back to the original definition.
 */
export function resolveNamedDefinition(
  model: PySnapshotModel,
  contextFile: PyFileModel,
  referenceName: string,
  expectedName: string
): PyNamedDefinition | null {
  const parts = referenceName.split('.').filter(Boolean);
  if (parts.length === 0) return null;
  const boundName = parts[0].toLowerCase();
  const expectedKey = expectedName.toLowerCase();

  if (parts.length === 1 && referenceName.toLowerCase() === expectedKey) {
    const local = definitionsInFile(contextFile, referenceName)[0];
    if (local) return local;
  }

  const binding = contextFile.imports.find(item => item.name.toLowerCase() === boundName);
  if (binding) {
    const targetName = binding.is_from
      ? (parts.length > 1 ? parts[parts.length - 1] : binding.imported_name)
      : (parts.length > 1 ? parts[parts.length - 1] : expectedName);
    const moduleCandidates = [binding.module];
    if (binding.is_from) {
      moduleCandidates.push(`${binding.module}${binding.module.endsWith('.') ? '' : '.'}${binding.imported_name}`);
    }

    for (const moduleName of moduleCandidates) {
      const targetFile = fileForModule(model, moduleName, contextFile.file_path);
      if (!targetFile) continue;
      const target = targetName.toLowerCase() === expectedKey
        ? definitionsInFile(targetFile, targetName)[0]
        : definitionsInFile(targetFile, expectedName)[0];
      if (target) return target;
    }
  }

  if (parts.length > 1) {
    const moduleName = parts.slice(0, -1).join('.');
    const targetFile = fileForModule(model, moduleName, contextFile.file_path);
    const targetName = parts[parts.length - 1];
    const target = targetFile && targetName.toLowerCase() === expectedKey
      ? definitionsInFile(targetFile, targetName)[0]
      : undefined;
    if (target) return target;
  }

  return null;
}

export function enclosingClass(model: PySnapshotModel, func?: PyFunction): PyClass | undefined {
  if (!func) return undefined;
  const parts = func.qualified_name.split('.');
  if (parts.length < 2) return undefined;
  const candidates = classNamed(model, parts[parts.length - 2]);
  for (const cls of candidates) {
    if (cls.methods.some(method => method === func)) return cls;
  }
  return undefined;
}

/**
 * Resolve a name referenced at a call site to its definition.
 * `receiver` is the dotted receiver chain for method-style calls
 * ('self.get_user' → receiver 'self', name 'get_user').
 */
export function resolveName(
  name: string,
  receiver: string | undefined,
  context: NameContext,
  model: PySnapshotModel
): PyResolution {
  const simple = name.split('.').pop() ?? name;
  const key = simple.toLowerCase();

  // Receiver 'self'/'cls' → method on the enclosing class (with MRO walk).
  if (receiver === 'self' || receiver === 'cls') {
    const cls = enclosingClass(model, context.func);
    if (cls) {
      const resolution = resolveMethodOnClass(cls, simple, model);
      if (resolution) return { kind: 'method', ...resolution };
    }
    return { kind: 'none' };
  }

  // Same-file functions (module-level and nested) take precedence.
  const local = context.file.functions.find(func => func.name.toLowerCase() === key);
  if (local) return { kind: 'local', func: local };

  // Same-file classes map to their __init__.
  const localClass = context.file.classes.find(cls => cls.name.toLowerCase() === key);
  if (localClass) {
    const init = localClass.methods.find(method => method.name === '__init__');
    if (init) return { kind: 'local', func: init, cls: localClass };
    return { kind: 'local', cls: localClass };
  }

  // Import bindings in this file: from X import name / import X as name.
  const binding = context.file.imports.find(item => item.name.toLowerCase() === key);
  if (binding) {
    const moduleFile = fileForModule(model, binding.module, context.file.file_path);
    if (moduleFile) {
      const importedKey = (binding.imported_name || binding.name).toLowerCase();
      const importedFunc = moduleFile.functions.find(func => func.name.toLowerCase() === importedKey);
      if (importedFunc) return { kind: 'import', func: importedFunc, import: binding };
      const importedClass = moduleFile.classes.find(cls => cls.name.toLowerCase() === importedKey);
      if (importedClass) {
        const init = importedClass.methods.find(method => method.name === '__init__');
        if (init) return { kind: 'import', func: init, cls: importedClass, import: binding };
        return { kind: 'import', cls: importedClass, import: binding };
      }
    }
    return { kind: 'none', import: binding }; // external module not in snapshot
  }

  // Cross-snapshot fallback by simple name (prefer the same directory family).
  const contextDir = normalizePath(context.file.file_path).split('/').slice(0, -1).join('/');
  let best: PyFunction | undefined;
  let bestDir = '';
  for (const func of functionNamed(model, simple)) {
    if (func === context.func) continue;
    const dir = normalizePath(fileOfFunction(func, model)?.file_path ?? '').split('/').slice(0, -1).join('/');
    if (!best || (dir === contextDir && bestDir !== contextDir)) { best = func; bestDir = dir; }
  }
  if (best) return { kind: 'global', func: best };

  return { kind: 'none' };
}

export function fileOfFunction(func: PyFunction, model: PySnapshotModel): PyFileModel | undefined {
  for (const file of model.files) {
    if (file.functions.includes(func) || file.classes.some(cls => cls.methods.includes(func))) return file;
  }
  return undefined;
}

export function fileOfClass(cls: PyClass, model: PySnapshotModel): PyFileModel | undefined {
  for (const file of model.files) {
    if (file.classes.includes(cls)) return file;
  }
  return undefined;
}

function resolveMethodOnClass(
  cls: PyClass,
  methodName: string,
  model: PySnapshotModel,
  seen: Set<string> = new Set()
): { func: PyFunction; cls: PyClass } | undefined {
  if (seen.has(cls.qualified_name)) return undefined;
  seen.add(cls.qualified_name);

  const method = cls.methods.find(m => m.name.toLowerCase() === methodName.toLowerCase());
  if (method) return { func: method, cls };

  const edge = model.class_edges.get(cls.qualified_name);
  for (const base of edge?.bases ?? []) {
    for (const baseClass of classNamed(model, base)) {
      const found = resolveMethodOnClass(baseClass, methodName, model, seen);
      if (found) return found;
    }
  }
  return undefined;
}
