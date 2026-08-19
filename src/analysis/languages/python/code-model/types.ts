// ── Python Code Model Types ──
// Data structures produced by the lightweight Python structure parser.
// The model is deliberately shallow: no expression trees, only the
// structural facts needed for dependency analysis and root-cause attribution.

export interface PyLocation {
  file_path: string;
  line: number;
}

/** A defined name (function/class/assignment/import) with original casing. */
export interface PyNameDef extends PyLocation {
  name: string;
}

export interface PyImport {
  file_path: string;
  line: number;
  module: string;   // full module path, e.g. 'services.user_service'
  name: string;     // bound name (alias if aliased, else the imported name)
  alias?: string;   // 'as' alias, when present
  is_from: boolean; // true for 'from X import Y', false for 'import X'
}

export interface PyCall {
  name: string;          // full dotted chain, e.g. 'get_user' or 'user.get_name'
  receiver?: string;     // receiver chain for method calls, e.g. 'user' for 'user.get_name'
  line: number;
}

export type PyRhsKind = 'call' | 'dict' | 'list' | 'attr' | 'literal' | 'other';

export interface PyAssignment {
  name: string;          // target, e.g. 'user' or 'self.name'
  line: number;
  rhs_calls: string[];   // call chains appearing on the right-hand side
  rhs_kind: PyRhsKind;
}

export interface PyAttributeAccess {
  receiver: string;
  attr: string;
  line: number;
}

export interface PyReturn {
  line: number;
  is_none: boolean; // 'return None'
  is_bare: boolean; // bare 'return' (implicitly returns None)
}

export type PyFunctionKind = 'function' | 'method' | 'async_function' | 'async_method';

export interface PyFunction {
  name: string;
  qualified_name: string; // 'func', 'Class.method', 'outer.inner'
  kind: PyFunctionKind;
  params: string[];
  decorators: string[];
  body: { start: number; end: number };
  calls: PyCall[];
  assignments: PyAssignment[];
  attr_accesses: PyAttributeAccess[];
  returns: PyReturn[];
  raises: string[];
}

export interface PyClass {
  name: string;
  qualified_name: string;
  bases: string[];
  /** 1-based line of the `class X(...)` statement itself. */
  line: number;
  body: { start: number; end: number };
  methods: PyFunction[];
  /** Class-body assignments (class attributes), e.g. `voodoo_patch_already = False`. */
  assignments: PyAssignment[];
}

export interface PyFileModel {
  file_path: string;
  lines: string[];
  imports: PyImport[];
  classes: PyClass[];
  functions: PyFunction[]; // module-level and nested functions (flattened)
  module_assignments: PyAssignment[]; // top-level assignments with RHS info
  // Simple lowercase name → where it is defined (functions, classes,
  // module-level assignments, imports). Powers NameError detection.
  name_defs: Map<string, PyNameDef[]>;
}

export interface PySnapshotModel {
  files: PyFileModel[];
  by_path: Map<string, PyFileModel>;
  functions_by_name: Map<string, PyFunction[]>;   // lowercase simple name
  qualified_functions: Map<string, PyFunction>;   // qualified_name → function
  classes_by_name: Map<string, PyClass[]>;        // lowercase simple name
  imports_by_name: Map<string, PyImport[]>;       // lowercase bound name
  class_edges: Map<string, { bases: string[]; subclasses: string[] }>; // qualified_name keyed
  skipped_files: number;  // Python files not indexed because a limit was hit
  truncated: boolean;     // true when the file or function limit was hit
}
