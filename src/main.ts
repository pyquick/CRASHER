import express from 'express';
import cors from 'cors';
import compression from 'compression';
import { config } from './config.js';
import { initDb, closeDb } from './database.js';
import { requestLogger, errorHandler, notFoundHandler } from './middleware.js';
import crashReportHandler from './handler/crash_report.js';
import symbolHandler from './handler/symbol.js';
import webHandler from './handler/web.js';

// Initialize database
initDb();
console.log(`📁 Database: ${config.dbPath}`);
console.log(`🔑 Auth token: ${config.authToken}`);

const app = express();

// Middleware
app.use(compression());
app.use(cors({ origin: config.corsOrigins, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(requestLogger);

// Trust proxy for correct client IP
app.set('trust proxy', true);

// API routes
app.use('/api/v1', crashReportHandler);
app.use('/api/v1', symbolHandler);

// Web admin panel
app.use('/web', webHandler);

// Root redirect
app.get('/', (_req, res) => {
  res.redirect('/web/');
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Error handlers
app.use('/api', notFoundHandler);
app.use(errorHandler);

// Start server
const server = app.listen(config.port, () => {
  console.log('');
  console.log('  🚀 Crash Report Server is running!');
  console.log(`  📡 API:  http://localhost:${config.port}/api/v1/`);
  console.log(`  🌐 Web:  http://localhost:${config.port}/web/`);
  console.log(`  ❤️  Health: http://localhost:${config.port}/health`);
  console.log('');
  console.log('  Unity client usage:');
  console.log(`    POST http://your-server:${config.port}/api/v1/crash-report`);
  console.log('');
});

// Graceful shutdown
function shutdown() {
  console.log('\n🛑 Shutting down...');
  server.close(() => {
    closeDb();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
