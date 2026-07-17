import {
  createIveKitHttpSdk,
  type IveKitChatMessage,
  type IveKitChatSession
} from '@opc/ivekit-sdk';
import { BriefcaseBusiness, CircleStop, Headset, List, MessageSquare, MonitorCog, Phone, RefreshCw, ScanSearch, ShieldCheck, Workflow } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { MessageComposer } from './chat/message-composer.js';
import { MessageTimeline } from './chat/message-timeline.js';
import { ParticipantRail } from './chat/participant-rail.js';
import { SessionList } from './chat/session-list.js';
import { projectSessionSummary } from './chat/session-summary.js';
import { useChatSession } from './chat/use-chat-session.js';
import { useBusinessContext, type BusinessRefSelection } from './context/use-business-context.js';
import { BusinessContextPanel } from './context/business-context-panel.js';
import {
  readIveKitLocation,
  sessionLocationPatch,
  updateIveKitLocation,
  type IveKitLocationPatch,
  type WorkspaceMode
} from './navigation.js';
import {
  loadRuntimeConfig,
  accessTokenRefreshDelay,
  startAccessTokenRefreshLoop,
  requestAccessToken,
  requestIdentity,
  type IveKitRuntimeConfig
} from './runtime-config.js';
import { EventReplayController, eventWorkspace, type EventWorkspace } from './realtime/event-replay.js';

const MediaWorkspace = lazy(async () => {
  const module = await import('./media/media-workspace.js');
  return { default: module.MediaWorkspace };
});

const RustDeskWorkspace = lazy(async () => {
  const module = await import('./remote/rustdesk-workspace.js');
  return { default: module.RustDeskWorkspace };
});

const QualityWorkspace = lazy(async () => {
  const module = await import('./chat/quality-workspace.js');
  return { default: module.QualityWorkspace };
});

const VoiceWorkspace = lazy(async () => {
  const module = await import('./voice/voice-workspace.js');
  return { default: module.VoiceWorkspace };
});

const QueueMonitorWorkspace = lazy(async () => {
  const module = await import('./contact-center/queue-monitor-workspace.js');
  return { default: module.QueueMonitorWorkspace };
});

const IvrDesignerWorkspace = lazy(async () => {
  const processLike = (globalThis as {
    process?: { versions?: { node?: string } };
  }).process;
  if (!processLike?.versions?.node) await import('@xyflow/react/dist/style.css');
  const module = await import('./ivr/ivr-designer-browser.js');
  return { default: module.IvrDesignerWorkspace };
});

