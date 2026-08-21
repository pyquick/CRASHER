// ── Python Fix Suggestion Generator ──
// Produces concrete, code-grounded fix suggestions for each root-cause
// candidate: guard snippets, default values, import fixes and base cases.
// `suggestExceptionAdvice` is the fallback: every Python error gets at
// least one exception-type-based suggestion, even when no root cause was
// found or no source snapshot is available.

import type { FixSuggestion, RootCauseCandidate, SourceLocation } from '../../../types.js';
import type { PyFileModel } from '../code-model/types.js';
import type { CrashContext } from '../root-cause/index.js';

/**
 * Format a window of source lines around a line, marking it with '>'.
 */
export function snippetAround(file: PyFileModel, line: number | null, radius = 2): string {
  if (!line || line < 1 || line > file.lines.length) return '';
  const start = Math.max(1, line - radius);
  const end = Math.min(file.lines.length, line + radius);
  const parts: string[] = [];
  for (let index = start; index <= end; index++) {
    const marker = index === line ? '>' : ' ';
    parts.push(`${marker} ${String(index).padStart(5)} | ${file.lines[index - 1]}`);
  }
  return parts.join('\n');
}

export function sourceLocationFor(
  file: PyFileModel,
  line: number | null,
  functionName: string
): SourceLocation {
  return {
    file_path: file.file_path,
    line_number: line ?? 0,
    function_name: functionName,
    snippet: snippetAround(file, line),
  };
}

function rawLine(file: PyFileModel, line: number | null): { text: string; indent: string } {
  const text = line ? (file.lines[line - 1] ?? '').trimEnd() : '';
  const indent = text.match(/^\s*/)?.[0] ?? '';
  return { text: text.trim(), indent };
}

function fix(
  candidate: RootCauseCandidate,
  index: number,
  title: string,
  description: string,
  crashSite: string,
  fixSite: string,
  codeBefore: string,
  codeAfter: string
): FixSuggestion {
  return {
    candidate_index: index,
    title,
    description,
    crash_site_snippet: crashSite,
    fix_site_snippet: fixSite,
    code_before: codeBefore,
    code_after: codeAfter,
    confidence: candidate.confidence,
  };
}

/**
 * Suggest fixes for a candidate. Returns 1-2 suggestions per candidate.
 * `candidateIndex` is the candidate's position in the ranked candidates list.
 */
