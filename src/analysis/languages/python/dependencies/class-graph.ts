// ── Python Class Graph ──
// Class hierarchy queries: subclass discovery, method resolution (MRO-lite)
// and attribute-definition location for 'self.x' assignments.

import type { PyAssignment, PyClass, PySnapshotModel } from '../code-model/types.js';
import { classNamed } from '../code-model/index.js';
import type { CrashContext } from '../root-cause/evidence.js';
import { enclosingClass, fileOfClass } from './imports.js';

/**
 * All transitive subclasses of a class (qualified names).
 */
export function transitiveSubclasses(cls: PyClass, model: PySnapshotModel): string[] {
  const result: string[] = [];
  const seen = new Set<string>([cls.qualified_name]);

  const walk = (qualifiedName: string): void => {
    const edge = model.class_edges.get(qualifiedName);
    for (const sub of edge?.subclasses ?? []) {
      if (seen.has(sub)) continue;
      seen.add(sub);
      result.push(sub);
      walk(sub);
    }
  };

  walk(cls.qualified_name);
  return result;
}

/**
 * Find the method with the given name on a class, walking base classes
 * (MRO-lite, depth-first). Returns the defining class and method.
 */
export function methodResolution(
  cls: PyClass,
  methodName: string,
  model: PySnapshotModel,
  seen: Set<string> = new Set()
): { cls: PyClass; method: typeof cls.methods[number] } | undefined {
  if (seen.has(cls.qualified_name)) return undefined;
  seen.add(cls.qualified_name);

  const method = cls.methods.find(m => m.name.toLowerCase() === methodName.toLowerCase());
  if (method) return { cls, method };

  const edge = model.class_edges.get(cls.qualified_name);
  for (const base of edge?.bases ?? []) {
    for (const baseClass of classNamed(model, base)) {
      const found = methodResolution(baseClass, methodName, model, seen);
      if (found) return found;
    }
  }
  return undefined;
}

export interface AttributeDefinitionSite {
  cls: PyClass;
  /** Method that assigns `self.<attr>`; null for class-body assignments. */
  method_name: string | null;
  line: number;
  assignment: PyAssignment;
}

/**
 * Locate where an attribute is defined, searching the class hierarchy:
 * `self.<attr>` assignments in methods and class-body assignments.
 */
export function attributeDefinitionSites(
  cls: PyClass,
  attr: string,
  model: PySnapshotModel
): AttributeDefinitionSite[] {
  const sites: AttributeDefinitionSite[] = [];
  const seen = new Set<string>();
  const attrKey = attr.toLowerCase();

  const walk = (current: PyClass): void => {
    if (seen.has(current.qualified_name)) return;
    seen.add(current.qualified_name);
    for (const assignment of current.assignments) {
      if (assignment.name.toLowerCase() === attrKey) {
        sites.push({ cls: current, method_name: null, line: assignment.line, assignment });
      }
    }
    for (const method of current.methods) {
      for (const assignment of method.assignments) {
        if (assignment.name.toLowerCase() === `self.${attrKey}`) {
          sites.push({ cls: current, method_name: method.name, line: assignment.line, assignment });
        }
      }
    }
    const edge = model.class_edges.get(current.qualified_name);
    for (const base of edge?.bases ?? []) {
      for (const baseClass of classNamed(model, base)) walk(baseClass);
    }
  };

  walk(cls);
  return sites;
}

/** Prefer the class living in the same directory family as the crash file. */
function preferSameDirectoryFamily(candidates: PyClass[], model: PySnapshotModel, crashFilePath: string): PyClass | null {
  if (candidates.length <= 1) return candidates[0] ?? null;
  const dir = crashFilePath.replace(/\\/g, '/').toLowerCase().split('/').slice(0, -1).join('/');
  for (const cls of candidates) {
    const file = fileOfClass(cls, model);
    if (!file) continue;
    const clsDir = file.file_path.replace(/\\/g, '/').toLowerCase().split('/').slice(0, -1).join('/');
    if (clsDir === dir || dir.startsWith(clsDir + '/') || clsDir.startsWith(dir + '/')) return cls;
  }
  return candidates[0];
}

function classFromConstructorCalls(assignments: PyAssignment[], model: PySnapshotModel): PyClass | null {
  for (const assignment of assignments) {
    for (const call of assignment.rhs_calls) {
      const simple = call.split('.').pop()!;
      const candidates = classNamed(model, simple);
      if (candidates.length > 0) return candidates[0];
    }
  }
  return null;
}

/**
 * Resolve which class the receiver of a failed attribute access belongs to.
 * Fallback order, most reliable first:
 *  1. class name quoted in the exception message ("'Constants' object has
 *     no attribute ...") — the final class of the object;
 *  2. 'self'/'cls' → the crash function's enclosing class;
 *  3. 'self.<attr>' chains → the enclosing class's assignment of that
 *     attribute (constructor call in its RHS);
 *  4. plain variable → its assignment sites (function-local, then
 *     module-level) or import bindings;
 *  5. the receiver itself naming a class (static attribute access).
 */
export function resolveAttributeReceiverClass(ctx: CrashContext, receiver: string): PyClass | null {
  const { model, crashFile, crashFunc } = ctx;

  // 1. Class name from the exception message — the strongest signal.
  const messageMatch = ctx.exception.message.match(
    /^'([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)' object has no attribute/
  );
  if (messageMatch) {
    const simple = messageMatch[1].split('.').pop()!;
    const cls = preferSameDirectoryFamily(classNamed(model, simple), model, crashFile.file_path);
    if (cls) return cls;
  }

  // 2. self/cls → enclosing class of the crash function.
  if (receiver === 'self' || receiver === 'cls') {
    return enclosingClass(model, crashFunc ?? undefined) ?? null;
  }

  // 3. self.<attr> chain → resolve the attribute's assignment in the class.
  if (receiver.startsWith('self.') || receiver.startsWith('cls.')) {
    const attr = receiver.split('.').slice(1).join('.');
    const enclosing = enclosingClass(model, crashFunc ?? undefined);
    if (enclosing) {
      for (const site of attributeDefinitionSites(enclosing, attr, model)) {
        const cls = classFromConstructorCalls([site.assignment], model);
        if (cls) return cls;
      }
    }
  }

  // 4. Plain variable → assignment sites (function-local, then module-level)
  //    and import bindings.
  const nameKey = receiver.toLowerCase();
  const assignments = [...(crashFunc?.assignments ?? []), ...crashFile.module_assignments];
  const cls = classFromConstructorCalls(
    assignments.filter(assignment => assignment.name.toLowerCase() === nameKey),
    model
  );
  if (cls) return cls;
  const binding = crashFile.imports.find(item => item.name.toLowerCase() === nameKey);
  if (binding) {
    const imported = classNamed(model, binding.name);
    if (imported.length > 0) return imported[0];
  }

  // 5. The receiver itself is a class name (static access). Case-sensitive:
  //    a lowercase variable 'user' must never resolve to class 'User'.
  const byExactName = classNamed(model, receiver).filter(cls => cls.name === receiver);
  return preferSameDirectoryFamily(byExactName, model, crashFile.file_path);
}
