import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, apiPut } from '../api/client';
import { readAuthStorage, writeAuthStorage } from '../auth-storage';
import { useAuth } from './useAuth';
import { useWebSocket } from './useWebSocket';
import { requestDesktopNotificationPermission, showDesktopNotification } from './useDesktopNotification';
import {
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrackPublication
} from 'livekit-client';

export type AgentSeatStatus =
  | 'offline'
  | 'idle'
  | 'busy'
  | 'away'
  | 'training'
  | 'lunch'
  | 'wrap_up';

export interface IncomingCallPayload {
  call_session_id: string;
  room_name: string;
  seat_id: string;
  target_user_id: string;
  from: string;
  customer_summary?: string;
  intent_score?: number;
  transfer_reason?: string;
}

export interface IntercomIncomingPayload {
  room_name: string;
  media: 'voice' | 'video';
  from_seat_id: string;
  from_user_id: string;
  from_display_name: string;
  target_seat_id: string;
  target_user_id: string;
}

interface AgentSeatRow {
  id: string;
  user_id: string;
  display_name: string;
  status: AgentSeatStatus;
  livekit_identity: string;
}

const STATUS_OPTIONS: { value: AgentSeatStatus; label: string }[] = [
  { value: 'idle', label: '在线空闲' },
  { value: 'busy', label: '通话中' },
  { value: 'away', label: '离开' },
  { value: 'training', label: '培训' },
  { value: 'lunch', label: '午休' },
  { value: 'wrap_up', label: '后处理' },
  { value: 'offline', label: '离线' }
];

