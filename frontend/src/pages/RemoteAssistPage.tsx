import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Room, RoomEvent, Track } from 'livekit-client';
import {
  buildRemoteAssistControlResultPayload,
  buildRemoteAssistPointerPayload,
  drawRemoteAssistAnnotation,
  executeRemoteAssistInlineControlAction,
  readRemoteAssistDataEvent,
  sendRemoteAssistRealtimeEvent,
  type RemoteAssistInlineControlResult
} from './remote-assist-data-channel';
import {
  fetchRemoteAssistMediaJoinPlan,
  fetchRemoteAssistJoinVerification,
  postRemoteAssistConsentGrant,
  postRemoteAssistConsentRevoke,
  postRemoteAssistEvent,
  postRemoteAssistRecordingStart,
  postRemoteAssistRecordingStop,
  type RemoteAssistVerifiedSession
} from './remote-assist-join';

const POINTER_SEND_INTERVAL_MS = 50;
const ANNOTATION_EVENT_TYPE = 'annotation.draw';
const CONTROL_ACTION_EVENT_TYPE = 'control.action';
const CONTROL_RESULT_EVENT_TYPE = 'control.result';
const WEB_ASSIST_CONSENT_SCOPES = ['view_screen', 'control_mouse_keyboard', 'record_screen'];
type RemoteAssistMediaMode = 'unprepared' | 'development' | 'livekit';
type RemoteAssistRecordingState = 'idle' | 'starting' | 'recording' | 'stopping' | 'error';

function recordingStateLabel(state: RemoteAssistRecordingState): string {
  if (state === 'starting') return '正在启动录屏';
  if (state === 'recording') return '正在录屏';
  if (state === 'stopping') return '正在停止录屏';
  if (state === 'error') return '录屏异常';
  return '未录屏';
}

function prepareAnnotationCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return canvas.getContext('2d');
}

