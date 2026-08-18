// ── Python Dataflow Queries ──
// Variable-level flows inside a function: assignment sites, read sites and
// callees that may return None (the heart of 'the crashing line is not the
// culprit' reasoning).

import type {
  PyAssignment,
  PyFunction,
  PySnapshotModel,
} from '../code-model/types.js';
import { resolveName, type NameContext, fileOfFunction } from './imports.js';

export function findAssignmentSites(func: PyFunction, varName: string): PyAssignment[] {
  return func.assignments.filter(assignment => assignment.name.toLowerCase() === varName.toLowerCase());
}

export interface VariableRead {
  line: number;
  kind: 'attr' | 'call' | 'identifier';
  name: string;
}

/**
 * Find where a variable is read inside its function: attribute accesses
 * (v.x), receiver calls (v.method()) and plain identifier uses.
 */
export function findReadsOf(func: PyFunction, varName: string): VariableRead[] {
  const reads: VariableRead[] = [];
  for (const attr of func.attr_accesses) {
    if (attr.receiver.toLowerCase() === varName.toLowerCase()) {
      reads.push({ line: attr.line, kind: 'attr', name: attr.attr });
    }
  }
  for (const call of func.calls) {
    if (call.receiver && call.receiver.toLowerCase() === varName.toLowerCase()) {
      reads.push({ line: call.line, kind: 'call', name: call.name });
    }
  }
  return reads;
}

/**
 * Whether a function can return None: explicit 'return None', a bare
 * 'return', or falling off the end (no return statements at all).
 */
export function canReturnNone(func: PyFunction): boolean {
  if (func.returns.length === 0) return true;
  return func.returns.some(ret => ret.is_none || ret.is_bare);
}

export interface NoneReturningCallee {
  assignment: PyAssignment;
  call: string;
  callee: PyFunction | null; // null when the callee is external/unresolved
  reason: 'explicit-none' | 'bare-return' | 'no-return' | 'dict-get';
}

/**
 * For each assignment of `varName` inside `func`, check whether any called
 * function on the right-hand side may produce None.
 */
export function noneReturningCallees(
  model: PySnapshotModel,
  func: PyFunction,
  varName: string
): NoneReturningCallee[] {
  const results: NoneReturningCallee[] = [];
  const file = fileOfFunction(func, model);
  if (!file) return results;
  const context: NameContext = { file, func };

  for (const assignment of findAssignmentSites(func, varName)) {
    for (const call of assignment.rhs_calls) {
      // dict.get(...) without a default returns None.
      if (call.toLowerCase().endsWith('.get')) {
        results.push({ assignment, call, callee: null, reason: 'dict-get' });
        continue;
      }
      const resolution = resolveName(call, call.includes('.') ? call.split('.')[0] : undefined, context, model);
      const callee = resolution.func ?? null;
      if (!callee || callee.name === '__init__') continue; // constructors return the object
      if (callee.returns.some(ret => ret.is_none)) {
        results.push({ assignment, call, callee, reason: 'explicit-none' });
      } else if (callee.returns.some(ret => ret.is_bare)) {
        results.push({ assignment, call, callee, reason: 'bare-return' });
      } else if (callee.returns.length === 0) {
        results.push({ assignment, call, callee, reason: 'no-return' });
      }
    }
  }

  return results;
}
