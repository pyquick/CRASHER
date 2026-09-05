import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerificationStore } from './verification.js';

test('resend respects the cooldown window', () => {
  const store = createVerificationStore<{ userId: number }>(60_000, 60_000, 3);
  const { token } = store.createWithCode({ userId: 1 });
  assert.equal(store.resend(token), null);
});

test('resend with force bypasses the cooldown window', () => {
  const store = createVerificationStore<{ userId: number }>(60_000, 60_000, 3);
  const first = store.createWithCode({ userId: 1 });
  const code = store.resend(first.token, true);
  assert.ok(code && code.length === 6 && code !== first.code);

  // Only the newest code validates after a forced resend.
  assert.equal(store.verify(first.token, first.code), false);
  assert.equal(store.verify(first.token, code!), true);
});

test('resend on an expired token fails', () => {
  const store = createVerificationStore<{ userId: number }>(-1, 60_000, 3);
  const { token } = store.createWithCode({ userId: 1 });
  assert.equal(store.verify(token, '123456'), false);
  assert.equal(store.resend(token, true), null);
});
