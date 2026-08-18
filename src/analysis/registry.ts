// ── Language Registry ──
// Aggregates every language's parser and profile (分析表) into ordered
// lookup tables. Profile order matters: detectLanguage checks runtime hints
// and content patterns in this exact order.

import type { LanguageProfile, StackFrame } from './types.js';
import * as csharp from './languages/csharp/index.js';
import * as cpp from './languages/cpp/index.js';
import * as go from './languages/go/index.js';
import * as python from './languages/python/index.js';
import * as javascript from './languages/javascript/index.js';
import * as java from './languages/java/index.js';
import * as rust from './languages/rust/index.js';
import * as ruby from './languages/ruby/index.js';
import * as php from './languages/php/index.js';
import * as swift from './languages/swift/index.js';
import * as dart from './languages/dart/index.js';
import * as elixir from './languages/elixir/index.js';
import * as lua from './languages/lua/index.js';

/**
 * Ordered language profiles (分析表). Content auto-detection iterates in
 * this exact order (must match the legacy detectLanguage priority chain).
 * Runtime-hint keys are globally unique, so hint order is unaffected.
 */
export const LANGUAGE_PROFILES: LanguageProfile[] = [
  python.profile,
  ruby.profile,
  php.profile,
  go.profile,
  java.profile,
  rust.profile,
  csharp.profile,
  cpp.profile,
  swift.profile,
  dart.profile,
  elixir.profile,
  lua.profile,
  javascript.profile,
];

/**
 * Language id → frame parser.
 */
export const PARSERS: Record<string, (lines: string[]) => StackFrame[]> = {
  csharp: csharp.parse,
  cpp: cpp.parse,
  c: cpp.parse,
  go: go.parse,
  python: python.parse,
  javascript: javascript.parse,
  node: javascript.parse,
  browser: javascript.parse,
  typescript: javascript.parse,
  java: java.parse,
  kotlin: java.parse,
  rust: rust.parse,
  ruby: ruby.parse,
  php: php.parse,
  swift: swift.parse,
  dart: dart.parse,
  elixir: elixir.parse,
  erlang: elixir.parse,
  lua: lua.parse,
};

/**
 * Find the profile that covers a detected language id.
 */
export function profileFor(id: string): LanguageProfile | undefined {
  return LANGUAGE_PROFILES.find(profile => profile.ids.includes(id));
}