export function App() {
  const initialLocation = useRef(currentIveKitLocation()).current;
  const [config, setConfig] = useState<IveKitRuntimeConfig | null>(null);
  const [token, setToken] = useState('');
  const [identity, setIdentity] = useState('');
  const [sessions, setSessions] = useState<IveKitChatSession[]>([]);
  const [selectedId, setSelectedId] = useState(initialLocation.sessionId);
  const [query, setQuery] = useState('');
  const [sessionHasMore, setSessionHasMore] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState('');
  const [commandError, setCommandError] = useState('');
  const [replyTo, setReplyTo] = useState<IveKitChatMessage | null>(null);
  const [forwardFrom, setForwardFrom] = useState<IveKitChatMessage | null>(null);
  const [mobileView, setMobileView] = useState<'sessions' | 'chat'>('sessions');
  const [selectedFindingId, setSelectedFindingId] = useState('');
  const [mediaCallId, setMediaCallId] = useState(initialLocation.callId);
  const [voiceCallId, setVoiceCallId] = useState(initialLocation.voiceCallId);
  const [remoteSessionId, setRemoteSessionId] = useState(initialLocation.remoteSessionId);
  const [flowId, setFlowId] = useState(initialLocation.flowId);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(initialLocation.workspace);
  const [businessRef, setBusinessRef] = useState<BusinessRefSelection | null>(initialLocation.businessRef);
  const [authorizationOpen, setAuthorizationOpen] = useState(false);
  const [chatReplayVersion, setChatReplayVersion] = useState(0);
  const [mediaReplayVersion, setMediaReplayVersion] = useState(0);
  const [voiceReplayVersion, setVoiceReplayVersion] = useState(0);
  const [remoteReplayVersion, setRemoteReplayVersion] = useState(0);
  const [ivrReplayVersion, setIvrReplayVersion] = useState(0);
  const sessionRequest = useRef(0);
  const sessionCursor = useRef<string | null>(null);
  const seededContext = useRef('');

  const client = useMemo(() => config && token ? createIveKitHttpSdk({
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
    websocketUrl: config?.websocketUrl,
    replayVersion: chatReplayVersion
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
    const onPopState = () => {
      const next = currentIveKitLocation();
      setWorkspaceMode(next.workspace);
      setBusinessRef(next.businessRef);
      setSelectedId(next.sessionId);
      setMediaCallId(next.callId);
      setVoiceCallId(next.voiceCallId);
      setRemoteSessionId(next.remoteSessionId);
      setFlowId(next.flowId);
      setMobileView(next.sessionId ? 'chat' : 'sessions');
      seededContext.current = '';
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  useEffect(() => {
    if (workspaceMode !== 'messages') return;
    const timer = window.setTimeout(() => void refreshSessions(false), 250);
    return () => window.clearTimeout(timer);
  }, [refreshSessions, workspaceMode]);
  useEffect(() => setSelectedFindingId(''), [selectedId]);
  useEffect(() => setAuthorizationOpen(false), [businessRef?.id, businessRef?.type]);
  useEffect(() => {
    if (!selected) return;
    const next = { type: selected.business_ref.type, id: selected.business_ref.id };
    const locationPatch = sessionLocationPatch(businessRef, next, selected.id);
    const businessChanged = locationPatch.callId === '';
    if (businessChanged) {
      setBusinessRef(next);
      setMediaCallId('');
      setVoiceCallId('');
      setRemoteSessionId('');
      setFlowId('');
      seededContext.current = '';
    }
    navigateIveKitLocation(locationPatch);
  }, [businessRef?.id, businessRef?.type, selected]);
  useEffect(() => {
    if (!businessContext.context || !businessRef) return;
    if (businessContext.context.business_ref.type !== businessRef.type ||
        businessContext.context.business_ref.id !== businessRef.id) return;
    const key = `${businessRef.type}:${businessRef.id}`;
    if (seededContext.current === key) return;
    seededContext.current = key;
    if (!mediaCallId) {
      const callId = businessContext.context.media.calls[0]?.id || '';
      if (callId) selectMediaCallValue(callId, setMediaCallId, 'replace');
    }
    if (!remoteSessionId) {
      const nextRemoteSessionId = businessContext.context.remote_assistance.sessions[0]?.id || '';
      if (nextRemoteSessionId) {
        setRemoteSessionId(nextRemoteSessionId);
        navigateIveKitLocation({ remoteSessionId: nextRemoteSessionId });
      }
    }
  }, [businessContext.context, businessRef, mediaCallId, remoteSessionId]);
  useEffect(() => {
    if (!client) return;
    let refreshTimer: number | null = null;
    const pending = new Set<EventWorkspace>();
    const refresh = async (workspace: EventWorkspace) => {
      if (workspace === 'chat') {
        setChatReplayVersion((value) => value + 1);
        await refreshSessions(false);
      } else if (workspace === 'media') {
        setMediaReplayVersion((value) => value + 1);
        await businessContext.refresh();
      } else if (workspace === 'voice') {
        setVoiceReplayVersion((value) => value + 1);
      } else if (workspace === 'remote') {
        setRemoteReplayVersion((value) => value + 1);
        await businessContext.refresh();
      } else if (workspace === 'ivr') {
        setIvrReplayVersion((value) => value + 1);
      } else {
        await businessContext.refresh();
      }
    };
    const flush = () => {
      refreshTimer = null;
      const workspaces = [...pending];
      pending.clear();
      void Promise.all(workspaces.map(refresh)).catch(() => undefined);
    };
    const schedule = (workspace: EventWorkspace) => {
      pending.add(workspace);
      if (refreshTimer === null) refreshTimer = window.setTimeout(flush, 50);
    };
    const controller = new EventReplayController({
      events: client.events,
      onEvent: (event) => { schedule(eventWorkspace(event.type)); },
      snapshots: {
        chat: () => refresh('chat'),
        media: () => refresh('media'),
        voice: () => refresh('voice'),
        remote: () => refresh('remote'),
        ivr: () => refresh('ivr')
      }
    });
    const resume = () => { void controller.resume().catch(() => undefined); };
    const visible = () => { if (document.visibilityState === 'visible') resume(); };
    void controller.start().catch(() => undefined);
    const interval = window.setInterval(resume, 15_000);
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', visible);
    return () => {
      controller.stop();
      window.clearInterval(interval);
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [businessContext.refresh, client, refreshSessions]);
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
    selectMediaCallValue(callId, setMediaCallId, 'push');
  }, []);
  const selectVoiceCall = useCallback((callId: string) => {
    setVoiceCallId(callId);
    navigateIveKitLocation({ voiceCallId: callId }, callId ? 'push' : 'replace');
  }, []);
  const selectWorkspace = useCallback((mode: WorkspaceMode) => {
    setWorkspaceMode(mode);
    navigateIveKitLocation({ workspace: mode }, 'push');
  }, []);
  const loadBusinessTimeline = useCallback((input?: { cursor?: string; limit?: number }) => {
    if (!client || !businessRef) return Promise.reject(new Error('business context unavailable'));
    return client.context.listTimeline(businessRef, input);
  }, [businessRef?.id, businessRef?.type, client]);

  return (
    <main className={`workspace ${workspaceMode === 'calls' ? 'workspace-media' : workspaceMode === 'voice' ? 'workspace-voice' : workspaceMode === 'remote' ? 'workspace-remote' : workspaceMode === 'quality' ? 'workspace-quality' : workspaceMode === 'operations' ? 'workspace-operations' : workspaceMode === 'ivr' ? 'workspace-ivr' : ''}`} data-mobile-view={mobileView}>
      <header className="topbar">
        <div className="brand"><MessageSquare size={18} /> <strong>iveKit</strong></div>
        {businessRef && <div className="business-context" title={`${businessRef.type}: ${businessRef.id}`}>
          <BriefcaseBusiness size={15} />
          <strong>{businessRef.id}</strong>
          {businessContext.context && <span>{businessContext.context.chat.count}M · {businessContext.context.media.count}C · {businessContext.context.remote_assistance.count}R</span>}
          <button title="Show authorization summary" disabled={!businessContext.context} onClick={() => setAuthorizationOpen((open) => !open)}><ShieldCheck size={14} /></button>
          <button title="Refresh business context" disabled={businessContext.loading} onClick={() => void businessContext.refresh()}><RefreshCw className={businessContext.loading ? 'spin' : ''} size={14} /></button>
        </div>}
        <div className="workspace-tabs" role="group" aria-label="Workspace">
          <button title="Show messages workspace" aria-pressed={workspaceMode === 'messages'} onClick={() => selectWorkspace('messages')}><MessageSquare size={16} /><span>Messages</span></button>
          <button title="Show calls workspace" aria-pressed={workspaceMode === 'calls'} onClick={() => selectWorkspace('calls')}><Phone size={16} /><span>Calls</span></button>
          <button title="Show voice workspace" aria-pressed={workspaceMode === 'voice'} onClick={() => selectWorkspace('voice')}><Headset size={16} /><span>Voice</span></button>
          <button title="Show remote workspace" aria-pressed={workspaceMode === 'remote'} onClick={() => selectWorkspace('remote')}><MonitorCog size={16} /><span>Remote</span></button>
          <button title="Show quality workspace" aria-pressed={workspaceMode === 'quality'} onClick={() => selectWorkspace('quality')}><ScanSearch size={16} /><span>Quality</span></button>
          <button title="Show operations workspace" aria-pressed={workspaceMode === 'operations'} onClick={() => selectWorkspace('operations')}><List size={16} /><span>Operations</span></button>
          <button title="Show IVR Designer" aria-pressed={workspaceMode === 'ivr'} onClick={() => selectWorkspace('ivr')}><Workflow size={16} /><span>IVR</span></button>
        </div>
        {workspaceMode === 'messages' && <div className="mobile-tabs" role="group" aria-label="Mobile workspace">
          <button title="Show sessions" aria-pressed={mobileView === 'sessions'} onClick={() => setMobileView('sessions')}><List size={17} /></button>
          <button title="Show messages" aria-pressed={mobileView === 'chat'} onClick={() => setMobileView('chat')}><MessageSquare size={17} /></button>
        </div>}
        {workspaceMode === 'messages' && <><span className={`connection connection-${chat.state.connection}`}>{chat.state.connection}</span><button className="icon-button" title="Refresh sessions" onClick={() => void refreshSessions(false)}><RefreshCw size={17} /></button></>}
      </header>
      {authorizationOpen && businessContext.context && <BusinessContextPanel context={businessContext.context} loadTimeline={loadBusinessTimeline} onClose={() => setAuthorizationOpen(false)} />}
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
        onSelect={(id) => {
          const nextSession = sessions.find((session) => session.id === id);
          setSelectedId(id); setSelectedFindingId(''); setReplyTo(null); setForwardFrom(null); setMobileView('chat');
          navigateIveKitLocation({
            sessionId: id,
            businessRef: nextSession ? { type: nextSession.business_ref.type, id: nextSession.business_ref.id } : undefined
          }, 'push');
        }}
        onLoadMore={sessionHasMore ? () => void refreshSessions(true) : undefined}
      />
      <section className="timeline-pane">
        <div className="pane-heading"><h2>{selected?.title || 'Messages'}</h2><span className="pane-actions"><span>{chat.state.unreadCount ? `${chat.state.unreadCount} unread` : chat.state.messages.length}</span><button className="icon-button light" title="Close session" disabled={!selected || chat.state.closed} onClick={() => void closeSelected().catch(reportCommandError)}><CircleStop size={16} /></button></span></div>
        <MessageTimeline
          messages={chat.state.messages}
          client={client}
          sessionId={selected?.id}
          refreshVersion={chatReplayVersion}
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
        ? <Suspense fallback={<div className="media-workspace-loading">Loading call</div>}><MediaWorkspace key={`media-replay-${mediaReplayVersion}`} client={client} identity={identity} callId={mediaCallId} onCallIdChange={selectMediaCall} websocketUrl={config?.websocketUrl} accessToken={token} /></Suspense>
        : workspaceMode === 'voice'
          ? <Suspense fallback={<div className="media-workspace-loading">Loading voice workspace</div>}><VoiceWorkspace client={client} callId={voiceCallId} onCallIdChange={selectVoiceCall} refreshVersion={voiceReplayVersion} businessRef={businessRef || undefined} /></Suspense>
          : workspaceMode === 'remote'
            ? <Suspense fallback={<div className="media-workspace-loading">Loading remote workspace</div>}><RustDeskWorkspace key={`remote-replay-${remoteReplayVersion}`} baseUrl={config?.baseUrl || ''} tenantId={config?.tenantId || ''} accessToken={token} identity={identity} onError={reportCommandError} openProtocol={openExternal} initialBusinessRef={businessRef || undefined} initialRemoteSessionId={remoteSessionId} onRemoteSessionIdChange={(value) => { setRemoteSessionId(value); navigateIveKitLocation({ remoteSessionId: value }); }} /></Suspense>
            : workspaceMode === 'quality'
              ? client && <Suspense fallback={<div className="media-workspace-loading">Loading quality workspace</div>}><QualityWorkspace client={client} selectedSessionId={selectedId} refreshVersion={chatReplayVersion} /></Suspense>
              : workspaceMode === 'operations'
                ? <Suspense fallback={<div className="media-workspace-loading">Loading operations workspace</div>}><QueueMonitorWorkspace client={client} /></Suspense>
                : <Suspense fallback={<div className="media-workspace-loading">Loading IVR Designer</div>}><IvrDesignerWorkspace client={client} flowId={flowId} refreshVersion={ivrReplayVersion} onFlowIdChange={(value) => { setFlowId(value); navigateIveKitLocation({ flowId: value }); }} /></Suspense>}
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

function currentIveKitLocation() {
  return readIveKitLocation(typeof window === 'undefined' ? 'http://ivekit.local/' : window.location.href);
}

function selectMediaCallValue(
  callId: string,
  setCallId: (value: string) => void,
  history: 'push' | 'replace'
): void {
  setCallId(callId);
  navigateIveKitLocation({ callId }, history);
}

function navigateIveKitLocation(patch: IveKitLocationPatch, history: 'push' | 'replace' = 'replace'): void {
  const url = updateIveKitLocation(window.location.href, patch);
  if (url.toString() === window.location.href) return;
  window.history[history === 'push' ? 'pushState' : 'replaceState']({}, '', url);
}
