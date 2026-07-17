import { createHash } from 'node:crypto';
import type { PolicySeverity } from './types.js';
import { detectContactSignals, type ContactSignalKind } from './contact-normalization.js';

export const CONTACT_DETECTOR_VERSION = 'contact-v2';
export const ANTI_CIRCUMVENTION_POLICY_VERSION = 'anti-circumvention-v2';

export interface TextPolicyMatch {
  policy_type: string;
  severity: PolicySeverity;
  matched_text_hash: string;
  action: string;
  detector_version: typeof CONTACT_DETECTOR_VERSION;
  policy_version: typeof ANTI_CIRCUMVENTION_POLICY_VERSION;
  confidence: number;
  match_kind: ContactSignalKind;
}

export function scanTextPolicy(text: string): TextPolicyMatch[] {
  return dedupeMatches(detectContactSignals(text).map((signal) => ({
    policy_type: signal.policy_type,
    severity: severityFor(signal.policy_type),
    matched_text_hash: hashMatchedText(signal.canonical_value),
    action: 'record',
    detector_version: CONTACT_DETECTOR_VERSION,
    policy_version: ANTI_CIRCUMVENTION_POLICY_VERSION,
    confidence: signal.confidence,
    match_kind: signal.kind
  })));
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

function severityFor(policyType: string): PolicySeverity {
  return policyType === 'phone_number' || policyType === 'email' ||
    policyType === 'pay_directly' || policyType === 'outside_app'
    ? 'high'
    : 'medium';
}