export default function RemoteAssistPage() {
  const [params] = useSearchParams();
  const tenantId = params.get('tenant_id') || '';
  const remoteSessionId = params.get('remote_session_id') || '';
  const token = params.get('token') || '';
  const [verified, setVerified] = useState<RemoteAssistVerifiedSession | null>(null);
  const [error, setError] = useState('');
  const [consentGranted, setConsentGranted] = useState(false);
  const [preparingMedia, setPreparingMedia] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [recordingState, setRecordingState] = useState<RemoteAssistRecordingState>('idle');
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const annotationCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const roomRef = useRef<Room | null>(null);
  const mediaModeRef = useRef<RemoteAssistMediaMode>('unprepared');
  const sharingRef = useRef(false);
  const stoppingShareRef = useRef(false);
  const lastPointerSentAtRef = useRef(0);
  const recordingEgressIdRef = useRef('');

  useEffect(() => {
    if (!tenantId || !remoteSessionId || !token) {
      setError('缺少远程协助参数');
      return;
    }

    let cancelled = false;

    async function verify() {
      try {
        const session = await fetchRemoteAssistJoinVerification(fetch, {
          tenantId,
          remoteSessionId,
          token
        });
        if (cancelled) return;
        setVerified(session);
        setConsentGranted(false);
        setRecordingState('idle');
        recordingEgressIdRef.current = '';
        setError('');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }

    void verify();
    return () => {
      cancelled = true;
      void roomRef.current?.disconnect();
      roomRef.current = null;
      mediaModeRef.current = 'unprepared';
    };
  }, [tenantId, remoteSessionId, token]);

  async function prepareMediaJoin() {
    if (roomRef.current) return;
    const mediaJoin = await fetchRemoteAssistMediaJoinPlan(fetch, {
      tenantId,
      remoteSessionId,
      token
    });
    if (mediaJoin.token.token.startsWith('dev-token:')) {
      mediaModeRef.current = 'development';
      return;
    }
    const room = new Room();
    room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
      const event = readRemoteAssistDataEvent(payload, topic, remoteSessionId);
      if (event?.event_type === ANNOTATION_EVENT_TYPE) drawAnnotationPayload(event.payload);
      if (event?.event_type === CONTROL_ACTION_EVENT_TYPE) {
        const result = executeRemoteAssistInlineControlAction(event.payload);
        void emitAssistControlResult(result);
      }
    });
    await room.connect(mediaJoin.token.livekit_url || mediaJoin.token.url || '', mediaJoin.token.token);
    roomRef.current = room;
    mediaModeRef.current = 'livekit';
  }

  async function grantConsent() {
    if (!verified) return;
    try {
      setPreparingMedia(true);
      await postRemoteAssistConsentGrant(fetch, {
        tenantId,
        remoteSessionId,
        token,
        scopes: WEB_ASSIST_CONSENT_SCOPES,
        expiresAt: verified.expires_at
      });
      setConsentGranted(true);
      await prepareMediaJoin();
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '远程协助授权失败');
    } finally {
      setPreparingMedia(false);
    }
  }

  async function revokeConsent() {
    if (!verified) return;
    try {
      await stopScreenShare();
      await postRemoteAssistConsentRevoke(fetch, {
        tenantId,
        remoteSessionId,
        token,
        scopes: WEB_ASSIST_CONSENT_SCOPES
      });
      await roomRef.current?.disconnect();
      roomRef.current = null;
      mediaModeRef.current = 'unprepared';
      setConsentGranted(false);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '远程协助撤销授权失败');
    }
  }

  async function startAssistRecording() {
    if (!verified || recordingEgressIdRef.current) return;
    try {
      setRecordingState('starting');
      const recording = await postRemoteAssistRecordingStart(fetch, {
        tenantId,
        remoteSessionId,
        token,
        format: 'mp4'
      });
      recordingEgressIdRef.current = recording.egress_id;
      setRecordingState('recording');
    } catch (e) {
      setRecordingState('error');
      setError(e instanceof Error ? e.message : '远程协助录屏启动失败');
    }
  }

  async function stopAssistRecording() {
    if (!recordingEgressIdRef.current) {
      setRecordingState('idle');
      return;
    }
    const egressId = recordingEgressIdRef.current;
    recordingEgressIdRef.current = '';
    try {
      setRecordingState('stopping');
      await postRemoteAssistRecordingStop(fetch, {
        tenantId,
        remoteSessionId,
        token,
        egressId
      });
      setRecordingState('idle');
    } catch (e) {
      recordingEgressIdRef.current = egressId;
      setRecordingState('recording');
      setError(e instanceof Error ? e.message : '远程协助录屏停止失败');
    }
  }

  async function startScreenShare() {
    if (!consentGranted) {
      await grantConsent();
      return;
    }
    try {
      if (!roomRef.current && mediaModeRef.current !== 'development') {
        await prepareMediaJoin();
      }
      const room = roomRef.current;
      if (room) {
        await room.localParticipant.setScreenShareEnabled(true);
        const publication = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
        publication?.videoTrack?.mediaStreamTrack.addEventListener(
          'ended',
          () => void stopScreenShare(),
          { once: true }
        );
        if (publication?.videoTrack && previewRef.current) {
          previewRef.current.srcObject = null;
          const stream = new MediaStream([publication.videoTrack.mediaStreamTrack]);
          previewRef.current.srcObject = stream;
          await previewRef.current.play();
        }
      } else if (mediaModeRef.current === 'development') {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false
        });
        streamRef.current = stream;
        if (previewRef.current) {
          previewRef.current.srcObject = stream;
          await previewRef.current.play();
        }
        stream.getVideoTracks()[0]?.addEventListener('ended', () => void stopScreenShare());
      } else {
        throw new Error('远程协助媒体连接尚未就绪');
      }
      sharingRef.current = true;
      setSharing(true);
      await emitAssistEvent('screen.share_started', { video: true, audio: false });
      await startAssistRecording();
    } catch (e) {
      setError(e instanceof Error ? e.message : '屏幕共享启动失败');
    }
  }

  async function stopScreenShare(options: { emit?: boolean } = {}) {
    if (stoppingShareRef.current) return;
    stoppingShareRef.current = true;
    try {
      const hadStream = Boolean(streamRef.current) || sharingRef.current;
      const hadRecording = Boolean(recordingEgressIdRef.current);
      if (roomRef.current) {
        await roomRef.current.localParticipant.setScreenShareEnabled(false).catch(() => undefined);
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (previewRef.current) previewRef.current.srcObject = null;
      sharingRef.current = false;
      setSharing(false);
      if (hadStream && options.emit !== false) {
        await emitAssistEvent('screen.share_stopped');
      }
      if (hadRecording) {
        await stopAssistRecording();
      }
    } finally {
      stoppingShareRef.current = false;
    }
  }

  async function emitAssistEvent(eventType: string, payload: Record<string, unknown> = {}) {
    if (!verified) return;
    try {
      await postRemoteAssistEvent(fetch, {
        tenantId,
        remoteSessionId,
        token,
        eventType,
        payload
      });
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '远程协助事件同步失败');
    }
  }

  async function emitAssistDataEvent(eventType: string, payload: Record<string, unknown> = {}) {
    if (!verified) return;
    await sendRemoteAssistRealtimeEvent(roomRef.current, {
      remoteSessionId,
      actorIdentity: verified.actor_identity,
      eventType,
      payload,
      reliable: false
    }).catch(() => undefined);
  }

  async function emitAssistControlResult(result: RemoteAssistInlineControlResult) {
    if (!verified) return;
    await sendRemoteAssistRealtimeEvent(roomRef.current, {
      remoteSessionId,
      actorIdentity: verified.actor_identity,
      eventType: CONTROL_RESULT_EVENT_TYPE,
      payload: buildRemoteAssistControlResultPayload(result),
      reliable: true,
      fallback: async (fallbackEvent) => {
        await postRemoteAssistEvent(fetch, {
          tenantId,
          remoteSessionId,
          token,
          eventType: fallbackEvent.eventType,
          payload: {
            ...fallbackEvent.payload,
            transport_fallback: 'http'
          }
        });
      }
    }).catch((e) => setError(e instanceof Error ? e.message : '远程协助控制结果同步失败'));
  }

  function drawAnnotationPayload(payload: unknown) {
    const canvas = annotationCanvasRef.current;
    if (!canvas) return;
    const context = prepareAnnotationCanvas(canvas);
    if (!context) return;
    drawRemoteAssistAnnotation(context, payload);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!sharing || !verified || !roomRef.current) return;
    const now = Date.now();
    if (now - lastPointerSentAtRef.current < POINTER_SEND_INTERVAL_MS) return;
    const payload = buildRemoteAssistPointerPayload(
      { clientX: event.clientX, clientY: event.clientY },
      event.currentTarget.getBoundingClientRect()
    );
    if (!payload) return;
    lastPointerSentAtRef.current = now;
    void emitAssistDataEvent('pointer.move', payload);
  }

  useEffect(() => () => void stopScreenShare({ emit: false }), []);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <header className="border-b border-slate-800 px-4 py-3 flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold">远程协助</h1>
          <p className="text-xs text-slate-400">{remoteSessionId || '等待会话'}</p>
        </div>
        <span className="text-xs text-slate-400">{verified ? verified.role : '校验中'}</span>
      </header>

      <section className="flex-1 grid lg:grid-cols-[1fr_280px] min-h-0">
        <div
          className="relative bg-black flex items-center justify-center overflow-hidden"
          onPointerMove={handlePointerMove}
        >
          <video
            ref={previewRef}
            data-testid="remote-assist-screen"
            className="h-full w-full object-contain"
            muted
            playsInline
          />
          <div
            data-testid="remote-assist-pointer-layer"
            className="pointer-events-none absolute inset-0"
            aria-hidden="true"
          />
          <canvas
            ref={annotationCanvasRef}
            data-testid="remote-assist-annotation-layer"
            className="pointer-events-none absolute inset-0 h-full w-full"
            aria-hidden="true"
          />
          {!sharing && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-400">
              等待屏幕共享
            </div>
          )}
        </div>

        <aside className="border-l border-slate-800 bg-slate-900 p-4 space-y-4">
          {error && <div className="rounded border border-red-500/40 bg-red-950/40 p-3 text-sm text-red-200">{error}</div>}
          <div
            data-testid="remote-assist-recording-status"
            className={recordingState === 'recording' ? 'text-sm text-red-300' : 'text-sm text-slate-400'}
          >
            {recordingStateLabel(recordingState)}
          </div>
          {verified && (
            <div className="space-y-2 text-sm">
              <div className="text-slate-400">身份</div>
              <div className="font-mono text-xs break-all">{verified.actor_identity}</div>
              <div className="text-slate-400">有效期</div>
              <div className="font-mono text-xs break-all">{new Date(verified.expires_at).toLocaleString()}</div>
            </div>
          )}
          <button
            type="button"
            onClick={() => (sharing ? void stopScreenShare() : consentGranted ? void startScreenShare() : void grantConsent())}
            disabled={!verified || preparingMedia}
            className="w-full rounded bg-cyan-500 px-3 py-2 text-sm font-medium text-slate-950 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
          >
            {preparingMedia ? '准备中' : sharing ? '停止共享' : consentGranted ? '共享屏幕' : '授权协助'}
          </button>
          {consentGranted && (
            <button
              type="button"
              onClick={() => void revokeConsent()}
              className="w-full rounded border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800"
            >
              撤销授权
            </button>
          )}
        </aside>
      </section>
    </main>
  );
}
