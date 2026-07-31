import { Circle, Download, Play, Search, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  IveKitHttpSdk,
  IveKitMediaCall,
  IveKitMediaCallRole,
  IveKitMediaRecording,
  IveKitMediaRecordingObjectInspection
} from '@converact/sdk';
import { isTerminalStatus } from './media-reducer.js';

const activeStatuses = new Set<IveKitMediaRecording['status']>(['starting', 'pending', 'recording', 'stopping']);

export function RecordingPanel(props: {
  client: IveKitHttpSdk;
  call: IveKitMediaCall;
  role: IveKitMediaCallRole;
  pollMs?: number;
  invalidationKey?: number;
}) {
  const [recordings, setRecordings] = useState<IveKitMediaRecording[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [inspections, setInspections] = useState<Record<string, IveKitMediaRecordingObjectInspection>>({});
  const [playback, setPlayback] = useState<{ url: string; contentType: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [authorized, setAuthorized] = useState(true);
  const [error, setError] = useState('');
  const [clock, setClock] = useState(() => Date.now());
  const generation = useRef(0);
  const nextCursorRef = useRef<string | null>(null);
  const playbackUrl = useRef('');

  const load = useCallback(async (append = false) => {
    const request = generation.current;
    try {
      const page = await props.client.media.listRecordingsPage({
        call_id: props.call.id,
        room_name: props.call.room_name,
        limit: 25,
        ...(append && nextCursorRef.current ? { cursor: nextCursorRef.current } : {})
      });
      if (generation.current !== request) return;
      setRecordings((current) => append ? dedupe([...current, ...page.items]) : page.items);
      setNextCursor(page.next_cursor);
      nextCursorRef.current = page.next_cursor;
      setError('');
    } catch (cause) {
      if (generation.current === request) {
        setError(errorMessage(cause));
        if (isAuthorizationLoss(cause)) setAuthorized(false);
      }
    }
  }, [props.client, props.call.id, props.call.room_name]);

  useEffect(() => {
    generation.current += 1;
    setRecordings([]);
    setNextCursor(null);
    nextCursorRef.current = null;
    setInspections({});
    setAuthorized(true);
    void load(false);
    return () => { generation.current += 1; };
  }, [props.call.id, load]);

  const hasActive = recordings.some((recording) => activeStatuses.has(recording.status));
  useEffect(() => {
    if (!hasActive || !authorized || isTerminalStatus(props.call.status)) return;
    const timer = window.setTimeout(() => void load(false), props.pollMs ?? 2_000);
    return () => window.clearTimeout(timer);
  }, [hasActive, authorized, props.call.status, props.pollMs, load, recordings]);
  useEffect(() => {
    if (!hasActive) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasActive]);
  useEffect(() => () => { if (playbackUrl.current) URL.revokeObjectURL(playbackUrl.current); }, []);
  useEffect(() => { if (props.invalidationKey) void load(false); }, [props.invalidationKey, load]);

  const run = async (command: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try { await command(); await load(false); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  };
  const start = () => run(() => props.client.media.startRecording(props.call.room_name, {
    media_call_id: props.call.id,
    business_ref: props.call.business_ref,
    has_video: props.call.media === 'video'
  }));
  const stop = (recording: IveKitMediaRecording) => run(() => props.client.media.stopRecording(recording.egress_id));
  const inspect = async (recording: IveKitMediaRecording) => {
    try {
      const result = await props.client.media.inspectRecordingObject(recording.id);
      setInspections((current) => ({ ...current, [recording.id]: result }));
    } catch (cause) { setError(errorMessage(cause)); }
  };
  const fetchObject = async (recording: IveKitMediaRecording, play: boolean) => {
    try {
      const file = await props.client.media.exportRecordingObject(recording.id);
      if (play && !canPlayMedia(file.contentType)) {
        throw new Error(`This browser cannot play ${file.contentType || 'the exported recording'}`);
      }
      const bytes = Uint8Array.from(file.bytes);
      const url = URL.createObjectURL(new Blob([bytes.buffer], { type: file.contentType }));
      if (play) {
        if (playbackUrl.current) URL.revokeObjectURL(playbackUrl.current);
        playbackUrl.current = url;
        setPlayback({ url, contentType: file.contentType });
      } else {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = file.filename;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    } catch (cause) { setError(errorMessage(cause)); }
  };

  const active = recordings.find((recording) => activeStatuses.has(recording.status));
  return <section className="recording-panel" aria-label="Recordings">
    <header><strong>Recordings</strong>{props.role === 'host' && !active && !isTerminalStatus(props.call.status) && <button title="Start recording" disabled={busy} onClick={() => void start()}><Circle size={15} />Start</button>}</header>
    {error && <div className="recording-error" role="alert">{error}</div>}
    <div className="recording-list">{recordings.map((recording) => {
      const inspection = inspections[recording.id];
      return <article key={recording.id}>
        <div><strong>{statusLabel(recording.status)}</strong><span>{durationLabel(recording, clock)}</span></div>
        <small>Retention {dateLabel(recording.retention_until)}</small>
        {recording.evidence_record_id && <small>Evidence <code>{recording.evidence_record_id}</code></small>}
        {inspection && <small>{inspection.readable ? `${inspection.size_bytes} bytes` : inspection.status}</small>}
        <footer>
          {props.role === 'host' && activeStatuses.has(recording.status) && <button title="Stop recording" disabled={busy || !recording.egress_id} onClick={() => void stop(recording)}><Square size={14} /></button>}
          <button title="Inspect recording object" disabled={busy} onClick={() => void inspect(recording)}><Search size={14} /></button>
          {recording.object_status === 'readable' && <><button title="Play recording" onClick={() => void fetchObject(recording, true)}><Play size={14} /></button><button title="Export recording" onClick={() => void fetchObject(recording, false)}><Download size={14} /></button></>}
        </footer>
      </article>;
    })}{!recordings.length && <span className="recording-empty">No recordings</span>}</div>
    {nextCursor && <button className="recording-more" onClick={() => void load(true)}>Load more</button>}
    {playback && (playback.contentType.startsWith('video/') ? <video controls src={playback.url} /> : <audio controls src={playback.url} />)}
  </section>;
}

function dedupe(items: IveKitMediaRecording[]): IveKitMediaRecording[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}
function statusLabel(status: string): string { return status.replace(/^./, (value) => value.toUpperCase()); }
function durationLabel(recording: IveKitMediaRecording, now: number): string {
  if (recording.duration_ms != null) return formatDuration(recording.duration_ms);
  if (!activeStatuses.has(recording.status)) return 'Duration unavailable';
  const startedAt = Date.parse(recording.created_at);
  return Number.isFinite(startedAt) ? `${formatDuration(Math.max(0, now - startedAt))} elapsed` : 'Duration pending';
}
function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function canPlayMedia(contentType: string): boolean {
  const kind = contentType.startsWith('video/') ? 'video' : contentType.startsWith('audio/') ? 'audio' : '';
  if (!kind) return false;
  const media = document.createElement(kind);
  return typeof media.canPlayType !== 'function' || media.canPlayType(contentType) !== '';
}
function dateLabel(value: string): string { return value ? new Date(value).toISOString().slice(0, 10) : 'not set'; }
function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
function isAuthorizationLoss(cause: unknown): boolean {
  const status = Number((cause as { status?: unknown })?.status || 0);
  return status === 401 || status === 403 || status === 404;
}
