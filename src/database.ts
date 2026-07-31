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
  mkdirSync(config.sourcesDir, { recursive: true });

  db = new Database(config.dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  return db;
}

function addColumnIfNotExists(
  db: Database.Database,
  table: string,
  column: string,
  definition: string
): void {
  const exists = db
    .prepare(`SELECT COUNT(*) as c FROM pragma_table_info('${table}') WHERE name = ?`)
    .get(column) as { c: number };
  if (exists.c === 0) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (err: any) {
      // Ignore duplicate column errors in case of race
      if (!err.message?.includes('duplicate column')) {
        throw err;
      }
    }
  }
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('admin','operator','viewer')),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
      session_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_version INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      tier TEXT NOT NULL DEFAULT 'operator' CHECK(tier IN ('admin','operator','viewer')),
      expires_at TEXT,
      revoked_at TEXT,
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL DEFAULT '',
      target_id TEXT NOT NULL DEFAULT '',
      ip_address TEXT NOT NULL DEFAULT '',
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email TEXT NOT NULL UNIQUE,
      email_verified INTEGER NOT NULL DEFAULT 0,
      email_verify_token_hash TEXT,
      email_verify_expires_at TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS password_reset_requests (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      approved_by INTEGER REFERENCES users(id),
      new_password_hash TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS source_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      release TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS source_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL REFERENCES source_snapshots(id) ON DELETE CASCADE,
      relative_path TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      language TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(snapshot_id, relative_path)
    );

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
      runtime TEXT DEFAULT '',
      runtime_version TEXT DEFAULT '',
      framework TEXT DEFAULT '',
      environment TEXT DEFAULT '',
      server_name TEXT DEFAULT '',
      release TEXT DEFAULT '',
      error_severity TEXT DEFAULT 'error',
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

    CREATE TABLE IF NOT EXISTS player_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'bug' CHECK(category IN ('bug','suggestion','other')),
      severity TEXT NOT NULL DEFAULT 'normal' CHECK(severity IN ('low','normal','high','critical')),
      status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','in_progress','resolved','closed')),
      player_id TEXT DEFAULT '',
      player_name TEXT DEFAULT '',
      contact TEXT DEFAULT '',
      app_version TEXT DEFAULT '',
      platform TEXT DEFAULT '',
      device_model TEXT DEFAULT '',
      scene_name TEXT DEFAULT '',
      custom_data TEXT DEFAULT '',
      client_ip TEXT DEFAULT '',
      client_timestamp TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS feedback_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feedback_id INTEGER NOT NULL REFERENCES player_feedback(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      content_type TEXT DEFAULT '',
      file_size INTEGER DEFAULT 0,
      file_path TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_crash_groups_hash ON crash_groups(crash_hash);
    CREATE INDEX IF NOT EXISTS idx_crash_groups_status ON crash_groups(status);
    CREATE INDEX IF NOT EXISTS idx_crash_groups_last_seen ON crash_groups(last_seen);
    CREATE INDEX IF NOT EXISTS idx_crash_reports_group_id ON crash_reports(group_id);
    CREATE INDEX IF NOT EXISTS idx_crash_reports_created_at ON crash_reports(created_at);
    CREATE INDEX IF NOT EXISTS idx_crash_reports_platform ON crash_reports(platform);
    CREATE INDEX IF NOT EXISTS idx_crash_reports_app_version ON crash_reports(app_version);
    CREATE INDEX IF NOT EXISTS idx_crash_attachments_report_id ON crash_attachments(crash_report_id);
    CREATE INDEX IF NOT EXISTS idx_symbols_build_guid ON symbols(build_guid);
    CREATE INDEX IF NOT EXISTS idx_crash_reports_runtime ON crash_reports(runtime);
    CREATE INDEX IF NOT EXISTS idx_player_feedback_status ON player_feedback(status);
    CREATE INDEX IF NOT EXISTS idx_player_feedback_created_at ON player_feedback(created_at);
    CREATE INDEX IF NOT EXISTS idx_feedback_attachments_feedback_id ON feedback_attachments(feedback_id);
  `);

  // v2 migration: add dump_info column
  addColumnIfNotExists(db, 'crash_reports', 'dump_info', "TEXT DEFAULT ''");

  // v3 migration: add generic runtime fields
  addColumnIfNotExists(db, 'crash_reports', 'runtime', "TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'crash_reports', 'runtime_version', "TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'crash_reports', 'framework', "TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'crash_reports', 'environment', "TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'crash_reports', 'server_name', "TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'crash_reports', 'release', "TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'crash_reports', 'error_severity', "TEXT DEFAULT 'error'");

  // v4 migration: IL2CPP symbolication metadata
  addColumnIfNotExists(db, 'crash_reports', 'build_guid', "TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'crash_reports', 'symbolicated_stack', "TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'crash_reports', 'symbolication_info', "TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'crash_reports', 'symbolication_status', "TEXT DEFAULT 'not_applicable'");
  addColumnIfNotExists(db, 'crash_reports', 'symbol_id', 'INTEGER');
  addColumnIfNotExists(db, 'symbols', 'symbol_type', "TEXT DEFAULT 'unknown'");
  addColumnIfNotExists(db, 'symbols', 'module_name', "TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'symbols', 'architecture', "TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'symbols', 'index_status', "TEXT DEFAULT 'ready'");
  addColumnIfNotExists(db, 'symbols', 'index_error', "TEXT DEFAULT ''");

  // v5 migration: API key tier
  addColumnIfNotExists(db, 'api_keys', 'tier', "TEXT NOT NULL DEFAULT 'operator'");

  // v6 migration: projects and source snapshots
  addColumnIfNotExists(db, 'crash_groups', 'project_id', 'INTEGER REFERENCES projects(id) ON DELETE SET NULL');
  addColumnIfNotExists(db, 'crash_reports', 'project_id', 'INTEGER REFERENCES projects(id) ON DELETE SET NULL');

  // v7 migration: TOTP columns on users
  addColumnIfNotExists(db, 'users', 'totp_secret', 'TEXT');
  addColumnIfNotExists(db, 'users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_crash_reports_build_guid ON crash_reports(build_guid);
    CREATE INDEX IF NOT EXISTS idx_crash_reports_symbol_id ON crash_reports(symbol_id);
    CREATE INDEX IF NOT EXISTS idx_symbols_type ON symbols(symbol_type);
    CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);
    CREATE INDEX IF NOT EXISTS idx_source_snapshots_project_release ON source_snapshots(project_id, release, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_source_files_snapshot_path ON source_files(snapshot_id, relative_path);
    CREATE INDEX IF NOT EXISTS idx_crash_groups_project_id ON crash_groups(project_id);
    CREATE INDEX IF NOT EXISTS idx_crash_reports_project_id ON crash_reports(project_id);
  `);
}

export function closeDb(): void {
  if (db) {
    db.close();
  }
}
