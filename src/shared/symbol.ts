/**
 * Detect symbol file type from filename.
 * Used by both symbol upload handler and symbolication service.
 */
export type SymbolFileType = 'symbol_map' | 'elf' | 'dsym' | 'unknown';

export function detectSymbolType(filename: string): SymbolFileType {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.sym.so') || lower.includes('.sym.') || lower.includes('symbol_map') || lower.endsWith('.symbols')) {
    return 'symbol_map';
  }
  if (lower.endsWith('.so') || lower.endsWith('.elf') || lower.endsWith('.o') || lower.endsWith('.a')) {
    return 'elf';
  }
  if (lower.endsWith('.dsym') || lower.endsWith('.dwarf') || lower.includes('dsym')) {
    return 'dsym';
  }
  return 'unknown';
}
