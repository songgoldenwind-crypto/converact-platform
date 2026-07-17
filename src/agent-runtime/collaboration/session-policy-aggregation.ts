import { createHash } from 'node:crypto';

import { pgId, type PgQueryable } from '../../db-pg.js';
import { PolicyFindingStore } from './policy-finding-store.js';
import {
  ANTI_CIRCUMVENTION_POLICY_VERSION,
  scanTextPolicy,
  type TextPolicyMatch
} from './policy-scan.js';
import type {
  CollaborationPolicyEvent,
  PolicyEvidenceRef,
  PolicyScanResult
} from './types.js';

const MESSAGE_LIMIT = 20;
const CHARACTER_LIMIT = 20_000;
const FRAGMENT_LIMIT = 4_000;
const AGGREGATE_DETECTOR_VERSION = 'contact-aggregate-v1';
const SOCIAL_POLICIES = new Set(['wechat', 'whatsapp', 'telegram', 'qq']);

interface SessionFragment {
  content: string;
  message_id: string;
  message_position: number;
  evidence: PolicyEvidenceRef;
}

interface AggregateCandidate {
  match: TextPolicyMatch;
  evidence_refs: PolicyEvidenceRef[];
  match_kind: 'aggregate' | 'visual_code';
}

interface VisualObservationRow {
  id: string;
  message_id: string;
  attachment_id: string;
  observation_type: string;
  value_hash: string;
  symbology: string;
  frame_timestamp_ms: number | null;
  page_number: number | null;
  detector_version: string;
}

export class SessionPolicyAggregation {
  constructor(private readonly pg: PgQueryable) {}

  async scan(input: { tenant_id: string; session_id: string }): Promise<PolicyScanResult> {
    const { fragments, messageIds } = await this.loadFragments(input);
    if (fragments.length < 2) return { matched: false, events: [], findings: [] };
    const candidates = this.fragmentCandidates(fragments);
    const observations = await this.loadVisualObservations(input, messageIds);
    candidates.push(...this.visualCandidates(fragments, observations));

    const events: CollaborationPolicyEvent[] = [];
    const findings = [];
    for (const candidate of dedupeCandidates(candidates)) {
      const finding = await new PolicyFindingStore(this.pg).recordFinding({
        tenant_id: input.tenant_id,
        session_id: input.session_id,
        message_id: '',
        source: 'aggregate',
        source_ref_id: input.session_id,
        policy_type: candidate.match.policy_type,
        severity: candidate.match.severity,
        matched_text_hash: candidate.match.matched_text_hash,
        action: candidate.match.action,
        confidence: Math.min(candidate.match.confidence, 0.9),
        evidence_refs: candidate.evidence_refs,
        detector_version: AGGREGATE_DETECTOR_VERSION,
        policy_version: ANTI_CIRCUMVENTION_POLICY_VERSION,
        metadata: {
          match_kind: candidate.match_kind,
          fragment_count: candidate.evidence_refs.length
        }
      });
      findings.push(finding);
      events.push(await this.recordEvent(input, finding));
    }
    return { matched: findings.length > 0, events, findings };
  }

