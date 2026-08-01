import type {
  ConveractFabricHttpSdk,
  ConveractFabricFindingQueueInput,
  ConveractFabricFindingQueueItem,
  ConveractFabricPolicyFinding,
  ConveractFabricPolicyFindingResult,
  ConveractFabricPolicyFindingReviewInput
} from '@converact/sdk';
import { Filter, RefreshCw } from 'lucide-react';
import React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { FindingPanel } from './finding-panel.js';

interface QueueFilters {
  sessionId: string;
  source: '' | 'text' | 'ocr' | 'asr' | 'ai';
  severity: '' | 'low' | 'medium' | 'high';
  reviewStatus: '' | 'pending' | 'confirmed' | 'false_positive' | 'resolved' | 'escalated';
  createdFrom: string;
  createdTo: string;
}

export function ReviewQueue(props: {
  client: ConveractFabricHttpSdk;
  initialSessionId?: string;
  refreshVersion?: number;
}) {
  const initialFilters = filtersFor(props.initialSessionId);
  const [draft, setDraft] = useState(initialFilters);
  const [filters, setFilters] = useState(initialFilters);
  const [items, setItems] = useState<ConveractFabricPolicyFinding[]>([]);
  const [cursor, setCursor] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<ConveractFabricPolicyFindingResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (pageCursor = '') => {
    setLoading(true);
    setError('');
    try {
      const page = await props.client.intelligence.listFindings(queueInput(filters, pageCursor));
      const next = page.items.map(queueFinding);
      setItems((current) => pageCursor ? dedupeFindings([...current, ...next]) : next);
      setCursor(page.next_cursor);
      setDenied(false);
    } catch (cause) {
      if (errorStatus(cause) === 403) setDenied(true);
      else setError('Review queue unavailable');
    } finally {
      setLoading(false);
    }
  }, [filters, props.client]);

  useEffect(() => { void load(); }, [load, props.refreshVersion]);

  const loadDetail = useCallback(async (id: string) => {
    if (!items.some((item) => item.id === id)) throw new Error('Finding is no longer available');
    const result = await props.client.intelligence.getFinding(id);
    const normalized = { ...result, finding: queueFinding(result.finding) };
    setDetail(normalized);
    return normalized;
  }, [items, props.client]);

  const review = useCallback(async (id: string, input: ConveractFabricPolicyFindingReviewInput) => {
    if (!items.some((item) => item.id === id)) throw new Error('Finding is no longer available');
    const result = await props.client.intelligence.reviewFinding(id, input);
    const normalized = { ...result, finding: queueFinding(result.finding) };
    setItems((current) => current.map((item) => item.id === id ? normalized.finding : item));
    setDetail(normalized);
    return normalized;
  }, [items, props.client]);

  if (denied) return <section className="quality-review-queue denied"><p>Review queue unavailable for your role</p></section>;

  return <section className="quality-review-queue" aria-label="Tenant quality review queue">
    <form className="quality-filters" onSubmit={(event) => { event.preventDefault(); setFilters({ ...draft }); }}>
      <label>Session<input aria-label="Finding session" value={draft.sessionId} onChange={(event) => setDraft({ ...draft, sessionId: event.target.value })} /></label>
      <label>Status<select aria-label="Finding status" value={draft.reviewStatus} onChange={(event) => setDraft({ ...draft, reviewStatus: event.target.value as QueueFilters['reviewStatus'] })}>
        <option value="">All</option><option value="pending">Pending</option><option value="confirmed">Confirmed</option><option value="escalated">Follow-up</option><option value="resolved">Resolved</option><option value="false_positive">Dismissed</option>
      </select></label>
      <label>Severity<select aria-label="Finding severity" value={draft.severity} onChange={(event) => setDraft({ ...draft, severity: event.target.value as QueueFilters['severity'] })}>
        <option value="">All</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
      </select></label>
      <label>Source<select aria-label="Finding source" value={draft.source} onChange={(event) => setDraft({ ...draft, source: event.target.value as QueueFilters['source'] })}>
        <option value="">All</option><option value="text">Chat text</option><option value="ocr">Image OCR</option><option value="asr">Audio ASR</option><option value="ai">AI quality</option>
      </select></label>
      <label>From<input type="date" aria-label="Finding date from" value={draft.createdFrom} onChange={(event) => setDraft({ ...draft, createdFrom: event.target.value })} /></label>
      <label>To<input type="date" aria-label="Finding date to" value={draft.createdTo} onChange={(event) => setDraft({ ...draft, createdTo: event.target.value })} /></label>
      <button type="submit" aria-label="Apply filters"><Filter size={14} /><span>Apply</span></button>
      <button type="button" className="quality-refresh" aria-label="Refresh findings" disabled={loading} onClick={() => void load()}><RefreshCw className={loading ? 'spin' : ''} size={14} /></button>
    </form>
    {error && <p className="quality-workspace-error" role="alert">{error}</p>}
    <FindingPanel
      findings={items}
      selectedId={selectedId}
      detail={detail}
      canReview
      onSelect={(id) => { setSelectedId(id); setDetail(null); }}
      onLoadDetail={loadDetail}
      onReview={review}
    />
    {cursor && <button className="quality-load-more" aria-label="Load more findings" disabled={loading} onClick={() => void load(cursor)}>Load more</button>}
  </section>;
}

