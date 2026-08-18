// ── File Tree Builder ──
// Language-independent crash file tree construction.

import type { FileTreeNode, StackFrame } from '../types.js';

/**
 * Build a tree diagram showing the file paths involved in the crash.
 * The tree looks like:
 * └── src/
 *     └── controllers/
 *         └── player.js  ← crash here (line 42)
 */
export function buildFileTree(frames: StackFrame[]): FileTreeNode[] {
  const rootNodes: FileTreeNode[] = [];

  for (const frame of frames) {
    if (!frame.file_path) continue;

    const normalizedPath = frame.file_path
      .replace(/\\/g, '/')
      .replace(/\/{2,}/g, '/')
      .replace(/^\.\//, '')
      .replace(/\/$/, '');
    const parts = normalizedPath.split('/').filter(p => p);
    if (parts.length === 0) continue;

    let siblings = rootNodes;
    let currentPath = '';

    for (let depth = 0; depth < parts.length; depth++) {
      const part = parts[depth];
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isLast = depth === parts.length - 1;

      // Find existing node at this level by name
      let existing: FileTreeNode | undefined;
      for (const child of siblings) {
        if (child.name === part) {
          existing = child;
          break;
        }
      }

      if (existing) {
        // If we're at the file level and this frame is a crash trigger, upgrade it
        if (isLast && frame.severity === 'trigger') {
          existing.is_crash_site = true;
          existing.line_number = frame.line_number ?? existing.line_number;
          existing.severity = 'red';
        } else if (isLast && frame.severity !== 'trigger' && !existing.is_crash_site) {
          // Update severity to the highest priority
          const sevPriority = { red: 4, orange: 3, yellow: 2, gray: 1 };
          const newSev = severityToColor(frame.severity);
          if ((sevPriority[newSev] || 0) > (sevPriority[existing.severity] || 0)) {
            existing.severity = newSev;
          }
          if (frame.line_number && !existing.line_number) {
            existing.line_number = frame.line_number;
          }
        }
        siblings = existing.children;
      } else {
        // Create new node
        const severity: FileTreeNode['severity'] = isLast
          ? severityToColor(frame.severity)
          : 'gray';

        const node: FileTreeNode = {
          name: part,
          path: currentPath,
          is_file: isLast,
          is_crash_site: isLast && frame.severity === 'trigger',
          line_number: isLast ? frame.line_number : null,
          severity,
          children: [],
        };

        siblings.push(node);
        siblings = node.children;
      }
    }
  }

  // Sort: directories before files, crash-site files first, then alphabetically
  return sortTreeNodes(rootNodes);
}

export function sortTreeNodes(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes
    .sort((a, b) => {
      // Crash site files first
      if (a.is_crash_site && !b.is_crash_site) return -1;
      if (!a.is_crash_site && b.is_crash_site) return 1;
      // Directories before files
      if (!a.is_file && b.is_file) return -1;
      if (a.is_file && !b.is_file) return 1;
      // Alphabetically
      return a.name.localeCompare(b.name);
    })
    .map(node => ({
      ...node,
      children: sortTreeNodes(node.children),
    }));
}

export function severityToColor(severity: StackFrame['severity']): FileTreeNode['severity'] {
  switch (severity) {
    case 'trigger': return 'red';
    case 'propagation': return 'orange';
    case 'source': return 'yellow';
    case 'framework': return 'gray';
    default: return 'gray';
  }
}
