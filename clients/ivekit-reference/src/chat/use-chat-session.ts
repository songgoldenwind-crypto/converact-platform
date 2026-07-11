import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import type {
  IveKitAttachmentUploadInput,
  IveKitAttachmentUploadOptions,
  IveKitChatAttachmentUploadDescriptor,
  IveKitChatMessage,
  IveKitChatMessageInput,
  IveKitChatParticipant,
  IveKitChatSession,
  IveKitClient,
  IveKitPolicyFinding,
  IveKitPolicyFindingResult,
  IveKitPolicyFindingReviewInput
} from '@opc/ivekit-sdk';
import { ChatConvergence } from './convergence.js';
import { chatReducer, initialChatState } from './chat-reducer.js';
import { ReceiveOnlyTinodeAdapter } from './tinode-adapter.js';
import { eventRevokesSession, sessionAllowsWrites, type CollaborationRealtimeEnvelope } from './session-access.js';
import { PendingSendStore } from './pending-send-store.js';
import { dedupeFindingReviews } from './finding-view-model.js';
import type { ChatConvergenceTrigger } from './types.js';

export interface UseChatSessionInput {
  client: IveKitClient | null;
  session: IveKitChatSession | null;
  identity: string;
  role?: string;
  accessToken: string;
  websocketUrl?: string;
}

