// ── Python Fix Suggestion Generator ──
// Produces concrete, code-grounded fix suggestions for each root-cause
// candidate: guard snippets, default values, import fixes and base cases.

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
      suggestions.push(fix(
        candidate, index,
        'Define the missing attribute in __init__',
        `Assign self.<attr> in the class __init__ (or the attribute is misspelled at the crash line).`,
        snippetAround(crashFile, crashLine),
        snippetAround(siteFile, candidate.line_number),
        crash.text,
        `${crash.indent}${crash.text}  # define the attribute in __init__: self.<attr> = <value>`
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
