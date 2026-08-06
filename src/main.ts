import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import compression from 'compression';
import { config } from './config.js';
import { initDb, closeDb } from './database.js';
import { purgeExpiredSessions, purgeExpiredResetTokens } from './auth.js';
import {
  authenticateSession,
  apiKeyRateLimit,
  clearApiKeyIdentity,
  errorHandler,
  notFoundHandler,
  rateLimit,
  requestLogger,
  requireApiAuth,
  requireApiKey,
  requireApiKeyDeleteAccess,
  requireApiKeyWriteAccess,
  requireCsrf,
} from './middleware.js';
import authHandler from './handler/auth.js';
import crashReportHandler from './handler/crash_report.js';
import feedbackHandler from './handler/feedback.js';
import symbolHandler from './handler/symbol.js';
import unityHandler from './handler/unity.js';
import queryHandler from './handler/query.js';
import sourceHandler from './handler/source.js';
import webHandler from './handler/web.js';
import { testSmtpConnection } from './notification/service.js';

initDb();
purgeExpiredSessions();
purgeExpiredResetTokens();
testSmtpConnection();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

function cookieParser(req: Request, _res: Response, next: NextFunction): void {
  const raw = req.headers.cookie;
  if (!raw || typeof raw !== 'string') {
    req.cookies = {};
    next();
    return;
  }
  const parsed: Record<string, string> = {};
  for (const pair of raw.split(';')) {
    const index = pair.indexOf('=');
    if (index > 0) parsed[pair.substring(0, index).trim()] = pair.substring(index + 1).trim();
  }
  req.cookies = parsed;
  next();
}

const corsOptions: cors.CorsOptions = {
  credentials: true,
  origin(origin, callback) {
    if (!origin) {
      callback(null, true);
      return;
    }
    callback(null, config.corsOrigins.includes(origin));
  },
};

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(compression());
app.use(cors(corsOptions));
app.use(cookieParser);
app.use(express.json({ limit: config.maxJsonBodySize }));
app.use(express.urlencoded({ extended: false, limit: '1mb', parameterLimit: 200 }));
app.use(authenticateSession);
app.use(requestLogger);

app.use('/web', authHandler);
app.use('/api/v1/auth', authHandler);

const ingestLimiter = rateLimit({ windowMs: 60 * 1000, limit: config.ingestRateLimit });
const apiKeyMinuteLimiter = apiKeyRateLimit(60, 'minute_limit');
const apiKeyDailyLimiter = apiKeyRateLimit(24 * 60 * 60, 'daily_limit');
const onIngestPost = (middleware: (req: Request, res: Response, next: NextFunction) => void) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === 'POST') middleware(req, res, next);
    else next();
  };
};
const onFeedbackPost = (middleware: (req: Request, res: Response, next: NextFunction) => void) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === 'POST' && req.path === '/') middleware(req, res, next);
    else next();
  };
};
// Ingest routes: API key required for POST, viewer-tier keys cannot write
app.use('/api/v1/crash-report', onIngestPost(ingestLimiter), onIngestPost(requireApiKey), onIngestPost(apiKeyMinuteLimiter), onIngestPost(apiKeyDailyLimiter), requireApiKeyWriteAccess);
app.use('/api/v1/player-feedback', onFeedbackPost(ingestLimiter), onFeedbackPost(requireApiKey), onFeedbackPost(apiKeyMinuteLimiter), onFeedbackPost(apiKeyDailyLimiter), requireApiKeyWriteAccess);
app.use('/api/v1/unity/crash-report', onIngestPost(ingestLimiter), onIngestPost(requireApiKey), onIngestPost(apiKeyMinuteLimiter), onIngestPost(apiKeyDailyLimiter), requireApiKeyWriteAccess);
app.use('/api/v1/project-sources', onIngestPost(ingestLimiter), onIngestPost(requireApiKey), onIngestPost(apiKeyMinuteLimiter), onIngestPost(apiKeyDailyLimiter), requireApiKeyWriteAccess);
// Viewer API keys cannot access crash/feedback/symbol GET endpoints; admin+operator only
app.use('/api/v1', crashReportHandler);
app.use('/api/v1', feedbackHandler);
app.use('/api/v1', unityHandler);
app.use('/api/v1', sourceHandler);
app.use('/api/v1', clearApiKeyIdentity);

const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: config.apiRateLimit });
// Protected API routes: session-auth required, CSRF required, API key delete restrictions
app.use('/api/v1', apiLimiter, requireApiAuth, requireCsrf, requireApiKeyDeleteAccess, queryHandler);
app.use('/api/v1', apiLimiter, requireApiAuth, requireCsrf, requireApiKeyDeleteAccess, symbolHandler);

app.use('/web', webHandler);

app.get('/', (_req, res) => res.redirect('/web/'));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use(notFoundHandler);
app.use(errorHandler);

const server = app.listen(config.port, () => {
  console.log(`Crash Report Server running on http://localhost:${config.port}`);
  console.log(`[security] Public ingestion API keys required: ${config.apiRequireKey}`);
});

function shutdown() {
  server.close(() => { closeDb(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
