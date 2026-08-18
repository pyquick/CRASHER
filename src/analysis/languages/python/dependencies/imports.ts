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
function fileForModule(model: PySnapshotModel, module: string): PyFileModel | undefined {
  const modulePath = normalizePath(module).replace(/\./g, '/');
  for (const file of model.files) {
    const normalized = normalizePath(file.file_path).replace(/\.py$/, '');
    if (normalized === modulePath || normalized.endsWith('/' + modulePath)) return file;
  }
  return undefined;
}

function enclosingClass(model: PySnapshotModel, func?: PyFunction): PyClass | undefined {
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
    const moduleFile = fileForModule(model, binding.module);
    if (moduleFile) {
      const importedFunc = moduleFile.functions.find(func => func.name.toLowerCase() === key);
      if (importedFunc) return { kind: 'import', func: importedFunc, import: binding };
      const importedClass = moduleFile.classes.find(cls => cls.name.toLowerCase() === key);
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
