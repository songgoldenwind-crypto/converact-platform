import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent, type WheelEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Room, RoomEvent, Track } from 'livekit-client';
import { apiGet, apiPost, getUserId } from '../api/client';
import { useWebSocket } from '../hooks/useWebSocket';
import {
  buildRemoteAssistAnnotationPayload,
  buildRemoteAssistControlClickPayload,
  buildRemoteAssistControlScrollPayload,
  buildRemoteAssistControlTextInputPayload,
  drawRemoteAssistAnnotation,
  readRemoteAssistDataEvent,
  sendRemoteAssistRealtimeEvent,
  type RemoteAssistAnnotationPhase,
  type RemoteAssistControlPayload,
  type RemoteAssistDataFallbackPoster
} from './remote-assist-data-channel';
import {
  deriveRemoteAssistObserverState,
  filterRemoteAssistObserverEvents,
  fetchRemoteAssistObserverMediaJoinPlan,
  fetchRemoteAssistObserverTimelineEvents,
  readRemoteAssistObserverEvent,
  type RemoteAssistObserverEvent,
  type RemoteAssistObserverEventFilter
} from './remote-assist-observer';

const MAX_EVENTS = 80;
const ANNOTATION_EVENT_TYPE = 'annotation.draw';
const CONTROL_EVENT_TYPE = 'control.action';
const CONTROL_RESULT_EVENT_TYPE = 'control.result';
type RemoteAssistInteractionMode = 'annotation' | 'control';

function prepareAnnotationCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return canvas.getContext('2d');
}

function eventLabel(type: string): string {
  if (type === 'screen.share_started') return '共享开始';
  if (type === 'screen.share_stopped') return '共享结束';
  if (type === 'pointer.move') return '指针移动';
  if (type.startsWith('annotation.')) return '标注';
  if (type === CONTROL_EVENT_TYPE) return '控制';
  if (type === CONTROL_RESULT_EVENT_TYPE) return '控制结果';
  return type;
}

function eventTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
}

function observerEventKey(event: RemoteAssistObserverEvent): string {
  return `${event.created_at}:${event.actor_identity}:${event.event_type}:${JSON.stringify(event.payload)}`;
}

