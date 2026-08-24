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
  emailEnabled: boolean;
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
  aiEncryptionKey: string;
  aiDeepseekModel: string;
  aiDeepseekEndpoint: string;
  aiRequestTimeoutMs: number;
  aiMessageMaxLength: number;
  aiContextMaxChars: number;
  aiSourceMaxFiles: number;
  aiHistoryMaxChars: number;
  aiRateLimit: number;
  aiMaxConversations: number;
  aiMaxMessagesPerConversation: number;
  aiRetentionDays: number;
  aiBashEnabled: boolean;
  aiBashTimeoutMs: number;
  aiBashMaxOutput: number;
  aiMaxToolSteps: number;
  aiSubagentMax: number;
  aiSubagentMaxSteps: number;
  aiSubagentModel: string;
  aiWebFetchTimeoutMs: number;
  aiWebFetchMaxBytes: number;
  aiToolResultMaxChars: number;
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
    // Email functionality is only enabled when every SMTP/ALERT env var is set.
    emailEnabled: !!(process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_SECURE
      && process.env.SMTP_USER && process.env.SMTP_PASSWORD && process.env.ALERT_EMAIL_FROM && process.env.ALERT_EMAIL_TO
      && process.env.ALERT_ON_NEW_GROUP && process.env.ALERT_THRESHOLD_COUNT),
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
    aiEncryptionKey: env('AI_ENCRYPTION_KEY', ''),
    aiDeepseekModel: env('AI_DEEPSEEK_MODEL', 'deepseek-chat'),
    aiDeepseekEndpoint: env('AI_DEEPSEEK_ENDPOINT', 'https://api.deepseek.com/chat/completions'),
    aiRequestTimeoutMs: Math.max(1000, envInt('AI_REQUEST_TIMEOUT_MS', 60000)),
    aiMessageMaxLength: Math.max(100, envInt('AI_MESSAGE_MAX_LENGTH', 10000)),
    aiContextMaxChars: Math.max(10000, envInt('AI_CONTEXT_MAX_CHARS', 120000)),
    aiSourceMaxFiles: Math.max(1, envInt('AI_SOURCE_MAX_FILES', 20)),
    aiHistoryMaxChars: Math.max(1000, envInt('AI_HISTORY_MAX_CHARS', 40000)),
    aiRateLimit: Math.max(1, envInt('AI_RATE_LIMIT', 20)),
    // 0 = unlimited
    aiMaxConversations: Math.max(0, envInt('AI_MAX_CONVERSATIONS', 50)),
    aiMaxMessagesPerConversation: Math.max(0, envInt('AI_MAX_MESSAGES_PER_CONVERSATION', 100)),
    aiRetentionDays: Math.max(1, envInt('AI_RETENTION_DAYS', 30)),
    aiBashEnabled: envBool('AI_BASH_ENABLED', false),
    aiBashTimeoutMs: Math.max(1000, envInt('AI_BASH_TIMEOUT_MS', 30000)),
    aiBashMaxOutput: Math.max(1024, envInt('AI_BASH_MAX_OUTPUT', 65536)),
    aiMaxToolSteps: Math.max(1, envInt('AI_MAX_TOOL_STEPS', 12)),
    aiSubagentMax: Math.max(1, envInt('AI_SUBAGENT_MAX', 4)),
    aiSubagentMaxSteps: Math.max(1, envInt('AI_SUBAGENT_MAX_STEPS', 8)),
    aiSubagentModel: env('AI_SUBAGENT_MODEL', '') || env('AI_DEEPSEEK_MODEL', 'deepseek-chat'),
    aiWebFetchTimeoutMs: Math.max(1000, envInt('AI_WEBFETCH_TIMEOUT_MS', 15000)),
    aiWebFetchMaxBytes: Math.max(1024, envInt('AI_WEBFETCH_MAX_BYTES', 262144)),
    aiToolResultMaxChars: Math.max(1000, envInt('AI_TOOL_RESULT_MAX_CHARS', 20000)),
  };
}

export const config = loadConfig();
