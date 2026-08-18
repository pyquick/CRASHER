// ── Python Line Tokenizer ──
// Strips comments and string literals from a line (tracking triple-quoted
// strings across lines), then extracts identifiers, call chains, receiver
// calls and attribute accesses. Deliberately shallow — the parser is the
// single authority for structure; this module only cleans and tokenizes.

const IDENTIFIER = /[A-Za-z_]\w*/g;
const DOTTED_CHAIN = /[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/g;
const CALL_CHAIN = /([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/g;

const PYTHON_KEYWORDS = new Set([
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def',
  'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if',
  'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'try', 'while', 'with', 'yield',
]);

export interface StringState {
  delimiter: string; // '' | "'" | '"' | "'''" | '"""'
}

export interface LineTokens {
  identifiers: string[];
  calls: string[];
  receiverCalls: Array<{ receiver: string; name: string }>;
  attrs: Array<{ receiver: string; attr: string }>;
}

/**
 * Remove comments and string literals from a line, replacing them with a
 * single space. Triple-quoted string state is carried across lines via the
 * state object (mutated in place, also returned for convenience).
 */
export function stripLine(line: string, state: StringState): string {
  let out = '';
  let i = 0;
  const n = line.length;

  while (i < n) {
    const ch = line[i];

    if (state.delimiter) {
      // Inside a multi-line string: find the closing delimiter.
      const close = line.indexOf(state.delimiter, i);
      if (close === -1) {
        out += ' ';
        return out;
      }
      out += ' ';
      i = close + state.delimiter.length;
      state.delimiter = '';
      continue;
    }

    if (ch === '#') break; // comment runs to end of line

    if (ch === "'" || ch === '"') {
      // Triple-quoted string?
      if (line.startsWith(ch + ch + ch, i)) {
        const triple = ch + ch + ch;
        const rest = line.indexOf(triple, i + 3);
        if (rest === -1) {
          state.delimiter = triple;
          out += ' ';
          return out;
        }
        out += ' ';
        i = rest + 3;
        continue;
      }
      // Single-line string: scan to the closing quote, honoring backslash escapes.
      let j = i + 1;
      while (j < n) {
        if (line[j] === '\\') { j += 2; continue; }
        if (line[j] === ch) break;
        j++;
      }
      out += ' ';
      i = j + 1;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

function chainParts(chain: string): string[] {
  return chain.split('.').map(part => part.trim());
}

/**
 * Extract identifiers, call chains, receiver calls and attribute accesses
 * from a comment/string-free code line.
 */
export function tokenizeLine(code: string): LineTokens {
  const identifiers: string[] = [];
  for (const match of code.matchAll(IDENTIFIER)) {
    if (!PYTHON_KEYWORDS.has(match[0])) identifiers.push(match[0]);
  }

  const calls: string[] = [];
  const receiverCalls: Array<{ receiver: string; name: string }> = [];
  for (const match of code.matchAll(CALL_CHAIN)) {
    const chain = match[1];
    const parts = chainParts(chain);
    if (PYTHON_KEYWORDS.has(parts[0])) continue; // 'def', 'if', ... are not calls
    calls.push(chain);
    if (parts.length > 1) {
      receiverCalls.push({ receiver: parts.slice(0, -1).join('.'), name: parts[parts.length - 1] });
    }
  }

  const attrs: Array<{ receiver: string; attr: string }> = [];
  for (const match of code.matchAll(DOTTED_CHAIN)) {
    const parts = chainParts(match[0]);
    for (let index = 1; index < parts.length; index++) {
      const receiver = parts.slice(0, index).join('.');
      if (PYTHON_KEYWORDS.has(parts[0])) continue;
      attrs.push({ receiver, attr: parts[index] });
    }
  }

  return { identifiers, calls, receiverCalls, attrs };
}
