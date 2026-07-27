import { randomBytes } from 'crypto';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Config {
  port: number;
  dataDir: string;
  dbPath: string;
  symbolsDir: string;
  attachmentsDir: string;
  maxLogSize: number;
  maxAttachmentSize: number;
  corsOrigins: string[];
  authToken: string;
}

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v !== undefined) {
    const n = parseInt(v, 10);
    if (!isNaN(n)) return n;
  }
  return fallback;
}

function randomToken(): string {
  return randomBytes(16).toString('hex');
}

function loadConfig(): Config {
  const port = envInt('PORT', 8080);
  const dataDir = resolve(env('DATA_DIR', resolve(__dirname, '..', '..', 'data')));
  const dbPath = env('DB_PATH', resolve(dataDir, 'crash_reports.db'));
  const symbolsDir = env('SYMBOLS_DIR', resolve(dataDir, 'symbols'));
  const attachmentsDir = env('ATTACHMENTS_DIR', resolve(dataDir, 'attachments'));
  const maxLogSize = envInt('MAX_LOG_SIZE', 10 * 1024 * 1024); // 10MB
  const maxAttachmentSize = envInt('MAX_ATTACHMENT_SIZE', 20 * 1024 * 1024); // 20MB
  const corsOrigins = env('CORS_ORIGINS', '*').split(',').map(s => s.trim());
  const authToken = env('AUTH_TOKEN', randomToken());

  return {
    port,
    dataDir,
    dbPath,
    symbolsDir,
    attachmentsDir,
    maxLogSize,
    maxAttachmentSize,
    corsOrigins,
    authToken,
  };
}

export const config = loadConfig();
