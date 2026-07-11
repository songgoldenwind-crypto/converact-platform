import { Clock3, Users } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { MediaCallState } from './media-reducer.js';

export function CallHeader(props: { state: MediaCallState; now?: number }) {
  const [clock, setClock] = useState(() => props.now ?? Date.now());
  const call = props.state.call;
  const active = call?.status === 'active' && Boolean(call.started_at);

  useEffect(() => {
    if (props.now != null) setClock(props.now);
  }, [props.now]);
  useEffect(() => {
    if (!active || props.now != null) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active, props.now]);

  return (
    <header className="media-call-header">
      <div className="media-call-title">
        <h2>{call?.title || 'Media call'}</h2>
        <span className={`call-status status-${call?.status || 'idle'}`}>{statusLabel(call?.status || 'idle')}</span>
      </div>
      <div className="media-call-facts">
        <span><Users size={14} />{props.state.participants.length} participants</span>
        {active && call?.started_at && (
          <time aria-label="Call elapsed time" dateTime={call.started_at}><Clock3 size={14} />{elapsed(clock, call.started_at)}</time>
        )}
      </div>
    </header>
  );
}

function elapsed(now: number, startedAt: string): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${pad(hours)}:${pad(minutes)}:${pad(remainder)}`
    : `${pad(minutes)}:${pad(remainder)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function statusLabel(status: string): string {
  return status.replaceAll('_', ' ').replace(/^./, (value) => value.toUpperCase());
}