function filtersFor(sessionId = ''): QueueFilters {
  return { sessionId, source: '', severity: '', reviewStatus: 'pending', createdFrom: '', createdTo: '' };
}

function queueInput(filters: QueueFilters, cursor: string): ConveractFabricFindingQueueInput {
  return {
    ...(filters.sessionId.trim() ? { session_id: filters.sessionId.trim() } : {}),
    ...(filters.source ? { source: filters.source } : {}),
    ...(filters.severity ? { severity: filters.severity } : {}),
    ...(filters.reviewStatus ? { review_status: filters.reviewStatus } : {}),
    ...(filters.createdFrom ? { created_from: `${filters.createdFrom}T00:00:00.000Z` } : {}),
    ...(filters.createdTo ? { created_to: `${filters.createdTo}T23:59:59.999Z` } : {}),
    ...(cursor ? { cursor } : {}),
    limit: 50
  };
}

function queueFinding(value: ConveractFabricFindingQueueItem): ConveractFabricPolicyFinding {
  return {
    id: value.id,
    tenant_id: text(value.tenant_id),
    session_id: value.session_id,
    message_id: text(value.message_id),
    source: enumValue(value.source, ['text', 'ocr', 'asr', 'ai', 'aggregate'], 'text'),
    source_ref_id: text(value.source_ref_id),
    policy_type: text(value.policy_type),
    severity: enumValue(value.severity, ['low', 'medium', 'high'], 'medium'),
    matched_text_hash: '',
    fingerprint: value.id,
    action: text(value.action),
    confidence: typeof value.confidence === 'number' ? value.confidence : null,
    rationale: text(value.rationale),
    review_status: enumValue(value.review_status, ['pending', 'confirmed', 'false_positive', 'resolved', 'escalated'], 'pending'),
    evidence_refs: Array.isArray(value.evidence_refs) ? value.evidence_refs.filter(record) : [],
    detector_version: text(value.detector_version),
    policy_version: text(value.policy_version),
    evidence_snapshot_hash: text(value.evidence_snapshot_hash),
    content_version: Number.isSafeInteger(value.content_version) && value.content_version >= 0 ? value.content_version : 0,
    reviewed_by: text(value.reviewed_by),
    reviewed_at: nullableText(value.reviewed_at),
    review_note: text(value.review_note),
    metadata: {},
    created_at: text(value.created_at),
    updated_at: text(value.updated_at),
    resolved_at: nullableText(value.resolved_at)
  };
}

function dedupeFindings(items: ConveractFabricPolicyFinding[]): ConveractFabricPolicyFinding[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function text(value: unknown): string { return String(value || ''); }
function nullableText(value: unknown): string | null { return value == null || value === '' ? null : String(value); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}
function errorStatus(cause: unknown): number { return Number((cause as { status?: unknown })?.status || 0); }
