import { createIveKitClient, type IveKitChatMessage, type IveKitChatSession } from '@opc/ivekit-sdk';
import { BriefcaseBusiness, CircleStop, List, MessageSquare, MonitorCog, Phone, RefreshCw } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { MessageComposer } from './chat/message-composer.js';
import { MessageTimeline } from './chat/message-timeline.js';
import { ParticipantRail } from './chat/participant-rail.js';
import { SessionList } from './chat/session-list.js';
import { projectSessionSummary } from './chat/session-summary.js';
import { useChatSession } from './chat/use-chat-session.js';
import { useBusinessContext, type BusinessRefSelection } from './context/use-business-context.js';
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

const RustDeskLaunchPanel = lazy(async () => {
  const module = await import('./remote/rustdesk-launch-panel.js');
  return { default: module.RustDeskLaunchPanel };
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
  const [workspaceMode, setWorkspaceMode] = useState<'messages' | 'calls' | 'remote'>(initialWorkspaceMode);
  const [businessRef, setBusinessRef] = useState<BusinessRefSelection | null>(initialBusinessRef);
  const sessionRequest = useRef(0);
  const sessionCursor = useRef<string | null>(null);
  const seededContext = useRef('');

  const client = useMemo(() => config && token ? createIveKitClient({
    baseUrl: config.baseUrl,
    tenantId: config.tenantId,
    accessToken: token
  }) : null, [config, token]);
  const businessContext = useBusinessContext(client, businessRef);
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
      const page = await client.chat.listSessions({
        query,
        cursor: append ? sessionCursor.current || undefined : undefined,
        limit: 50,
        business_ref_type: businessRef?.type,
        business_ref_id: businessRef?.id
      });
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
  }, [businessRef?.id, businessRef?.type, client, query]);

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
    if (!selected) return;
    const next = { type: selected.business_ref.type, id: selected.business_ref.id };
    if (businessRef?.type === next.type && businessRef.id === next.id) return;
    setBusinessRef(next);
    replaceUrlState({ businessRef: next });
  }, [businessRef?.id, businessRef?.type, selected]);
  useEffect(() => {
    if (!businessContext.context || !businessRef) return;
    const key = `${businessRef.type}:${businessRef.id}`;
    if (seededContext.current === key) return;
    seededContext.current = key;
    if (!mediaCallId) {
      const callId = businessContext.context.media.calls[0]?.id || '';
      if (callId) selectMediaCallValue(callId, setMediaCallId);
    }
  }, [businessContext.context, businessRef, mediaCallId]);
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
  const openExternal = useCallback((url: string) => {
    try {
      if (window.iveKitHost?.openExternal) {
        void Promise.resolve(window.iveKitHost.openExternal(url)).catch(reportCommandError);
        return;
      }
      window.location.assign(url);
    } catch (cause) {
      reportCommandError(cause);
    }
  }, [reportCommandError]);
  const dismissError = useCallback(() => {
    setBootstrapError('');
    setCommandError('');
    chat.clearError();
  }, [chat.clearError]);
  const visibleError = bootstrapError || businessContext.error || commandError || chat.error;
  const closeSelected = useCallback(async () => {
    if (!selected || !window.confirm('Close this session for every participant?')) return;
    const closed = await chat.closeSession();
    if (closed) setSessions((current) => current.map((session) => session.id === closed.id ? closed : session));
  }, [chat.closeSession, selected]);
  const selectMediaCall = useCallback((callId: string) => {
    selectMediaCallValue(callId, setMediaCallId);
  }, []);
  const selectWorkspace = useCallback((mode: 'messages' | 'calls' | 'remote') => {
    setWorkspaceMode(mode);
    replaceUrlState({ workspace: mode });
  }, []);

  return (
    <main className={`workspace ${workspaceMode === 'calls' ? 'workspace-media' : workspaceMode === 'remote' ? 'workspace-remote' : ''}`} data-mobile-view={mobileView}>
      <header className="topbar">
        <div className="brand"><MessageSquare size={18} /> <strong>iveKit</strong></div>
        {businessRef && <div className="business-context" title={`${businessRef.type}: ${businessRef.id}`}>
          <BriefcaseBusiness size={15} />
          <strong>{businessRef.id}</strong>
          {businessContext.context && <span>{businessContext.context.chat.count}M · {businessContext.context.media.count}C · {businessContext.context.remote_assistance.count}R</span>}
          <button title="Refresh business context" disabled={businessContext.loading} onClick={() => void businessContext.refresh()}><RefreshCw className={businessContext.loading ? 'spin' : ''} size={14} /></button>
        </div>}
        <div className="workspace-tabs" role="group" aria-label="Workspace">
          <button title="Show messages workspace" aria-pressed={workspaceMode === 'messages'} onClick={() => selectWorkspace('messages')}><MessageSquare size={16} /><span>Messages</span></button>
          <button title="Show calls workspace" aria-pressed={workspaceMode === 'calls'} onClick={() => selectWorkspace('calls')}><Phone size={16} /><span>Calls</span></button>
          <button title="Show remote workspace" aria-pressed={workspaceMode === 'remote'} onClick={() => selectWorkspace('remote')}><MonitorCog size={16} /><span>Remote</span></button>
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
      /></> : workspaceMode === 'calls'
        ? <Suspense fallback={<div className="media-workspace-loading">Loading call</div>}><MediaWorkspace client={client} identity={identity} callId={mediaCallId} onCallIdChange={selectMediaCall} websocketUrl={config?.websocketUrl} accessToken={token} /></Suspense>
        : <Suspense fallback={<div className="media-workspace-loading">Loading remote workspace</div>}><RustDeskLaunchPanel client={client?.rustdesk || null} identity={identity} onError={reportCommandError} openProtocol={openExternal} initialBusinessRef={businessRef || undefined} initialRemoteSessionId={businessContext.context?.remote_assistance.sessions[0]?.id} /></Suspense>}
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

function initialBusinessRef(): BusinessRefSelection | null {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  const type = url.searchParams.get('business_ref_type')?.trim() || '';
  const id = url.searchParams.get('business_ref_id')?.trim() || '';
  return type && id ? { type, id } : null;
}

function initialWorkspaceMode(): 'messages' | 'calls' | 'remote' {
  if (typeof window === 'undefined') return 'messages';
  const url = new URL(window.location.href);
  const mode = url.searchParams.get('workspace');
  if (mode === 'messages' || mode === 'calls' || mode === 'remote') return mode;
  return initialCallId() ? 'calls' : 'messages';
}

function selectMediaCallValue(callId: string, setCallId: (value: string) => void): void {
  setCallId(callId);
  replaceUrlState({ callId });
}

function replaceUrlState(input: {
  businessRef?: BusinessRefSelection;
  callId?: string;
  workspace?: 'messages' | 'calls' | 'remote';
}): void {
  const url = new URL(window.location.href);
  if (input.businessRef) {
    url.searchParams.set('business_ref_type', input.businessRef.type);
    url.searchParams.set('business_ref_id', input.businessRef.id);
  }
  if (input.callId !== undefined) {
    if (input.callId) url.searchParams.set('call_id', input.callId);
    else url.searchParams.delete('call_id');
  }
  if (input.workspace) url.searchParams.set('workspace', input.workspace);
  window.history.replaceState({}, '', url);
}
