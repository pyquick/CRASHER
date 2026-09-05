import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBashPolicy, normalizeBashCommand, parseBashPolicy } from './bash-policy.js';

test('bash policy defaults to deny and normalizes whitespace', () => {
  const policy = parseBashPolicy(undefined);
  const decision = evaluateBashPolicy(policy, '  echo   hello\n');
  assert.equal(normalizeBashCommand('  echo   hello\n'), 'echo hello');
  assert.equal(decision.allowed, false);
  assert.equal(decision.ruleId, null);
  assert.match(decision.commandHash, /^[a-f0-9]{64}$/);
});

test('bash policy allows explicit exact and prefix rules', () => {
  const policy = parseBashPolicy(JSON.stringify({
    default: 'deny',
    allow: [{ id: 'echo', command: 'echo hello' }, { id: 'node-tests', command: 'node --test', match: 'prefix' }],
  }));
  assert.equal(evaluateBashPolicy(policy, 'echo hello').allowed, true);
  assert.equal(evaluateBashPolicy(policy, 'node --test src/foo.test.ts').ruleId, 'node-tests');
  assert.equal(evaluateBashPolicy(policy, 'echo hello there').allowed, false);
});

test('deny rules win over allow rules', () => {
  const policy = parseBashPolicy(JSON.stringify({
    default: 'allow',
    allow: [{ id: 'all-node', command: 'node', match: 'prefix' }],
    deny: [{ id: 'no-tests', command: 'node --test', match: 'prefix' }],
  }));
  const decision = evaluateBashPolicy(policy, 'node --test src/foo.test.ts');
  assert.equal(decision.allowed, false);
  assert.equal(decision.ruleId, 'no-tests');
});

test('invalid policy input fails closed', () => {
  const policy = parseBashPolicy('{not json');
  assert.equal(evaluateBashPolicy(policy, 'echo hello').allowed, false);
});
