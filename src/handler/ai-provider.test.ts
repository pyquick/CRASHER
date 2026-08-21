import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskAiProviderKey } from './ai-provider.js';

test('AI provider key mask exposes two characters at each end', () => {
  const masked = maskAiProviderKey('sk-1234567890abcdef-last');
  assert.equal(masked, 'sk***************st');
  assert.equal(masked.length, 19);
});