export function suggestFixes(candidate: RootCauseCandidate, ctx: CrashContext, candidateIndex: number): FixSuggestion[] {
  const { crashFile, crashLine } = ctx;
  const siteFile = ctx.model.by_path.get(candidate.file_path) ?? crashFile;
  const crash = rawLine(crashFile, crashLine);
  const site = rawLine(siteFile, candidate.line_number);
  const suggestions: FixSuggestion[] = [];
  const index = candidateIndex;

  switch (candidate.kind) {
    case 'none-return': {
      if (site.text.startsWith('return')) {
        suggestions.push(fix(
          candidate, index,
          'Return a default value instead of None',
          `${candidate.function_name} can return None, which propagates to the crash. Return a sensible default (or raise a clear error) here.`,
          snippetAround(crashFile, crashLine),
          snippetAround(siteFile, candidate.line_number),
          site.text,
          `${site.indent}return <default_value>  # e.g. a fallback object, or raise ValueError('not found')`
        ));
      }
      suggestions.push(fix(
        candidate, index,
        'Guard against None before using the result',
        `Add a None check (or default) where the result is assigned, before it is dereferenced at line ${crashLine}.`,
        snippetAround(crashFile, crashLine),
        snippetAround(crashFile, crashLine),
        crash.text,
        `${crash.indent}if <var> is None:\n${crash.indent}    return  # or assign a default\n${crash.indent}${crash.text}`
      ));
      break;
    }
    case 'missing-attribute': {
      const attr = candidate.reason.match(/^'([^']+)' from [^']*never defines '([^']+)'/)?.[2]
        ?? candidate.reason.match(/^'([^']+)' is never assigned/)?.[1];
      const attrRef = attr ?? '<attr>';
      const classBodyIndent = site.indent ? `${site.indent}    ` : '    ';
      suggestions.push(fix(
        candidate, index,
        'Define the missing attribute on the class',
        attr
          ? `'${attr}' is not defined on the class or its base classes. Add it to the class body here (or assign self.${attr} in __init__); alternatively the attribute name is misspelled at the crash line.`
          : `The accessed attribute is not defined on the class or its base classes. Add it to the class body (or assign it in __init__); alternatively the attribute name is misspelled at the crash line.`,
        snippetAround(crashFile, crashLine),
        snippetAround(siteFile, candidate.line_number),
        site.text,
        `${site.text}\n${classBodyIndent}${attrRef} = <default_value>`
      ));
      break;
    }
    case 'missing-key': {
      const guard = crash.text.replace(/\[([^\]]+)\]\s*$/, `.get($1, <default>)`);
      suggestions.push(fix(
        candidate, index,
        'Use .get() with a default for the missing key',
        `The subscripted key may be absent. Use dict.get(key, default) or validate the key before access at line ${crashLine}.`,
        snippetAround(crashFile, crashLine),
        snippetAround(siteFile, candidate.line_number),
        crash.text,
        guard === crash.text ? crash.text : `${crash.indent}${guard}`
      ));
      break;
    }
    case 'out-of-range': {
      suggestions.push(fix(
        candidate, index,
        'Add a bounds check before indexing',
        `The index used at line ${crashLine} can fall outside the sequence bounds. Validate it first.`,
        snippetAround(crashFile, crashLine),
        snippetAround(siteFile, candidate.line_number),
        crash.text,
        `${crash.indent}if 0 <= <index> < len(<sequence>):\n${crash.indent}    ${crash.text}`
      ));
      break;
    }
    case 'undefined-name': {
      const evidenceText = candidate.evidence.join(' ');
      const typo = evidenceText.match(/did you mean '([^']+)'/)?.[1];
      const undefined = evidenceText.match(/'([^']+)' is not defined/)?.[1];
      const corrected = typo && undefined && crash.text.includes(undefined)
        ? crash.text.replace(new RegExp(`\\b${undefined}\\b`), typo)
        : crash.text;
      suggestions.push(fix(
        candidate, index,
        'Fix the undefined name',
        typo
          ? `The name is likely a typo — replace '${undefined}' with '${typo}'.`
          : 'Import the missing name or define it before use.',
        snippetAround(crashFile, crashLine),
        snippetAround(siteFile, candidate.line_number),
        crash.text,
        corrected === crash.text ? crash.text : `${crash.indent}${corrected}`
      ));
      break;
    }
    case 'import-failure': {
      suggestions.push(fix(
        candidate, index,
        'Fix the failing import',
        `Install the missing dependency into the runtime environment, or correct the module path at line ${candidate.line_number}.`,
        snippetAround(crashFile, crashLine),
        snippetAround(siteFile, candidate.line_number),
        site.text,
        `${site.indent}${site.text}  # install the missing package or fix the module path`
      ));
      break;
    }
    case 'recursion': {
      suggestions.push(fix(
        candidate, index,
        'Add a base case to stop the recursion',
        `The recursion cycle ${candidate.evidence[0]?.split(':')[1]?.trim() ?? ''} never terminates. Add a base case that returns before recursing.`,
        snippetAround(crashFile, crashLine),
        snippetAround(siteFile, candidate.line_number),
        crash.text,
        `${crash.indent}if <base_condition>:\n${crash.indent}    return <value>\n${crash.indent}${crash.text}`
      ));
      break;
    }
    default: {
      suggestions.push(fix(
        candidate, index,
        'Review the data flow into the crash site',
        candidate.reason,
        snippetAround(crashFile, crashLine),
        snippetAround(siteFile, candidate.line_number),
        crash.text,
        crash.text
      ));
    }
  }

  return suggestions;
}

// ── Exception-Type Advice Fallback ──
// Title + description suggestions keyed by Python exception type. These are
// shown whenever the root-cause analysis produces no code-grounded fixes,
// so every Python error still gets actionable advice.