export function useAgentWorkbench() {
  const { tenantId, userId } = useAuth();
  const [seat, setSeat] = useState<AgentSeatRow | null>(null);
  const [status, setStatus] = useState<AgentSeatStatus>('offline');
  const [incoming, setIncoming] = useState<IncomingCallPayload | null>(null);
  const [activeCallId, setActiveCallId] = useState<string | null>(null);
  const [roomName, setRoomName] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [onHold, setOnHold] = useState(false);
  const [error, setError] = useState('');
  const [dispositionCodes, setDispositionCodes] = useState<Array<{ code: string; label: string }>>([]);
  const [selectedDisposition, setSelectedDisposition] = useState('completed');
  const [transferSeatId, setTransferSeatId] = useState('');
  const [peerSeats, setPeerSeats] = useState<AgentSeatRow[]>([]);
  const [scriptProgress, setScriptProgress] = useState<{
    template_name: string;
    current_step_index: number;
    steps: Array<{ id: string; title: string; prompt: string }>;
  } | null>(null);
  const [assistTips, setAssistTips] = useState<Array<{ type: string; content: string; source?: string }>>([]);
  const [transcript, setTranscript] = useState<Array<{ turn_index: number; role: string; content: string; timestamp: string }>>([]);
  const roomRef = useRef<Room | null>(null);
  const audioContainerRef = useRef<HTMLDivElement | null>(null);
  // Video call state (customer video + agent intercom share this layer)
  const remoteVideoRef = useRef<HTMLDivElement | null>(null);
  const remoteScreenShareRef = useRef<HTMLDivElement | null>(null);
  const localVideoRef = useRef<HTMLDivElement | null>(null);
  const [videoActive, setVideoActive] = useState(false);
  const [customerJoinUrl, setCustomerJoinUrl] = useState<string | null>(null);
  const [remotePresent, setRemotePresent] = useState(false);
  const [remoteScreenShareActive, setRemoteScreenShareActive] = useState(false);
  const [liveKitConfigured, setLiveKitConfigured] = useState(false);
  const [screenShareActive, setScreenShareActive] = useState(false);
  const [screenSharePending, setScreenSharePending] = useState(false);
  const [intercomIncoming, setIntercomIncoming] = useState<IntercomIncomingPayload | null>(null);
  // Active intercom room the caller is waiting in (so they can cancel).
  const intercomRoomRef = useRef<string | null>(null);

  const loadSeat = useCallback(async () => {
    const seats = await apiGet<AgentSeatRow[]>(`/api/call-center/seats?tenant_id=${tenantId}`);
    const storedSeatId = readAuthStorage('seat_id');
    const mine =
      seats.find((s) => s.id === storedSeatId) ||
      seats.find((s) => s.user_id === userId) ||
      seats[0] ||
      null;
    setSeat(mine);
    if (mine) {
      writeAuthStorage('seat_id', mine.id);
      setStatus(mine.status as AgentSeatStatus);
    }
    setPeerSeats(seats.filter((s) => s.id !== mine?.id));
  }, [tenantId, userId]);

  useEffect(() => {
    void loadSeat().catch((e) => setError(e.message));
    void requestDesktopNotificationPermission();
    void apiGet<Array<{ code: string; label: string }>>('/api/call-center/disposition-codes')
      .then(setDispositionCodes)
      .catch(() => undefined);
  }, [loadSeat]);

  useEffect(() => {
    if (!seat?.id) return;
    const timer = setInterval(() => {
      void apiPost(`/api/call-center/seats/${seat.id}/heartbeat?tenant_id=${tenantId}`, {}).catch(
        () => undefined
      );
    }, 30_000);
    return () => clearInterval(timer);
  }, [seat?.id, tenantId]);

  const updateStatus = useCallback(
    async (next: AgentSeatStatus) => {
      if (!seat?.id) return;
      await apiPut(`/api/call-center/seats/${seat.id}/status?tenant_id=${tenantId}`, {
        status: next
      });
      setStatus(next);
    },
    [seat?.id, tenantId]
  );

  useEffect(() => {
    if (!seat?.id) return;
    if (seat.status === 'offline') {
      void updateStatus('idle').catch(() => undefined);
    }
  }, [seat?.id, seat?.status, updateStatus]);

  useEffect(() => {
    if (!activeCallId) {
      setScriptProgress(null);
      setAssistTips([]);
      return;
    }
    void apiGet<{
      template_name: string;
      current_step_index: number;
      steps: Array<{ id: string; title: string; prompt: string }>;
    }>(`/api/call-center/calls/${activeCallId}/script`)
      .then(setScriptProgress)
      .catch(() => undefined);
  }, [activeCallId]);

  useWebSocket((type, data) => {
    if (type === 'call.incoming') {
      const payload = data as IncomingCallPayload;
      if (payload.target_user_id && userId && payload.target_user_id !== userId) return;
      setIncoming(payload);
      showDesktopNotification('来电转接', {
        body: `${payload.from || '未知号码'} — 意向 ${Math.round((payload.intent_score || 0) * 100)}%`,
        tag: payload.call_session_id
      });
    }
    if (type === 'call.hold' && (data as { call_session_id?: string }).call_session_id === activeCallId) {
      setOnHold(true);
    }
    if (type === 'call.resumed' && (data as { call_session_id?: string }).call_session_id === activeCallId) {
      setOnHold(false);
    }
    if (type === 'call.ended') {
      const payload = data as { call_session_id?: string };
      if (payload.call_session_id === activeCallId) {
        void disconnectRoom();
        setActiveCallId(null);
        setRoomName(null);
        setOnHold(false);
        setScriptProgress(null);
        setAssistTips([]);
        setTranscript([]);
        void updateStatus('wrap_up');
      }
    }
    if (type === 'call.transcript') {
      const payload = data as { call_session_id?: string; turn_index: number; role: string; content: string; timestamp: string };
      if (payload.call_session_id === activeCallId) {
        setTranscript((prev) => [...prev, {
          turn_index: payload.turn_index,
          role: payload.role,
          content: payload.content,
          timestamp: payload.timestamp
        }].slice(-50));
      }
    }
    if (type === 'agent.assist') {
      const payload = data as { call_session_id?: string; type: string; content: string; source?: string };
      if (payload.call_session_id === activeCallId) {
        setAssistTips((prev) => [
          { type: payload.type, content: payload.content, source: payload.source },
          ...prev
        ].slice(0, 5));
      }
    }
    // --- Agent-to-agent intercom ---
    if (type === 'intercom.incoming') {
      const payload = data as IntercomIncomingPayload;
      // Only the targeted agent rings (tenant-broadcast + client-side filter).
      if (payload.target_user_id && userId && payload.target_user_id !== userId) return;
      setIntercomIncoming(payload);
      showDesktopNotification('坐席呼叫', {
        body: `${payload.from_display_name} 发起${payload.media === 'video' ? '视频' : '语音'}通话`,
        tag: payload.room_name
      });
    }
    if (type === 'intercom.accepted') {
      const payload = data as { room_name: string };
      // Caller side: peer joined the room we're waiting in.
      if (intercomRoomRef.current && payload.room_name === intercomRoomRef.current) {
        setRemotePresent(true);
      }
    }
    if (type === 'intercom.declined') {
      const payload = data as { room_name: string; target_user_id?: string };
      // Caller side: peer declined/cancelled — tear down our waiting room.
      if (intercomRoomRef.current && payload.room_name === intercomRoomRef.current) {
        void endVideoCall();
        setError('对方已拒接或取消');
      }
      // Callee side: caller cancelled — dismiss the ringing popup.
      if (intercomIncoming && payload.room_name === intercomIncoming.room_name) {
        setIntercomIncoming(null);
      }
    }
  });

  async function disconnectRoom() {
    const room = roomRef.current;
    if (room) {
      if (screenShareActive) {
        await room.localParticipant.setScreenShareEnabled(false).catch(() => undefined);
      }
      await room.disconnect();
      roomRef.current = null;
    }
    setConnected(false);
    setLiveKitConfigured(false);
    setScreenShareActive(false);
    setScreenSharePending(false);
    setRemoteScreenShareActive(false);
  }

  function wireRoomLifecycle(room: Room) {
    room.on(RoomEvent.Reconnecting, () => {
      if (roomRef.current === room) setConnected(false);
    });
    room.on(RoomEvent.Reconnected, () => {
      if (roomRef.current === room) setConnected(true);
    });
    room.on(RoomEvent.Disconnected, () => {
      if (roomRef.current !== room) return;
      roomRef.current = null;
      setConnected(false);
      setScreenShareActive(false);
      setScreenSharePending(false);
      setRemotePresent(false);
      setRemoteScreenShareActive(false);
    });
  }

  async function acceptIncoming() {
    if (!incoming || !seat?.id) return;
    setError('');
    try {
      const acceptPath =
        incoming.transfer_reason === 'inbound_acd'
          ? `/api/call-center/inbound/${incoming.call_session_id}/accept`
          : `/api/call-center/transfers/${incoming.call_session_id}/accept`;

      const result = await apiPost<{
        livekit: { token: string; livekit_url: string; configured: boolean };
        room_name: string;
        call_session_id: string;
      }>(acceptPath, { seat_id: seat.id });

      setIncoming(null);
      setActiveCallId(result.call_session_id);
      setRoomName(result.room_name);

      await disconnectRoom();
      const room = new Room({ adaptiveStream: true });
      roomRef.current = room;
      wireRoomLifecycle(room);

      room.on(RoomEvent.TrackSubscribed, (track, _pub: RemoteTrackPublication, _participant: RemoteParticipant) => {
        if (track.kind === Track.Kind.Audio && audioContainerRef.current) {
          const el = track.attach();
          audioContainerRef.current.appendChild(el);
        }
      });

      const { token, livekit_url, configured } = result.livekit;
      setLiveKitConfigured(configured);
      if (!configured && token.startsWith('dev-token:')) {
        setConnected(true);
        return;
      }

      await room.connect(livekit_url, token);
      await room.localParticipant.setMicrophoneEnabled(true);
      setConnected(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : '接听失败');
    }
  }

  async function toggleHold() {
    if (!activeCallId || !seat?.id) return;
    const path = onHold ? 'resume' : 'hold';
    await apiPost(`/api/call-center/calls/${activeCallId}/${path}`, { seat_id: seat.id });
    setOnHold(!onHold);
  }

  const [previewTasks, setPreviewTasks] = useState<Array<{ id: string; phone_number: string }>>([]);

  useEffect(() => {
    if (!seat?.id) return;
    void apiGet<Array<{ id: string; phone_number: string }>>(
      `/api/call-center/outbound-tasks/preview-queue?seat_id=${seat.id}`
    )
      .then(setPreviewTasks)
      .catch(() => undefined);
  }, [seat?.id, activeCallId]);

  async function confirmPreviewDial(taskId: string) {
    await apiPost(`/api/call-center/outbound-tasks/${taskId}/preview-dial`, {});
    setPreviewTasks((prev) => prev.filter((t) => t.id !== taskId));
  }

  async function blindTransfer() {
    if (!activeCallId || !seat?.id || !transferSeatId) return;
    await apiPost(`/api/call-center/calls/${activeCallId}/transfer`, {
      seat_id: seat.id,
      target_seat_id: transferSeatId,
      mode: 'blind'
    });
    await disconnectRoom();
    setActiveCallId(null);
    setRoomName(null);
    setOnHold(false);
    await updateStatus('wrap_up');
  }

  async function warmTransfer() {
    if (!activeCallId || !seat?.id || !transferSeatId) return;
    await apiPost(`/api/call-center/calls/${activeCallId}/transfer`, {
      seat_id: seat.id,
      target_seat_id: transferSeatId,
      mode: 'warm'
    });
  }

  async function completeWarmTransfer() {
    if (!activeCallId || !seat?.id || !transferSeatId) return;
    await apiPost(`/api/call-center/calls/${activeCallId}/warm-transfer/complete`, {
      from_seat_id: seat.id,
      target_seat_id: transferSeatId
    });
    await disconnectRoom();
    setActiveCallId(null);
    setRoomName(null);
    setOnHold(false);
    await updateStatus('wrap_up');
  }

  async function endActiveCall() {
    if (!activeCallId || !seat?.id) return;
    await apiPost(`/api/call-center/calls/${activeCallId}/end`, {
      seat_id: seat.id,
      disposition: selectedDisposition
    });
    await disconnectRoom();
    setActiveCallId(null);
    setRoomName(null);
    setOnHold(false);
    await updateStatus('wrap_up');
  }

  async function advanceScript() {
    if (!activeCallId) return;
    const next = await apiPost<{
      template_name: string;
      current_step_index: number;
      steps: Array<{ id: string; title: string; prompt: string }>;
    }>(`/api/call-center/calls/${activeCallId}/script`, {});
    setScriptProgress(next);
  }

  // Wire a connected room's tracks into the video layout:
  // screen share -> main pane, camera/avatar -> camera pane, audio -> hidden.
  function wireRemoteTracks(room: Room) {
    room.on(RoomEvent.TrackSubscribed, (track, publication: RemoteTrackPublication, _participant: RemoteParticipant) => {
      if (track.kind === Track.Kind.Video) {
        const isScreenShare = publication.source === Track.Source.ScreenShare;
        const target = isScreenShare ? remoteScreenShareRef.current : remoteVideoRef.current;
        if (!target) return;
        target.innerHTML = '';
        const el = track.attach() as HTMLVideoElement;
        el.style.width = '100%';
        el.style.height = '100%';
        el.style.objectFit = isScreenShare ? 'contain' : 'cover';
        el.setAttribute('playsinline', 'true');
        target.appendChild(el);
        if (isScreenShare) setRemoteScreenShareActive(true);
        setRemotePresent(true);
      } else if (track.kind === Track.Kind.Audio && audioContainerRef.current) {
        const el = track.attach();
        el.style.display = 'none';
        audioContainerRef.current.appendChild(el);
      }
    });
    room.on(RoomEvent.TrackUnsubscribed, (track, publication: RemoteTrackPublication) => {
      if (publication.source === Track.Source.ScreenShare) {
        if (remoteScreenShareRef.current) remoteScreenShareRef.current.innerHTML = '';
        setRemoteScreenShareActive(false);
      } else if (track.kind === Track.Kind.Video && remoteVideoRef.current) {
        remoteVideoRef.current.innerHTML = '';
      }
    });
    room.on(RoomEvent.ParticipantConnected, () => setRemotePresent(true));
    room.on(RoomEvent.ParticipantDisconnected, () => {
      if (room.numParticipants <= 1) setRemotePresent(false);
    });
    if (room.numParticipants >= 1) setRemotePresent(true);
  }

  // Publish local mic (+ camera for video), and show the local camera preview.
  async function publishLocalMedia(room: Room, withVideo: boolean) {
    await room.localParticipant.setMicrophoneEnabled(true);
    if (!withVideo) return;
    try {
      await room.localParticipant.setCameraEnabled(true);
      const camPub = room.localParticipant.getTrackPublication(Track.Source.Camera);
      if (camPub?.videoTrack && localVideoRef.current) {
        localVideoRef.current.innerHTML = '';
        const el = camPub.videoTrack.attach() as HTMLVideoElement;
        el.style.width = '100%';
        el.style.height = '100%';
        el.style.objectFit = 'cover';
        el.muted = true;
        el.setAttribute('playsinline', 'true');
        localVideoRef.current.appendChild(el);
      }
    } catch {
      // Camera denied/unavailable — continue with audio only.
    }
  }

  // Connect to a LiveKit room with a token and set up the video layout.
  // Shared by customer-video and agent-intercom flows.
  async function connectVideoRoom(
    token: { token: string; livekit_url: string; configured: boolean },
    roomNameValue: string,
    withVideo: boolean
  ): Promise<boolean> {
    setRoomName(roomNameValue);
    await disconnectRoom();
    setLiveKitConfigured(token.configured);
    setRemotePresent(false);
    const room = new Room({ adaptiveStream: true });
    roomRef.current = room;
    wireRoomLifecycle(room);
    wireRemoteTracks(room);
    if (!token.configured && String(token.token).startsWith('dev-token:')) {
      // LiveKit not configured (dev) — mark active so UI shows the join link,
      // but skip the real connection.
      setVideoActive(true);
      setConnected(true);
      return false;
    }
    await room.connect(token.livekit_url, token.token);
    await publishLocalMedia(room, withVideo);
    setVideoActive(true);
    setConnected(true);
    return true;
  }

  async function toggleScreenShare() {
    const room = roomRef.current;
    if (!room || !liveKitConfigured) {
      setError('屏幕共享需要真实 LiveKit 连接');
      return;
    }
    const next = !screenShareActive;
    setScreenSharePending(true);
    setError('');
    try {
      await room.localParticipant.setScreenShareEnabled(next);
      setScreenShareActive(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : '屏幕共享失败');
    } finally {
      setScreenSharePending(false);
    }
  }

  async function startVideoCall() {
    if (!seat?.id) return;
    setError('');
    try {
      const result = await apiPost<{
        room: { room_name: string };
        agent_token: { token: string; livekit_url: string; configured: boolean };
        customer_join_path?: string;
      }>('/api/call-center/video/start', {
        call_session_id: activeCallId || undefined,
        enable_screen_share: false
      });
      if (result.customer_join_path) {
        setCustomerJoinUrl(`${window.location.origin}${result.customer_join_path}`);
      }
      await connectVideoRoom(result.agent_token, result.room.room_name, true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Agent A calls a peer agent B (voice or video).
  async function callPeer(targetSeatId: string, media: 'voice' | 'video') {
    if (!seat?.id) return;
    setError('');
    try {
      const result = await apiPost<{
        room_name: string;
        media: 'voice' | 'video';
        caller_token: { token: string; livekit_url: string; configured: boolean };
      }>('/api/call-center/intercom/start', {
        from_seat_id: seat.id,
        target_seat_id: targetSeatId,
        media
      });
      intercomRoomRef.current = result.room_name;
      setCustomerJoinUrl(null); // intercom has no external join link
      await connectVideoRoom(result.caller_token, result.room_name, media === 'video');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Agent B accepts an incoming intercom call.
  async function acceptIntercom() {
    if (!intercomIncoming || !seat?.id) return;
    const payload = intercomIncoming;
    setIntercomIncoming(null);
    setError('');
    try {
      const result = await apiPost<{
        room_name: string;
        livekit: { token: string; livekit_url: string; configured: boolean };
      }>('/api/call-center/intercom/accept', {
        room_name: payload.room_name,
        seat_id: seat.id
      });
      intercomRoomRef.current = result.room_name;
      await connectVideoRoom(result.livekit, result.room_name, payload.media === 'video');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Decline an incoming intercom call (callee) or cancel a pending one (caller).
  async function declineIntercom() {
    const roomName = intercomIncoming?.room_name || intercomRoomRef.current;
    const reason = intercomIncoming ? 'declined' : 'cancelled';
    setIntercomIncoming(null);
    if (!roomName) return;
    try {
      await apiPost('/api/call-center/intercom/decline', { room_name: roomName, reason });
    } catch {
      // best-effort signal
    }
    if (reason === 'cancelled') void endVideoCall();
  }

  // Tear down any active video/intercom call.
  async function endVideoCall() {
    await disconnectRoom();
    intercomRoomRef.current = null;
    setVideoActive(false);
    setRemotePresent(false);
    setCustomerJoinUrl(null);
    if (remoteVideoRef.current) remoteVideoRef.current.innerHTML = '';
    if (remoteScreenShareRef.current) remoteScreenShareRef.current.innerHTML = '';
    if (localVideoRef.current) localVideoRef.current.innerHTML = '';
    setRemoteScreenShareActive(false);
  }

  return {
    seat,
    status,
    statusOptions: STATUS_OPTIONS,
    incoming,
    activeCallId,
    roomName,
    connected,
    onHold,
    error,
    dispositionCodes,
    selectedDisposition,
    setSelectedDisposition,
    transferSeatId,
    setTransferSeatId,
    peerSeats,
    audioContainerRef,
    remoteVideoRef,
    remoteScreenShareRef,
    localVideoRef,
    videoActive,
    customerJoinUrl,
    remotePresent,
    remoteScreenShareActive,
    intercomIncoming,
    updateStatus,
    acceptIncoming,
    dismissIncoming: () => setIncoming(null),
    toggleHold,
    blindTransfer,
    warmTransfer,
    completeWarmTransfer,
    endActiveCall,
    scriptProgress,
    assistTips,
    transcript,
    advanceScript,
    startVideoCall,
    callPeer,
    acceptIntercom,
    declineIntercom,
    endVideoCall,
    screenShareActive,
    screenSharePending,
    canScreenShare: videoActive && connected && liveKitConfigured,
    toggleScreenShare,
    previewTasks,
    confirmPreviewDial
  };
}
