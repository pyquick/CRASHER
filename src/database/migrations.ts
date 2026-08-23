import type Database from 'better-sqlite3';
import { applySchema } from './schema.js';

interface Migration {
  version: number;
  description: string;
  up: (db: Database.Database) => void;
}

const migrations: Migration[] = [
  {
    version: 2,
    description: 'Add dump_info column to crash_reports',
    up: (db) => addColumn(db, 'crash_reports', 'dump_info', "TEXT DEFAULT ''"),
  },
  {
    version: 3,
    description: 'Add generic runtime fields to crash_reports',
    up: (db) => {
      addColumn(db, 'crash_reports', 'runtime', "TEXT DEFAULT ''");
      addColumn(db, 'crash_reports', 'runtime_version', "TEXT DEFAULT ''");
      addColumn(db, 'crash_reports', 'framework', "TEXT DEFAULT ''");
      addColumn(db, 'crash_reports', 'environment', "TEXT DEFAULT ''");
      addColumn(db, 'crash_reports', 'server_name', "TEXT DEFAULT ''");
      addColumn(db, 'crash_reports', 'release', "TEXT DEFAULT ''");
      addColumn(db, 'crash_reports', 'error_severity', "TEXT DEFAULT 'error'");
    },
  },
  {
    version: 4,
    description: 'Add IL2CPP symbolication metadata to crash_reports and symbols',
    up: (db) => {
      addColumn(db, 'crash_reports', 'build_guid', "TEXT DEFAULT ''");
      addColumn(db, 'crash_reports', 'symbolicated_stack', "TEXT DEFAULT ''");
      addColumn(db, 'crash_reports', 'symbolication_info', "TEXT DEFAULT ''");
      addColumn(db, 'crash_reports', 'symbolication_status', "TEXT DEFAULT 'not_applicable'");
      addColumn(db, 'crash_reports', 'symbol_id', 'INTEGER');
      addColumn(db, 'symbols', 'symbol_type', "TEXT DEFAULT 'unknown'");
      addColumn(db, 'symbols', 'module_name', "TEXT DEFAULT ''");
      addColumn(db, 'symbols', 'architecture', "TEXT DEFAULT ''");
      addColumn(db, 'symbols', 'index_status', "TEXT DEFAULT 'ready'");
      addColumn(db, 'symbols', 'index_error', "TEXT DEFAULT ''");
    },
  },
  {
    version: 5,
    description: 'Add API key tier column',
    up: (db) => addColumn(db, 'api_keys', 'tier', "TEXT NOT NULL DEFAULT 'operator'"),
  },
  {
    version: 6,
    description: 'Add project_id to crash_groups and crash_reports',
    up: (db) => {
      addColumn(db, 'crash_groups', 'project_id', 'INTEGER REFERENCES projects(id) ON DELETE SET NULL');
      addColumn(db, 'crash_reports', 'project_id', 'INTEGER REFERENCES projects(id) ON DELETE SET NULL');
    },
  },
  {
    version: 7,
    description: 'Add TOTP columns to users',
    up: (db) => {
      addColumn(db, 'users', 'totp_secret', 'TEXT');
      addColumn(db, 'users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    version: 8,
    description: 'Add per-key request quotas to api_keys',
    up: (db) => {
      addColumn(db, 'api_keys', 'minute_limit', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'api_keys', 'daily_limit', 'INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    version: 9,
    description: 'Add 2FA method preference to users',
    up: (db) => addColumn(db, 'users', 'two_factor_method', "TEXT NOT NULL DEFAULT 'totp' CHECK(two_factor_method IN ('totp','email','sms','none'))"),
  },
  {
    version: 10,
    description: 'Add phone numbers table for SMS 2FA',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_phones (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          phone TEXT NOT NULL UNIQUE,
          phone_verified INTEGER NOT NULL DEFAULT 0,
          phone_verify_token_hash TEXT,
          phone_verify_expires_at TEXT,
          is_primary INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_user_phones_user_id ON user_phones(user_id);
      `);
    },
  },
  {
    version: 11,
    description: 'Add containers, ultraadmin role, container_id to all tables',
    up: (db) => {
      // Fix users table CHECK constraint to allow 'ultraadmin' role
      const roleConstraint = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='users'"
      ).get() as { sql: string } | undefined;
      if (roleConstraint && !roleConstraint.sql.includes("'ultraadmin'")) {
        db.exec(`
          CREATE TABLE users_new (
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
          INSERT INTO users_new SELECT id, username, password_hash, role, is_active, session_version, created_at, updated_at, last_login_at FROM users;
          DROP TABLE users;
          ALTER TABLE users_new RENAME TO users;
        `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);`);
      }

      addColumn(db, 'users', 'container_id', 'INTEGER REFERENCES containers(id) ON DELETE SET NULL');
      addColumn(db, 'users', 'totp_mandatory', 'INTEGER NOT NULL DEFAULT 0');

      const dataTables = ['crash_groups', 'crash_reports', 'player_feedback', 'projects', 'symbols', 'api_keys', 'source_snapshots'];
      for (const table of dataTables) {
        addColumn(db, table, 'container_id', 'INTEGER REFERENCES containers(id) ON DELETE SET NULL');
      }

      addColumn(db, 'containers', 'banned_at', 'TEXT');
      addColumn(db, 'containers', 'banned_notification_sent', 'INTEGER NOT NULL DEFAULT 0');

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_users_container_id ON users(container_id);
        CREATE INDEX IF NOT EXISTS idx_crash_groups_container_id ON crash_groups(container_id);
        CREATE INDEX IF NOT EXISTS idx_crash_reports_container_id ON crash_reports(container_id);
        CREATE INDEX IF NOT EXISTS idx_player_feedback_container_id ON player_feedback(container_id);
        CREATE INDEX IF NOT EXISTS idx_projects_container_id ON projects(container_id);
        CREATE INDEX IF NOT EXISTS idx_symbols_container_id ON symbols(container_id);
        CREATE INDEX IF NOT EXISTS idx_api_keys_container_id ON api_keys(container_id);
        CREATE INDEX IF NOT EXISTS idx_source_snapshots_container_id ON source_snapshots(container_id);
        CREATE INDEX IF NOT EXISTS idx_containers_name ON containers(name);
      `);
    },
  },
  {
    version: 12,
    description: 'Add extended indexes for performance',
    up: (db) => {
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
    },
  },
  {
    version: 13,
    description: 'Add verify_email_on_login to users and reset TOTP for non-admins',
    up: (db) => {
      addColumn(db, 'users', 'verify_email_on_login', 'INTEGER NOT NULL DEFAULT 0');
      // Two-step verification is admin-only: TOTP data of other roles is no longer used.
      db.exec("UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE role != 'admin'");
    },
  },
  {
    version: 14,
    description: 'Repair: ensure verify_email_on_login exists on users (idempotent)',
    up: (db) => {
      // Re-asserts the v13 schema change for databases where v13 was recorded
      // without its DDL persisting. Idempotent: skips if the column exists.
      addColumn(db, 'users', 'verify_email_on_login', 'INTEGER NOT NULL DEFAULT 0');
      db.exec("UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE role != 'admin'");
    },
  },
  {
    version: 15,
    description: 'Add source file dedup columns (content_hash, parent_file_id, patch)',
    up: (db) => {
      addColumn(db, 'source_files', 'content_hash', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'source_files', 'parent_file_id', 'INTEGER');
      addColumn(db, 'source_files', 'patch', "TEXT NOT NULL DEFAULT ''");
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_source_files_path ON source_files(relative_path);
        CREATE INDEX IF NOT EXISTS idx_source_files_parent ON source_files(parent_file_id);
      `);
    },
  },
  {
    version: 16,
    description: 'Add encrypted AI provider configuration and owner-scoped chat history',
    up: (db) => {
      db.exec(`
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
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_ai_provider_configs_user_id ON ai_provider_configs(user_id);
        CREATE INDEX IF NOT EXISTS idx_ai_conversations_owner_updated ON ai_conversations(owner_user_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_ai_conversations_expires_at ON ai_conversations(expires_at);
        CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation_id ON ai_messages(conversation_id, id);
      `);
    },
  },
  {
    version: 17,
    description: 'Add selectable DeepSeek model to provider configuration',
    up: (db) => addColumn(db, 'ai_provider_configs', 'model', "TEXT NOT NULL DEFAULT 'deepseek-chat'"),
  },
  {
    version: 18,
    description: 'Add encrypted multi-key AI provider storage and reasoning messages',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_provider_keys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          provider TEXT NOT NULL CHECK(provider IN ('deepseek')),
          encrypted_api_key TEXT NOT NULL,
          masked_api_key TEXT NOT NULL DEFAULT '',
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
        CREATE INDEX IF NOT EXISTS idx_ai_provider_keys_selection
          ON ai_provider_keys(user_id, provider, enabled, retry_after_at, last_used_at, id);
      `);
      addColumn(db, 'ai_messages', 'encrypted_reasoning', 'TEXT');
      db.exec(`
        INSERT INTO ai_provider_keys (user_id, provider, encrypted_api_key, masked_api_key, encryption_aad, enabled, created_at, updated_at)
        SELECT c.user_id, c.provider, c.encrypted_api_key, '', 'provider:' || c.user_id || ':' || c.provider, c.enabled, c.created_at, c.updated_at
        FROM ai_provider_configs c
        WHERE NOT EXISTS (
          SELECT 1 FROM ai_provider_keys k WHERE k.user_id = c.user_id AND k.provider = c.provider
        );
      `);
    },
  },
  {
    version: 19,
    description: 'Add AI agent event log (tool calls, results, subagents, task updates)',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_agent_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id INTEGER NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
          message_id INTEGER REFERENCES ai_messages(id) ON DELETE SET NULL,
          owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('tool_call','tool_result','subagent','task_update')),
          name TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','ok','error','cancelled')),
          group_id INTEGER REFERENCES ai_agent_events(id) ON DELETE CASCADE,
          encrypted_payload TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_ai_agent_events_conversation ON ai_agent_events(conversation_id, id);
        CREATE INDEX IF NOT EXISTS idx_ai_agent_events_message ON ai_agent_events(message_id);
      `);
    },
  },
];

function addColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const exists = db
    .prepare(`SELECT COUNT(*) as c FROM pragma_table_info('${table}') WHERE name = ?`)
    .get(column) as { c: number };
  if (exists.c === 0) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    // Verify the DDL actually persisted; if not, throw so the migration
    // transaction rolls back and the version is NOT recorded.
    const after = db
      .prepare(`SELECT COUNT(*) as c FROM pragma_table_info('${table}') WHERE name = ?`)
      .get(column) as { c: number };
    if (after.c === 0) {
      throw new Error(`Migration failed: column ${table}.${column} was not added`);
    }
  }
}

export function runMigrations(db: Database.Database): void {
  // Ensure schema_version tracking table exists
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL DEFAULT 0)`);

  const current = (db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number | null })?.version ?? 0;

  // Apply base schema first
  applySchema(db);

  // Apply pending migrations in order. Each migration runs in its own
  // transaction together with its version record, so a failed or partial
  // migration never marks itself as applied (it retries on the next boot).
  for (const migration of migrations) {
    if (migration.version > current) {
      console.log(`[migration] v${migration.version}: ${migration.description}`);
      db.transaction(() => {
        migration.up(db);
        db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version);
      })();
    }
  }
}
