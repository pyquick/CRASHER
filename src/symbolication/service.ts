import { existsSync } from 'fs';
import { platform as hostPlatform } from 'os';
import * as store from '../store.js';
import { resolveDsym } from './dsym.js';
import { resolveElf } from './elf.js';
import { resolveSymbolMap } from './symbol_map.js';
import type { SymbolicatedFrame, SymbolicationResult, SymbolType } from './types.js';

function extractAddresses(text: string): string[] {
  const matches = text.match(/0x[0-9a-fA-F]{6,}/g) ?? [];
  return [...new Set(matches)].slice(0, 50);
}

function getSymbolType(symbol: { symbol_type?: string; filename: string }): SymbolType {
  if (symbol.symbol_type && symbol.symbol_type !== 'unknown') return symbol.symbol_type as SymbolType;
  const lower = symbol.filename.toLowerCase();
  if (lower.includes('symbolmap') || lower.endsWith('.map') || lower.endsWith('.txt')) return 'symbol_map';
  if (lower.endsWith('.dsym') || lower.endsWith('.zip')) return 'dsym';
  if (lower.endsWith('.so') || lower.endsWith('.sym') || lower.endsWith('.dbg')) return 'elf';
  return 'unknown';
}

/** Symbolicate Unity IL2CPP addresses using the matching uploaded symbol file. */
export async function symbolicateUnityCrash(input: {
  runtime?: string;
  platform?: string;
  build_guid?: string;
  stack_trace?: string;
  log_text?: string;
}): Promise<SymbolicationResult> {
  if (input.runtime !== 'unity') {
    return { status: 'not_applicable', stack: '', frames: [], warnings: [] };
  }

  const rawStack = [input.stack_trace, input.log_text].filter(Boolean).join('\n');
  const addresses = extractAddresses(rawStack);
  if (addresses.length === 0) {
    return { status: 'unavailable', stack: '', frames: [], warnings: ['No IL2CPP addresses found in crash data'] };
  }
  if (!input.build_guid) {
    return { status: 'unavailable', stack: '', frames: [], warnings: ['Missing build_guid; cannot select matching symbols'] };
  }

  const symbols = store.listSymbols({ platform: input.platform, build_guid: input.build_guid, page: 1, page_size: 20 }).items;
  const symbol = symbols[0];
  if (!symbol || !existsSync(symbol.file_path)) {
    return { status: 'unavailable', stack: '', frames: [], warnings: ['No matching symbol file uploaded for this platform and build_guid'] };
  }

  const symbolType = getSymbolType(symbol);
  const warnings: string[] = [];
  let frames: SymbolicatedFrame[] = [];

  if (symbolType === 'symbol_map') {
    frames = resolveSymbolMap(symbol.file_path, addresses);
  } else if (symbolType === 'elf') {
    const tool = process.env.ADDR2LINE_PATH || 'llvm-addr2line';
    frames = await resolveElf(symbol.file_path, addresses, tool);
    if (frames.length === 0) warnings.push(`No symbols resolved with ${tool}; verify the ELF file and address base`);
  } else if (symbolType === 'dsym') {
    if (hostPlatform() !== 'darwin') {
      warnings.push('iOS dSYM symbolication requires a macOS worker with atos');
    } else {
      frames = await resolveDsym(symbol.file_path, addresses, undefined);
    }
  } else {
    warnings.push('Unsupported symbol file type');
  }

  const stack = frames.map(frame => `${frame.method ?? frame.address}${frame.source ? ` (${frame.source})` : ''}`).join('\n');
  const resolved = frames.filter(frame => frame.method);
  return {
    status: resolved.length === 0 ? (warnings.length ? 'failed' : 'unavailable') : (resolved.length < addresses.length ? 'partial' : 'symbolicated'),
    method: resolved[0]?.method,
    stack,
    frames,
    symbol_id: symbol.id,
    warnings,
  };
}