  private async loadFragments(input: {
    tenant_id: string;
    session_id: string;
  }): Promise<{ fragments: SessionFragment[]; messageIds: string[] }> {
    const messageResult = await this.pg.query(
      `SELECT id, sender_identity, body, current_body, edit_version, created_at
       FROM collaboration_messages
       WHERE tenant_id = $1 AND session_id = $2 AND deleted_at IS NULL
       ORDER BY created_at DESC, id DESC
       LIMIT $3`,
      [input.tenant_id, input.session_id, MESSAGE_LIMIT]
    );
    const messageIds = messageResult.rows.map((row) => String(row.id));
    if (!messageIds.length) return { fragments: [], messageIds: [] };
    const attachmentResult = await this.pg.query(
      `SELECT id, message_id, checksum, ocr_text, asr_text, processed_at, updated_at, created_at
       FROM collaboration_message_attachments
       WHERE tenant_id = $1 AND session_id = $2 AND message_id = ANY($3::text[])
       ORDER BY created_at ASC, id ASC`,
      [input.tenant_id, input.session_id, messageIds]
    );
    const attachments = new Map<string, Record<string, unknown>[]>();
    for (const row of attachmentResult.rows) {
      const messageId = String(row.message_id);
      const rows = attachments.get(messageId) || [];
      rows.push(row);
      attachments.set(messageId, rows);
    }

    let remaining = CHARACTER_LIMIT;
    const groups: SessionFragment[][] = [];
    for (const [messagePosition, row] of messageResult.rows.entries()) {
      if (remaining <= 0) break;
      const messageId = String(row.id);
      const sender = String(row.sender_identity || '');
      const group: SessionFragment[] = [];
      const body = String(row.current_body || row.body || '').trim();
      remaining = appendFragment(group, remaining, {
        content: body,
        message_id: messageId,
        message_position: messagePosition,
        evidence: {
          type: 'message', id: messageId, message_id: messageId, sender_identity: sender,
          source: 'text', version: Number(row.edit_version || 0) + 1,
          content_hash: sha256(body)
        }
      });
      for (const attachment of attachments.get(messageId) || []) {
        for (const source of ['ocr', 'asr'] as const) {
          if (remaining <= 0) break;
          const content = String(attachment[`${source}_text`] || '').trim();
          remaining = appendFragment(group, remaining, {
            content,
            message_id: messageId,
            message_position: messagePosition,
            evidence: {
              type: 'attachment', id: String(attachment.id), message_id: messageId,
              sender_identity: sender, source, checksum: String(attachment.checksum || ''),
              version: String(attachment.processed_at || attachment.updated_at || attachment.created_at || ''),
              content_hash: sha256(content)
            }
          });
        }
      }
      if (group.length) groups.push(group);
    }
    return { fragments: groups.reverse().flat(), messageIds };
  }

  private fragmentCandidates(fragments: SessionFragment[]): AggregateCandidate[] {
    const candidates: AggregateCandidate[] = [];
    for (let index = 0; index < fragments.length - 1; index += 1) {
      for (const size of [2, 3]) {
        const group = fragments.slice(index, index + size);
        if (group.length !== size || new Set(group.map((item) => item.evidence.id)).size < 2) continue;
        if (Math.abs(group.at(-1)!.message_position - group[0]!.message_position) > 2) continue;
        const individualKeys = new Set(group.flatMap((fragment) =>
          scanTextPolicy(fragment.content).map(matchKey)
        ));
        for (const match of scanTextPolicy(group.map((fragment) => fragment.content).join('\n'))) {
          if (individualKeys.has(matchKey(match))) continue;
          candidates.push({
            match,
            evidence_refs: group.map((fragment) => fragment.evidence),
            match_kind: 'aggregate'
          });
        }
        candidates.push(...intentAccountCandidates(group));
      }
    }
    return candidates;
  }

