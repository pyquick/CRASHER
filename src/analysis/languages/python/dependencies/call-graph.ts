// ── Python Call Graph ──
// Builds a function-level call graph from the snapshot model and provides
// caller/callee queries, dependency chain search (BFS) and cycle detection.

import type { PyFunction, PySnapshotModel } from '../code-model/types.js';
import { fileOfFunction, resolveName, type NameContext } from './imports.js';

export interface CallEdge {
  caller: PyFunction;
  callee: PyFunction;
  line: number;
  kind: 'local' | 'method' | 'import' | 'global';
}

export function buildCallGraph(model: PySnapshotModel): CallEdge[] {
  const edges: CallEdge[] = [];
  const seen = new Set<string>();

  const addEdge = (caller: PyFunction, callee: PyFunction, line: number, kind: CallEdge['kind']): void => {
    const key = `${caller.qualified_name}→${callee.qualified_name}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ caller, callee, line, kind });
  };

  const visitFunction = (func: PyFunction): void => {
    const file = fileOfFunction(func, model);
    if (!file) return;
    const context: NameContext = { file, func };
    for (const call of func.calls) {
      const resolution = resolveName(call.name, call.receiver, context, model);
      if (resolution.func && resolution.kind !== 'none') {
        addEdge(func, resolution.func, call.line, resolution.kind);
      }
    }
  };

  for (const file of model.files) {
    for (const func of file.functions) visitFunction(func);
    for (const cls of file.classes) {
      for (const method of cls.methods) visitFunction(method);
    }
  }

  return edges;
}

export function calleesOf(edges: CallEdge[], func: PyFunction): CallEdge[] {
  return edges.filter(edge => edge.caller === func);
}

export function callersOf(edges: CallEdge[], func: PyFunction): CallEdge[] {
  return edges.filter(edge => edge.callee === func);
}

/**
 * BFS through the call graph for dependency chains from `start` to `target`.
 * Returns paths of qualified names (including both endpoints), up to maxDepth
 * edges, at most `limit` paths.
 */
export function findDependencyChain(
  edges: CallEdge[],
  start: PyFunction,
  target: PyFunction,
  maxDepth = 6,
  limit = 5
): string[][] {
  if (start === target) return [[start.qualified_name]];

  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.caller.qualified_name) ?? [];
    list.push(edge.callee.qualified_name);
    adjacency.set(edge.caller.qualified_name, list);
  }

  const paths: string[][] = [];
  const queue: Array<{ node: string; path: string[] }> = [{ node: start.qualified_name, path: [start.qualified_name] }];
  const targetName = target.qualified_name;

  while (queue.length > 0 && paths.length < limit) {
    const { node, path } = queue.shift()!;
    if (path.length - 1 >= maxDepth) continue;
    for (const next of adjacency.get(node) ?? []) {
      if (path.includes(next)) continue;
      const nextPath = [...path, next];
      if (next === targetName) {
        paths.push(nextPath);
        continue;
      }
      queue.push({ node: next, path: nextPath });
    }
  }

  return paths;
}

/**
 * Find all cycles in the call graph that contain the given function,
 * as chains of qualified names. Self-recursion yields ['f', 'f'].
 */
export function findCyclesContaining(edges: CallEdge[], func: PyFunction): string[][] {
  const start = func.qualified_name;
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.caller.qualified_name) ?? [];
    list.push(edge.callee.qualified_name);
    adjacency.set(edge.caller.qualified_name, list);
  }

  const cycles: string[][] = [];
  const seen = new Set<string>();

  const dfs = (node: string, path: string[]): void => {
    for (const next of adjacency.get(node) ?? []) {
      if (next === start) {
        const cycle = [...path, start];
        const key = cycle.join('→');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
        continue;
      }
      if (path.includes(next) || path.length > 8) continue;
      dfs(next, [...path, next]);
    }
  };

  dfs(start, [start]);
  return cycles;
}
