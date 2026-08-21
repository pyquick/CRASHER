import type Database from 'better-sqlite3';

/**
 * All CREATE TABLE and CREATE INDEX DDL statements.
 * Applied once during database initialization before migrations run.
 */
export function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('ultraadmin','admin','operator','viewer')),
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
      minute_limit INTEGER NOT NULL DEFAULT 0 CHECK(minute_limit >= 0),
      daily_limit INTEGER NOT NULL DEFAULT 0 CHECK(daily_limit >= 0),
      expires_at TEXT,
      revoked_at TEXT,
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS api_key_usage (
      api_key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
      period_start INTEGER NOT NULL,
      period_seconds INTEGER NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (api_key_id, period_start, period_seconds)
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

    CREATE TABLE IF NOT EXISTS containers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      tier INTEGER NOT NULL DEFAULT 1 CHECK(tier IN (1,2,3,4,5)),
      is_banned INTEGER NOT NULL DEFAULT 0 CHECK(is_banned IN (0,1)),
      storage_size_bytes INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ai_provider_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK(provider IN ('deepseek')),
      model TEXT NOT NULL DEFAULT 'deepseek-chat' CHECK(model IN ('deepseek-chat','deepseek-v4-pro[1m]','deepseek-v4-flash[1m]')),
      encrypted_api_key TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, provider)
    );

    CREATE TABLE IF NOT EXISTS ai_provider_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK(provider IN ('deepseek')),
      encrypted_api_key TEXT NOT NULL,
      masked_api_key TEXT NOT NULL,
      encryption_aad TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_failure_code TEXT,
      last_failure_at TEXT,
      retry_after_at TEXT,
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ai_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      group_id INTEGER REFERENCES crash_groups(id) ON DELETE SET NULL,
      report_id INTEGER REFERENCES crash_reports(id) ON DELETE SET NULL,
      title TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      encrypted_content TEXT NOT NULL,
      encrypted_reasoning TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Base indexes
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
    CREATE INDEX IF NOT EXISTS idx_api_key_usage_period ON api_key_usage(period_start);
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
    CREATE INDEX IF NOT EXISTS idx_ai_provider_configs_user_id ON ai_provider_configs(user_id);
    CREATE INDEX IF NOT EXISTS idx_ai_provider_keys_selection ON ai_provider_keys(user_id, provider, enabled, retry_after_at, last_used_at, id);
    CREATE INDEX IF NOT EXISTS idx_ai_conversations_owner_updated ON ai_conversations(owner_user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_conversations_expires_at ON ai_conversations(expires_at);
    CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation_id ON ai_messages(conversation_id, id);
  `);
}