const EXCEPTION_ADVICE: Record<string, { title: string; description: string }> = {
  AttributeError: {
    title: 'Guard attribute access',
    description: "'X' object has no attribute 'y' — the object is not the type you expect, often None returned by an earlier function. Check it before use (if obj is not None: / hasattr(obj, 'y')), and verify the attribute name is spelled correctly.",
  },
  KeyError: {
    title: 'Use safe dictionary access',
    description: 'The key is missing from the dictionary. Use d.get(key, default) or check `key in d` before subscripting, and make sure the key was inserted earlier.',
  },
  IndexError: {
    title: 'Check the index bounds',
    description: 'A list/tuple index is out of range. Validate it first: `if 0 <= i < len(seq):` — the sequence is probably shorter (or empty) than the code assumes.',
  },
  TypeError: {
    title: 'Check the operand types',
    description: 'An operation received an incompatible type (e.g. str + int, or calling a non-callable). Verify the types with isinstance() or type hints, and convert explicitly where needed.',
  },
  ValueError: {
    title: 'Validate the input value',
    description: "The value has the right type but an invalid form (e.g. int('abc'), list.remove() of a missing item). Validate or normalize the value before use.",
  },
  ZeroDivisionError: {
    title: 'Guard the divisor',
    description: 'A division by zero occurred. Check the divisor before dividing (`if divisor != 0:`), or handle the zero case explicitly.',
  },
  ModuleNotFoundError: {
    title: 'Install or locate the missing module',
    description: 'The module could not be found. Install the missing package into the runtime environment (pip install), or check the module name and PYTHONPATH.',
  },
  ImportError: {
    title: 'Fix the failing import',
    description: 'A module or name could not be imported. Install the missing dependency (pip install), correct the module path, or resolve the circular import.',
  },
  FileNotFoundError: {
    title: 'Handle the missing file',
    description: 'The file does not exist. Check the path with os.path.exists(), create the file when needed, or handle the missing-file case gracefully.',
  },
  PermissionError: {
    title: 'Check file permissions',
    description: 'The process lacks permission to access the file or directory. Check the permissions and the running user, or run with the required privileges.',
  },
  OSError: {
    title: 'Handle the I/O failure',
    description: 'An operating-system error occurred (file, socket, or device). Wrap the I/O call in try/except OSError and surface a clear error message.',
  },
  NameError: {
    title: 'Fix the undefined name',
    description: 'A name is not defined. Check for typos, a missing import, or use before assignment — the traceback may suggest the correct spelling.',
  },
  UnboundLocalError: {
    title: 'Initialize the variable before use',
    description: 'A local variable is read before it is assigned in this scope. Initialize it before use, or mark it global/nonlocal if that is intended.',
  },
  RecursionError: {
    title: 'Stop the recursion',
    description: 'The recursion never terminates. Add a base case that returns before recursing, or rewrite the logic as an iterative loop.',
  },
  StopIteration: {
    title: 'Handle iterator exhaustion',
    description: 'An iterator was consumed past its end. Use next(it, default) or catch StopIteration explicitly — note that raising it inside a generator becomes a RuntimeError.',
  },
  OverflowError: {
    title: 'Reduce the numeric magnitude',
    description: 'A number is too large for its type. Use float or Decimal for large values, or scale the computation down.',
  },
  UnicodeDecodeError: {
    title: 'Use the correct encoding',
    description: "The bytes could not be decoded. Open the file with the right encoding, e.g. open(path, encoding='utf-8'), or pass errors='replace'.",
  },
  MemoryError: {
    title: 'Reduce memory usage',
    description: 'The process ran out of memory. Stream or chunk data instead of loading it all at once, and release large objects (del, gc.collect()).',
  },
  TimeoutError: {
    title: 'Handle the timeout',
    description: 'An operation timed out. Increase the timeout or add retry logic, and handle the timeout case gracefully.',
  },
  ConnectionError: {
    title: 'Handle the connection failure',
    description: 'A network connection failed. Add retry/backoff logic, handle the offline case, and surface a clear error message.',
  },
  AssertionError: {
    title: 'Review the failed assertion',
    description: 'An assert statement failed. Check the inputs that reach the assertion and whether the assumption behind it still holds.',
  },
  RuntimeError: {
    title: 'Check the runtime state',
    description: 'A generic runtime error occurred (e.g. misuse of a generator or an unsupported operation). Inspect the traceback for the operation that raised it.',
  },
};

const DEFAULT_EXCEPTION_ADVICE: { title: string; description: string } = {
  title: 'Debug with try/except and logging',
  description: 'Wrap the crash site in try/except, log the full traceback, and reproduce the failure with pdb or logging to inspect the failing state.',
};

/**
 * Fallback suggestion for an exception type, used when no code-grounded
 * fix was produced. Always returns exactly one advisory suggestion.
 */
export function suggestExceptionAdvice(exception: { type: string; message: string }): FixSuggestion[] {
  const entry = matchExceptionAdvice(exception.type);
  return [{
    candidate_index: -1,
    title: entry.title,
    description: entry.description,
    crash_site_snippet: '',
    fix_site_snippet: '',
    code_before: '',
    code_after: '',
    confidence: 0.5,
  }];
}

function matchExceptionAdvice(type: string): { title: string; description: string } {
  const lower = type.toLowerCase();
  // Longest keys first so e.g. ModuleNotFoundError wins over ImportError.
  const keys = Object.keys(EXCEPTION_ADVICE).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (lower.includes(key.toLowerCase())) return EXCEPTION_ADVICE[key];
  }
  return DEFAULT_EXCEPTION_ADVICE;
}
