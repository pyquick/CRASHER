// Windows Minidump (.dmp) binary parser
// Reads the MDMP format directly — see https://msdn.microsoft.com/en-us/library/ms680378.aspx
//
// Minidump file structure:
//   MINIDUMP_HEADER (32 bytes)
//   Stream directory entries
//   Stream data (each at file offset)

import type { DumpInfo, DumpThreadFrame } from './types.js';

const SIG = 0x504d444d; // 'MDMP'

// Stream types
const StreamType = {
  ThreadList: 3,
  ModuleList: 4,
  MemoryList: 5,
  Exception: 6,
  SystemInfo: 7,
  ThreadExList: 9,
  Memory64List: 10,
  MiscInfo: 15,
  MemoryInfoList: 16,
  ThreadInfoList: 17,
} as const;

interface StreamDir {
  type: number;
  offset: number;
  size: number;
}

export function parseMinidump(buf: Buffer, filename: string): DumpInfo {
  const warnings: string[] = [];
  const result: DumpInfo = {
    type: 'minidump',
    summary: '',
    threads: [],
    loaded_modules: [],
    parse_warnings: warnings,
  };

  try {
    if (buf.length < 32) {
      warnings.push('File too small to be a valid minidump');
      result.summary = `Minidump: ${filename} (invalid file)`;
      return result;
    }

    // Read header
    const signature = buf.readUInt32LE(0);
    if (signature !== SIG) {
      warnings.push('Not a valid MDMP signature');
      result.summary = `Minidump: ${filename} (not a minidump file)`;
      return result;
    }

    const versionLo = buf.readUInt16LE(4);
    const versionHi = buf.readUInt16LE(6);
    const streamCount = buf.readUInt32LE(8);
    const streamDirRva = buf.readUInt32LE(12);

    // Read stream directory
    const streams: StreamDir[] = [];
    for (let i = 0; i < streamCount; i++) {
      const offset = streamDirRva + i * 12;
      if (offset + 12 > buf.length) break;
      streams.push({
        type: buf.readUInt32LE(offset),
        offset: buf.readUInt32LE(offset + 4),
        size: buf.readUInt32LE(offset + 8),
      });
    }

    // Parse SystemInfo
    const sysStream = streams.find(s => s.type === StreamType.SystemInfo);
    if (sysStream && sysStream.offset + 56 <= buf.length) {
      const off = sysStream.offset;
      const procArch = buf.readUInt16LE(off);
      const procLevel = buf.readUInt16LE(off + 2);
      const procRev = buf.readUInt16LE(off + 4);
      const cpuCount = buf[off + 6];
      const major = buf.readUInt32LE(off + 8);
      const minor = buf.readUInt32LE(off + 12);
      const build = buf.readUInt32LE(off + 16);
      const platformId = buf.readUInt32LE(off + 20);

      const archNames: Record<number, string> = {
        0: 'x86', 5: 'ARM', 9: 'AMD64', 12: 'ARM64',
      };

      result.raw_header = [
        `OS Version: ${major}.${minor}.${build}`,
        `Platform: ${platformId === 2 ? 'Windows NT' : `ID ${platformId}`}`,
        `Architecture: ${archNames[procArch] || `unknown (${procArch})`}`,
        `CPU Count: ${cpuCount}`,
        `Processor: ${procLevel}.${procRev}`,
        `MDMP Version: ${versionHi}.${versionLo}`,
      ].join('\n');
    }

    // Parse Exception
    const excStream = streams.find(s => s.type === StreamType.Exception);
    if (excStream && excStream.offset + 16 <= buf.length) {
      const off = excStream.offset;
      const threadId = buf.readUInt32LE(off);
      result.crashed_thread = threadId;

      // ExceptionRecord at offset 4
      const erOff = off + 4;
      if (erOff + 24 <= buf.length) {
        const excCode = buf.readUInt32LE(erOff);
        const excFlags = buf.readUInt32LE(erOff + 4);
        const excAddrOff = erOff + 12;

        // Read exception address based on pointer size (32 or 64 bit)
        const is64 = buf.readUInt16LE(6) >= 513;
        let excAddr: string;
        if (is64) {
          excAddr = '0x' + buf.readBigUInt64LE(excAddrOff).toString(16);
        } else {
          excAddr = '0x' + buf.readUInt32LE(excAddrOff).toString(16);
        }

        result.fault_address = excAddr;
        // Map common exception codes to names
        result.crash_reason = codeToName(excCode);
        result.signal = `0x${excCode.toString(16).toUpperCase()}`;

        // Read exception flags
        if (excFlags & 1) result.signal += ' (continuable)';
      }
    }

    // Parse ThreadList
    const threadStream = streams.find(s =>
      s.type === StreamType.ThreadList || s.type === StreamType.ThreadExList
    );
    if (threadStream && threadStream.offset + 4 <= buf.length) {
      const off = threadStream.offset;
      const threadCount = buf.readUInt32LE(off);
      result.thread_count = threadCount;

      result.threads = [];
      for (let i = 0; i < Math.min(threadCount, 50); i++) {
        const tOff = off + 4 + i * 48; // each THREAD is 48 bytes
        if (tOff + 48 > buf.length) break;

        const threadId = buf.readUInt32LE(tOff);
        const threadFrame: DumpThreadFrame = {
          index: threadId,
          frames: [`Thread ID: ${threadId}`, `Suspend count: ${buf.readUInt32LE(tOff + 4)}`],
        };

        // Read stack memory — limited to what we can show without full unwind
        const stackStart = buf.readUInt32LE(tOff + 20);
        const stackSize = buf.readUInt32LE(tOff + 36);

        if (threadId === result.crashed_thread) {
          threadFrame.name = 'Crashed';
        }

        threadFrame.frames.push(
          `Stack: 0x${stackStart.toString(16)}, Size: ${stackSize} bytes`
        );

        // If we have Memory64List or MemoryList, we can hint at resolved stack
        const memStream = streams.find(s =>
          s.type === StreamType.Memory64List || s.type === StreamType.MemoryList
        );
        if (memStream) {
          threadFrame.frames.push(
            '[Memory dump available — use minidump_stackwalk for full stack trace]'
          );
        }

        result.threads.push(threadFrame);
      }
    }

    // Parse ModuleList
    const modStream = streams.find(s => s.type === StreamType.ModuleList);
    if (modStream && modStream.offset + 4 <= buf.length) {
      const off = modStream.offset;
      const moduleCount = buf.readUInt32LE(off);

      // In MDMP format, each module is MODULE_SIZE bytes (around 108+)
      // We need to read RVAs and then read strings from the file
      // MODULE: BaseOfImage(u32), SizeOfImage(u32), CheckSum(u32), TimeDateStamp(u32),
      //         ModuleNameRva(u32), VersionInfo(16 bytes), CvRecord(8+u32), MiscRecord(u32),
      //         Reserved0(2xu32), Reserved1(2xu32)
      let currentOff = off + 4;
      for (let i = 0; i < Math.min(moduleCount, 100); i++) {
        if (currentOff + 64 > buf.length) break;

        const baseOfImage = buf.readBigUInt64LE ? buf.readBigUInt64LE(currentOff) : BigInt(buf.readUInt32LE(currentOff));
        const sizeOfImage = buf.readUInt32LE(currentOff + 8);
        const moduleNameRva = buf.readUInt32LE(currentOff + 24);

        // Read module name from the RVA
        let name = `module_${i}`;
        let nameOff = moduleNameRva;
        // For .dmp files, RVAs are file offsets (or we need to locate by matching stream ranges)
        // We try reading UTF-16 string at the RVA position
        try {
          if (nameOff > 0 && nameOff < buf.length) {
            name = readWideString(buf, nameOff);
          }
        } catch {
          // fallback
        }

        result.loaded_modules!.push({
          name: name || `module_${i}`,
          base: '0x' + baseOfImage.toString(16),
          size: '0x' + sizeOfImage.toString(16),
        });

        // Size of MODULE struct varies. We look for the next module in a safe way:
        // Standard MDMP module is 108 bytes (32-bit fields) or 148 bytes for some variants
        // Use 108 as safe default for older format
        currentOff += 108;
      }
    }

    if (result.loaded_modules?.length === 0) {
      delete result.loaded_modules;
    }
    if (result.threads?.length === 0) {
      delete result.threads;
    }

    result.summary = result.crash_reason
      ? `Minidump: ${result.crash_reason} (threads: ${result.thread_count ?? 0})`
      : `Minidump: ${filename} (threads: ${result.thread_count ?? 0})`;

    // Note about full symbolication
    if (result.threads && result.threads.length > 0) {
      warnings.push(
        'For full stack unwinding with function names, use minidump_stackwalk tool ' +
        '(included with Google Breakpad) or re-upload with symbols'
      );
    }

  } catch (e: any) {
    warnings.push(`Minidump parse error: ${e.message}`);
    result.summary = `Minidump: ${filename} (parse error)`;
  }

  return result;
}

