import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { config } from '../config.js';
import { runMigrations } from './migrations.js';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export function initDb(): Database.Database {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  mkdirSync(config.symbolsDir, { recursive: true });
  mkdirSync(config.attachmentsDir, { recursive: true });
  mkdirSync(config.sourcesDir, { recursive: true });

  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  const bashSettings = db.prepare('SELECT enabled, policy_json FROM ai_bash_settings WHERE id = 1').get() as { enabled: number; policy_json: string } | undefined;
  if (bashSettings) {
    config.aiBashEnabled = bashSettings.enabled === 1;
    config.aiBashPolicy = bashSettings.policy_json;
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
  }
}
