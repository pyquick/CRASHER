import { execFile } from 'child_process';
import { platform } from 'os';
import { promisify } from 'util';
import type { SymbolicatedFrame } from './types.js';

const execFileAsync = promisify(execFile);

/** Resolve Mach-O addresses with atos. This is available only on macOS. */
export async function resolveDsym(
  executable: string,
  addresses: string[],
  loadAddress: string | undefined
): Promise<SymbolicatedFrame[]> {
  if (platform() !== 'darwin') return [];

  const frames: SymbolicatedFrame[] = [];
  for (const address of addresses) {
    const match = address.match(/0x([0-9a-fA-F]+)/i);
    if (!match) continue;
    try {
      const args = ['-o', executable];
      if (loadAddress) args.push('-l', loadAddress);
      args.push(`0x${match[1]}`);
      const { stdout } = await execFileAsync('atos', args, { timeout: 5000, maxBuffer: 1024 * 1024 });
      const method = stdout.trim();
      if (method && !method.startsWith('0x')) frames.push({ address, method });
    } catch {
      // The service returns a partial result with warning instead of failing ingestion.
    }
  }
  return frames;
}
