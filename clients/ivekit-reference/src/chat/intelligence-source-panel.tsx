import type { IveKitClient, IveKitIntelligenceSourceSnapshot } from '@opc/ivekit-sdk';
import { Import, RefreshCw, RotateCcw } from 'lucide-react';
import React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

export function IntelligenceSourcePanel(props: {
  client: IveKitClient;
  initialSessionId?: string;
  refreshVersion?: number;
}) {
  const sessionId = useRef<HTMLInputElement>(null);
  const sourceType = useRef<HTMLSelectElement>(null);
  const sourceRefId = useRef<HTMLInputElement>(null);
  const [snapshot, setSnapshot] = useState<IveKitIntelligenceSourceSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (sessionId.current) sessionId.current.value = props.initialSessionId || '';
  }, [props.initialSessionId]);

  const refresh = useCallback(async () => {
    if (!snapshot) return;
    const next = await props.client.intelligence.getSource(snapshot.source.session_id, snapshot.source.id);
    setSnapshot(next);
    setError('');
  }, [props.client, snapshot?.source.id, snapshot?.source.session_id]);

  useEffect(() => {
    if (!snapshot) return;
    void refresh().catch((cause) => handleError(cause, setDenied, setError));
  }, [props.refreshVersion, refresh]);

  useEffect(() => {
    if (!snapshot || !['pending', 'processing', 'retry_wait'].includes(snapshot.source.status)) return;
    const timer = window.setTimeout(() => {
      void refresh().catch((cause) => handleError(cause, setDenied, setError));
    }, 1_500);
    return () => window.clearTimeout(timer);
  }, [refresh, snapshot]);

  async function importSource() {
    const session = sessionId.current?.value.trim() || '';
    const sourceRef = sourceRefId.current?.value.trim() || '';
    const type = sourceType.current?.value === 'remote_recording' ? 'remote_recording' : 'media_recording';
    if (!session || !sourceRef) {
      setError('Session and recording source ID are required');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await props.client.intelligence.importSource(session, {
        source_type: type,
        source_ref_id: sourceRef
      }, { idempotencyKey: randomId() });
      setSnapshot(result);
      setDenied(false);
    } catch (cause) {
      handleError(cause, setDenied, setError);
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    if (!snapshot) return;
    setBusy(true);
    setError('');
    try {
      setSnapshot(await props.client.intelligence.retrySource(snapshot.source.session_id, snapshot.source.id));
    } catch (cause) {
      handleError(cause, setDenied, setError);
    } finally {
      setBusy(false);
    }
  }

  if (denied) return <section className="intelligence-source-panel denied"><p>Recording intelligence unavailable for your role</p></section>;

  const status = snapshot?.source.status || '';
  const errorCode = text(snapshot?.source.error_code);
  return <section className="intelligence-source-panel" aria-label="Recording intelligence source">
    <header><div><h2>Recording sources</h2><small>Media and remote evidence</small></div>{snapshot && <button title="Refresh recording status" disabled={busy} onClick={() => void refresh()}><RefreshCw className={busy ? 'spin' : ''} size={15} /></button>}</header>
    <div className="source-import-fields">
      <label>Session ID<input ref={sessionId} defaultValue={props.initialSessionId || ''} /></label>
      <label>Source type<select ref={sourceType} aria-label="Recording source type" defaultValue="media_recording">
        <option value="media_recording">LiveKit recording</option><option value="remote_recording">Remote recording</option>
      </select></label>
      <label>Recording source ID<input ref={sourceRefId} aria-label="Recording source ID" /></label>
      <button className="source-import-command" disabled={busy} onClick={() => void importSource()}><Import size={15} /><span>Import recording</span></button>
    </div>
    {snapshot && <div className="source-status" aria-live="polite">
      <div><span className={`source-status-dot ${status}`} /><strong>{sourceStatusLabel(status)}</strong><small>{sourceTypeLabel(snapshot.source)}</small></div>
      <dl>
        <dt>Source</dt><dd>{snapshot.source.id}</dd>
        <dt>Message</dt><dd>{snapshot.message_id}</dd>
        <dt>Attachment</dt><dd>{text(snapshot.attachment.id)}</dd>
        <dt>Extraction</dt><dd>{text(snapshot.attachment.processing_status) || 'pending'}</dd>
      </dl>
      {errorCode && <p className="source-status-error">{sourceErrorLabel(errorCode)}</p>}
      {['failed', 'cancelled'].includes(status) && <button className="source-retry" aria-label="Retry recording processing" disabled={busy} onClick={() => void retry()}><RotateCcw size={14} /><span>Retry processing</span></button>}
    </div>}
    {error && <p className="quality-workspace-error" role="alert">{error}</p>}
  </section>;
}

function sourceStatusLabel(status: string): string {
  switch (status) {
    case 'pending': return 'Pending';
    case 'processing': return 'Processing';
    case 'retry_wait': return 'Retry scheduled';
    case 'succeeded': return 'Succeeded';
    case 'failed': return 'Failed';
    case 'cancelled': return 'Cancelled';
    default: return 'Not imported';
  }
}

function sourceTypeLabel(source: Record<string, unknown>): string {
  return source.source_type === 'remote_recording' ? 'Remote recording' : 'LiveKit recording';
}

function sourceErrorLabel(code: string): string {
  if (code === 'provider_unavailable') return 'Provider unavailable';
  if (code === 'provider_credential_unavailable') return 'Provider credentials unavailable';
  if (code.includes('policy_disabled')) return 'Processing disabled by policy';
  return 'Recording processing failed';
}

function handleError(
  cause: unknown,
  setDenied: (value: boolean) => void,
  setError: (value: string) => void
) {
  if (Number((cause as { status?: unknown })?.status || 0) === 403) setDenied(true);
  else setError('Recording intelligence request failed');
}

function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  throw new Error('Web Crypto is required for source import idempotency');
}

function text(value: unknown): string { return String(value || ''); }