  private async loadVisualObservations(
    input: { tenant_id: string; session_id: string },
    messageIds: string[]
  ): Promise<VisualObservationRow[]> {
    if (!messageIds.length) return [];
    const result = await this.pg.query(
      `SELECT id, message_id, attachment_id, observation_type, value_hash, symbology,
              frame_timestamp_ms, page_number, detector_version
       FROM collaboration_visual_observations
       WHERE tenant_id = $1 AND session_id = $2 AND message_id = ANY($3::text[])
       ORDER BY created_at ASC, id ASC`,
      [input.tenant_id, input.session_id, messageIds]
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      message_id: String(row.message_id),
      attachment_id: String(row.attachment_id),
      observation_type: String(row.observation_type),
      value_hash: String(row.value_hash),
      symbology: String(row.symbology || ''),
      frame_timestamp_ms: row.frame_timestamp_ms == null ? null : Number(row.frame_timestamp_ms),
      page_number: row.page_number == null ? null : Number(row.page_number),
      detector_version: String(row.detector_version || 'visual-observation-v1')
    }));
  }

  private visualCandidates(
    fragments: SessionFragment[],
    observations: VisualObservationRow[]
  ): AggregateCandidate[] {
    const positionByMessage = new Map(fragments.map((fragment) => [
      fragment.message_id, fragment.message_position
    ]));
    const candidates: AggregateCandidate[] = [];
    for (const observation of observations) {
      const observationPosition = positionByMessage.get(observation.message_id);
      if (observationPosition == null) continue;
      for (const fragment of fragments) {
        if (Math.abs(fragment.message_position - observationPosition) > 1) continue;
        for (const intent of scanTextPolicy(fragment.content).filter((match) =>
          SOCIAL_POLICIES.has(match.policy_type)
        )) {
          candidates.push({
            match: {
              ...intent,
              matched_text_hash: sha256(`${intent.policy_type}:${observation.value_hash}`),
              confidence: Math.min(intent.confidence, 0.85)
            },
            evidence_refs: [fragment.evidence, {
              type: 'visual_observation', id: observation.id,
              message_id: observation.message_id, attachment_id: observation.attachment_id,
              source: 'ocr', observation_type: observation.observation_type,
              value_hash: observation.value_hash, symbology: observation.symbology,
              frame_timestamp_ms: observation.frame_timestamp_ms,
              page_number: observation.page_number, version: observation.detector_version
            }],
            match_kind: 'visual_code'
          });
        }
      }
    }
    return candidates;
  }

  private async recordEvent(
    input: { tenant_id: string; session_id: string },
    finding: PolicyScanResult['findings'][number]
  ): Promise<CollaborationPolicyEvent> {
    const eventId = pgId('cpol');
    await this.pg.query(
      `INSERT INTO collaboration_policy_events
        (id, tenant_id, session_id, message_id, policy_type, severity, matched_text_hash, action,
         source, source_ref_id, attachment_id, finding_id,
         detector_version, policy_version, evidence_snapshot_hash, content_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        eventId, input.tenant_id, input.session_id, '', finding.policy_type, finding.severity,
        finding.matched_text_hash, finding.action, 'aggregate', input.session_id, '', finding.id,
        finding.detector_version, finding.policy_version, finding.evidence_snapshot_hash,
        finding.content_version
      ]
    );
    const result = await this.pg.query('SELECT * FROM collaboration_policy_events WHERE id = $1', [eventId]);
    return decodePolicyEvent(result.rows[0]);
  }
}

function appendFragment(group: SessionFragment[], remaining: number, fragment: SessionFragment): number {
  if (!fragment.content || remaining <= 0) return remaining;
  const content = fragment.content.slice(0, Math.min(FRAGMENT_LIMIT, remaining));
  group.push({
    ...fragment,
    content,
    evidence: { ...fragment.evidence, content_hash: sha256(content) }
  });
  return remaining - content.length;
}

function intentAccountCandidates(group: SessionFragment[]): AggregateCandidate[] {
  const candidates: AggregateCandidate[] = [];
  for (let index = 0; index < group.length - 1; index += 1) {
    const intentFragment = group[index]!;
    const accountFragment = group[index + 1]!;
    const account = normalizedAccount(accountFragment.content);
    if (!account) continue;
    for (const intent of scanTextPolicy(intentFragment.content).filter((match) =>
      SOCIAL_POLICIES.has(match.policy_type)
    )) {
      candidates.push({
        match: {
          ...intent,
          matched_text_hash: sha256(`${intent.policy_type}:${account}`),
          confidence: Math.min(intent.confidence, 0.85)
        },
        evidence_refs: [intentFragment.evidence, accountFragment.evidence],
        match_kind: 'aggregate'
      });
    }
  }
  return candidates;
}

function normalizedAccount(value: string): string {
  const account = value.normalize('NFKC').trim().replace(/^@/, '').toLowerCase();
  return /^(?:[a-z][a-z0-9_.-]{4,31}|[1-9]\d{4,11})$/u.test(account) ? account : '';
}

function dedupeCandidates(candidates: AggregateCandidate[]): AggregateCandidate[] {
  const unique = new Map<string, AggregateCandidate>();
  for (const candidate of candidates) {
    const evidence = candidate.evidence_refs
      .map((ref) => `${String(ref.type)}:${String(ref.id)}:${String(ref.source || '')}`)
      .sort()
      .join('|');
    unique.set(`${matchKey(candidate.match)}:${evidence}`, candidate);
  }
  return [...unique.values()];
}

function matchKey(match: Pick<TextPolicyMatch, 'policy_type' | 'matched_text_hash'>): string {
  return `${match.policy_type}:${match.matched_text_hash}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function decodePolicyEvent(row: Record<string, unknown>): CollaborationPolicyEvent {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), session_id: String(row.session_id),
    message_id: String(row.message_id || ''), policy_type: String(row.policy_type),
    severity: String(row.severity) as CollaborationPolicyEvent['severity'],
    matched_text_hash: String(row.matched_text_hash), action: String(row.action || 'record'),
    source: 'aggregate', source_ref_id: String(row.source_ref_id || ''), attachment_id: '',
    finding_id: String(row.finding_id || ''), detector_version: String(row.detector_version),
    policy_version: String(row.policy_version), evidence_snapshot_hash: String(row.evidence_snapshot_hash),
    content_version: Number(row.content_version || 1), created_at: String(row.created_at || '')
  };
}
