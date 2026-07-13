import type {
  IveKitPolicyFinding,
  IveKitPolicyFindingResult,
  IveKitPolicyFindingReviewInput
} from '@opc/ivekit-sdk';
import { AlertTriangle, Check, CircleCheck, SearchCheck, X } from 'lucide-react';
import React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  availableFindingActions,
  projectFindings,
  safeFindingText,
  type FindingReviewAction
} from './finding-view-model.js';

export function FindingPanel(props: {
  findings: IveKitPolicyFinding[];
  selectedId: string;
  detail: IveKitPolicyFindingResult | null;
  canReview: boolean;
  onSelect(id: string): void;
  onLoadDetail(id: string): Promise<IveKitPolicyFindingResult>;
  onReview(id: string, input: IveKitPolicyFindingReviewInput): Promise<IveKitPolicyFindingResult>;
}) {
  const projected = useMemo(() => projectFindings(props.findings), [props.findings]);
  const [detail, setDetail] = useState(props.detail);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const attemptedDetailVersion = useRef('');
  const projectedSelected = projected.find((item) => item.id === props.selectedId);
  useEffect(() => setDetail(props.detail), [props.detail]);
  useEffect(() => {
    setNote('');
    setError('');
    attemptedDetailVersion.current = '';
  }, [props.selectedId]);
  useEffect(() => {
    const detailIsCurrent = detail?.finding.id === props.selectedId &&
      (!projectedSelected || detail.finding.updated_at === projectedSelected.updatedAt);
    if (!props.selectedId || detailIsCurrent) return;
    const requestedVersion = `${props.selectedId}:${projectedSelected?.updatedAt || ''}`;
    if (attemptedDetailVersion.current === requestedVersion) return;
    attemptedDetailVersion.current = requestedVersion;
    let active = true;
    void props.onLoadDetail(props.selectedId).then((result) => {
      if (active) setDetail(result);
    }).catch((cause) => {
      if (active) setError(errorMessage(cause));
    });
    return () => { active = false; };
  }, [props.selectedId, projectedSelected, detail, props.onLoadDetail]);

  const selected = detail?.finding.id === props.selectedId &&
    (!projectedSelected || detail.finding.updated_at === projectedSelected.updatedAt)
    ? projectFindings([detail.finding])[0]
    : projectedSelected;
  const actions = selected ? availableFindingActions(selected.reviewStatus) : [];

  const review = async (action: FindingReviewAction) => {
    const reason = note.trim();
    if (!reason) {
      setError('A review reason is required');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await props.onReview(selected!.id, {
        review_status: action.status,
        note: reason
      });
      setDetail(result);
      setNote('');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return <div className="finding-panel">
    <div className="finding-list" aria-label="Quality findings">
      {projected.map((item) => <button
        className={`finding ${item.severity}${item.id === props.selectedId ? ' selected' : ''}`}
        key={item.id}
        onClick={() => props.onSelect(item.id)}
      >
        <span><strong>{item.policyType}</strong><small>{item.sourceLabel}</small></span>
        <span><em>{item.statusLabel}</em><small>{item.severity}</small></span>
      </button>)}
      {!projected.length && <p className="empty">No findings</p>}
    </div>
    {selected && <section className="finding-detail" aria-label="Finding detail">
      <header><AlertTriangle size={15} /><strong>{selected.policyType}</strong><span>{selected.statusLabel}</span></header>
      <p>{selected.rationale}</p>
      <div className="finding-facts">
        <span>{selected.sourceLabel}</span>
        {selected.confidenceLabel && <span>{selected.confidenceLabel}</span>}
        {selected.providerLabel && <span>{selected.providerLabel}</span>}
        {selected.evidenceLabels.map((label) => <span key={label}>{label}</span>)}
      </div>
      {!!detail?.reviews?.length && <div className="review-history">
        <strong>Review history</strong>
        {detail.reviews.map((review) => <div key={review.id}>
          <span>{review.from_status} → {review.to_status}</span>
          <small>{safeFindingText(review.reviewed_by)} · {new Date(review.created_at).toLocaleString()}</small>
          {review.note && <p>{safeFindingText(review.note)}</p>}
        </div>)}
      </div>}
      {props.canReview && !!actions.length && <div className="review-controls">
        <textarea aria-label="Review reason" value={note} onInput={(event) => setNote(event.currentTarget.value)} placeholder="Reason for this decision" />
        <div>{actions.map((action) => <button
          key={action.status}
          title={action.accessibleName}
          aria-label={action.accessibleName}
          disabled={busy}
          onClick={() => void review(action)}
        >{actionIcon(action.status)}<span>{action.label}</span></button>)}</div>
      </div>}
      {!props.canReview && !!actions.length && <p className="review-unavailable">Review unavailable for your role</p>}
      {error && <p className="finding-error" role="alert">{error}</p>}
    </section>}
  </div>;
}

function actionIcon(status: FindingReviewAction['status']) {
  if (status === 'confirmed') return <Check size={14} />;
  if (status === 'false_positive') return <X size={14} />;
  if (status === 'resolved') return <CircleCheck size={14} />;
  return <SearchCheck size={14} />;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
