import { createIveKitClient, type IveKitChatMessage, type IveKitChatSession } from '@opc/ivekit-sdk';
import { CircleStop, List, MessageSquare, Phone, RefreshCw } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { MessageComposer } from './chat/message-composer.js';
import { MessageTimeline } from './chat/message-timeline.js';
import { ParticipantRail } from './chat/participant-rail.js';
import { SessionList } from './chat/session-list.js';
import { projectSessionSummary } from './chat/session-summary.js';
import { useChatSession } from './chat/use-chat-session.js';
import {
  loadRuntimeConfig,
  accessTokenRefreshDelay,
  startAccessTokenRefreshLoop,
  requestAccessToken,
  requestIdentity,
  type IveKitRuntimeConfig
} from './runtime-config.js';

const MediaWorkspace = lazy(async () => {
  const module = await import('./media/media-workspace.js');
  return { default: module.MediaWorkspace };
});

export function App() {
  const [config, setConfig] = useState<IveKitRuntimeConfig | null>(null);
  const [token, setToken] = useState('');
  const [identity, setIdentity] = useState('');
  const [sessions, setSessions] = useState<IveKitChatSession[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [sessionHasMore, setSessionHasMore] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState('');
  const [commandError, setCommandError] = useState('');
  const [replyTo, setReplyTo] = useState<IveKitChatMessage | null>(null);
  const [forwardFrom, setForwardFrom] = useState<IveKitChatMessage | null>(null);
  const [mobileView, setMobileView] = useState<'sessions' | 'chat'>('sessions');
  const [selectedFindingId, setSelectedFindingId] = useState('');
  const [mediaCallId, setMediaCallId] = useState(initialCallId);
  const [workspaceMode, setWorkspaceMode] = useState<'messages' | 'calls'>(() => initialCallId() ? 'calls' : 'messages');
  const sessionRequest = useRef(0);
  const sessionCursor = useRef<string | null>(null);

  const client = useMemo(() => config && token ? createIveKitClient({
    baseUrl: config.baseUrl,
    tenantId: config.tenantId,
    accessToken: token
  }) : null, [config, token]);
  const selected = sessions.find((session) => session.id === selectedId) || null;
  const chat = useChatSession({
    client,
    session: selected,
    identity,
    accessToken: token,
    websocketUrl: config?.websocketUrl
  });

  const refreshSessions = useCallback(async (append = false) => {
    if (!client) return;
    const request = ++sessionRequest.current;
    setSessionLoading(true);
    try {
      const page = await client.chat.listSessions({ query, cursor: append ? sessionCursor.current || undefined : undefined, limit: 50 });
      if (request !== sessionRequest.current) return;
      setSessions((current) => append ? dedupeSessions([...current, ...page.items]) : page.items);
      sessionCursor.current = page.next_cursor;
      setSessionHasMore(page.has_more && Boolean(page.next_cursor));
      setSelectedId((current) => append
        ? current || page.items[0]?.id || ''
        : page.items.some((session) => session.id === current) ? current : page.items[0]?.id || '');
      setBootstrapError('');
    } catch (cause) {
      if (request === sessionRequest.current) setBootstrapError(errorMessage(cause));
    } finally {
      if (request === sessionRequest.current) setSessionLoading(false);
    }
  }, [client, query]);

  useEffect(() => {
    let active = true;
    let refreshLoop: { stop(): void } | null = null;
    void (async () => {
      try {
        const runtime = await loadRuntimeConfig();
        if (!active) return;
        setConfig(runtime);
        refreshLoop = startAccessTokenRefreshLoop({
          load: async () => {
            const accessToken = await requestAccessToken();
            return { accessToken, identity: await requestIdentity(accessToken) };
          },
          onToken: (credentials) => {
            setToken(credentials.accessToken);
            setIdentity(credentials.identity);
            setBootstrapError('');
          },
          onError: (cause) => setBootstrapError(errorMessage(cause)),
          refreshDelay: (credentials) => accessTokenRefreshDelay(credentials.accessToken)
        });
      } catch (cause) {
        if (active) { setBootstrapError(errorMessage(cause)); setSessionLoading(false); }
      }
    })();
    return () => {
      active = false;
      refreshLoop?.stop();
    };
  }, []);
  useEffect(() => {
    if (workspaceMode !== 'messages') return;
    const timer = window.setTimeout(() => void refreshSessions(false), 250);
    return () => window.clearTimeout(timer);
  }, [refreshSessions, workspaceMode]);
  useEffect(() => setSelectedFindingId(''), [selectedId]);
  useEffect(() => {
    if (!selectedId || chat.loading || chat.state.requestId === 0) return;
    setSessions((current) => current.map((session) => session.id === selectedId
      ? projectSessionSummary(session, chat.state.messages, chat.state.realtime, chat.state.unreadCount)
      : session));
  }, [selectedId, chat.loading, chat.state.requestId, chat.state.messages, chat.state.realtime, chat.state.unreadCount]);

  const upload = useCallback((file: File, onProgress: (percent: number) => void) => {
    const operation = chat.uploadAttachment({
      kind: attachmentKind(file),
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      body: file
    }, { onProgress: (progress) => onProgress(progress.percent) });
    return operation;
  }, [chat.uploadAttachment]);

  const download = useCallback(async (attachmentId: string) => {
    if (!client || !selected) return;
    const file = await client.chat.downloadAttachment(selected.id, attachmentId);
    const bytes = Uint8Array.from(file.bytes);
    const url = URL.createObjectURL(new Blob([bytes.buffer], { type: file.contentType }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [client, selected]);
  const reportCommandError = useCallback((cause: unknown) => setCommandError(errorMessage(cause)), []);
  const dismissError = useCallback(() => {
    setBootstrapError('');
    setCommandError('');
    chat.clearError();
  }, [chat.clearError]);
  const visibleError = bootstrapError || commandError || chat.error;
  const closeSelected = useCallback(async () => {
    if (!selected || !window.confirm('Close this session for every participant?')) return;
    const closed = await chat.closeSession();
    if (closed) setSessions((current) => current.map((session) => session.id === closed.id ? closed : session));
  }, [chat.closeSession, selected]);
  const selectMediaCall = useCallback((callId: string) => {
    setMediaCallId(callId);
    const url = new URL(window.location.href);
    if (callId) url.searchParams.set('call_id', callId);
    else url.searchParams.delete('call_id');
    window.history.replaceState({}, '', url);
  }, []);

  return (
    <main className={`workspace ${workspaceMode === 'calls' ? 'workspace-media' : ''}`} data-mobile-view={mobileView}>
      <header className="topbar">
        <div className="brand"><MessageSquare size={18} /> <strong>iveKit</strong></div>
        <div className="workspace-tabs" role="group" aria-label="Workspace">
          <button title="Show messages workspace" aria-pressed={workspaceMode === 'messages'} onClick={() => setWorkspaceMode('messages')}><MessageSquare size={16} /><span>Messages</span></button>
          <button title="Show calls workspace" aria-pressed={workspaceMode === 'calls'} onClick={() => setWorkspaceMode('calls')}><Phone size={16} /><span>Calls</span></button>
        </div>
        {workspaceMode === 'messages' && <div className="mobile-tabs" role="group" aria-label="Mobile workspace">
          <button title="Show sessions" aria-pressed={mobileView === 'sessions'} onClick={() => setMobileView('sessions')}><List size={17} /></button>
          <button title="Show messages" aria-pressed={mobileView === 'chat'} onClick={() => setMobileView('chat')}><MessageSquare size={17} /></button>
        </div>}
        {workspaceMode === 'messages' && <><span className={`connection connection-${chat.state.connection}`}>{chat.state.connection}</span><button className="icon-button" title="Refresh sessions" onClick={() => void refreshSessions(false)}><RefreshCw size={17} /></button></>}
      </header>
      {workspaceMode === 'messages' ? <><SessionList
        sessions={sessions}
        selectedId={selectedId}
        query={query}
        loading={sessionLoading}
        onQueryChange={(value) => {
          sessionCursor.current = null;
          setSessionHasMore(false);
          setQuery(value);
        }}
        onSelect={(id) => { setSelectedId(id); setSelectedFindingId(''); setReplyTo(null); setForwardFrom(null); setMobileView('chat'); }}
        onLoadMore={sessionHasMore ? () => void refreshSessions(true) : undefined}
      />
      <section className="timeline-pane">
        <div className="pane-heading"><h2>{selected?.title || 'Messages'}</h2><span className="pane-actions"><span>{chat.state.unreadCount ? `${chat.state.unreadCount} unread` : chat.state.messages.length}</span><button className="icon-button light" title="Close session" disabled={!selected || chat.state.closed} onClick={() => void closeSelected().catch(reportCommandError)}><CircleStop size={16} /></button></span></div>
        <MessageTimeline
          messages={chat.state.messages}
          identity={identity}
          receipts={chat.state.receipts}
          findings={chat.findings}
          canLoadOlder={chat.hasOlder}
          onLoadOlder={() => void chat.loadOlder().catch(reportCommandError)}
          onReply={(message) => { setReplyTo(message); setForwardFrom(null); }}
          onForward={(message) => { setForwardFrom(message); setReplyTo(null); }}
          onRetry={(id) => void chat.retrySend(id).catch(reportCommandError)}
          onReact={(id, emoji, remove) => void chat.react(id, emoji, remove).catch(reportCommandError)}
          onPin={(id, remove) => void chat.pin(id, remove).catch(reportCommandError)}
          onEdit={(id, body) => void chat.editMessage(id, body).catch(reportCommandError)}
          onDelete={(id) => void chat.deleteMessage(id).catch(reportCommandError)}
          onRead={(id) => void chat.markRead(id).catch(() => undefined)}
          onDownload={(id) => void download(id).catch(reportCommandError)}
          onSelectFinding={setSelectedFindingId}
        />
        <MessageComposer
          key={selectedId}
          disabled={!selected || chat.loading || chat.state.requestId === 0 || chat.state.closed || chat.state.connection === 'fatal' || !identity}
          participants={chat.participants}
          replyTo={replyTo}
          forwardFrom={forwardFrom}
          onClearRelation={() => { setReplyTo(null); setForwardFrom(null); }}
          onUpload={upload}
          onSend={chat.sendMessage}
          onTyping={chat.setTyping}
        />
      </section>
      <ParticipantRail
        participants={chat.participants}
        realtime={chat.state.realtime}
        findings={chat.findings}
        identity={identity}
        selectedFindingId={selectedFindingId}
        findingDetail={selectedFindingId ? chat.findingDetails[selectedFindingId] || null : null}
        onSelectFinding={setSelectedFindingId}
        onCloseFinding={() => setSelectedFindingId('')}
        onLoadFinding={chat.loadFinding}
        onReviewFinding={chat.reviewFinding}
      /></> : <Suspense fallback={<div className="media-workspace-loading">Loading call</div>}><MediaWorkspace client={client} identity={identity} callId={mediaCallId} onCallIdChange={selectMediaCall} websocketUrl={config?.websocketUrl} accessToken={token} /></Suspense>}
      {visibleError && <div className="error-toast" role="alert">{visibleError}<button title="Dismiss error" onClick={dismissError}>×</button></div>}
    </main>
  );
}

function attachmentKind(file: File): 'image' | 'video' | 'audio' | 'file' {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'file';
}

function dedupeSessions(sessions: IveKitChatSession[]): IveKitChatSession[] {
  return [...new Map(sessions.map((session) => [session.id, session])).values()];
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function initialCallId(): string {
  return typeof window === 'undefined' ? '' : new URL(window.location.href).searchParams.get('call_id')?.trim() || '';
}
