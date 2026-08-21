import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations.js';

test('fresh database includes AI key and encrypted reasoning schema', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    const keyColumns = db.prepare("SELECT name FROM pragma_table_info('ai_provider_keys')").all() as Array<{ name: string }>;
    const messageColumns = db.prepare("SELECT name FROM pragma_table_info('ai_messages')").all() as Array<{ name: string }>;
    const version = (db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version;

    assert.ok(keyColumns.some(column => column.name === 'encryption_aad'));
    assert.ok(keyColumns.some(column => column.name === 'masked_api_key'));
    assert.ok(messageColumns.some(column => column.name === 'encrypted_reasoning'));
    assert.equal(version, 18);
  } finally {
    db.close();
  }
});

test('migration preserves a legacy provider key and its AAD', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('owner', 'hash', 'admin')").run();
    db.prepare(`INSERT INTO ai_provider_configs (user_id, provider, encrypted_api_key, enabled)
      VALUES (1, 'deepseek', 'ciphertext', 1)`).run();
    db.prepare('DELETE FROM ai_provider_keys').run();
    db.prepare('DELETE FROM schema_version WHERE version = 18').run();
    runMigrations(db);

    const migrated = db.prepare('SELECT user_id, encrypted_api_key, encryption_aad, enabled FROM ai_provider_keys').get() as {
      user_id: number; encrypted_api_key: string; encryption_aad: string; enabled: number;
    };
    assert.deepEqual(migrated, {
      user_id: 1,
      encrypted_api_key: 'ciphertext',
      encryption_aad: 'provider:1:deepseek',
      enabled: 1,
    });
  } finally {
    db.close();
  }
});
