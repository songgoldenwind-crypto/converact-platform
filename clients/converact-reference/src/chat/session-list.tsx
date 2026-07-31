import type { IveKitChatSession } from '@converact/sdk';
import { Search } from 'lucide-react';
import type { KeyboardEvent } from 'react';

export function SessionList(props: {
  sessions: IveKitChatSession[];
  selectedId: string;
  query: string;
  loading: boolean;
  onQueryChange(value: string): void;
  onSelect(id: string): void;
  onLoadMore?(): void;
}) {
  const selectByKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const current = Math.max(0, props.sessions.findIndex((session) => session.id === props.selectedId));
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const next = props.sessions[Math.min(props.sessions.length - 1, Math.max(0, current + delta))];
    if (next) props.onSelect(next.id);
  };
  return (
    <section className="session-pane" aria-label="Sessions">
      <div className="pane-heading"><h1>Sessions</h1><span>{props.sessions.length}</span></div>
      <label className="search"><Search size={16} /><input value={props.query} onChange={(event) => props.onQueryChange(event.target.value)} placeholder="Search" /></label>
      <div className="session-list" onKeyDown={selectByKey}>
        {props.sessions.map((session) => (
          <button key={session.id} className={session.id === props.selectedId ? 'session active' : 'session'} onClick={() => props.onSelect(session.id)}>
            <span className="session-title">
              <strong>{session.title || session.business_ref.display_name || session.business_ref_id}</strong>
              {session.status === 'closed'
                ? <em className="closed-label">Closed</em>
                : Boolean(session.summary?.unread_count) && <b className="unread-badge" aria-label={`${session.summary?.unread_count} unread`}>{session.summary?.unread_count}</b>}
            </span>
            <span className="session-preview">
              <span>{lastMessageLabel(session)}</span>
              {session.summary?.last_message && <time>{shortTime(session.summary.last_message.created_at)}</time>}
            </span>
            <span className="session-meta">
              <span>{session.business_ref_type} · {session.business_ref_id}</span>
              <i
                className={`presence ${session.summary?.online_participant_count ? 'online' : 'offline'}`}
                role="img"
                aria-label={`${session.summary?.online_participant_count || 0} participants online`}
              />
            </span>
          </button>
        ))}
        {!props.sessions.length && <p className="empty">{props.loading ? 'Loading sessions' : 'No sessions'}</p>}
        {props.onLoadMore && <button className="text-command" onClick={props.onLoadMore}>Load more</button>}
      </div>
    </section>
  );
}

function lastMessageLabel(session: IveKitChatSession): string {
  const message = session.summary?.last_message;
  if (!message) return 'No messages yet';
  if (message.deleted) return `${message.sender_identity}: Message deleted`;
  const body = message.body.trim() || `[${message.message_type}]`;
  return `${message.sender_identity}: ${body}`;
}

function shortTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
