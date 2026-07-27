import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import compression from 'compression';
import { config } from './config.js';
import { initDb, closeDb } from './database.js';
import { requestLogger, errorHandler, requireApiAuth } from './middleware.js';
import crashReportHandler from './handler/crash_report.js';
import symbolHandler from './handler/symbol.js';
import unityHandler from './handler/unity.js';
import queryHandler from './handler/query.js';
import webHandler from './handler/web.js';

initDb();

const app = express();

// Simple cookie parser middleware (avoids extra dependency)
function cookieParser(req: Request, _res: Response, next: NextFunction): void {
  const raw = req.headers.cookie;
  if (!raw || typeof raw !== 'string') {
    req.cookies = {};
    next();
    return;
  }
  const parsed: Record<string, string> = {};
  for (const pair of raw.split(';')) {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      parsed[pair.substring(0, idx).trim()] = pair.substring(idx + 1).trim();
    }
  }
  req.cookies = parsed;
  next();
}

app.use(compression());
app.use(cors({ origin: config.corsOrigins, credentials: true }));
app.use(cookieParser);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(requestLogger);
app.set('trust proxy', true);

// Public endpoints (no auth required — clients submit crash reports here)
app.use('/api/v1', crashReportHandler);
app.use('/api/v1', unityHandler);

// Protected endpoints (auth required for viewing data)
app.use('/api/v1', requireApiAuth, queryHandler);
app.use('/api/v1', requireApiAuth, symbolHandler);

// Web UI
app.use('/web', webHandler);

app.get('/', (_req, res) => res.redirect('/web/'));
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.use(errorHandler);

const server = app.listen(config.port, () => {
  console.log(`  Crash Report Server running on http://localhost:${config.port}`);
});

function shutdown() {
  server.close(() => { closeDb(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
