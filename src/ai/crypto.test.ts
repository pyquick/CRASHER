import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AI_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const { encryptAiValue, decryptAiValue } = await import('./crypto.js');

test('AI encryption round trips and authenticates associated data', () => {
  const plaintext = 'secret-value';
  const encrypted = encryptAiValue(plaintext, 'test-aad');
  assert.notEqual(encrypted, plaintext);
  assert.equal(decryptAiValue(encrypted, 'test-aad'), plaintext);
  assert.throws(() => decryptAiValue(encrypted, 'wrong-aad'));
});
