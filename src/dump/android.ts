// Android tombstone parser
// See: https://source.android.com/docs/core/tests/debug/native-crash

import type { DumpInfo } from './types.js';

export function parseTombstone(content: string, filename: string): DumpInfo {
  const warnings: string[] = [];
  const result: DumpInfo = {
    type: 'android_tombstone',
    summary: '',
    threads: [],
    loaded_modules: [],
    parse_warnings: warnings,
  };

  // Extract signal info
  const sigMatch = content.match(
    /signal\s+(\d+)\s+\(([^)]+)\).*?code\s+(-?\d+)\s*(?:\(([^)]*)\))?.*?fault\s+addr\s+(0x[0-9a-fA-F]+)?/s
  );
  if (sigMatch) {
    result.signal = `SIG${sigMatch[2]} (${sigMatch[1]})`;
    result.crash_reason = sigMatch[4] || sigMatch[2];
    if (sigMatch[5]) result.fault_address = sigMatch[5];
  } else {
    // Simple fallback pattern
    const simpleMatch = content.match(/signal (\d+) \(([^)]+)\)/);
    if (simpleMatch) {
      result.signal = `SIG${simpleMatch[2]} (${simpleMatch[1]})`;
      result.crash_reason = simpleMatch[2];
    }
  }

  // Extract abort message
  const abortMatch = content.match(/Abort\s*message\s*:\s*(.+)/i);
  if (abortMatch) {
    result.crash_reason = (result.crash_reason ? result.crash_reason + '; ' : '') + abortMatch[1].trim();
  }

  // Extract pid/tid info
  const pidMatch = content.match(/(?:pid|PID):\s*(\d+).*?(?:tid|TID):\s*(\d+)/s);
  if (pidMatch) {
    result.raw_header = `PID: ${pidMatch[1]}, TID: ${pidMatch[2]}`;
    result.crashed_thread = parseInt(pidMatch[2], 10);
  }

  // Extract backtrace
  const backtraceSection = extractSection(content, 'backtrace:', 'stack:');
  if (backtraceSection) {
    const lines = backtraceSection.split('\n').filter(l => l.trim());
    const frames: string[] = [];

    // Match: "#00  pc 0x1234  libfoo.so (Function+offset)"
    // Or: "#00  pc 0x1234  libfoo.so"
    for (const line of lines) {
      const m = line.match(/^\s*#(\d{2})\s+(pc\s+[0-9a-fA-Fx]+.*)/);
      if (m) {
        frames.push(`#${m[1]} ${m[2].trim()}`);
      }
    }

    if (frames.length > 0) {
      result.threads!.push({ index: result.crashed_thread ?? 0, frames });
      result.thread_count = 1;
    }
  }

  // Also try "backtrace" section (without colon after "backtrace")
  if (!backtraceSection || result.threads?.length === 0) {
    const btSection = extractSection(content, 'backtrace', /^---|^memory map|^build fingerprint/);
    if (btSection) {
      const lines = btSection.split('\n').filter(l => l.trim());
      const frames: string[] = [];
      for (const line of lines) {
        const m = line.match(/^\s*#(\d{2})\s+(pc\s+[0-9a-fA-Fx]+.*)/);
        if (m) frames.push(`#${m[1]} ${m[2].trim()}`);
      }
      if (frames.length > 0) {
        result.threads!.push({ index: result.crashed_thread ?? 0, frames });
        result.thread_count = 1;
      }
    }
  }

  // Extract loaded modules from tail of backtrace or memory map
  const mmSection = extractSection(content, 'memory map', /^$|^(?!\s)/);
  if (mmSection) {
    const lines = mmSection.split('\n').filter(l => l.trim());
    const moduleSet = new Set<string>();
    for (const line of lines) {
      // Example: "12340000-12350000 r-xp 00000000 00:01 12345  /system/lib64/libc.so"
      const modMatch = line.match(/([0-9a-fA-F]+)-([0-9a-fA-F]+)\s+[r-][w-][x-][ps-]\s+\S+\s+\S+\s+\S+\s+(.+)/);
      if (modMatch && modMatch[3]) {
        const name = modMatch[3].trim();
        if (!moduleSet.has(name) && name !== '[stack]' && name !== '[vdso]') {
          moduleSet.add(name);
          result.loaded_modules!.push({
            name,
            base: `0x${modMatch[1]}`,
            size: '0x' + (parseInt(modMatch[2], 16) - parseInt(modMatch[1], 16)).toString(16),
          });
        }
      }
      // Also match build-id entries (no perms): "12340000-12350000 r /system/lib64/libc.so"
      const modMatch2 = line.match(/([0-9a-fA-F]+)-([0-9a-fA-F]+)\s+r(?:\s+(\d+))?\s+(.+)/);
      if (!modMatch && modMatch2 && modMatch2[4]) {
        const name = modMatch2[4].trim();
        if (!moduleSet.has(name) && name !== '[stack]' && name !== '[vdso]' && !name.match(/^\d+$/)) {
          moduleSet.add(name);
          result.loaded_modules!.push({
            name,
            base: `0x${modMatch2[1]}`,
            size: '0x' + (parseInt(modMatch2[2], 16) - parseInt(modMatch2[1], 16)).toString(16),
          });
        }
      }
    }
  }

  if (result.loaded_modules?.length === 0) {
    delete result.loaded_modules;
  }
  if (result.threads?.length === 0) {
    delete result.threads;
  } else {
    result.thread_count = result.threads!.length;
  }

  result.summary = result.crash_reason
    ? `Android Tombstone: ${result.crash_reason}`
    : `Android Tombstone: ${filename}`;

  return result;
}

function extractSection(
  content: string,
  startPattern: string | RegExp,
  endPattern: string | RegExp
): string | null {
  const startRegex = typeof startPattern === 'string'
    ? new RegExp(`^\\s*${escapeRegex(startPattern)}`, 'im')
    : startPattern;
  const startMatch = content.match(startRegex);
  if (!startMatch || startMatch.index === undefined) return null;

  const remaining = content.substring(startMatch.index + startMatch[0].length);

  const endRegex = typeof endPattern === 'string'
    ? new RegExp(`^\\s*${escapeRegex(endPattern)}`, 'im')
    : endPattern;
  const endMatch = remaining.match(endRegex);

  if (endMatch && endMatch.index !== undefined) {
    return remaining.substring(0, endMatch.index);
  }
  return remaining;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