function mergeObserverEvents(
  historicalEvents: RemoteAssistObserverEvent[],
  currentEvents: RemoteAssistObserverEvent[]
): RemoteAssistObserverEvent[] {
  const seen = new Set<string>();
  return [...historicalEvents, ...currentEvents].filter((event) => {
    const key = observerEventKey(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function controlActionLabel(action?: string): string {
  if (action === 'click') return '点击';
  if (action === 'scroll') return '滚动';
  if (action === 'text_input') return '文本输入';
  return '控制';
}

function controlReasonLabel(reason?: string): string {
  if (reason === 'invalid_payload') return '无效指令';
  if (reason === 'surface_unavailable') return '页面不可用';
  if (reason === 'target_not_found') return '目标不可点击';
  if (reason === 'target_disabled') return '目标已禁用';
  if (reason === 'unsupported_button') return '不支持的按键';
  if (reason === 'scroll_unavailable') return '无法滚动';
  if (reason === 'no_editable_target') return '未选中可输入区域';
  return reason || '';
}

export default function RemoteAssistObserverPage() {
  const [params] = useSearchParams();
  const remoteSessionId = params.get('remote_session_id') || '';
  const [events, setEvents] = useState<RemoteAssistObserverEvent[]>([]);
  const [mediaConnected, setMediaConnected] = useState(false);
  const [mediaError, setMediaError] = useState('');
  const [interactionMode, setInteractionMode] = useState<RemoteAssistInteractionMode>('annotation');
  const [eventFilter, setEventFilter] = useState<RemoteAssistObserverEventFilter>('all');
  const [controlText, setControlText] = useState('');
  const screenMediaRef = useRef<HTMLDivElement | null>(null);
  const annotationCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const annotationDrawingRef = useRef(false);
  const roomRef = useRef<Room | null>(null);

  function appendEvent(event: RemoteAssistObserverEvent) {
    setEvents((current) => [...current, event].slice(-MAX_EVENTS));
  }

  function drawAnnotationPayload(payload: unknown) {
    const canvas = annotationCanvasRef.current;
    if (!canvas) return;
    const context = prepareAnnotationCanvas(canvas);
    if (!context) return;
    drawRemoteAssistAnnotation(context, payload);
  }

  const postRemoteAssistFallbackEvent: RemoteAssistDataFallbackPoster = async (fallbackEvent) => {
    await apiPost(`/api/collaboration/remote-assistance/${encodeURIComponent(remoteSessionId)}/events`, {
      event_type: fallbackEvent.eventType,
      payload: {
        ...fallbackEvent.payload,
        transport_fallback: 'http'
      }
    });
  };

  function sendAnnotation(event: PointerEvent<HTMLCanvasElement>, phase: RemoteAssistAnnotationPhase) {
    if (!remoteSessionId) return;
    const reliable = phase !== 'move';
    const payload = buildRemoteAssistAnnotationPayload(
      { clientX: event.clientX, clientY: event.clientY },
      event.currentTarget.getBoundingClientRect(),
      phase
    );
    if (!payload) return;
    drawAnnotationPayload(payload);
    void sendRemoteAssistRealtimeEvent(roomRef.current, {
      remoteSessionId,
      actorIdentity: getUserId() || 'engineer',
      eventType: ANNOTATION_EVENT_TYPE,
      payload,
      reliable,
      fallback: postRemoteAssistFallbackEvent
    });
  }

  function sendControlPayload(payload: RemoteAssistControlPayload | null) {
    if (!remoteSessionId || !payload) return;
    void sendRemoteAssistRealtimeEvent(roomRef.current, {
      remoteSessionId,
      actorIdentity: getUserId() || 'engineer',
      eventType: CONTROL_EVENT_TYPE,
      payload,
      reliable: true,
      fallback: postRemoteAssistFallbackEvent
    }).catch((e) => setMediaError(e instanceof Error ? e.message : String(e)));
  }

  function handleAnnotationPointerDown(event: PointerEvent<HTMLCanvasElement>) {
    if (!mediaConnected || interactionMode !== 'annotation') return;
    annotationDrawingRef.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    sendAnnotation(event, 'begin');
  }

  function handleAnnotationPointerMove(event: PointerEvent<HTMLCanvasElement>) {
    if (interactionMode !== 'annotation') return;
    if (!annotationDrawingRef.current) return;
    sendAnnotation(event, 'move');
  }

  function stopAnnotation(event: PointerEvent<HTMLCanvasElement>) {
    if (!annotationDrawingRef.current) return;
    annotationDrawingRef.current = false;
    sendAnnotation(event, 'end');
  }

  function handleControlPointerDown(event: PointerEvent<HTMLCanvasElement>) {
    if (!mediaConnected || interactionMode !== 'control') return;
    event.preventDefault();
    sendControlPayload(
      buildRemoteAssistControlClickPayload(
        { clientX: event.clientX, clientY: event.clientY },
        event.currentTarget.getBoundingClientRect()
      )
    );
  }

  function handleControlWheel(event: WheelEvent<HTMLCanvasElement>) {
    if (!mediaConnected || interactionMode !== 'control') return;
    event.preventDefault();
    sendControlPayload(buildRemoteAssistControlScrollPayload({ deltaX: event.deltaX, deltaY: event.deltaY }));
  }

  function handleControlTextSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = buildRemoteAssistControlTextInputPayload(controlText);
    if (!payload) return;
    sendControlPayload(payload);
    setControlText('');
  }

  function handleScreenPointerDown(event: PointerEvent<HTMLCanvasElement>) {
    if (interactionMode === 'control') {
      handleControlPointerDown(event);
      return;
    }
    handleAnnotationPointerDown(event);
  }

  function handleScreenPointerMove(event: PointerEvent<HTMLCanvasElement>) {
    if (interactionMode !== 'annotation') return;
    handleAnnotationPointerMove(event);
  }

  function handleScreenPointerStop(event: PointerEvent<HTMLCanvasElement>) {
    if (interactionMode !== 'annotation') return;
    stopAnnotation(event);
  }

  useEffect(() => {
    setEvents([]);
    setMediaConnected(false);
    setMediaError('');
    if (!remoteSessionId) return;
    let cancelled = false;

    async function joinMedia() {
      try {
        const plan = await fetchRemoteAssistObserverMediaJoinPlan(apiGet, {
          remoteSessionId,
          identity: getUserId() || undefined
        });
        if (cancelled) return;
        if (plan.token.token.startsWith('dev-token:')) {
          setMediaConnected(true);
          return;
        }
        const room = new Room();
        room.on(RoomEvent.TrackSubscribed, (track, publication) => {
          if (track.kind !== Track.Kind.Video || publication.source !== Track.Source.ScreenShare) return;
          if (!screenMediaRef.current) return;
          screenMediaRef.current.innerHTML = '';
          const el = track.attach() as HTMLVideoElement;
          el.style.width = '100%';
          el.style.height = '100%';
          el.style.objectFit = 'contain';
          el.setAttribute('playsinline', 'true');
          screenMediaRef.current.appendChild(el);
        });
        room.on(RoomEvent.TrackUnsubscribed, (_track, publication) => {
          if (publication.source === Track.Source.ScreenShare && screenMediaRef.current) {
            screenMediaRef.current.innerHTML = '';
          }
        });
        room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
          const event = readRemoteAssistDataEvent(payload, topic, remoteSessionId);
          if (!event) return;
          if (event.event_type === ANNOTATION_EVENT_TYPE) drawAnnotationPayload(event.payload);
          appendEvent(event);
        });
        await room.connect(plan.token.livekit_url || plan.token.url || '', plan.token.token);
        if (cancelled) {
          void room.disconnect();
          return;
        }
        roomRef.current = room;
        setMediaConnected(true);
      } catch (e) {
        if (!cancelled) setMediaError(e instanceof Error ? e.message : String(e));
      }
    }

    async function loadTimeline() {
      try {
        const historicalEvents = await fetchRemoteAssistObserverTimelineEvents(apiGet, { remoteSessionId });
        if (cancelled) return;
        setEvents((current) => mergeObserverEvents(historicalEvents, current).slice(-MAX_EVENTS));
      } catch (e) {
        if (!cancelled) setMediaError(e instanceof Error ? e.message : String(e));
      }
    }

    void loadTimeline();
    void joinMedia();
    return () => {
      cancelled = true;
      void roomRef.current?.disconnect();
      roomRef.current = null;
      if (screenMediaRef.current) screenMediaRef.current.innerHTML = '';
    };
  }, [remoteSessionId]);

  const { connected } = useWebSocket((type, data) => {
    if (!remoteSessionId) return;
    if (type !== 'remote.web_assist.event') return;
    const event = readRemoteAssistObserverEvent(type, data, remoteSessionId);
    if (!event) return;
    appendEvent(event);
  });

  const state = useMemo(() => deriveRemoteAssistObserverState(events), [events]);
  const filteredEvents = useMemo(() => filterRemoteAssistObserverEvents(events, eventFilter), [eventFilter, events]);
  const recentEvents = useMemo(() => [...filteredEvents].reverse(), [filteredEvents]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">远程协助观察</h1>
          <p className="mt-1 font-mono text-xs text-slate-500">{remoteSessionId || '未选择会话'}</p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span
            className={`h-2.5 w-2.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-slate-300'}`}
            aria-hidden="true"
          />
          <span className="text-slate-600">{connected ? '已连接' : '未连接'}</span>
        </div>
      </div>

      {mediaError && (
        <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">{mediaError}</div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="overflow-hidden rounded-lg border border-slate-200 bg-slate-950">
          <div className="flex flex-col gap-3 border-b border-slate-800 px-4 py-3 text-sm lg:flex-row lg:items-center lg:justify-between">
            <span className="font-medium text-slate-100">客户屏幕</span>
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex overflow-hidden rounded border border-slate-700">
                <button
                  type="button"
                  data-testid="remote-assist-annotation-mode"
                  className={`px-3 py-1.5 ${
                    interactionMode === 'annotation' ? 'bg-cyan-500 text-slate-950' : 'bg-slate-900 text-slate-300'
                  }`}
                  onClick={() => setInteractionMode('annotation')}
                >
                  标注
                </button>
                <button
                  type="button"
                  data-testid="remote-assist-control-mode"
                  className={`border-l border-slate-700 px-3 py-1.5 ${
                    interactionMode === 'control' ? 'bg-cyan-500 text-slate-950' : 'bg-slate-900 text-slate-300'
                  }`}
                  onClick={() => {
                    annotationDrawingRef.current = false;
                    setInteractionMode('control');
                  }}
                >
                  控制
                </button>
              </div>
              <span className={state.sharing ? 'text-emerald-300' : 'text-slate-400'}>
                {state.sharing ? '共享中' : mediaConnected ? '已入房' : '等待中'}
              </span>
            </div>
          </div>
          <div
            data-testid="remote-assist-observer-screen"
            className="relative aspect-video min-h-[360px] overflow-hidden bg-black"
          >
            <div ref={screenMediaRef} className="absolute inset-0" />
            {!state.sharing && <div className="absolute inset-0 grid place-items-center text-sm text-slate-500">
              {state.sharing ? '客户正在共享' : '等待客户共享'}
            </div>}
            <canvas
              ref={annotationCanvasRef}
              data-testid="remote-assist-observer-annotation-layer"
              className={`absolute inset-0 h-full w-full touch-none ${
                interactionMode === 'control' ? 'cursor-pointer' : 'cursor-crosshair'
              }`}
              onPointerDown={handleScreenPointerDown}
              onPointerMove={handleScreenPointerMove}
              onPointerUp={handleScreenPointerStop}
              onPointerLeave={handleScreenPointerStop}
              onWheel={handleControlWheel}
              aria-hidden="true"
            />
            <div
              data-testid="remote-assist-observer-pointer"
              className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-cyan-400 shadow-lg transition-all"
              style={{
                left: `${state.pointer?.x ?? 50}%`,
                top: `${state.pointer?.y ?? 50}%`,
                opacity: state.pointer ? 1 : 0
              }}
              aria-hidden="true"
            />
          </div>
        </section>

        <aside className="space-y-4">
          <section className="rounded-lg border border-slate-200 bg-white">
            <div className="border-b border-slate-200 px-4 py-3">
              <h2 className="font-medium text-slate-900">控制输入</h2>
            </div>
            <form className="flex gap-2 p-3" onSubmit={handleControlTextSubmit}>
              <input
                data-testid="remote-assist-control-text-input"
                className="min-w-0 flex-1 rounded border border-slate-200 px-3 py-2 text-sm outline-none focus:border-cyan-500"
                value={controlText}
                onChange={(event) => setControlText(event.target.value)}
                disabled={!mediaConnected}
                placeholder="输入文本"
              />
              <button
                type="submit"
                data-testid="remote-assist-control-text-send"
                className="rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                disabled={!mediaConnected || !controlText}
              >
                发送
              </button>
            </form>
            <div
              data-testid="remote-assist-control-result"
              className="border-t border-slate-100 px-4 py-3 text-sm"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-500">最近结果</span>
                {state.lastControlResult ? (
                  <span
                    className={
                      state.lastControlResult.executed
                        ? 'font-medium text-emerald-600'
                        : 'font-medium text-red-600'
                    }
                  >
                    {state.lastControlResult.executed ? '成功' : '失败'}
                  </span>
                ) : (
                  <span className="text-slate-400">暂无</span>
                )}
              </div>
              {state.lastControlResult && (
                <div className="mt-2 space-y-1 text-xs text-slate-500">
                  <div>{controlActionLabel(state.lastControlResult.action)}</div>
                  {state.lastControlResult.reason && (
                    <div>{controlReasonLabel(state.lastControlResult.reason)}</div>
                  )}
                  <div className="font-mono">{eventTime(state.lastControlResult.createdAt)}</div>
                </div>
              )}
            </div>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white">
            <div className="border-b border-slate-200 px-4 py-3">
              <h2 className="font-medium text-slate-900">实时事件</h2>
              <p className="mt-1 text-xs text-slate-500">
                {state.lastActor ? `${state.lastActor} · ${eventLabel(state.lastEventType)}` : '暂无事件'}
              </p>
            </div>
            <div data-testid="remote-assist-event-filter" className="flex border-b border-slate-100 p-2 text-xs">
              <button
                type="button"
                data-testid="remote-assist-event-filter-all"
                className={`flex-1 rounded px-2 py-1.5 ${
                  eventFilter === 'all' ? 'bg-slate-900 text-white' : 'text-slate-500'
                }`}
                onClick={() => setEventFilter('all')}
              >
                全部
              </button>
              <button
                type="button"
                data-testid="remote-assist-event-filter-control-actions"
                className={`flex-1 rounded px-2 py-1.5 ${
                  eventFilter === 'control-actions' ? 'bg-slate-900 text-white' : 'text-slate-500'
                }`}
                onClick={() => setEventFilter('control-actions')}
              >
                控制指令
              </button>
              <button
                type="button"
                data-testid="remote-assist-event-filter-control-results"
                className={`flex-1 rounded px-2 py-1.5 ${
                  eventFilter === 'control-results' ? 'bg-slate-900 text-white' : 'text-slate-500'
                }`}
                onClick={() => setEventFilter('control-results')}
              >
                控制结果
              </button>
            </div>
            <ol data-testid="remote-assist-observer-events" className="max-h-[520px] space-y-1 overflow-auto p-3">
              {recentEvents.length ? (
                recentEvents.map((event, index) => (
                  <li
                    key={`${event.created_at}-${event.event_type}-${index}`}
                    className="rounded border border-slate-100 px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-slate-800">{eventLabel(event.event_type)}</span>
                      <span className="font-mono text-[11px] text-slate-400">{eventTime(event.created_at)}</span>
                    </div>
                    <div className="mt-1 truncate text-xs text-slate-500">{event.actor_identity}</div>
                  </li>
                ))
              ) : (
                <li className="px-3 py-8 text-center text-sm text-slate-400">暂无事件</li>
              )}
            </ol>
          </section>
        </aside>
      </div>
    </div>
  );
}
