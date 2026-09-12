// ── Python Snapshot Model Builder ──
// Parses every Python source file in a snapshot and aggregates cross-file
// lookup maps (functions, classes, imports, class edges).

import type { AnalysisSourceFile, AnalysisSourceSnapshot } from '../../../types.js';
import { pathsMatch } from '../../../../source.js';
import type { PyClass, PyFileModel, PySnapshotModel } from './types.js';
import { parsePythonFile } from './parser.js';

export { parsePythonFile, parsePythonSource } from './parser.js';
export * from './types.js';

// The model indexes every uploaded Python file and function. Upload limits and
// request-level resource controls remain the boundary for untrusted snapshots.

export interface BuildSnapshotModelOptions {
  /** Definition names to prioritize in traversal order. */
  priorityDefinitionNames?: string[];
  /** Stack/source paths that must be indexed before unrelated files. */
  priorityFilePaths?: string[];
}

function definitionPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*(?:class|(?:async\\s+)?def)\\s+${escaped}\\b`, 'mi');
}

export function buildSnapshotModel(
  snapshot: AnalysisSourceSnapshot,
  options: BuildSnapshotModelOptions = {}
): PySnapshotModel {
  const pythonFiles: AnalysisSourceFile[] = snapshot.files.filter(file => file.language === 'python');

  const model: PySnapshotModel = {
    files: [],
    by_path: new Map(),
    functions_by_name: new Map(),
    qualified_functions: new Map(),
    classes_by_name: new Map(),
    imports_by_name: new Map(),
    class_edges: new Map(),
    skipped_files: 0,
    truncated: false,
  };

  const indexFile = (fileModel: PyFileModel): void => {
    model.files.push(fileModel);
    model.by_path.set(fileModel.file_path, fileModel);

    const allFunctions = [...fileModel.functions, ...fileModel.classes.flatMap(cls => cls.methods)];
    for (const func of allFunctions) {
      const key = func.name.toLowerCase();
      const list = model.functions_by_name.get(key) ?? [];
      list.push(func);
      model.functions_by_name.set(key, list);
      model.qualified_functions.set(func.qualified_name, func);
    }

    for (const cls of fileModel.classes) {
      const key = cls.name.toLowerCase();
      const list = model.classes_by_name.get(key) ?? [];
      list.push(cls);
      model.classes_by_name.set(key, list);
      model.class_edges.set(cls.qualified_name, { bases: cls.bases.map(base => base.toLowerCase()), subclasses: [] });
    }

    for (const item of fileModel.imports) {
      const key = item.name.toLowerCase();
      const list = model.imports_by_name.get(key) ?? [];
      list.push(item);
      model.imports_by_name.set(key, list);
    }
  };

  const orderedFiles: AnalysisSourceFile[] = [];
  const includedFiles = new Set<AnalysisSourceFile>();
  const addFile = (file: AnalysisSourceFile): void => {
    if (includedFiles.has(file)) return;
    includedFiles.add(file);
    orderedFiles.push(file);
  };

  // Prioritized files are ordered first for deterministic traversal, then all
  // remaining Python files are indexed without a code-size cap.
  const patterns = [...new Set(options.priorityDefinitionNames ?? [])]
    .filter(Boolean)
    .map(definitionPattern);
  if (patterns.length > 0) {
    for (const file of pythonFiles) {
      if (patterns.some(pattern => pattern.test(file.content))) addFile(file);
    }
  }

  for (const priorityPath of options.priorityFilePaths ?? []) {
    for (const file of pythonFiles) {
      if (pathsMatch(file.relative_path, priorityPath)) addFile(file);
    }
  }

  for (const file of pythonFiles) addFile(file);

  model.skipped_files = 0;

  for (const file of orderedFiles) {
    try {
      indexFile(parsePythonFile(file));
    } catch {
      // A single unparseable file must never break the whole model.
    }
  }

  // Fill subclass lists: base simple name → subclasses.
  for (const [qualifiedName, edge] of model.class_edges) {
    for (const base of edge.bases) {
      for (const [otherName, other] of model.class_edges) {
        const otherSimple = otherName.split('.').pop()?.toLowerCase() ?? '';
        if (otherSimple === base) {
          other.subclasses.push(qualifiedName);
          break;
        }
      }
    }
  }

  return model;
}

export function classNamed(model: PySnapshotModel, name: string): PyClass[] {
  return model.classes_by_name.get(name.toLowerCase()) ?? [];
}

export function functionNamed(model: PySnapshotModel, name: string) {
  return model.functions_by_name.get(name.toLowerCase()) ?? [];
}
