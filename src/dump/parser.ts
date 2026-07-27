// Dump parser dispatcher — determines file type and delegates to the right parser

import type { DumpInfo } from './types.js';
import { parseTombstone } from './android.js';
import { parseIOSCrash } from './ios.js';
import { parseUnityLog } from './unity_log.js';
import { parseMinidump } from './minidump.js';

/**
 * Parse a file buffer as a crash dump.
 * Auto-detects the format based on filename extension and content heuristics.
 */
export function parseDump(
  buffer: Buffer,
  filename: string,
  contentType?: string
): DumpInfo | null {
  const lowerName = filename.toLowerCase();
  const name = lowerName.split('/').pop()?.split('\\').pop() ?? lowerName;

  // 1. Minidump — .dmp extension or binary signature
  if (name.endsWith('.dmp') || name.endsWith('.mdmp')) {
    return parseMinidump(buffer, filename);
  }
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x504d444d) {
    return parseMinidump(buffer, filename);
  }

  // 2. iOS .ips (JSON) — check extension first
  if (name.endsWith('.ips')) {
    return parseIOSCrash(buffer.toString('utf-8'), filename);
  }

  // 3. Content-type based detection
  const isText = contentType
    ? contentType.startsWith('text/') || contentType === 'application/octet-stream'
    : isTextBuffer(buffer);

  if (!isText) return null;

  const content = buffer.toString('utf-8');

  // 4. iOS .crash — begins with "Incident Identifier:" or "Date/Time:"
  if (name.endsWith('.crash')) {
    return parseIOSCrash(content, filename);
  }
  if (
    !name.endsWith('.log') &&
    !name.endsWith('.txt') &&
    content.match(/^(?:Incident Identifier|Date\/Time):/m)
  ) {
    return parseIOSCrash(content, filename);
  }

  // 5. Android tombstone — contains "Build fingerprint:" and "signal N" or "backtrace"
  if (
    content.includes('Build fingerprint:') ||
    (content.match(/signal\s+\d+\s+\(SIG[A-Z]+\)/) &&
      (content.includes('backtrace') || content.includes('pid:')))
  ) {
    return parseTombstone(content, filename);
  }

  // 6. Unity Player.log — contains "Initialize engine version" or "UnityEngine"
  if (
    name.includes('player') && name.endsWith('.log') ||
    name.includes('unity') && name.endsWith('.log') ||
    content.match(/Initialize engine version|UnityEngine|UnityEditor|Mono path/i)
  ) {
    return parseUnityLog(content, filename);
  }

  // 7. Generic .log with crash patterns
  if (
    name.endsWith('.log') &&
    (content.match(/\b(Exception|Error|Assertion)\b.*:/gi) || content.includes('at 0x'))
  ) {
    return parseUnityLog(content, filename);
  }

  return null;
}

/**
 * Check if a buffer is likely a text file.
 */
function isTextBuffer(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 512));
  for (let i = 0; i < sample.length; i++) {
    const byte = sample[i];
    // Allow common UTF-8 sequences, newlines, tabs
    if (byte === 0 && sample.length > 4 && sample.filter(b => b === 0).length > sample.length * 0.3) {
      return false; // too many nulls = binary
    }
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20 && byte !== 0x1b)) {
      return false; // control characters (not tab/newline/cr/esc)
    }
  }
  return true;
}