function readWideString(buf: Buffer, offset: number): string {
  const chars: number[] = [];
  for (let i = 0; i < 256; i++) {
    const chOff = offset + i * 2;
    if (chOff + 1 >= buf.length) break;
    const ch = buf.readUInt16LE(chOff);
    if (ch === 0) break;
    chars.push(ch);
  }
  return String.fromCodePoint(...chars);
}

function codeToName(code: number): string {
  const map: Record<number, string> = {
    0x80000003: 'BREAKPOINT',
    0x80000004: 'SINGLE_STEP',
    0xC0000005: 'ACCESS_VIOLATION',
    0xC0000006: 'IN_PAGE_ERROR',
    0xC0000017: 'NO_MEMORY',
    0xC000001D: 'ILLEGAL_INSTRUCTION',
    0xC0000025: 'NONCONTINUABLE_EXCEPTION',
    0xC0000026: 'INVALID_DISPOSITION',
    0xC000008C: 'ARRAY_BOUNDS_EXCEEDED',
    0xC000008D: 'FLOAT_DENORMAL_OPERAND',
    0xC000008E: 'FLOAT_DIVIDE_BY_ZERO',
    0xC000008F: 'FLOAT_INEXACT_RESULT',
    0xC0000090: 'FLOAT_INVALID_OPERATION',
    0xC0000091: 'FLOAT_OVERFLOW',
    0xC0000092: 'FLOAT_STACK_CHECK',
    0xC0000093: 'FLOAT_UNDERFLOW',
    0xC0000094: 'INTEGER_DIVIDE_BY_ZERO',
    0xC0000095: 'INTEGER_OVERFLOW',
    0xC0000096: 'PRIVILEGED_INSTRUCTION',
    0xC00000FD: 'STACK_OVERFLOW',
    0xC0000135: 'DLL_NOT_FOUND',
    0xC0000139: 'ENTRYPOINT_NOT_FOUND',
    0xC000013A: 'CONTROL_C_EXIT',
    0xC0000142: 'DLL_INIT_FAILED',
    0xC00002B4: 'WAKE_SYSTEM',
    0xE06D7363: 'C++ EH_EXCEPTION',
    0xE0434352: 'CLR_EXCEPTION',
  };
  return map[code] || `Exception 0x${code.toString(16).toUpperCase()}`;
}