export function useChatSession(input: UseChatSessionInput) {
  const [state, dispatch] = useReducer(chatReducer, undefined, initialChatState);
  const [participants, setParticipants] = useState<IveKitChatParticipant[]>([]);
  const [findings, setFindings] = useState<IveKitPolicyFinding[]>([]);
  const [findingDetails, setFindingDetails] = useState<Record<string, IveKitPolicyFindingResult>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hasOlder, setHasOlder] = useState(false);
  const requestId = useRef(0);
  const historyCursor = useRef<string | null>(null);
  const ancillaryRefreshId = useRef(0);
  const convergence = useRef<ChatConvergence | null>(null);
  const pendingSends = useRef(new PendingSendStore());
  const revokeCurrentSession = useRef<() => void>(() => undefined);
  const client = input.client;
  const sessionId = input.session?.id || '';
  const sessionStatus = input.session?.status;

  const refreshAncillary = useCallback(async () => {
    if (!client || !sessionId) return;
    const activeRequest = requestId.current;
    const refreshId = ++ancillaryRefreshId.current;
    const [realtime, messageState, pins, findingResult] = await Promise.all([
      client.chat.listRealtimeState(sessionId),
      client.chat.getMessageState(sessionId),
      client.chat.listPins(sessionId),
      client.chat.listFindings(sessionId, { limit: 100 })
    ]);
    if (activeRequest !== requestId.current || refreshId !== ancillaryRefreshId.current) return;
    dispatch({ type: 'realtime_updated', realtime: realtime.states || [] });
    dispatch({ type: 'message_state_updated', requestId: activeRequest, unreadCount: messageState.unread_count, receipts: messageState.receipts });
    dispatch({ type: 'pins_updated', requestId: activeRequest, pins: pins.pins });
    setFindings(findingResult.findings);
  }, [client, sessionId]);

  useEffect(() => {
    dispatch({ type: 'reset' });
    setParticipants([]);
    setFindings([]);
    setFindingDetails({});
    setHasOlder(false);
    historyCursor.current = null;
    pendingSends.current.clear();
    if (!client || !sessionId || !input.identity) return;
    const activeClient = client;
    const currentRequest = ++requestId.current;
    dispatch({ type: 'request_started', requestId: currentRequest });
    setLoading(true);
    setError('');
    let active = true;
    let socket: WebSocket | null = null;
    let expiryTimer: number | null = null;
    let presenceTimer: number | null = null;
    let presenceActive = false;
    let recentRefreshId = 0;

    const sync = new ChatConvergence({
      fetchAfter: (cursor) => client.chat.listMessagesPage(sessionId, {
        direction: 'after', cursor: cursor || undefined, limit: 100
      }),
      onProjection: (projection) => {
        if (active) dispatch({ type: 'converged', messages: projection.changedMessages });
      },
      onFatalAuth: () => {
        if (active && currentRequest === requestId.current) {
          dispatch({ type: 'connection_changed', connection: 'fatal' });
        }
      }
    });
    convergence.current = sync;

    const refreshRecentMessages = async () => {
      const refreshId = ++recentRefreshId;
      const recent = await activeClient.chat.listMessagesPage(sessionId, { direction: 'before', limit: 100 });
      if (!active || currentRequest !== requestId.current || refreshId !== recentRefreshId) return;
      dispatch({ type: 'converged', messages: recent.items });
    };

    const invalidateRealtime = (trigger: ChatConvergenceTrigger) => {
      sync.supersede();
      return Promise.all([sync.invalidate(trigger), refreshRecentMessages()]).then(() => undefined);
    };

    const adapter = new ReceiveOnlyTinodeAdapter({
      getPlan: () => client.chat.createClientPlan(sessionId, {
        identity: input.identity,
        role: input.role || 'agent'
      }),
      onStateChange: (connection) => { if (active) dispatch({ type: 'connection_changed', connection }); },
      onInvalidate: (trigger) => { void invalidateRealtime(trigger).catch(reportError); },
      onError: reportError
    });

    void Promise.all([
      client.chat.getSnapshot(sessionId, { limit: 100 }),
      client.chat.listMessagesPage(sessionId, { direction: 'before', limit: 100 }),
      client.chat.listRealtimeState(sessionId),
      client.chat.getMessageState(sessionId),
      client.chat.listPins(sessionId),
      client.chat.listFindings(sessionId, { limit: 100 })
    ]).then(([snapshot, history, realtime, messageState, pins, findingResult]) => {
      if (!active || currentRequest !== requestId.current) return;
      historyCursor.current = history.next_cursor;
      setHasOlder(history.has_more && Boolean(history.next_cursor));
      setParticipants(snapshot.participants);
      setFindings(findingResult.findings);
      dispatch({
        type: 'loaded',
        requestId: currentRequest,
        messages: history.items,
        realtime: realtime.states || [],
        unreadCount: messageState.unread_count,
        pins: pins.pins,
        receipts: messageState.receipts
      });
      if (sessionAllowsWrites(snapshot.session, snapshot.participants, input.identity)) {
        sync.reset(history.items, null);
        void sync.invalidate('initial').catch(reportError);
        void adapter.connect().catch(reportError);
        presenceActive = true;
        void heartbeat();
        presenceTimer = window.setInterval(() => { void heartbeat(); }, 60_000);
      } else {
        revokeAccess();
      }
      setLoading(false);
    }).catch(reportError);

    const visibility = () => {
      if (document.visibilityState === 'visible') void invalidateRealtime('visibility').catch(reportError);
    };
    const online = () => adapter.setNetworkOnline(true);
    const offline = () => adapter.setNetworkOnline(false);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);

    if (input.websocketUrl && sessionStatus === 'open') {
      const url = new URL(input.websocketUrl);
      url.searchParams.set('token', input.accessToken);
      socket = new WebSocket(url);
      socket.onmessage = (event) => {
        try {
          const envelope = JSON.parse(String(event.data)) as CollaborationRealtimeEnvelope;
          if (envelope.data?.session_id !== sessionId) return;
          if (eventRevokesSession(envelope, input.identity)) {
            revokeAccess();
            return;
          }
          if (envelope.type?.startsWith('collaboration.')) {
            const payload = envelope.data;
            if (envelope.type === 'collaboration.message.reaction_updated' && payload?.message_id && payload.reactions) {
              dispatch({ type: 'reactions_updated', requestId: currentRequest, messageId: payload.message_id, reactions: payload.reactions });
            } else if (envelope.type === 'collaboration.message.pin_updated' && payload?.pins) {
              dispatch({ type: 'pins_updated', requestId: currentRequest, pins: payload.pins });
            } else if (envelope.type === 'collaboration.message.edited' && payload?.message) {
              dispatch({ type: 'message_edited', requestId: currentRequest, message: payload.message });
            } else if (envelope.type === 'collaboration.message.deleted' && payload?.message) {
              dispatch({ type: 'message_deleted', requestId: currentRequest, message: payload.message });
            } else if (envelope.type === 'collaboration.policy.finding_reviewed' && payload?.finding) {
              setFindings((current) => upsertFinding(current, payload.finding!));
            }
            void invalidateRealtime('ivekit_event').catch(reportError);
            if (/receipt|presence|typing|pin|finding/.test(envelope.type)) void refreshAncillary().catch(reportError);
          }
        } catch { /* malformed event */ }
      };
    }

    const heartbeat = () => client.chat.setPresence(sessionId, {
      identity: input.identity, status: 'online', ttl_ms: 90_000
    }).catch(reportError);
    expiryTimer = window.setInterval(() => dispatch({ type: 'realtime_expired', now: Date.now() }), 1_000);

    function revokeAccess() {
      if (!active) return;
      dispatch({ type: 'session_closed' });
      sync.close();
      void adapter.dispose();
      socket?.close();
      if (presenceTimer != null) window.clearInterval(presenceTimer);
      presenceTimer = null;
      if (presenceActive) {
        presenceActive = false;
        void activeClient.chat.setPresence(sessionId, { identity: input.identity, status: 'offline' }).catch(() => undefined);
      }
    }
    revokeCurrentSession.current = revokeAccess;

    function reportError(cause: unknown) {
      if (!active) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setLoading(false);
    }

    return () => {
      active = false;
      if (revokeCurrentSession.current === revokeAccess) revokeCurrentSession.current = () => undefined;
      requestId.current += 1;
      sync.close();
      void adapter.dispose();
      socket?.close();
      if (expiryTimer != null) window.clearInterval(expiryTimer);
      if (presenceTimer != null) window.clearInterval(presenceTimer);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      if (presenceActive) void client.chat.setPresence(sessionId, {
        identity: input.identity, status: 'offline'
      }).catch(() => undefined);
    };
  }, [client, sessionId, sessionStatus, input.identity, input.role, input.accessToken, input.websocketUrl, refreshAncillary]);

  const loadOlder = useCallback(async () => {
    if (!client || !sessionId || !historyCursor.current) return;
    const generation = requestId.current;
    const page = await client.chat.listMessagesPage(sessionId, {
      direction: 'before', cursor: historyCursor.current, limit: 100
    });
    if (generation !== requestId.current) return;
    historyCursor.current = page.next_cursor;
    setHasOlder(page.has_more && Boolean(page.next_cursor));
    dispatch({ type: 'history_prepended', requestId: generation, messages: page.items });
  }, [client, sessionId]);

  const sendMessage = useCallback(async (messageInput: Omit<IveKitChatMessageInput, 'sender_identity'>) => {
    if (!client || !sessionId || state.closed || state.connection === 'fatal') throw new Error('session is not writable');
    const generation = requestId.current;
    const key = globalThis.crypto.randomUUID();
    const localId = `local-${key}`;
    const optimistic = optimisticMessage(localId, sessionId, input.identity, messageInput);
    pendingSends.current.remember(localId, key, messageInput);
    dispatch({ type: 'optimistic_sent', message: optimistic, idempotencyKey: key });
    try {
      const result = await client.chat.postMessage(sessionId, {
        ...messageInput,
        sender_identity: input.identity
      }, { idempotencyKey: key });
      dispatch({ type: 'send_succeeded', requestId: generation, localId, message: result.message });
      pendingSends.current.resolve(localId);
      return result.message;
    } catch (cause) {
      const status = Number((cause as { status?: number }).status || 0);
      dispatch({
        type: 'send_failed',
        requestId: generation,
        localId,
        retryable: status === 0 || status === 202 || status >= 500,
        error: cause instanceof Error ? cause.message : String(cause)
      });
      throw cause;
    }
  }, [client, sessionId, input.identity, state.closed, state.connection]);

  const uploadAttachment = useCallback((
    attachment: IveKitAttachmentUploadInput,
    options?: IveKitAttachmentUploadOptions
  ) => {
    if (!client || !sessionId || state.closed) throw new Error('session is not writable');
    return client.chat.uploadAttachmentWithProgress(sessionId, attachment, options);
  }, [client, sessionId, state.closed]);

  const retrySend = useCallback(async (localId: string) => {
    if (!client || !sessionId || state.closed) throw new Error('session is not writable');
    const pending = pendingSends.current.get(localId);
    if (!pending) throw new Error('retry message is unavailable');
    const generation = requestId.current;
    dispatch({ type: 'send_retrying', localId });
    try {
      const result = await client.chat.postMessage(sessionId, {
        ...pending.input,
        sender_identity: input.identity
      }, { idempotencyKey: pending.idempotencyKey });
      dispatch({ type: 'send_succeeded', requestId: generation, localId, message: result.message });
      pendingSends.current.resolve(localId);
    } catch (cause) {
      const status = Number((cause as { status?: number }).status || 0);
      dispatch({
        type: 'send_failed', requestId: generation, localId, retryable: status === 0 || status >= 500,
        error: cause instanceof Error ? cause.message : String(cause)
      });
      throw cause;
    }
  }, [client, sessionId, input.identity, state.closed]);

  const markRead = useCallback(async (messageId: string) => {
    if (!client || !sessionId) return;
    const generation = requestId.current;
    const result = await client.chat.markReceipt(sessionId, messageId, {
      identity: input.identity, status: 'read'
    });
    dispatch({ type: 'message_state_updated', requestId: generation, unreadCount: result.unread_count, receipts: result.receipts });
  }, [client, sessionId, input.identity]);

  const setTyping = useCallback((typing: boolean) => {
    if (!client || !sessionId || state.closed) return Promise.resolve();
    return client.chat.setTyping(sessionId, { identity: input.identity, typing }).then(() => undefined);
  }, [client, sessionId, input.identity, state.closed]);

  const react = useCallback(async (messageId: string, emoji: string, remove = false) => {
    if (!client || !sessionId || state.closed) throw new Error('session is not writable');
    const generation = requestId.current;
    const result = remove
      ? await client.chat.removeReaction(sessionId, messageId, emoji)
      : await client.chat.addReaction(sessionId, messageId, emoji);
    dispatch({ type: 'reactions_updated', requestId: generation, messageId, reactions: result.reactions });
  }, [client, sessionId, state.closed]);

  const pin = useCallback(async (messageId: string, remove = false) => {
    if (!client || !sessionId || state.closed) throw new Error('session is not writable');
    const generation = requestId.current;
    const result = remove
      ? await client.chat.unpinMessage(sessionId, messageId)
      : await client.chat.pinMessage(sessionId, messageId);
    dispatch({ type: 'pins_updated', requestId: generation, pins: result.pins });
  }, [client, sessionId, state.closed]);

  const editMessage = useCallback(async (messageId: string, body: string) => {
    if (!client || !sessionId || state.closed) throw new Error('session is not writable');
    const generation = requestId.current;
    const result = await client.chat.editMessage(sessionId, messageId, { body });
    dispatch({ type: 'message_edited', requestId: generation, message: result.message });
  }, [client, sessionId, state.closed]);

  const deleteMessage = useCallback(async (messageId: string) => {
    if (!client || !sessionId || state.closed) throw new Error('session is not writable');
    const generation = requestId.current;
    const result = await client.chat.deleteMessage(sessionId, messageId);
    dispatch({ type: 'message_deleted', requestId: generation, message: result.message });
  }, [client, sessionId, state.closed]);

  const closeSession = useCallback(async () => {
    if (!client || !sessionId || state.closed) return input.session;
    const generation = requestId.current;
    const closed = await client.chat.closeSession(sessionId);
    if (generation === requestId.current) revokeCurrentSession.current();
    return closed;
  }, [client, sessionId, state.closed, input.session]);

  const loadFinding = useCallback(async (findingId: string) => {
    if (!client || !sessionId) throw new Error('session is unavailable');
    const generation = requestId.current;
    const result = await client.chat.getFinding(sessionId, findingId);
    if (generation === requestId.current) {
      setFindingDetails((current) => ({ ...current, [findingId]: result }));
    }
    return result;
  }, [client, sessionId]);

  const reviewFinding = useCallback(async (findingId: string, review: IveKitPolicyFindingReviewInput) => {
    if (!client || !sessionId || state.closed) throw new Error('session is not writable');
    const generation = requestId.current;
    const result = await client.chat.reviewFinding(sessionId, findingId, review);
    const currentDetail = findingDetails[findingId];
    const reviews = dedupeFindingReviews(result.reviews || [
      ...(currentDetail?.reviews || []),
      ...(result.review ? [result.review] : [])
    ]);
    const merged = { ...result, reviews };
    if (generation === requestId.current) {
      setFindings((current) => upsertFinding(current, result.finding));
      setFindingDetails((current) => ({ ...current, [findingId]: merged }));
    }
    return merged;
  }, [client, sessionId, state.closed, findingDetails]);

  const clearError = useCallback(() => setError(''), []);

  return {
    state, participants, findings, findingDetails, loading, error, hasOlder, clearError, loadOlder, sendMessage,
    uploadAttachment, retrySend, markRead, setTyping, react, pin,
    editMessage, deleteMessage, closeSession, loadFinding, reviewFinding, refreshAncillary
  };
}

