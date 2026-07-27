// iOS / macOS crash report parser
// Handles both .crash (text) and .ips (JSON) formats

import type { DumpInfo, DumpThreadFrame } from './types.js';

export function parseIOSCrash(content: string, filename: string): DumpInfo {
  // Try JSON (.ips) format first
  if (content.trim().startsWith('{')) {
    return parseIPS(content, filename);
  }
  return parseLegacyCrash(content, filename);
}

function parseIPS(content: string, filename: string): DumpInfo {
  const warnings: string[] = [];
  const result: DumpInfo = {
    type: 'ios_crash',
    summary: '',
    threads: [],
    parse_warnings: warnings,
  };

  try {
    const data = JSON.parse(content);

    // Exception / termination
    const termination = data.termination;
    const exception = data.exception;
    if (termination) {
      result.crash_reason = `${termination.namespace || ''} ${termination.code || ''}`.trim();
      if (termination.description) {
        result.crash_reason += ` — ${termination.description}`;
      }
    }
    if (exception) {
      result.signal = `${exception.type || ''}`.trim();
      if (exception.signal) result.signal += ` (${exception.signal})`;
      if (!result.crash_reason && exception.message) {
        result.crash_reason = exception.message;
      }
    }

    // Threads
    const threads = data.threads || [];
    result.thread_count = threads.length;
    for (const t of threads) {
      const threadInfo: DumpThreadFrame = {
        index: t.id ?? t.index ?? 0,
        name: t.name,
        frames: [],
      };
      const frames = t.frames || [];
      for (let i = 0; i < Math.min(frames.length, 200); i++) {
        const f = frames[i];
        let frameStr = `${i}`.padStart(2);
        if (f.image) {
          frameStr += `  ${f.image}`;
          const offset = f.imageOffset ?? f.offset;
          if (offset !== undefined) frameStr += ` + ${offset}`;
        }
        if (f.symbol) {
          frameStr += `  ${f.symbol}`;
          if (f.symbolLocation) frameStr += ` (${f.symbolLocation})`;
        }
        threadInfo.frames.push(frameStr);
      }
      if (t.triggered) {
        result.crashed_thread = t.id ?? t.index ?? 0;
      }
      result.threads!.push(threadInfo);
    }

    // Modules / binary images
    const images = data.binaryImages || data.usedImages;
    if (images && Array.isArray(images)) {
      result.loaded_modules = images.slice(0, 100).map((img: any) => ({
        name: img.name ?? img.path?.split('/').pop() ?? 'unknown',
        base: formatHex(img.base ?? img.loadAddress),
        size: formatHex(img.size),
      }));
    }

    // Unity info
    if (data.metadata?.unityVersion) {
      result.unity_version = data.metadata.unityVersion;
    }

    result.summary = result.crash_reason
      ? `iOS Crash (IPS): ${result.crash_reason}`
      : `iOS Crash (IPS): ${filename}`;

    // Handle truncated message
    if (data.isTruncated) {
      warnings.push('Report was truncated by the system');
    }

  } catch (e: any) {
    warnings.push(`Failed to parse IPS JSON: ${e.message}`);
    result.summary = `iOS Crash (IPS): ${filename} (parse error)`;
  }

  return result;
}

function parseLegacyCrash(content: string, filename: string): DumpInfo {
  const warnings: string[] = [];
  const result: DumpInfo = {
    type: 'ios_crash',
    summary: '',
    threads: [],
    loaded_modules: [],
    parse_warnings: warnings,
  };

  // Exception type and code
  const excMatch = content.match(
    /Exception Type:\s*(\S+(?:\s+\S+)?)\s*\n(?:.*\n)*?Exception Codes?:\s*(.+?)(?:\n|$)/i
  );
  if (excMatch) {
    result.crash_reason = excMatch[1].trim();
    result.signal = excMatch[2].trim();
  }

  // Termination reason (newer iOS)
  const termMatch = content.match(/Termination Reason:\s*(.+)/i);
  if (termMatch) {
    result.crash_reason = result.crash_reason
      ? `${result.crash_reason} — ${termMatch[1].trim()}`
      : termMatch[1].trim();
  }

  // Threads — each thread section starts with "Thread N:" or "Thread N name:"
  const threadRegex = /Thread\s+(\d+)(?:\s+([^:\n]*?))?\s*:\s*\n/g;
  let tMatch: RegExpExecArray | null;
  while ((tMatch = threadRegex.exec(content)) !== null) {
    const tid = parseInt(tMatch[1], 10);
    const name = tMatch[2]?.trim() || undefined;
    const sectionStart = tMatch.index + tMatch[0].length;
    const sectionEnd = findNextThreadOrEnd(content, sectionStart);

    const threadContent = content.substring(sectionStart, sectionEnd);
    const frames = parseIOSFrames(threadContent);

    const threadInfo: DumpThreadFrame = { index: tid, name, frames };
    result.threads!.push(threadInfo);

    // Check if this is the crashed thread
    if (
      threadContent.includes('Thread state') ||
      name?.toLowerCase().includes('crashed')
    ) {
      result.crashed_thread = tid;
    }
  }
  result.thread_count = result.threads!.length;

  // If no crashed thread identified, pick thread 0
  if (result.crashed_thread === undefined && result.threads!.length > 0) {
    result.crashed_thread = result.threads![0].index;
  }

  // Binary images
  const biSection = extractSection(content, /^Binary Images:\s*$/im, /^(?:\s*$|$)/);
  if (biSection) {
    const lines = biSection.split('\n').filter(l => l.trim());
    for (const line of lines) {
      // Format: "0x100000000 - 0x1000ffff +AppName (1.0) <uuid> /path/to/binary"
      const imgMatch = line.match(
        /(0x[0-9a-fA-F]+)\s*-\s*(0x[0-9a-fA-F]+)\s+(\+?[\w.]+).*?\(([^)]*)\).*?(?:\/|\\)([^/\s]+)$/
      );
      if (imgMatch) {
        result.loaded_modules!.push({
          name: imgMatch[5],
          base: imgMatch[1],
          size: formatHex(
            parseInt(imgMatch[2], 16) - parseInt(imgMatch[1], 16)
          ),
        });
      }
    }
  }

  if (result.loaded_modules?.length === 0) {
    delete result.loaded_modules;
  }
  if (result.threads?.length === 0) {
    delete result.threads;
  }

  result.summary = result.crash_reason
    ? `iOS Crash: ${result.crash_reason}`
    : `iOS Crash: ${filename}`;

  return result;
}

function parseIOSFrames(threadContent: string): string[] {
  const lines = threadContent.split('\n');
  const frames: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.match(/^\d+\s+/)) {
      // Format: "0  libfoo.dylib  0x1234  func + 42"
      frames.push(trimmed);
    }
  }
  return frames;
}

function findNextThreadOrEnd(content: string, start: number): number {
  const remaining = content.substring(start);
  const nextThread = remaining.search(/^Thread\s+\d+/m);
  return nextThread >= 0 ? start + nextThread : content.length;
}

function extractSection(
  content: string,
  startPattern: RegExp,
  _endPattern: RegExp
): string | null {
  const match = content.match(startPattern);
  if (!match || match.index === undefined) return null;
  const start = match.index;
  const remaining = content.substring(start + match[0].length);
  // End at double newline or end of content
  const endMatch = remaining.match(/\n\n/);
  return endMatch ? remaining.substring(0, endMatch.index!) : remaining;
}

function formatHex(n: number | string): string {
  if (typeof n === 'string') n = parseInt(n, 16);
  if (isNaN(n)) return '0x0';
  return '0x' + n.toString(16);
}
