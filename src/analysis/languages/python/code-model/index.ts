// ── Python Snapshot Model Builder ──
// Parses every Python source file in a snapshot and aggregates cross-file
// lookup maps (functions, classes, imports, class edges).

import type { AnalysisSourceFile, AnalysisSourceSnapshot } from '../../../types.js';
import type { PyClass, PyFileModel, PySnapshotModel } from './types.js';
import { parsePythonFile } from './parser.js';

export { parsePythonFile, parsePythonSource } from './parser.js';
export * from './types.js';

// Per-request safety caps: the model is rebuilt on every analysis request,
// so very large snapshots are partially indexed instead of exhausting time.
export const MODEL_LIMITS = { maxFiles: 300, maxFunctions: 2000 } as const;

export function buildSnapshotModel(snapshot: AnalysisSourceSnapshot): PySnapshotModel {
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

  let functionCount = 0;

  const indexFile = (fileModel: PyFileModel): void => {
    model.files.push(fileModel);
    model.by_path.set(fileModel.file_path, fileModel);

    const allFunctions = [...fileModel.functions, ...fileModel.classes.flatMap(cls => cls.methods)];
    if (functionCount + allFunctions.length > MODEL_LIMITS.maxFunctions) {
      model.truncated = true;
    } else {
      for (const func of allFunctions) {
        const key = func.name.toLowerCase();
        const list = model.functions_by_name.get(key) ?? [];
        list.push(func);
        model.functions_by_name.set(key, list);
        model.qualified_functions.set(func.qualified_name, func);
      }
      functionCount += allFunctions.length;
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

  const indexed = pythonFiles.slice(0, MODEL_LIMITS.maxFiles);
  model.skipped_files = pythonFiles.length - indexed.length;
  if (model.skipped_files > 0) model.truncated = true;

  for (const file of indexed) {
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
