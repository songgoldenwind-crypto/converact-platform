import { createHash } from 'node:crypto';
import type { PolicySeverity } from './types.js';

export interface TextPolicyMatch {
  policy_type: string;
  severity: PolicySeverity;
  matched_text_hash: string;
  action: string;
}

interface Rule {
  policy_type: string;
  severity: PolicySeverity;
  pattern: RegExp;
}

const CONTACT_RULES: Rule[] = [
  { policy_type: 'phone_number', severity: 'high', pattern: /\b(?:\+?\d[\d\s().-]{7,}\d)\b/g },
  { policy_type: 'email', severity: 'high', pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
  { policy_type: 'wechat', severity: 'medium', pattern: /(?:\b(?:wechat|weixin)\b|微信)/gi },
  { policy_type: 'whatsapp', severity: 'medium', pattern: /\bwhatsapp\b/gi },
  { policy_type: 'telegram', severity: 'medium', pattern: /\btelegram\b/gi },
  { policy_type: 'pay_directly', severity: 'high', pattern: /\bpay\s+me\s+directly\b/gi },
  { policy_type: 'outside_app', severity: 'high', pattern: /\boutside\s+(?:the\s+)?app\b/gi }
];

const CONTACT_INTENT_RULES: Rule[] = [
  { policy_type: 'call_me', severity: 'medium', pattern: /\bcall\s+me\b/gi },
  { policy_type: 'text_me', severity: 'medium', pattern: /\btext\s+me\b/gi }
];

export function scanTextPolicy(text: string): TextPolicyMatch[] {
  const content = String(text || '');
  const matches = collectMatches(content, CONTACT_RULES);
  const hasDirectContact = matches.some((m) => m.policy_type === 'phone_number' || m.policy_type === 'email');
  if (!hasDirectContact) {
    matches.push(...collectMatches(content, CONTACT_INTENT_RULES));
  }
  return dedupeMatches(matches);
}

function collectMatches(text: string, rules: Rule[]): TextPolicyMatch[] {
  const matches: TextPolicyMatch[] = [];
  for (const rule of rules) {
    for (const match of text.matchAll(rule.pattern)) {
      const value = match[0] || '';
      if (!value.trim()) continue;
      matches.push({
        policy_type: rule.policy_type,
        severity: rule.severity,
        matched_text_hash: hashMatchedText(value),
        action: 'record'
      });
    }
  }
  return matches;
}

function dedupeMatches(matches: TextPolicyMatch[]): TextPolicyMatch[] {
  const seen = new Set<string>();
  const deduped: TextPolicyMatch[] = [];
  for (const match of matches) {
    const key = `${match.policy_type}:${match.matched_text_hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(match);
  }
  return deduped;
}

function hashMatchedText(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}
