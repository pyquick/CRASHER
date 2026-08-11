import multer from 'multer';
import { randomBytes } from 'crypto';
import { readFileSync, unlinkSync } from 'fs';
import type { Request } from 'express';
import { config } from '../config.js';
import { parseDump } from '../dump/parser.js';

// ── Storage factories ──

export function createDiskStorage(destination: string) {
  return multer.diskStorage({
    destination,
    filename: (_req, file, cb) => {
      const unique = randomBytes(12).toString('hex');
      const ext = file.originalname.split('.').pop() ?? 'bin';
      cb(null, `${unique}.${ext}`);
    },
  });
}

export function createAttachmentStorage() {
  return createDiskStorage(config.attachmentsDir);
}

// ── Multer instance factories ──

export function createAttachmentUpload(maxFiles = 10) {
  return multer({
    storage: createAttachmentStorage(),
    limits: { fileSize: config.maxAttachmentSize, files: maxFiles },
  });
}

export function createMemoryUpload(maxFileSize: number, maxFiles = 1) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxFileSize, files: maxFiles },
  });
}

export function createCustomUpload(destination: string, maxFileSize: number, maxFiles = 1) {
  return multer({
    storage: createDiskStorage(destination),
    limits: { fileSize: maxFileSize, files: maxFiles },
  });
}

// ── File helpers ──

export function getUploadedFiles(req: Request): Express.Multer.File[] {
  const files = (req as any).files as Express.Multer.File[] | undefined;
  const singleFile = (req as any).file as Express.Multer.File | undefined;
  return files || (singleFile ? [singleFile] : []);
}

export function cleanupUploads(req: Request): void {
  for (const file of getUploadedFiles(req)) {
    try { unlinkSync(file.path); } catch {}
  }
}

/**
 * Parse dump files attached to the request. Returns JSON string if any dumps were parsed.
 */
export function parseAttachedDumps(req: Request): string {
  const allFiles = getUploadedFiles(req);
  if (allFiles.length === 0) return '';

  const parsedDumps: any[] = [];
  for (const file of allFiles) {
    try {
      const buffer = readFileSync(file.path);
      const dump = parseDump(buffer, file.originalname, file.mimetype);
      if (dump) parsedDumps.push({ source_file: file.originalname, ...dump });
    } catch (parseErr: any) {
      console.warn(`[dump] Parse error for ${file.originalname}:`, parseErr.message);
    }
  }
  return parsedDumps.length > 0 ? JSON.stringify(parsedDumps) : '';
}

// ── Request helpers ──

export function getClientIp(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

export function getContainerId(req: Request): number | null {
  return req.authUser?.container_id ?? null;
}

// ── Form field extraction ──

function fieldString(body: Record<string, unknown>, key: string): string {
  return String(body[key] ?? '');
}

export function extractCrashFormFields(body: Record<string, unknown>) {
  const input: Record<string, unknown> = {
    exception_type: fieldString(body, 'exception_type'),
    project_name: fieldString(body, 'project_name'),
    exception_message: fieldString(body, 'exception_message'),
    stack_trace: fieldString(body, 'stack_trace'),
    log_text: fieldString(body, 'log_text'),
    runtime: fieldString(body, 'runtime'),
    runtime_version: fieldString(body, 'runtime_version'),
    framework: fieldString(body, 'framework'),
    environment: fieldString(body, 'environment'),
    server_name: fieldString(body, 'server_name'),
    release: fieldString(body, 'release'),
    error_severity: fieldString(body, 'error_severity'),
    unity_version: fieldString(body, 'unity_version'),
    platform: fieldString(body, 'platform'),
    device_model: fieldString(body, 'device_model'),
    os_version: fieldString(body, 'os_version'),
    gpu_name: fieldString(body, 'gpu_name'),
    cpu_name: fieldString(body, 'cpu_name'),
    app_version: fieldString(body, 'app_version'),
    bundle_id: fieldString(body, 'bundle_id'),
    scene_name: fieldString(body, 'scene_name'),
    client_timestamp: fieldString(body, 'client_timestamp'),
    build_guid: fieldString(body, 'build_guid'),
  };
  if (body.memory_mb) input.memory_mb = parseInt(String(body.memory_mb), 10) || 0;
  if (body.custom_data) {
    try { input.custom_data = typeof body.custom_data === 'string' ? JSON.parse(body.custom_data) : body.custom_data; }
    catch { input.custom_data = String(body.custom_data); }
  }
  return input;
}

export function extractFeedbackFormFields(body: Record<string, unknown>) {
  const input: Record<string, unknown> = {
    title: fieldString(body, 'title'),
    description: fieldString(body, 'description'),
    category: fieldString(body, 'category'),
    severity: fieldString(body, 'severity'),
    player_id: fieldString(body, 'player_id') || undefined,
    player_name: fieldString(body, 'player_name') || undefined,
    contact: fieldString(body, 'contact') || undefined,
    app_version: fieldString(body, 'app_version') || undefined,
    platform: fieldString(body, 'platform') || undefined,
    device_model: fieldString(body, 'device_model') || undefined,
    scene_name: fieldString(body, 'scene_name') || undefined,
    client_timestamp: fieldString(body, 'client_timestamp') || undefined,
  };
  if (body.custom_data) {
    try { input.custom_data = typeof body.custom_data === 'string' ? JSON.parse(body.custom_data) : body.custom_data; }
    catch { input.custom_data = String(body.custom_data); }
  }
  return input;
}
