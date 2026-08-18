// ── Python Class Graph ──
// Class hierarchy queries: subclass discovery, method resolution (MRO-lite)
// and attribute-definition location for 'self.x' assignments.

import type { PyClass, PySnapshotModel } from '../code-model/types.js';
import { classNamed } from '../code-model/index.js';

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

/**
 * Locate where an attribute ('self.x') is assigned, searching the class
 * hierarchy for __init__/methods that assign it.
 */
export function attributeDefinitionSites(
  cls: PyClass,
  attr: string,
  model: PySnapshotModel
): Array<{ cls: PyClass; method_name: string; line: number }> {
  const sites: Array<{ cls: PyClass; method_name: string; line: number }> = [];
  const seen = new Set<string>();

  const walk = (current: PyClass): void => {
    if (seen.has(current.qualified_name)) return;
    seen.add(current.qualified_name);
    for (const method of current.methods) {
      for (const assignment of method.assignments) {
        if (assignment.name.toLowerCase() === `self.${attr}`.toLowerCase()) {
          sites.push({ cls: current, method_name: method.name, line: assignment.line });
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
