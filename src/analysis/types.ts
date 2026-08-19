// ── Crash Analysis Types ──
// Provides structured crash analysis output for C#, C++/C, Go, Python stack traces.

/**
 * A single frame parsed from a crash stack trace.
 */
export interface StackFrame {
  /** Frame index (0 = crash point / innermost frame) */
  index: number;
  /** Detected language: csharp, cpp, c, go, python, unknown */
  language: string;
  /** Relative file path if extractable from the frame */
  file_path: string;
  /** Line number if extractable */
  line_number: number | null;
  /** Column number if extractable */
  column_number: number | null;
  /** Function/method name */
  function_name: string;
  /** Module, package, or assembly name */
  module_name: string;
  /** Memory address (for native C++/C crashes) */
  address: string;
  /** Original text line from the stack trace */
  raw_line: string;
  /**
   * Severity classification for color coding:
   * - 'trigger': the exact crash point (RED)
   * - 'propagation': intermediate frames that propagated the error (ORANGE)
   * - 'source': root cause / entry point (YELLOW)
   * - 'framework': framework/library code (GRAY)
   * - 'unknown': unclassified (WHITE)
   */
  severity: 'trigger' | 'propagation' | 'source' | 'framework' | 'unknown';
}

/**
 * A tree node representing a file or directory in the crash file tree.
 */
export interface FileTreeNode {
  /** Display name (file or directory name) */
  name: string;
  /** Full relative path */
  path: string;
  /** Whether this is a file (true) or directory (false) */
  is_file: boolean;
  /** Whether this is the crash trigger site */
  is_crash_site: boolean;
  /** Line number if this is the crash site */
  line_number: number | null;
  /** Severity color for the node */
  severity: 'red' | 'orange' | 'yellow' | 'gray';
  /** Children nodes */
  children: FileTreeNode[];
}

export interface SourceLocation {
  file_path: string;
  line_number: number;
  function_name: string;
  snippet: string;
}

export type SourceRelationship = 'crash' | 'definition' | 'caller' | 'callee' | 'stack';

export interface RelatedFunction extends SourceLocation {
  relationship: Exclude<SourceRelationship, 'crash' | 'definition'>;
  language: string;
}

export interface RelatedSourceFile {
  file_path: string;
  language: string;
  relationships: SourceRelationship[];
  functions: string[];
  match_count: number;
}

export interface SourceAnalysis {
  project_name: string;
  requested_release: string;
  snapshot_release: string;
  snapshot_id: number;
  match_type: 'exact' | 'latest';
  files_scanned: number;
  crash_source: SourceLocation | null;
  function_definition: SourceLocation | null;
  references: SourceLocation[];
  related_functions: RelatedFunction[];
  related_files: RelatedSourceFile[];
  warnings: string[];
  // Python deep analysis (optional — populated only when the crash language
  // is Python and the snapshot contains Python sources).
  root_cause_candidates?: RootCauseCandidate[];
  fixes?: FixSuggestion[];
  dependency_summary?: DependencySummary;
  /**
   * Crash path flow: the stack frames from entry point to crash site,
   * followed by the terminal root-cause node (e.g. the class definition
   * missing an attribute). Rendered as a flow chart in the web UI.
   */
  crash_path?: CrashPathStep[];
}

export type RootCauseKind =
  | 'none-return'
  | 'missing-attribute'
  | 'missing-key'
  | 'out-of-range'
  | 'type-mismatch'
  | 'undefined-name'
  | 'import-failure'
  | 'recursion'
  | 'generic';

export interface RootCauseCandidate {
  file_path: string;
  line_number: number | null;
  function_name: string;
  reason: string;
  confidence: number; // 0..1
  kind: RootCauseKind;
  evidence: string[];
  /** True when the analysis has resolved a definitive definition site. */
  is_conclusive?: boolean;
  /** Declaration shape at the resolved definition site. */
  definition_kind?: 'class' | 'function';
  /** Python module containing the resolved definition. */
  definition_module?: string;
  /** Modules imported by the file that contains the resolved definition. */
  imported_packages?: string[];
}

/**
 * One node of the crash-path flow chart: either a stack frame (entry point
 * → crash site) or the terminal root-cause location the analysis points at.
 */
export interface CrashPathStep {
  file_path: string;
  line_number: number | null;
  function_name: string;
  /** Display label, e.g. 'run' or "class Constants — 'x' is never assigned". */
  label: string;
  role: 'frame' | 'root-cause';
  /** Frame severity (frame steps only). */
  severity?: StackFrame['severity'];
  /** Root-cause kind (root-cause steps only). */
  kind?: RootCauseKind;
}

export interface FixSuggestion {
  candidate_index: number;
  title: string;
  description: string;
  crash_site_snippet: string;
  fix_site_snippet: string;
  code_before: string;
  code_after: string;
  confidence: number;
}

export interface DependencySummary {
  callers: SourceLocation[];
  subclass_chain: string[];
  variable_definitions: SourceLocation[];
}

/**
 * The complete crash analysis result.
 */
export interface CrashAnalysis {
  /** Report ID being analyzed */
  report_id: number;
  /** Exception type from the report */
  exception_type: string;
  /** Exception message */
  exception_message: string;
  /** Detected programming language */
  detected_language: string;

  /** Tree diagram showing crash files with relative paths */
  file_tree: FileTreeNode[];

  /** The exact crash trigger point */
  trigger_point: {
    file_path: string;
    line_number: number | null;
    function_name: string;
    message: string;
    /** The raw line that triggered the crash */
    raw_snippet: string;
  };

  /** The complete stack chain from source to crash */
  stack_chain: StackFrame[];

  /** Human-readable summary of the analysis */
  summary: string;

  /** Runtime info */
  runtime: string;
  runtime_version: string;

  /** Source-code evidence, when a project source snapshot is available */
  source_analysis?: SourceAnalysis;
}

/** An uploaded source file in a project source snapshot. */
export interface AnalysisSourceFile {
  relative_path: string;
  language: string;
  content: string;
}

/** A project source snapshot uploaded for source-code analysis. */
export interface AnalysisSourceSnapshot {
  project_name: string;
  requested_release: string;
  snapshot_release: string;
  snapshot_id: number;
  match_type: 'exact' | 'latest';
  files: AnalysisSourceFile[];
}

/**
 * Per-language profile — everything a single language family
 * needs for detection, frame classification, advice, and log extraction.
 * Each languages/<lang>/profile.ts exports one of these.
 */
export interface LanguageProfile {
  /** Language ids covered by this profile (e.g. ['javascript','typescript','node','browser']) */
  ids: string[];
  /** Display label per id */
  labels: Record<string, string>;
  /** Lowercased runtime hint string → detected id */
  runtimeHints: Record<string, string>;
  /** Detect the language from stack trace content; returns an id or null */
  detect: (stackTrace: string) => string | null;
  /** Framework-code patterns per id, used by severity classification */
  frameworkPatterns: Record<string, RegExp[]>;
  /** Exception-type → advice per id */
  advice: Record<string, Record<string, string>>;
  /** Default advice per id */
  defaultAdvice: Record<string, string>;
  /** Function declaration regex per source-file language (source analysis) */
  functionDeclarations: Record<string, RegExp>;
  /** Definition regex factory per source-file language (source analysis) */
  definitionPatterns: Record<string, (name: string) => RegExp>;
  /** Extract a stack trace from raw log text for an id; '' when not found */
  extractFromLog: (logText: string, id: string) => string;
}
