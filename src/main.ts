import express from 'express';
import cors from 'cors';
import compression from 'compression';
import { config } from './config.js';
import { initDb, closeDb } from './database.js';
import { requestLogger, errorHandler } from './middleware.js';
import crashReportHandler from './handler/crash_report.js';
import symbolHandler from './handler/symbol.js';
import downloadHandler from './handler/download.js';
import webHandler from './handler/web.js';

initDb();

const app = express();
app.use(compression());
app.use(cors({ origin: config.corsOrigins, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(requestLogger);
app.set('trust proxy', true);

app.use('/api/v1', downloadHandler);
app.use('/api/v1', crashReportHandler);
app.use('/api/v1', symbolHandler);
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
