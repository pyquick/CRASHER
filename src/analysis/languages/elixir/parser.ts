// ── Elixir / Erlang Stack Trace Parser ──
// Format: (elixir 1.15.0) lib/enum.ex:2510: Enum.reduce/3
//         (stdlib 4.2) lists.erl:1462: :lists.do_map/2

import type { StackFrame } from '../../types.js';
import { normalizePath } from '../../common/paths.js';

export function parse(lines: string[]): StackFrame[] {
  const frames: StackFrame[] = [];
  let index = 0;

  const beRegex = /^\(([^)]+)\)\s+(.+?\.(?:ex|exs|erl)):(\d+):\s+(.+?\/\d+)$/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const m = trimmed.match(beRegex);
    if (m) {
      const moduleAndArity = m[4] || '';
      const slashIdx = moduleAndArity.lastIndexOf('/');
      const func = slashIdx > 0 ? moduleAndArity.substring(0, slashIdx) : moduleAndArity;
      const modParts = func.split('.');
      const funcName = modParts.length > 1 ? modParts[modParts.length - 1] : func;
      const moduleName = modParts.length > 1 ? modParts.slice(0, -1).join('.') : m[1];

      frames.push({
        index: index++,
        language: 'elixir',
        file_path: normalizePath(m[2]),
        line_number: parseInt(m[3], 10),
        column_number: null,
        function_name: funcName,
        module_name: moduleName,
        address: '',
        raw_line: trimmed,
        severity: 'unknown',
      });
    }
  }

  return frames;
}
