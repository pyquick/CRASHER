import { readFileSync } from 'fs';
import type { SymbolicatedFrame } from './types.js';

interface SymbolMapEntry {
  address: bigint;
  method: string;
  source?: string;
}

const cache = new Map<string, SymbolMapEntry[]>();

/**
 * Resolve IL2CPP addresses from a text symbol map.
 * Supported lines include:
 *   0x00123456 Namespace.Type::Method()
 *   00123456 Namespace.Type.Method
 *   0x00123456 Namespace.Type::Method() (Assets/Scripts/File.cs:42)
 */
export function resolveSymbolMap(filePath: string, addresses: string[]): SymbolicatedFrame[] {
  const entries = loadSymbolMap(filePath);
  return addresses.flatMap(address => {
    const value = parseAddress(address);
    if (value === null) return [];
    const entry = findNearestEntry(entries, value);
    if (!entry) return [];
    return [{ address, method: entry.method, source: entry.source }];
  });
}

function loadSymbolMap(filePath: string): SymbolMapEntry[] {
  const cached = cache.get(filePath);
  if (cached) return cached;

  const entries: SymbolMapEntry[] = [];
  const content = readFileSync(filePath, 'utf-8');
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:0x)?([0-9a-fA-F]+)\s+(.+?)\s*$/);
    if (!match) continue;

    const address = BigInt(`0x${match[1]}`);
    let description = match[2].trim();
    let source: string | undefined;
    const sourceMatch = description.match(/\s+\(([^()]+:\d+)\)$/);
    if (sourceMatch) {
      source = sourceMatch[1];
      description = description.slice(0, sourceMatch.index).trim();
    }
    if (description) entries.push({ address, method: description, source });
  }

  entries.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  cache.set(filePath, entries);
  return entries;
}

function findNearestEntry(entries: SymbolMapEntry[], address: bigint): SymbolMapEntry | undefined {
  let low = 0;
  let high = entries.length - 1;
  let result: SymbolMapEntry | undefined;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const entry = entries[mid];
    if (entry.address <= address) {
      result = entry;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result;
}

export function parseAddress(value: string): bigint | null {
  const match = value.match(/0x([0-9a-fA-F]+)/i) ?? value.match(/\b([0-9a-fA-F]{6,})\b/);
  if (!match) return null;
  try {
    return BigInt(`0x${match[1]}`);
  } catch {
    return null;
  }
}
