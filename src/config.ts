import { createHash, randomBytes } from 'crypto';
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
  adminUsername: string;
  adminPasswordHash: string;
  sessionSecret: string;
  webhookUrl: string;
  webhookTimeoutMs: number;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword: string;
  alertEmailFrom: string;
  alertEmailTo: string;
  alertOnNewGroup: boolean;
  alertThresholdCount: number;
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

function envBool(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
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
  const adminUsername = env('ADMIN_USERNAME', 'admin');
  const adminPassword = env('ADMIN_PASSWORD', 'ghltbm123456');
  const adminPasswordHash = createHash('sha256').update(adminPassword).digest('hex');
  const sessionSecret = env('SESSION_SECRET', randomBytes(32).toString('hex'));
  const webhookUrl = env('WEBHOOK_URL', '');
  const webhookTimeoutMs = envInt('WEBHOOK_TIMEOUT_MS', 5000);
  const smtpHost = env('SMTP_HOST', '');
  const smtpPort = envInt('SMTP_PORT', 587);
  const smtpSecure = envBool('SMTP_SECURE', false);
  const smtpUser = env('SMTP_USER', '');
  const smtpPassword = env('SMTP_PASSWORD', '');
  const alertEmailFrom = env('ALERT_EMAIL_FROM', '');
  const alertEmailTo = env('ALERT_EMAIL_TO', '');
  const alertOnNewGroup = envBool('ALERT_ON_NEW_GROUP', true);
  const alertThresholdCount = envInt('ALERT_THRESHOLD_COUNT', 10);

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
    adminUsername,
    adminPasswordHash,
    sessionSecret,
    webhookUrl,
    webhookTimeoutMs,
    smtpHost,
    smtpPort,
    smtpSecure,
    smtpUser,
    smtpPassword,
    alertEmailFrom,
    alertEmailTo,
    alertOnNewGroup,
    alertThresholdCount,
  };
}

export const config = loadConfig();