function optimisticMessage(
  id: string,
  sessionId: string,
  identity: string,
  input: Omit<IveKitChatMessageInput, 'sender_identity'>
): IveKitChatMessage {
  return {
    id,
    session_id: sessionId,
    sender_identity: identity,
    body: input.body || '',
    message_type: (input.message_type || 'text') as IveKitChatMessage['message_type'],
    created_at: new Date().toISOString(),
    attachments: (input.attachments || []).map((attachment, index) => ({
      ...attachment,
      id: `${id}-attachment-${index}`,
      tenant_id: '',
      session_id: sessionId,
      message_id: id,
      created_at: new Date().toISOString()
    })),
    reply_to_message_id: input.reply_to_message_id || null,
    forwarded_from_message_id: input.forwarded_from_message_id || null,
    mentions: input.mentions || [],
    deleted_at: null,
    edit_version: 0,
    provider_delivery: { status: 'pending' }
  } as unknown as IveKitChatMessage;
}

export type AttachmentDescriptor = IveKitChatAttachmentUploadDescriptor;

function upsertFinding(findings: IveKitPolicyFinding[], finding: IveKitPolicyFinding): IveKitPolicyFinding[] {
  const next = findings.filter((item) => item.id !== finding.id && item.fingerprint !== finding.fingerprint);
  return [...next, finding];
}
