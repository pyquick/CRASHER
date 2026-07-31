#!/usr/bin/env node
/**
 * Emergency Admin Password Reset Script
 *
 * Usage:
 *   npx tsx src/cli/reset-admin-password.ts [--username=admin]
 *
 * Run from the project root. Source .env first if needed:
 *   set -a && source .env && set +a && npx tsx src/cli/reset-admin-password.ts
 */

import * as readline from 'readline';
import { initDb, closeDb, getDb } from '../database.js';
import * as auth from '../auth.js';
import { config } from '../config.js';

function parseArgs(): string {
  return process.argv.find(a => a.startsWith('--username='))?.split('=')[1]
    || config.bootstrapAdminUsername
    || 'admin';
}

async function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  const { isRaw } = stdin;
  try {
    stdin.setRawMode?.(true);
  } catch { /* ignore on non-TTY */ }
  stdin.resume();
  process.stdout.write(prompt);
  let buf = '';
  return new Promise(resolve => {
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString()) {
        if (char === '\r' || char === '\n') {
          stdin.removeListener('data', onData);
          try { stdin.setRawMode?.(isRaw ?? false); } catch { /* */ }
          stdin.pause();
          process.stdout.write('\n');
          resolve(buf);
          return;
        }
        if (char === '\x7f' || char === '\b') {
          if (buf.length > 0) { buf = buf.slice(0, -1); process.stdout.write('\b \b'); }
          return;
        }
        if (char === '\x03') { process.stdout.write('\n'); process.exit(1); }
        buf += char;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const username = parseArgs();
  console.log(`\n🔐 Emergency Admin Password Reset`);
  console.log(`Target user: ${username}\n`);

  initDb();

  const users = auth.listUsers();
  const targetUser = users.find(u => u.username.toLowerCase() === username.toLowerCase());

  if (!targetUser) {
    console.error(`❌ User "${username}" not found.`);
    console.log('Available users:');
    users.forEach(u => console.log(`  - ${u.username} (${u.role}, ${u.is_active === 1 ? 'active' : 'inactive'})`));
    closeDb();
    process.exit(1);
  }

  console.log(`Found: ${targetUser.username} (${targetUser.role}, ${targetUser.is_active === 1 ? 'active' : 'inactive'})`);

  if (targetUser.is_active !== 1) {
    console.warn('⚠️  User is inactive — password will be changed but login won\'t succeed.');
  }

  const password = await readHidden('Enter new password: ');
  if (!password) { console.error('❌ Password cannot be empty.'); closeDb(); process.exit(1); }

  const passwordError = auth.validatePassword(password, targetUser.username);
  if (passwordError) { console.error(`❌ ${passwordError}`); closeDb(); process.exit(1); }

  const confirm = await readHidden('Confirm new password: ');
  if (password !== confirm) { console.error('❌ Passwords do not match.'); closeDb(); process.exit(1); }

  const db = getDb();
  const newHash = auth.hashPassword(password);
  db.prepare("UPDATE users SET password_hash = ?, session_version = session_version + 1, updated_at = datetime('now') WHERE id = ?")
    .run(newHash, targetUser.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetUser.id);

  auth.writeAuditLog(null, 'password_reset.cli_emergency', 'user', String(targetUser.id), '127.0.0.1', { username: targetUser.username });

  console.log(`\n✅ Password reset for ${targetUser.username}.`);
  console.log('   Sessions invalidated. New hash: PBKDF2-HMAC-SHA256.\n');
  closeDb();
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
