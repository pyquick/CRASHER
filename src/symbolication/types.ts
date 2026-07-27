export type SymbolType = 'symbol_map' | 'elf' | 'dsym' | 'unknown';
export type SymbolicationStatus = 'symbolicated' | 'partial' | 'unavailable' | 'failed' | 'not_applicable';

export interface SymbolicatedFrame {
  address: string;
  method?: string;
  source?: string;
  module?: string;
  symbol_id?: number;
}

export interface SymbolicationResult {
  status: SymbolicationStatus;
  method?: string;
  stack: string;
  frames: SymbolicatedFrame[];
  symbol_id?: number;
  warnings: string[];
}
