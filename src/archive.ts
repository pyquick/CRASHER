// ── Archive Module ──
// Tar + gzip packing/unpacking using only Node.js built-in modules.
// No external dependencies needed.

import { createWriteStream, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'fs';
import { createGzip, gunzipSync, gzipSync } from 'zlib';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

// ── Types ──

export interface TarEntry {
  name: string;
  data?: Buffer | string;
  filePath?: string;     // read from disk
  mode?: number;
  mtime?: Date;
  size?: number;         // must provide for filePath entries
}

export interface ExtractedEntry {
  name: string;
  data: Buffer;
}

// ── Simple Tar Writer (POSIX ustar format) ──

function padOctal(n: number, len: number): string {
  return n.toString(8).padStart(len, '0');
}

function checksum(header: Buffer): number {
  // Set checksum field to spaces
  for (let i = 148; i < 156; i++) header[i] = 0x20;
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  return sum;
}

function createTarHeader(name: string, size: number, typeFlag: string = '0'): Buffer {
  const header = Buffer.alloc(512);
  if (name.length > 100) {
    // Use USTAR prefix — only needed for very long names
    // For simplicity, truncate and log a warning
    const parts = name.split('/');
    if (parts.length > 1) {
      const fn = parts.pop()!;
      const prefix = parts.join('/');
      header.write(prefix, 345, 155, 'utf-8');
      header.write(fn, 0, 100, 'utf-8');
    } else {
      header.write(name.substring(0, 99), 0, 99, 'utf-8');
    }
  } else {
    header.write(name, 0, 100, 'utf-8');
  }

  header.write(padOctal(0o644, 7), 100, 'utf-8');
  header.write(padOctal(0, 7), 108, 'utf-8');
  header.write(padOctal(0, 7), 116, 'utf-8');
  header.write(padOctal(size, 12), 124, 'utf-8');
  header.write(padOctal(Math.floor(Date.now() / 1000), 12), 136, 'utf-8');
  header.write('        ', 148, 'utf-8'); // checksum placeholder
  header.write(typeFlag, 156, 'utf-8');
  header.write('ustar\x0000', 257, 'utf-8');
  header.write('user', 265, 32, 'utf-8');
  header.write('group', 297, 32, 'utf-8');

  const sum = checksum(header);
  // Set padded octal checksum with null terminator
  const sumStr = padOctal(sum, 6) + '\x00 ';
  header.write(sumStr, 148, 'utf-8');

  return header;
}

/**
 * Write multiple entries into a .tar.gz file on disk.
 * Returns the path to the temp file.
 */
export function createTarGz(entries: TarEntry[]): string {
  const tmpPath = join(tmpdir(), `crashpkg-${randomBytes(8).toString('hex')}.tar.gz`);
  const tarPath = tmpPath.replace('.gz', '');

  try {
    // Write tar
    const chunks: Buffer[] = [];
    for (const entry of entries) {
      let data: Buffer;
      if (entry.data !== undefined) {
        data = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf-8') : entry.data;
      } else if (entry.filePath && existsSync(entry.filePath)) {
        data = readFileSync(entry.filePath);
      } else {
        data = Buffer.alloc(0);
      }
      const size = data.length;
      const header = createTarHeader(entry.name, size, '0');

      chunks.push(header);
      chunks.push(data);

      // Pad to 512-byte boundary
      const pad = (512 - (size % 512)) % 512;
      if (pad > 0) chunks.push(Buffer.alloc(pad));
    }

    // Two empty 512-byte blocks mark end of tar
    chunks.push(Buffer.alloc(1024));

    const tarData = Buffer.concat(chunks);
    const gzipped = gzipSync(tarData);
    writeFileSync(tmpPath, gzipped);

    return tmpPath;
  } catch (err) {
    try { unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

/**
 * Extract a .tar.gz file (from a Buffer or file path) and return the list of entries.
 * Uses in-memory parsing — no external tools needed.
 */
export function extractTarGzFile(filePath: string): ExtractedEntry[] {
  const compressed = readFileSync(filePath);
  return extractTarGz(compressed);
}

/**
 * Extract a .tar.gz buffer and return the list of entries.
 */
export function extractTarGz(buffer: Buffer): ExtractedEntry[] {
  const maxArchiveSize = 256 * 1024 * 1024;
  const decompressed = gunzipSync(buffer, { maxOutputLength: maxArchiveSize });
  return parseTar(decompressed);
}

/**
 * Parse a tar archive into { name, data } entries.
 */
function parseTar(buffer: Buffer): ExtractedEntry[] {
  const entries: ExtractedEntry[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (entries.length >= 10000) throw new Error('Archive contains too many entries');
    if (offset + 512 > buffer.length) throw new Error('Truncated tar header');
    // Each tar header is 512 bytes
    const header = buffer.subarray(offset, offset + 512);

    // Detect end-of-archive (all zeros)
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) { allZero = false; break; }
    }
    if (allZero) break;

    // Read name
    let name = '';
    for (let i = 0; i < 100; i++) {
      if (header[i] === 0) break;
      name += String.fromCharCode(header[i]);
    }

    // Read size (octal at bytes 124-135)
    let sizeStr = '';
    for (let i = 124; i < 136; i++) {
      if (header[i] === 0 || header[i] === 0x20) break;
      sizeStr += String.fromCharCode(header[i]);
    }
    const size = parseInt(sizeStr, 8) || 0;
    if (!Number.isSafeInteger(size) || size < 0 || size > 100 * 1024 * 1024) {
      throw new Error('Invalid or oversized tar entry');
    }
    if (offset + 512 + size > buffer.length) throw new Error('Truncated tar entry');

    // Check USTAR prefix for long filenames
    let prefix = '';
    for (let i = 345; i < 500; i++) {
      if (header[i] === 0) break;
      prefix += String.fromCharCode(header[i]);
    }
    if (prefix) {
      name = prefix + '/' + name;
    }

    // Read type flag
    const typeFlag = String.fromCharCode(header[156]);

    // Skip directories and non-regular files
    if (typeFlag === '5' || typeFlag === '0' || typeFlag === '\x00') {
      if (typeFlag === '0' || typeFlag === '\x00') {
        // Regular file
        const dataOffset = offset + 512;
        const data = buffer.subarray(dataOffset, dataOffset + size);

        // Normalize name (strip leading ./ if any)
        const cleanName = name.replace(/^\.?\//, '').replace(/\/+/g, '/');
        entries.push({ name: cleanName, data: Buffer.from(data) });
      }
    }

    // Advance: header (512) + data rounded up to 512
    const blocks = Math.ceil(size / 512);
    offset += 512 + blocks * 512;
  }

  return entries;
}

/**
 * Clean up a temp archive file.
 */
export function cleanupArchive(filePath: string): void {
  try { unlinkSync(filePath); } catch {}
}
