import { createIveKitClient, type IveKitChatMessage, type IveKitChatSession } from '@opc/ivekit-sdk';
import { MessageSquare, RefreshCw, Search, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { loadRuntimeConfig, requestAccessToken, type IveKitRuntimeConfig } from './runtime-config.js';

type WorkspaceState = 'loading' | 'ready' | 'empty' | 'error';

export function App() {
  const [config, setConfig] = useState<IveKitRuntimeConfig | null>(null);
  const [token, setToken] = useState('');
  const [sessions, setSessions] = useState<IveKitChatSession[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [messages, setMessages] = useState<IveKitChatMessage[]>([]);
  const [query, setQuery] = useState('');
  const [state, setState] = useState<WorkspaceState>('loading');
  const [error, setError] = useState('');

  const client = useMemo(() => config && token ? createIveKitClient({
    baseUrl: config.baseUrl,
    tenantId: config.tenantId,
    accessToken: token
  }) : null, [config, token]);

  const refreshSessions = useCallback(async () => {
    if (!client) return;
    setState('loading');
    try {
      const page = await client.chat.listSessions({ status: 'open', query, limit: 50 });
      setSessions(page.items);
      setSelectedId((current) => current || page.items[0]?.id || '');
      setState(page.items.length ? 'ready' : 'empty');
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setState('error');
    }
  }, [client, query]);

  useEffect(() => {
    Promise.all([loadRuntimeConfig(), requestAccessToken()])
      .then(([runtime, accessToken]) => { setConfig(runtime); setToken(accessToken); })
      .catch((cause) => { setError(cause instanceof Error ? cause.message : String(cause)); setState('error'); });
  }, []);
  useEffect(() => { void refreshSessions(); }, [refreshSessions]);
  useEffect(() => {
    if (!client || !selectedId) { setMessages([]); return; }
    void client.chat.listMessagesPage(selectedId, { direction: 'before', limit: 50 })
      .then((page) => setMessages(page.items))
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [client, selectedId]);

  const selected = sessions.find((session) => session.id === selectedId);
  return (
    <main className="workspace">
      <header className="topbar">
        <div className="brand"><MessageSquare size={18} /> <strong>iveKit</strong></div>
        <span className={`connection connection-${state}`}>{state === 'ready' ? 'Online' : state}</span>
        <button className="icon-button" title="Refresh sessions" onClick={() => void refreshSessions()}>
          <RefreshCw size={17} />
        </button>
      </header>
      <section className="session-pane">
        <div className="pane-heading"><h1>Sessions</h1><span>{sessions.length}</span></div>
        <label className="search"><Search size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" /></label>
        <div className="session-list">
          {sessions.map((session) => (
            <button key={session.id} className={session.id === selectedId ? 'session active' : 'session'} onClick={() => setSelectedId(session.id)}>
              <strong>{session.title || session.business_ref.display_name || session.business_ref_id}</strong>
              <span>{session.business_ref_type} · {session.business_ref_id}</span>
            </button>
          ))}
          {state === 'empty' && <p className="empty">No active sessions</p>}
        </div>
      </section>
      <section className="timeline-pane">
        <div className="pane-heading"><h2>{selected?.title || 'Messages'}</h2><span>{messages.length}</span></div>
        <div className="timeline">
          {messages.map((message) => (
            <article className="message" key={message.id}>
              <div><strong>{message.sender_identity}</strong><time>{new Date(message.created_at).toLocaleTimeString()}</time></div>
              <p>{message.deleted_at ? 'Message deleted' : message.body}</p>
            </article>
          ))}
          {!messages.length && <p className="empty">No messages</p>}
        </div>
        <div className="composer"><textarea disabled={!selected} aria-label="Message" /><button disabled={!selected}>Send</button></div>
      </section>
      <aside className="detail-pane">
        <div className="pane-heading"><h2>Details</h2><Users size={17} /></div>
        {selected ? <dl><dt>Status</dt><dd>{selected.status}</dd><dt>Reference</dt><dd>{selected.business_ref_id}</dd><dt>Tenant</dt><dd>{selected.tenant_id}</dd></dl> : <p className="empty">Select a session</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </aside>
    </main>
  );
}
