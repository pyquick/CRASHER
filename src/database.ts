import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { config } from './config.js';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export function initDb(): Database.Database {
  // Ensure data directory exists
  mkdirSync(dirname(config.dbPath), { recursive: true });
  mkdirSync(config.symbolsDir, { recursive: true });
  mkdirSync(config.attachmentsDir, { recursive: true });

  db = new Database(config.dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);

  return db;
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS crash_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      crash_hash TEXT NOT NULL UNIQUE,
      exception_type TEXT NOT NULL,
      exception_message TEXT DEFAULT '',
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      total_count INTEGER DEFAULT 1,
      status TEXT DEFAULT 'open' CHECK(status IN ('open','resolved','ignored')),
      resolved_version TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS crash_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER REFERENCES crash_groups(id) ON DELETE SET NULL,
      exception_type TEXT NOT NULL,
      exception_message TEXT DEFAULT '',
      stack_trace TEXT DEFAULT '',
      log_text TEXT DEFAULT '',
      unity_version TEXT DEFAULT '',
      platform TEXT DEFAULT '',
      device_model TEXT DEFAULT '',
      os_version TEXT DEFAULT '',
      gpu_name TEXT DEFAULT '',
      cpu_name TEXT DEFAULT '',
      memory_mb INTEGER DEFAULT 0,
      app_version TEXT DEFAULT '',
      bundle_id TEXT DEFAULT '',
      scene_name TEXT DEFAULT '',
      custom_data TEXT DEFAULT '',
      client_ip TEXT DEFAULT '',
      client_timestamp TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS crash_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      crash_report_id INTEGER NOT NULL REFERENCES crash_reports(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      content_type TEXT DEFAULT '',
      file_size INTEGER DEFAULT 0,
      file_path TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      build_guid TEXT NOT NULL,
      filename TEXT NOT NULL,
      file_size INTEGER DEFAULT 0,
      file_path TEXT NOT NULL,
      uploaded_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_crash_groups_hash ON crash_groups(crash_hash);
    CREATE INDEX IF NOT EXISTS idx_crash_groups_status ON crash_groups(status);
    CREATE INDEX IF NOT EXISTS idx_crash_groups_last_seen ON crash_groups(last_seen);
    CREATE INDEX IF NOT EXISTS idx_crash_reports_group_id ON crash_reports(group_id);
    CREATE INDEX IF NOT EXISTS idx_crash_reports_created_at ON crash_reports(created_at);
    CREATE INDEX IF NOT EXISTS idx_crash_reports_platform ON crash_reports(platform);
    CREATE INDEX IF NOT EXISTS idx_crash_reports_app_version ON crash_reports(app_version);
    CREATE INDEX IF NOT EXISTS idx_crash_attachments_report_id ON crash_attachments(crash_report_id);
    CREATE INDEX IF NOT EXISTS idx_symbols_build_guid ON symbols(build_guid);
  `);
}

export function closeDb(): void {
  if (db) {
    db.close();
  }
}
