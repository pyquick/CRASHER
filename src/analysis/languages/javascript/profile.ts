// ── JavaScript / TypeScript / Node.js / Browser profile ──
// Detection rules, framework patterns, exception advice, and log extraction
// for JS-family stack traces.

import type { LanguageProfile } from '../../types.js';

export const profile: LanguageProfile = {
  ids: ['javascript', 'typescript', 'node', 'browser'],

  labels: {
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    node: 'Node.js',
    browser: 'Browser JavaScript',
  },

  // runtime hint strings (lowercase) → detected language id
  runtimeHints: {
    node: 'node',
    nodejs: 'node',
    'node.js': 'node',
    bun: 'node',
    deno: 'node',
    browser: 'browser',
    web: 'browser',
    frontend: 'browser',
    javascript: 'javascript',
    js: 'javascript',
    typescript: 'typescript',
    ts: 'typescript',
  },

  // Auto-detect from stack trace content
  detect: (stackTrace: string): string | null => {
    if (stackTrace.match(/^\s*at\s+.+\(.+:\d+:\d+\)/m) || stackTrace.match(/^\s*at\s+.+:\d+:\d+$/m)) {
      const jsFileMatch = stackTrace.match(/\.(?:js|mjs|cjs|ts|jsx|tsx|mts|cts):\d+/);
      if (jsFileMatch) return 'javascript';
      // Generic "at ... (file:line:col)" could also be Node/Browser with no ext
      const atCount = (stackTrace.match(/^\s*at\s+/gm) || []).length;
      if (atCount >= 2) return 'javascript';
    }
    return null;
  },

  // Framework code recognition (severity classification)
  frameworkPatterns: {
    javascript: [/node:internal/, /node_modules/, /<anonymous>/, /processTicksAndRejections/, /^internal\//],
    node: [/node:internal/, /node_modules/, /<anonymous>/, /processTicksAndRejections/, /^internal\//],
    browser: [/^webpack/, /^__webpack/, /^\(index\)/, /^new\s+<anonymous>/, /@chrome-extension/],
  },

  // Exception type → advice
  advice: {
    javascript: {
      TypeError: 'Type error, usually caused by accessing a property or calling a method on null/undefined. Use optional chaining (?.) or add null checks.',
      ReferenceError: 'An undefined variable or identifier was referenced. Check if the variable is declared in the current scope.',
      SyntaxError: 'Code syntax error. Check that brackets match, quotes are closed, and commas are correct. Review syntax around the reported location.',
      RangeError: 'A value exceeded its valid range, usually caused by array length, recursion depth, or numeric conversion. Check for infinite recursion or invalid array lengths.',
    },
    node: {
      TypeError: 'Type error, usually caused by accessing a property or calling a method on null/undefined. Use optional chaining (?.) or add null checks.',
      ReferenceError: 'An undefined variable or identifier was referenced. Check if the variable is declared in the current scope.',
    },
  },

  defaultAdvice: {
    javascript: 'Review the stack trace above for the exact file path and line number. Use browser DevTools or Node.js inspector for debugging.',
    node: 'Review the stack trace above for the exact file path and line number. Use node --inspect or ndb for step-through debugging.',
    browser: 'Check the browser DevTools Sources panel at the reported file and line. Use source maps for minified code.',
    typescript: 'Check the stack trace for the exact source location. Use ts-node --inspect or source-map-support for accurate line numbers.',
  },

  // Source analysis: function declaration / definition regex (arrow functions)
  functionDeclarations: {
    javascript: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
    typescript: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  },
  definitionPatterns: {},

  // Extract stack trace from log text
  extractFromLog: (logText: string): string => {
    const lines = logText.split('\n');
    const jsLines = lines.filter(l => l.trim().match(/^\s*at\s+/));
    if (jsLines.length > 0) return jsLines.join('\n');
    return '';
  },
};
