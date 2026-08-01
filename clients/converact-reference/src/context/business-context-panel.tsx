import type { ConveractFabricBusinessContext, ConveractFabricUnifiedTimelineEvent, ConveractFabricUnifiedTimelinePage } from '@converact/sdk';
import { Clock3, LoaderCircle, MessageSquare, MonitorCog, ShieldCheck, Users, Video, X } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

export function BusinessContextPanel(props: {
  context: ConveractFabricBusinessContext;
  loadTimeline(input?: { cursor?: string; limit?: number }): Promise<ConveractFabricUnifiedTimelinePage>;
  onClose(): void;
}) {
  const authorization = props.context.authorization;
  const [tab, setTab] = useState<'authorization' | 'activity'>('authorization');
  const [events, setEvents] = useState<ConveractFabricUnifiedTimelineEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const load = useCallback(async (append = false) => {
    const generation = ++request.current;
    setLoading(true);
    try {
      const page = await props.loadTimeline({ cursor: append ? cursor || undefined : undefined, limit: 25 });
      if (generation !== request.current) return;
      setEvents((current) => append ? [...current, ...page.items] : page.items);
      setCursor(page.next_cursor);
      setHasMore(page.has_more && Boolean(page.next_cursor));
      setError('');
    } catch (cause) {
      if (generation === request.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation === request.current) setLoading(false);
    }
  }, [cursor, props.loadTimeline]);
  const selectTab = (next: 'authorization' | 'activity') => {
    setTab(next);
    if (next === 'activity' && events.length === 0 && !loading) void load(false);
  };
  return <aside className="business-context-panel" aria-label="Business authorization summary">
    <header>
      <div><ShieldCheck size={17} /><span><strong>Authorization</strong><small>{props.context.viewer.identity}</small></span></div>
      <button title="Close authorization summary" onClick={props.onClose}><X size={16} /></button>
    </header>
    <div className="context-panel-tabs" role="tablist" aria-label="Business context view">
      <button role="tab" aria-selected={tab === 'authorization'} onClick={() => selectTab('authorization')}><ShieldCheck size={14} /> Authorization</button>
      <button role="tab" aria-selected={tab === 'activity'} onClick={() => selectTab('activity')}><Clock3 size={14} /> Activity</button>
    </div>
    {tab === 'authorization' ? <><section>
      <h2><MessageSquare size={15} /> Messages</h2>
      {authorization.chat.length ? authorization.chat.map((item) => <div className="authorization-resource" key={item.session_id}>
        <span><strong>{item.viewer_role || 'System view'}</strong><small>{item.session_id}</small></span>
        <span><Users size={13} /> {activeCount(item.participants)} active / {item.participants.length}</span>
      </div>) : <p>No visible message session</p>}
    </section>
    <section>
      <h2><Video size={15} /> Calls</h2>
      {authorization.media.length ? authorization.media.map((item) => <div className="authorization-resource" key={item.call_id}>
        <span><strong>{item.viewer_role || 'System view'}</strong><small>{item.viewer_status || item.call_id}</small></span>
        <span><Users size={13} /> {item.participants.length} participants</span>
      </div>) : <p>No visible call</p>}
    </section>
    <section>
      <h2><MonitorCog size={15} /> Remote</h2>
      {authorization.remote_assistance.length ? authorization.remote_assistance.map((item) => <div className="remote-authorization" key={item.remote_session_id}>
        <div className="authorization-resource">
          <span><strong>{item.viewer_role || 'System view'}</strong><small>{item.remote_session_id}</small></span>
          <span>{item.consent.active ? `${item.consent.scopes.length} scopes` : 'No active consent'}</span>
        </div>
        <dl>
          <dt>Consent</dt><dd>{item.consent.scopes.join(', ') || 'None'}</dd>
          <dt>Control</dt><dd>{item.gateway?.controller.owner_identity || item.gateway?.controller.status || 'No gateway'}</dd>
          <dt>Gateway</dt><dd>{item.gateway?.status || 'Not active'}</dd>
        </dl>
      </div>) : <p>No visible remote session</p>}
    </section></> : <section className="business-timeline">
      {events.map((event) => <article key={event.id}>
        <span className={`timeline-source source-${event.source}`}>{event.source}</span>
        <div><strong>{event.event_type}</strong><small>{event.actor_identity || 'system'} · <time dateTime={event.occurred_at}>{new Date(event.occurred_at).toLocaleString()}</time></small></div>
        {event.evidence_ref && <output title={event.evidence_ref.checksum || 'Checksum pending'}>{event.evidence_ref.kind} · {shortChecksum(event.evidence_ref.checksum)}</output>}
      </article>)}
      {!events.length && !loading && !error && <p>No activity recorded</p>}
      {error && <p className="timeline-error" role="alert">{error}</p>}
      {loading && <div className="timeline-loading"><LoaderCircle className="spin" size={15} /> Loading activity</div>}
      {hasMore && !loading && <button className="timeline-more" onClick={() => void load(true)}>Load older</button>}
    </section>}
  </aside>;
}

function activeCount(participants: Array<{ status: string }>): number {
  return participants.filter((participant) => participant.status === 'active').length;
}

function shortChecksum(value: string): string {
  return value ? `${value.slice(0, 12)}…` : 'pending';
}
