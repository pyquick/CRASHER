import { test } from 'node:test';
import assert from 'node:assert/strict';
import { operation2FAMethods } from './auth-common.js';

test('operation 2FA prefers email/SMS methods', () => {
  assert.deepEqual(operation2FAMethods(['totp', 'email', 'sms']), ['email', 'sms']);
  assert.deepEqual(operation2FAMethods(['email']), ['email']);
  assert.deepEqual(operation2FAMethods(['sms', 'email']), ['sms', 'email']);
});

test('operation 2FA falls back to the original methods when no contact exists', () => {
  assert.deepEqual(operation2FAMethods(['totp']), ['totp']);
  assert.deepEqual(operation2FAMethods([]), []);
});
