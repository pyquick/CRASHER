import { createHash } from 'crypto';

export type BashPolicyMatch = 'exact' | 'prefix';

export interface BashPolicyRule {
  id: string;
  command: string;
  match?: BashPolicyMatch;
}

export interface BashPolicy {
  default: 'deny' | 'allow';
  allow: BashPolicyRule[];
  deny: BashPolicyRule[];
}

export interface BashPolicyDecision {
  allowed: boolean;
  ruleId: string | null;
  normalizedCommand: string;
  commandHash: string;
}

export function normalizeBashCommand(command: string): string {
  return command.replace(/\r\n?/g, '\n').trim().replace(/\s+/g, ' ');
}

function validRule(value: unknown): value is BashPolicyRule {
  if (typeof value !== 'object' || value === null) return false;
  const rule = value as Record<string, unknown>;
  return typeof rule.id === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(rule.id)
    && typeof rule.command === 'string' && rule.command.trim().length > 0 && rule.command.length <= 4000
    && (rule.match === undefined || rule.match === 'exact' || rule.match === 'prefix');
}

export function parseBashPolicy(raw: string | undefined): BashPolicy {
  if (!raw?.trim()) return { default: 'deny', allow: [], deny: [] };
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const allow = Array.isArray(value.allow) ? value.allow.filter(validRule).map(normalizeRule) : [];
    const deny = Array.isArray(value.deny) ? value.deny.filter(validRule).map(normalizeRule) : [];
    const defaultValue = value.default === 'allow' ? 'allow' : 'deny';
    return { default: defaultValue, allow, deny };
  } catch {
    return { default: 'deny', allow: [], deny: [] };
  }
}

function normalizeRule(rule: BashPolicyRule): BashPolicyRule {
  return { id: rule.id, command: normalizeBashCommand(rule.command), match: rule.match ?? 'exact' };
}

function matches(rule: BashPolicyRule, command: string): boolean {
  if (rule.match === 'prefix') return command === rule.command || command.startsWith(`${rule.command} `);
  return command === rule.command;
}

export function evaluateBashPolicy(policy: BashPolicy, command: string): BashPolicyDecision {
  const normalizedCommand = normalizeBashCommand(command);
  const commandHash = createHash('sha256').update(normalizedCommand).digest('hex');
  // Deny rules always win, regardless of declaration order or default.
  const deny = policy.deny.find(rule => matches(rule, normalizedCommand));
  if (deny) return { allowed: false, ruleId: deny.id, normalizedCommand, commandHash };
  const allow = policy.allow.find(rule => matches(rule, normalizedCommand));
  if (allow) return { allowed: true, ruleId: allow.id, normalizedCommand, commandHash };
  return { allowed: policy.default === 'allow', ruleId: null, normalizedCommand, commandHash };
}
