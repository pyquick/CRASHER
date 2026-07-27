import { execFile } from 'child_process';
import { promisify } from 'util';
import type { SymbolicatedFrame } from './types.js';

const execFileAsync = promisify(execFile);

/** Resolve addresses with llvm-addr2line/addr2line against an ELF or debug file. */
export async function resolveElf(
  executable: string,
  addresses: string[],
  tool: string
): Promise<SymbolicatedFrame[]> {
  const frames: SymbolicatedFrame[] = [];
  for (const address of addresses) {
    const hex = normalizeAddress(address);
    if (!hex) continue;
    try {
      const { stdout } = await execFileAsync(tool, ['-C', '-f', '-e', executable, hex], {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      });
      const [method, source] = stdout.trim().split(/\r?\n/);
      if (method && method !== '??') frames.push({ address: hex, method, source: source !== '??:0' ? source : undefined });
    } catch {
      // The service returns a partial result with warning instead of failing ingestion.
    }
  }
  return frames;
}

function normalizeAddress(value: string): string | undefined {
  const match = value.match(/0x([0-9a-fA-F]+)/i) ?? value.match(/\b([0-9a-fA-F]{6,})\b/);
  return match ? `0x${match[1]}` : undefined;
}
