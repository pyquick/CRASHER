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
