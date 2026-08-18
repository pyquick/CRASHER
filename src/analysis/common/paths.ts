// ── Shared Path Helpers ──
// Language-independent path normalization and module extraction,
// used by all language parsers.

/**
 * Normalize a stack trace file path to a relative, display-friendly form.
 * Handles Windows backslashes, Unity angle-bracket paths, file:// URLs,
 * and strips common absolute prefixes (/app/, /home/, /usr/, ...).
 */
export function normalizePath(filePath: string): string {
  if (!filePath) return '';

  let normalized = filePath.replace(/\\/g, '/');

  // Strip <angled brackets> from Unity paths like "<1234567890>"
  normalized = normalized.replace(/<[^>]+>/g, '').trim();

  // Handle file:// URLs (Node.js)
  if (normalized.startsWith('file://')) {
    try {
      normalized = decodeURIComponent(normalized.replace('file://', ''));
    } catch {
      normalized = normalized.replace('file://', '');
    }
    // Strip Windows drive letter leading slash
    if (/^\/[A-Za-z]:/.test(normalized)) {
      normalized = normalized.substring(1);
    }
  }

  // Make absolute paths relative by stripping common prefixes
  const prefixes = [
    '/app/', '/src/', '/home/', '/Users/', '/root/',
    '/var/www/', '/opt/', '/usr/local/', '/usr/',
    '/go/src/', '/go/pkg/',
    '/build/', '/dist/',
    '/workspace/', '/project/', '/Projects/',
  ];

  for (const prefix of prefixes) {
    const idx = normalized.indexOf(prefix);
    if (idx >= 0) {
      // Keep the meaningful part after the base prefix
      const after = normalized.substring(idx + prefix.length);
      // If there's a recognizable project structure, return relative
      if (after.length > 0) return after;
    }
  }

  // Strip leading path separators and common prefixes for known structures
  normalized = normalized.replace(/^[A-Za-z]:[/\\]/, ''); // Windows drive
  normalized = normalized.replace(/^\/+/, ''); // Leading slashes

  // For paths like "Owner/repo/folder/file.ext", strip first 0-1 segments
  // if the result looks like a well-known project root
  const segments = normalized.split('/');
  if (segments.length >= 3) {
    const knownRoots = ['src', 'lib', 'app', 'pkg', 'internal', 'cmd', 'main', 'test', 'tests'];
    for (let i = 0; i < Math.min(2, segments.length - 2); i++) {
      if (knownRoots.includes(segments[i])) {
        return segments.slice(i).join('/');
      }
    }
  }

  return normalized;
}

/**
 * Derive a module name from a file path ("parentDir/fileName").
 */
export function extractModuleFromPath(filePath: string): string {
  if (!filePath) return '';

  const parts = filePath.replace(/\\/g, '/').split('/').filter(p => p);
  if (parts.length === 0) return '';

  // Remove file extension and return the last directory or filename
  const last = parts[parts.length - 1];
  const name = last.replace(/\.[^.]+$/, '');

  // If the path has a parent directory, use "parentName/fileName"
  if (parts.length >= 2) {
    const parent = parts[parts.length - 2];
    return `${parent}/${name}`;
  }

  return name;
}
