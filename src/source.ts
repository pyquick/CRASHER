import { extname } from 'path';
import { createHash } from 'crypto';

const SOURCE_LANGUAGES: Record<string, string> = {
  '.cs': 'csharp', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.c': 'c',
  '.h': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.go': 'go', '.py': 'python',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.jsx': 'javascript',
  '.java': 'java', '.kt': 'kotlin', '.rs': 'rust', '.rb': 'ruby',
  '.php': 'php', '.swift': 'swift', '.dart': 'dart', '.ex': 'elixir',
  '.exs': 'elixir', '.erl': 'erlang', '.lua': 'lua',
};

export function normalizeProjectName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('project_name is required');
  const name = value.trim();
  if (!name || name.length > 100 || /[\0\r\n]/.test(name)) {
    throw new Error('project_name must be between 1 and 100 characters');
  }
  return name;
}

export function normalizeOptionalProjectName(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  return normalizeProjectName(value);
}

export function normalizeRelease(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error('release must be a string');
  const release = value.trim();
  if (release.length > 200 || /[\0\r\n]/.test(release)) {
    throw new Error('release must be at most 200 characters');
  }
  return release;
}

export function normalizeSourcePath(value: string): string {
  if (!value || value.includes('\0') || value.length > 500) throw new Error('Invalid source path');
  const slashes = value.replace(/\\/g, '/');
  if (slashes.startsWith('/') || /^[A-Za-z]:\//.test(slashes)) throw new Error('Absolute source paths are not allowed');
  const parts = slashes.split('/').filter(part => part && part !== '.');
  if (parts.length === 0 || parts.some(part => part === '..')) throw new Error('Source path traversal is not allowed');
  return parts.join('/');
}

export function sourceLanguage(filePath: string): string | null {
  return SOURCE_LANGUAGES[extname(filePath).toLowerCase()] ?? null;
}

export function isTextSource(data: Buffer): boolean {
  if (data.includes(0)) return false;
  if (data.length === 0) return true;
  let suspicious = 0;
  const sample = data.subarray(0, Math.min(data.length, 8192));
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious++;
  }
  return suspicious / sample.length < 0.02;
}

export function pathsMatch(stackPath: string, sourcePath: string): boolean {
  const stack = stackPath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const source = sourcePath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  return stack === source || stack.endsWith('/' + source) || source.endsWith('/' + stack);
}

// ----- Content dedup: hashing and line-level patches -----

export function computeContentHash(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface LinePatch {
  prefix: number; // common leading lines kept from the base
  suffix: number; // common trailing lines kept from the base
  lines: string[]; // replacement lines between prefix and suffix
}

// Computes the smallest single-hunk patch between two texts by stripping
// the common leading/trailing lines. Returns null when the texts are equal.
export function computeLinePatch(oldText: string, newText: string): LinePatch | null {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;
  if (prefix + suffix === oldLines.length && prefix + suffix === newLines.length) return null;
  return { prefix, suffix, lines: newLines.slice(prefix, newLines.length - suffix) };
}

export function applyLinePatch(baseText: string, patch: LinePatch): string {
  const baseLines = baseText.split('\n');
  if (patch.prefix + patch.suffix > baseLines.length) throw new Error('Patch does not fit its base file');
  const head = baseLines.slice(0, patch.prefix);
  const tail = baseLines.slice(baseLines.length - patch.suffix);
  return head.concat(patch.lines, tail).join('\n');
}

// A patch is worth storing (instead of the full file) when it is no larger
// than half of the new content.
export function isPatchSmall(patch: LinePatch, newSize: number): boolean {
  return newSize > 0 && JSON.stringify(patch).length * 2 <= newSize;
}
