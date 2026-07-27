// Dump type definitions

export type DumpType = 'minidump' | 'android_tombstone' | 'ios_crash' | 'unity_log' | 'unknown';

export interface DumpThreadFrame {
  index: number;
  name?: string;
  frames: string[];
}

export interface DumpModule {
  name: string;
  base: string;
  size: string;
}

export interface DumpInfo {
  type: DumpType;
  summary: string;
  crash_reason?: string;
  signal?: string;
  fault_address?: string;
  crashed_thread?: number;
  thread_count?: number;
  threads?: DumpThreadFrame[];
  loaded_modules?: DumpModule[];
  unity_version?: string;
  scene_name?: string;
  raw_header?: string;
  parse_warnings?: string[];
}

export const DUMP_INFO_VERSION = 1;
