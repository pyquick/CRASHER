// Unity Player.log parser
// Extracts: exception lines, stack traces, scene switches, Unity version

import type { DumpInfo } from './types.js';

export function parseUnityLog(content: string, filename: string): DumpInfo {
  const warnings: string[] = [];
  const result: DumpInfo = {
    type: 'unity_log',
    summary: '',
    threads: [],
    parse_warnings: warnings,
  };

  // Extract Unity version
  const versionMatch = content.match(
    /(?:Initialize engine version|Unity\s+version)\s*:?\s*([\d.]+[a-zA-Z]\d*)/i
  );
  if (versionMatch) {
    result.unity_version = versionMatch[1];
  }

  // Extract scene name from scene loading lines
  const sceneMatch = content.match(
    /Level\s+\S+\s+loaded|Unloading\s+\d+\s+unused\s+Assets|Scene\s+'([^']+)'/i
  );
  if (sceneMatch) {
    result.scene_name = sceneMatch[1] || sceneMatch[0];
  }

  // Find all Exception lines
  const exceptionLines: string[] = [];
  const exceptionPattern = /(.*?(?:Exception|Error|Assertion).*?:\s*.*)/gi;
  let excMatch: RegExpExecArray | null;
  while ((excMatch = exceptionPattern.exec(content)) !== null) {
    const line = excMatch[1].trim();
    if (line.length > 2 && line.length < 500) {
      exceptionLines.push(line);
    }
  }

  // Find stack traces
  const stackTraces: string[][] = [];
  const stackStartPattern = /^\s*(?:at\s+|Rethrow\s+at|\(at\s+)/gm;
  let ssMatch: RegExpExecArray | null;
  let lastIdx = -1;

  while ((ssMatch = stackStartPattern.exec(content)) !== null) {
    const startIdx = ssMatch.index;
    if (startIdx > lastIdx) {
      const remaining = content.substring(startIdx);
      const lines = remaining.split('\n');
      const frames: string[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) break;
        if (frames.length > 0 && !trimmed.match(/^\s*(?:at\s+|\.{3}\s|\[0x[0-9a-fA-F]+\])/)) break;
        if (trimmed.match(/^\s*(?:at\s+|\.{3}\s|\w+\.\w+\s*\(|Rethrow|\(wrapper)/)) {
          frames.push(trimmed);
        } else if (trimmed.match(/^\[0x[0-9a-fA-F]+\]/)) {
          frames.push(trimmed);
        }
      }
      if (frames.length > 0) {
        stackTraces.push(frames);
      }
      lastIdx = startIdx;
    }
  }

  // Build thread info
  if (exceptionLines.length > 0 || stackTraces.length > 0) {
    const frames: string[] = [];

    // Add exception lines as header
    for (const line of exceptionLines.slice(0, 5)) {
      frames.push(`EXCEPTION: ${line}`);
    }

    // Add first stack trace
    const primaryStack = stackTraces[0] || [];
    for (const frame of primaryStack.slice(0, 50)) {
      frames.push(`  ${frame}`);
    }

    if (frames.length > 0) {
      result.threads = [{ index: 0, name: 'Main', frames }];
      result.thread_count = 1;
    }

    if (exceptionLines.length > 0) {
      // Extract crash reason from first exception line
      const first = exceptionLines[0];
      const colonIdx = first.indexOf(':');
      result.crash_reason = colonIdx > 0
        ? first.substring(0, colonIdx).trim()
        : first.trim();
    }
  }

  // Extract memory info
  const memMatch = content.match(/Used\s+memory\s+from\s+profiler\s*[:\s]*([\d.]+)\s*(MB|GB)/i);
  if (memMatch) {
    result.raw_header = `Memory: ${memMatch[1]} ${memMatch[2]}`;
  }

  // Extra stack traces become additional threads
  for (let i = 1; i < stackTraces.length; i++) {
    result.threads!.push({
      index: i,
      name: `Stack ${i + 1}`,
      frames: stackTraces[i].map(f => `  ${f}`),
    });
  }
  result.thread_count = result.threads!.length;

  if (result.threads?.length === 0) {
    delete result.threads;
  }

  result.summary = result.crash_reason
    ? `Unity Log: ${result.crash_reason} (v${result.unity_version || '?'})`
    : `Unity Log: ${filename}`;

  return result;
}
