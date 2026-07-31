import type { IveKitPolicyFinding, IveKitPolicyFindingReview } from '@converact/sdk';

export type FindingReviewStatus = IveKitPolicyFinding['review_status'];
export type FindingReviewAction = {
  status: Exclude<FindingReviewStatus, 'pending'>;
  label: string;
  accessibleName: string;
};

export interface FindingViewModel {
  id: string;
  messageId: string;
  policyType: string;
  severity: IveKitPolicyFinding['severity'];
  source: IveKitPolicyFinding['source'];
  sourceLabel: string;
  reviewStatus: FindingReviewStatus;
  statusLabel: string;
  rationale: string;
  evidenceLabels: string[];
  providerLabel: string;
  confidenceLabel: string;
  updatedAt: string;
}

const SOURCE_LABELS: Record<IveKitPolicyFinding['source'], string> = {
  text: 'Chat text',
  ocr: 'Image OCR',
  asr: 'Audio ASR',
  ai: 'AI quality',
  aggregate: 'Combined evidence'
};

const STATUS_LABELS: Record<FindingReviewStatus, string> = {
  pending: 'Pending review',
  confirmed: 'Confirmed',
  false_positive: 'Dismissed',
  resolved: 'Resolved',
  escalated: 'Follow-up requested'
};

const ACTIONS: Record<Exclude<FindingReviewStatus, 'resolved' | 'false_positive'>, FindingReviewAction[]> = {
  pending: [
    { status: 'confirmed', label: 'Confirm', accessibleName: 'Confirm finding' },
    { status: 'false_positive', label: 'Dismiss', accessibleName: 'Dismiss finding' },
    { status: 'escalated', label: 'Follow up', accessibleName: 'Request finding follow-up' }
  ],
  confirmed: [
    { status: 'resolved', label: 'Resolve', accessibleName: 'Resolve finding' },
    { status: 'false_positive', label: 'Dismiss', accessibleName: 'Dismiss finding' },
    { status: 'escalated', label: 'Follow up', accessibleName: 'Request finding follow-up' }
  ],
  escalated: [
    { status: 'confirmed', label: 'Confirm', accessibleName: 'Confirm finding' },
    { status: 'resolved', label: 'Resolve', accessibleName: 'Resolve finding' },
    { status: 'false_positive', label: 'Dismiss', accessibleName: 'Dismiss finding' }
  ]
};

export function projectFindings(findings: readonly IveKitPolicyFinding[]): FindingViewModel[] {
  const deduped = new Map<string, IveKitPolicyFinding>();
  for (const finding of findings) {
    const key = finding.fingerprint || finding.id;
    const current = deduped.get(key);
    if (!current || current.updated_at.localeCompare(finding.updated_at) < 0) deduped.set(key, finding);
  }
  return [...deduped.values()].map(projectFinding).sort(compareFindings);
}

export function availableFindingActions(status: FindingReviewStatus): FindingReviewAction[] {
  if (status === 'resolved' || status === 'false_positive') return [];
  return ACTIONS[status];
}

export function dedupeFindingReviews(
  reviews: readonly IveKitPolicyFindingReview[]
): IveKitPolicyFindingReview[] {
  return [...new Map(reviews.map((review) => [review.id, review])).values()];
}

function projectFinding(finding: IveKitPolicyFinding): FindingViewModel {
  const metadata = finding.metadata || {};
  const providerMode = String(metadata.provider_mode || '');
  const provider = safeText(String(metadata.provider || ''));
  return {
    id: finding.id,
    messageId: finding.message_id,
    policyType: safeText(finding.policy_type),
    severity: finding.severity,
    source: finding.source,
    sourceLabel: SOURCE_LABELS[finding.source],
    reviewStatus: finding.review_status,
    statusLabel: STATUS_LABELS[finding.review_status],
    rationale: safeText(finding.rationale) || 'No rationale supplied',
    evidenceLabels: safeEvidenceLabels(finding.evidence_refs || []),
    providerLabel: providerMode === 'unconfigured'
      ? 'Provider not configured'
      : provider ? `Provider: ${provider}` : '',
    confidenceLabel: finding.confidence == null ? '' : `${Math.round(finding.confidence * 100)}% confidence`,
    updatedAt: finding.updated_at
  };
}

function safeEvidenceLabels(refs: Array<Record<string, unknown>>): string[] {
  const labels = refs.map((ref) => {
    switch (String(ref.type || '')) {
      case 'attachment': return 'Attachment evidence';
      case 'message': return 'Message evidence';
      case 'quality_review': return 'Quality review evidence';
      default: return 'Policy evidence';
    }
  });
  return [...new Set(labels)];
}

export function safeFindingText(value: string): string {
  return safeText(value);
}

function safeText(value: string): string {
  return String(value || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, '[phone]')
    .trim();
}

function compareFindings(left: FindingViewModel, right: FindingViewModel): number {
  const severity = { high: 3, medium: 2, low: 1 };
  const active = { pending: 3, escalated: 3, confirmed: 2, resolved: 1, false_positive: 0 };
  return severity[right.severity] - severity[left.severity]
    || active[right.reviewStatus] - active[left.reviewStatus]
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.id.localeCompare(right.id);
}
