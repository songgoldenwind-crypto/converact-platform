import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Room, RoomEvent, Track } from 'livekit-client';
import {
  customerMediaJoinErrorMessage,
  fetchCustomerMediaJoinPlan
} from './video-call-join';

export default function VideoCallPage() {
  const [params] = useSearchParams();
  const roomName = params.get('room') || '';
  const tenantId = params.get('tenant_id') || 'default';
  const invite = params.get('invite') || '';
  const expiresAt = params.get('expires_at') || '';
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [avatarActive, setAvatarActive] = useState(false);
  const [peerPresent, setPeerPresent] = useState(false);
  const [screenShareActive, setScreenShareActive] = useState(false);
  const remoteVideoRef = useRef<HTMLDivElement | null>(null);
  const remoteScreenShareRef = useRef<HTMLDivElement | null>(null);
  const localVideoRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLDivElement | null>(null);
  const roomRef = useRef<Room | null>(null);

  useEffect(() => {
    if (!roomName) {
      setError('缺少 room 参数');
      return;
    }

    const identity = `customer-${Math.random().toString(36).slice(2, 8)}`;
    let cancelled = false;

    function clearRemoteMedia() {
      if (remoteVideoRef.current) remoteVideoRef.current.innerHTML = '';
      if (remoteScreenShareRef.current) remoteScreenShareRef.current.innerHTML = '';
      setPeerPresent(false);
      setScreenShareActive(false);
      setAvatarActive(false);
    }

    async function join() {
      try {
        const joinPlan = await fetchCustomerMediaJoinPlan(fetch, {
          roomName,
          identity,
          tenantId,
          invite,
          expiresAt
        });
        const payload = joinPlan.token;
        const room = new Room();
        roomRef.current = room;

        room.on(RoomEvent.TrackSubscribed, (track, publication) => {
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
            if (isScreenShare) {
              setScreenShareActive(true);
            } else if (publication.trackName === 'avatar-video') {
              setAvatarActive(true);
            }
            setPeerPresent(true);
            target.appendChild(el);
          } else if (track.kind === Track.Kind.Audio && audioRef.current) {
            const el = track.attach();
            el.style.display = 'none';
            audioRef.current.appendChild(el);
          }
        });
        room.on(RoomEvent.TrackUnsubscribed, (track, publication) => {
          if (publication.source === Track.Source.ScreenShare) {
            if (remoteScreenShareRef.current) remoteScreenShareRef.current.innerHTML = '';
            setScreenShareActive(false);
          } else if (track.kind === Track.Kind.Video && remoteVideoRef.current) {
            remoteVideoRef.current.innerHTML = '';
          }
        });
        room.on(RoomEvent.ParticipantConnected, () => setPeerPresent(true));
        room.on(RoomEvent.ParticipantDisconnected, () => {
          if (room.numParticipants <= 0) setPeerPresent(false);
        });
        room.on(RoomEvent.Reconnecting, () => {
          if (cancelled) return;
          setConnected(false);
          setReconnecting(true);
        });
        room.on(RoomEvent.Reconnected, () => {
          if (cancelled) return;
          setReconnecting(false);
          setConnected(true);
          setError('');
        });
        room.on(RoomEvent.Disconnected, () => {
          if (cancelled) return;
          setConnected(false);
          setReconnecting(false);
          clearRemoteMedia();
          setError('音视频连接已断开，请重新打开邀请链接');
        });

        if (payload.token?.startsWith?.('dev-token:')) {
          setConnected(true);
          return;
        }

        const liveKitUrl = payload.livekit_url || payload.url;
        if (!liveKitUrl) {
          throw new Error('LiveKit URL is required');
        }
        await room.connect(liveKitUrl, payload.token);
        if (room.numParticipants >= 1) setPeerPresent(true);
        try {
          await room.localParticipant.setMicrophoneEnabled(true);
        } catch {
          setError('麦克风不可用，当前以仅收听模式加入');
        }
        // Camera is optional — a denied permission must not break the call.
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
          // Camera unavailable/denied — continue audio only.
        }
        setReconnecting(false);
        setConnected(true);
      } catch (e) {
        await roomRef.current?.disconnect().catch(() => undefined);
        roomRef.current = null;
        setConnected(false);
        setReconnecting(false);
        setError(customerMediaJoinErrorMessage(e));
      }
    }

    void join();
    return () => {
      cancelled = true;
      void roomRef.current?.disconnect();
      roomRef.current = null;
      setScreenShareActive(false);
    };
  }, [roomName, tenantId, invite, expiresAt]);

  return (
    <div className="min-h-screen bg-slate-900 text-white flex flex-col items-center justify-center p-6">
      <h1 className="text-xl font-semibold mb-2">视频通话</h1>
      {error && <p className="text-red-300 mb-4">{error}</p>}
      <div className="mb-2 text-sm flex gap-3">
        {reconnecting && <span className="text-yellow-300">正在重新连接</span>}
        {connected && <span className="text-green-300">已连接房间</span>}
        {avatarActive ? (
          <span className="text-cyan-300">AI 数字人已接入</span>
        ) : peerPresent ? (
          <span className="text-green-300">● 对方已接入</span>
        ) : (
          <span className="text-yellow-300">● 等待对方加入…</span>
        )}
      </div>
      <div
        data-testid="customer-video-call"
        className="relative w-full max-w-3xl aspect-video bg-black rounded-lg overflow-hidden"
      >
        <div
          data-testid="customer-remote-screen-share"
          ref={remoteScreenShareRef}
          className={`absolute inset-0 bg-black ${screenShareActive ? '' : 'hidden'}`}
        />
        <div
          data-testid="customer-remote-video"
          ref={remoteVideoRef}
          className={
            screenShareActive
              ? 'absolute bottom-3 left-3 w-28 h-20 bg-slate-800 rounded-md overflow-hidden border border-slate-600'
              : 'absolute inset-0'
          }
        />
        {!peerPresent && (
          <div className="absolute inset-0 flex items-center justify-center text-slate-400 text-sm">
            等待对方加入…
          </div>
        )}
        {screenShareActive && (
          <div className="absolute top-3 left-3 rounded bg-slate-950/70 px-2 py-1 text-xs text-slate-100">
            屏幕共享
          </div>
        )}
        <div ref={localVideoRef} className="absolute bottom-3 right-3 w-28 h-20 bg-slate-800 rounded-md overflow-hidden border border-slate-600" />
      </div>
      <div ref={audioRef} className="hidden" />
      <p className="text-xs text-slate-400 mt-4">请允许麦克风权限；摄像头可选</p>
    </div>
  );
}
