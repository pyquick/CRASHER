import 'dotenv/config';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Config {
  port: number;
  dataDir: string;
  dbPath: string;
  symbolsDir: string;
  attachmentsDir: string;
  sourcesDir: string;
  maxLogSize: number;
  maxAttachmentSize: number;
  maxSourceFileSize: number;
  maxSourceArchiveSize: number;
  maxSourceFiles: number;
  maxJsonBodySize: number;
  corsOrigins: string[];
  cookieSecure: boolean;
  sessionHours: number;
  apiRequireKey: boolean;
  trustProxy: boolean | number | string;
  loginRateLimit: number;
  ingestRateLimit: number;
  apiRateLimit: number;
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
  baseUrl: string;
  smsProvider: string;
  smsApiKey: string;
  smsApiSecret: string;
  smsFrom: string;
}

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const value = process.env[key];
  if (value !== undefined) {
    const parsed = parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function loadConfig(): Config {
  const port = envInt('PORT', 8080);
  const dataDir = resolve(env('DATA_DIR', resolve(__dirname, '..', 'data')));
  const dbPath = env('DB_PATH', resolve(dataDir, 'crash_reports.db'));
  const symbolsDir = env('SYMBOLS_DIR', resolve(dataDir, 'symbols'));
  const attachmentsDir = env('ATTACHMENTS_DIR', resolve(dataDir, 'attachments'));
  const sourcesDir = env('SOURCES_DIR', resolve(dataDir, 'sources'));
  const maxLogSize = envInt('MAX_LOG_SIZE', 10 * 1024 * 1024);
  const maxAttachmentSize = envInt('MAX_ATTACHMENT_SIZE', 20 * 1024 * 1024);
  const maxSourceFileSize = envInt('MAX_SOURCE_FILE_SIZE', 2 * 1024 * 1024);
  // Server-wide caps for source uploads. Tier-limited containers (T1-T3) use their own
  // per-tier limits; T4/T5 have no tier limit and are bounded only by these caps.
  const maxSourceArchiveSize = envInt('MAX_SOURCE_ARCHIVE_SIZE', 5 * 1024 * 1024 * 1024);
  const maxSourceFiles = Math.max(1, envInt('MAX_SOURCE_FILES', 50000));
  const maxJsonBodySize = envInt('MAX_JSON_BODY_SIZE', 12 * 1024 * 1024);
  const corsOrigins = env('CORS_ORIGINS', '').split(',').map(value => value.trim()).filter(Boolean);
  const nodeEnv = env('NODE_ENV', 'development').toLowerCase();
  const trustProxyValue = env('TRUST_PROXY', 'false');
  const numericTrustProxy = /^\d+$/.test(trustProxyValue) ? parseInt(trustProxyValue, 10) : null;
  const trustProxy = numericTrustProxy ?? (trustProxyValue === 'true' ? true : trustProxyValue === 'false' ? false : trustProxyValue);

  return {
    port,
    dataDir,
    dbPath,
    symbolsDir,
    attachmentsDir,
    sourcesDir,
    maxLogSize,
    maxAttachmentSize,
    maxSourceFileSize,
    maxSourceArchiveSize,
    maxSourceFiles,
    maxJsonBodySize,
    corsOrigins,
    cookieSecure: envBool('COOKIE_SECURE', nodeEnv === 'production'),
    sessionHours: Math.max(1, envInt('SESSION_HOURS', 12)),
    apiRequireKey: envBool('API_REQUIRE_KEY', true),
    trustProxy,
    loginRateLimit: Math.max(1, envInt('LOGIN_RATE_LIMIT', 150)),
    ingestRateLimit: Math.max(1, envInt('INGEST_RATE_LIMIT', 120)),
    apiRateLimit: Math.max(1, envInt('API_RATE_LIMIT', 600)),
    webhookUrl: env('WEBHOOK_URL', ''),
    webhookTimeoutMs: envInt('WEBHOOK_TIMEOUT_MS', 5000),
    smtpHost: env('SMTP_HOST', ''),
    smtpPort: envInt('SMTP_PORT', 587),
    smtpSecure: envBool('SMTP_SECURE', false),
    smtpUser: env('SMTP_USER', ''),
    smtpPassword: env('SMTP_PASSWORD', ''),
    alertEmailFrom: env('ALERT_EMAIL_FROM', ''),
    alertEmailTo: env('ALERT_EMAIL_TO', ''),
    alertOnNewGroup: envBool('ALERT_ON_NEW_GROUP', true),
    alertThresholdCount: envInt('ALERT_THRESHOLD_COUNT', 10),
    baseUrl: env('BASE_URL', `http://localhost:${port}`),
    smsProvider: env('SMS_PROVIDER', ''),
    smsApiKey: env('SMS_API_KEY', ''),
    smsApiSecret: env('SMS_API_SECRET', ''),
    smsFrom: env('SMS_FROM', ''),
  };
}

export const config = loadConfig();
