import { extname } from 'path';

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
