export const REMOTE_ASSIST_DATA_TOPIC = 'opc.remote_assist.web_assist.event';

export interface RemoteAssistDataChannelEvent {
  remote_session_id: string;
  actor_identity: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface RemoteAssistDataPublishInput {
  remoteSessionId: string;
  actorIdentity: string;
  eventType: string;
  payload?: Record<string, unknown>;
  createdAt?: string;
  reliable?: boolean;
}

export type RemoteAssistDataFallbackPoster = (event: RemoteAssistDataPublishInput) => Promise<unknown>;

export interface RemoteAssistRealtimePublishInput extends RemoteAssistDataPublishInput {
  fallback?: RemoteAssistDataFallbackPoster;
  fallbackWhenUnavailable?: boolean;
}

export interface RemoteAssistRealtimeSendResult {
  transport: 'data_channel' | 'http_fallback' | 'skipped';
  fallback_reason?:
    | 'data_channel_unavailable'
    | 'data_channel_publish_failed'
    | 'unreliable_event_not_fallbacked'
    | 'fallback_not_configured';
}

export interface RemoteAssistDataPublisher {
  localParticipant?: {
    publishData?: (
      data: Uint8Array,
      options?: { reliable?: boolean; topic?: string }
    ) => Promise<void>;
  };
}

export interface RemoteAssistPointerPoint {
  clientX: number;
  clientY: number;
}

export interface RemoteAssistPointerRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type RemoteAssistAnnotationPhase = 'begin' | 'move' | 'end';

export type RemoteAssistAnnotationPayload = Record<string, unknown> & {
  phase: RemoteAssistAnnotationPhase;
  x_percent: number;
  y_percent: number;
  color?: string;
  line_width?: number;
};

export type RemoteAssistControlAction = 'click' | 'scroll' | 'text_input';

export type RemoteAssistControlPayload = Record<string, unknown> & {
  action: RemoteAssistControlAction;
  x_percent?: number;
  y_percent?: number;
  button?: 'left';
  delta_x?: number;
  delta_y?: number;
  text?: string;
};

export interface RemoteAssistControlWheelDelta {
  deltaX?: number;
  deltaY?: number;
}

export interface RemoteAssistInlineControlElement {
  tagName?: string;
  disabled?: boolean;
  isContentEditable?: boolean;
  value?: string;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  textContent?: string | null;
  getAttribute?(name: string): string | null;
  click?(): void;
  focus?(): void;
  setRangeText?(text: string, start?: number, end?: number, selectionMode?: 'select' | 'start' | 'end' | 'preserve'): void;
  dispatchEvent?(event: Event): boolean;
}

export interface RemoteAssistInlineControlSurface {
  readonly width: number;
  readonly height: number;
  readonly activeElement?: RemoteAssistInlineControlElement | null;
  elementFromPoint(x: number, y: number): RemoteAssistInlineControlElement | null;
  scrollBy(input: { left: number; top: number; behavior: 'auto' }): void;
}

export interface RemoteAssistInlineControlResult {
  executed: boolean;
  action?: RemoteAssistControlAction;
  reason?:
    | 'invalid_payload'
    | 'surface_unavailable'
    | 'target_not_found'
    | 'target_disabled'
    | 'unsupported_button'
    | 'scroll_unavailable'
    | 'no_editable_target';
}

export type RemoteAssistControlResultPayload = Record<string, unknown> & {
  executed: boolean;
  action?: RemoteAssistControlAction;
  reason?: RemoteAssistInlineControlResult['reason'];
};

export interface RemoteAssistAnnotationContext {
  readonly canvas: {
    readonly width: number;
    readonly height: number;
  };
  lineCap: string;
  lineJoin: string;
  strokeStyle: string | object;
  lineWidth: number;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  closePath(): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type BrowserEventConstructor = new (type: string, eventInitDict?: Record<string, unknown>) => Event;
type BrowserInputEventConstructor = new (
  type: string,
  eventInitDict?: Record<string, unknown>
) => Event;
type BrowserWindowLike = {
  innerWidth?: number;
  innerHeight?: number;
  scrollBy(input: { left: number; top: number; behavior: 'auto' }): void;
};
type BrowserDocumentLike = {
  documentElement?: {
    clientWidth?: number;
    clientHeight?: number;
  };
  activeElement?: unknown;
  elementFromPoint(x: number, y: number): unknown;
};

export async function publishRemoteAssistDataEvent(
  room: RemoteAssistDataPublisher | null | undefined,
  input: RemoteAssistDataPublishInput
): Promise<boolean> {
  const publisher = room?.localParticipant;
  if (!publisher?.publishData) return false;

  const event: RemoteAssistDataChannelEvent = {
    remote_session_id: input.remoteSessionId,
    actor_identity: input.actorIdentity,
    event_type: input.eventType,
    payload: input.payload || {},
    created_at: input.createdAt || new Date().toISOString()
  };

  await publisher.publishData(encoder.encode(JSON.stringify(event)), {
    reliable: input.reliable ?? false,
    topic: REMOTE_ASSIST_DATA_TOPIC
  });
  return true;
}

export async function sendRemoteAssistRealtimeEvent(
  room: RemoteAssistDataPublisher | null | undefined,
  input: RemoteAssistRealtimePublishInput
): Promise<RemoteAssistRealtimeSendResult> {
  try {
    const published = await publishRemoteAssistDataEvent(room, input);
    if (published) return { transport: 'data_channel' };
    return sendRemoteAssistFallback(input, 'data_channel_unavailable');
  } catch {
    return sendRemoteAssistFallback(input, 'data_channel_publish_failed');
  }
}

async function sendRemoteAssistFallback(
  input: RemoteAssistRealtimePublishInput,
  reason: 'data_channel_unavailable' | 'data_channel_publish_failed'
): Promise<RemoteAssistRealtimeSendResult> {
  if (!input.fallback) {
    return { transport: 'skipped', fallback_reason: 'fallback_not_configured' };
  }
  if (!input.reliable && !input.fallbackWhenUnavailable) {
    return { transport: 'skipped', fallback_reason: 'unreliable_event_not_fallbacked' };
  }
  await input.fallback({
    remoteSessionId: input.remoteSessionId,
    actorIdentity: input.actorIdentity,
    eventType: input.eventType,
    payload: input.payload,
    createdAt: input.createdAt,
    reliable: input.reliable
  });
  return { transport: 'http_fallback', fallback_reason: reason };
}

export function readRemoteAssistDataEvent(
  payload: Uint8Array | ArrayBuffer | string,
  topic?: string,
  remoteSessionId?: string
): RemoteAssistDataChannelEvent | null {
  if (topic !== REMOTE_ASSIST_DATA_TOPIC) return null;
  const data = decodePayload(payload);
  if (!isRecord(data)) return null;
  if (
    typeof data.remote_session_id !== 'string' ||
    typeof data.actor_identity !== 'string' ||
    typeof data.event_type !== 'string' ||
    !isRecord(data.payload) ||
    typeof data.created_at !== 'string'
  ) {
    return null;
  }
  if (remoteSessionId && data.remote_session_id !== remoteSessionId) return null;
  return data as unknown as RemoteAssistDataChannelEvent;
}

export function buildRemoteAssistPointerPayload(
  point: RemoteAssistPointerPoint,
  rect: RemoteAssistPointerRect
): { x_percent: number; y_percent: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x_percent: roundPercent(clampPercent(((point.clientX - rect.left) / rect.width) * 100)),
    y_percent: roundPercent(clampPercent(((point.clientY - rect.top) / rect.height) * 100))
  };
}

export function buildRemoteAssistAnnotationPayload(
  point: RemoteAssistPointerPoint,
  rect: RemoteAssistPointerRect,
  phase: RemoteAssistAnnotationPhase
): RemoteAssistAnnotationPayload | null {
  const position = buildRemoteAssistPointerPayload(point, rect);
  if (!position) return null;
  return {
    phase,
    x_percent: position.x_percent,
    y_percent: position.y_percent
  };
}

export function buildRemoteAssistControlClickPayload(
  point: RemoteAssistPointerPoint,
  rect: RemoteAssistPointerRect
): RemoteAssistControlPayload | null {
  const position = buildRemoteAssistPointerPayload(point, rect);
  if (!position) return null;
  return {
    action: 'click',
    x_percent: position.x_percent,
    y_percent: position.y_percent,
    button: 'left'
  };
}

export function buildRemoteAssistControlScrollPayload(
  delta: RemoteAssistControlWheelDelta
): RemoteAssistControlPayload | null {
  const deltaX = readFiniteNumber(delta.deltaX) || 0;
  const deltaY = readFiniteNumber(delta.deltaY) || 0;
  if (deltaX === 0 && deltaY === 0) return null;
  return {
    action: 'scroll',
    delta_x: clampControlDelta(deltaX),
    delta_y: clampControlDelta(deltaY)
  };
}

export function buildRemoteAssistControlTextInputPayload(text: string): RemoteAssistControlPayload | null {
  if (!text) return null;
  return {
    action: 'text_input',
    text: text.slice(0, 500)
  };
}

export function executeRemoteAssistInlineControlAction(
  payload: unknown,
  surface: RemoteAssistInlineControlSurface | null = defaultInlineControlSurface()
): RemoteAssistInlineControlResult {
  const control = readRemoteAssistControlPayload(payload);
  if (!control) return { executed: false, reason: 'invalid_payload' };
  if (!surface) return { executed: false, action: control.action, reason: 'surface_unavailable' };

  if (control.action === 'click') return executeInlineClick(control, surface);
  if (control.action === 'scroll') return executeInlineScroll(control, surface);
  return executeInlineTextInput(control, surface);
}

export function buildRemoteAssistControlResultPayload(
  result: RemoteAssistInlineControlResult
): RemoteAssistControlResultPayload {
  const payload: RemoteAssistControlResultPayload = { executed: result.executed };
  if (result.action) payload.action = result.action;
  if (result.reason) payload.reason = result.reason;
  return payload;
}

export function drawRemoteAssistAnnotation(
  context: RemoteAssistAnnotationContext,
  payload: unknown
): boolean {
  if (!isRecord(payload)) return false;
  const phase = payload.phase;
  const xPercent = readFiniteNumber(payload.x_percent);
  const yPercent = readFiniteNumber(payload.y_percent);
  if ((phase !== 'begin' && phase !== 'move' && phase !== 'end') || xPercent === null || yPercent === null) {
    return false;
  }

  const x = (clampPercent(xPercent) / 100) * context.canvas.width;
  const y = (clampPercent(yPercent) / 100) * context.canvas.height;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.strokeStyle = typeof payload.color === 'string' && payload.color ? payload.color : '#22d3ee';
  context.lineWidth = readFiniteNumber(payload.line_width) || 3;

  if (phase === 'begin') {
    context.beginPath();
    context.moveTo(x, y);
    return true;
  }

  context.lineTo(x, y);
  context.stroke();
  if (phase === 'end') context.closePath();
  return true;
}

function decodePayload(payload: Uint8Array | ArrayBuffer | string): unknown {
  try {
    const text = typeof payload === 'string' ? payload : decoder.decode(payload);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readRemoteAssistControlPayload(payload: unknown): RemoteAssistControlPayload | null {
  if (!isRecord(payload)) return null;
  const action = payload.action;
  if (action === 'click') {
    const xPercent = readFiniteNumber(payload.x_percent);
    const yPercent = readFiniteNumber(payload.y_percent);
    const button = payload.button === undefined ? 'left' : payload.button;
    if (xPercent === null || yPercent === null || button !== 'left') return null;
    return {
      action,
      x_percent: clampPercent(xPercent),
      y_percent: clampPercent(yPercent),
      button
    };
  }
  if (action === 'scroll') {
    const deltaX = readFiniteNumber(payload.delta_x) || 0;
    const deltaY = readFiniteNumber(payload.delta_y) || 0;
    if (deltaX === 0 && deltaY === 0) return null;
    return {
      action,
      delta_x: clampControlDelta(deltaX),
      delta_y: clampControlDelta(deltaY)
    };
  }
  if (action === 'text_input') {
    if (typeof payload.text !== 'string' || !payload.text) return null;
    return {
      action,
      text: payload.text.slice(0, 500)
    };
  }
  return null;
}

function executeInlineClick(
  payload: RemoteAssistControlPayload,
  surface: RemoteAssistInlineControlSurface
): RemoteAssistInlineControlResult {
  if (payload.button && payload.button !== 'left') {
    return { executed: false, action: 'click', reason: 'unsupported_button' };
  }
  const xPercent = readFiniteNumber(payload.x_percent);
  const yPercent = readFiniteNumber(payload.y_percent);
  if (xPercent === null || yPercent === null) return { executed: false, action: 'click', reason: 'invalid_payload' };
  const target = surface.elementFromPoint(
    Math.round((clampPercent(xPercent) / 100) * surface.width),
    Math.round((clampPercent(yPercent) / 100) * surface.height)
  );
  if (!target?.click) return { executed: false, action: 'click', reason: 'target_not_found' };
  if (isDisabledControlTarget(target)) return { executed: false, action: 'click', reason: 'target_disabled' };
  target.focus?.();
  target.click();
  return { executed: true, action: 'click' };
}

function executeInlineScroll(
  payload: RemoteAssistControlPayload,
  surface: RemoteAssistInlineControlSurface
): RemoteAssistInlineControlResult {
  if (!surface.scrollBy) return { executed: false, action: 'scroll', reason: 'scroll_unavailable' };
  surface.scrollBy({
    left: readFiniteNumber(payload.delta_x) || 0,
    top: readFiniteNumber(payload.delta_y) || 0,
    behavior: 'auto'
  });
  return { executed: true, action: 'scroll' };
}

function executeInlineTextInput(
  payload: RemoteAssistControlPayload,
  surface: RemoteAssistInlineControlSurface
): RemoteAssistInlineControlResult {
  const text = typeof payload.text === 'string' ? payload.text : '';
  if (!text) return { executed: false, action: 'text_input', reason: 'invalid_payload' };
  const target = surface.activeElement;
  if (!target || isDisabledControlTarget(target) || !isEditableControlTarget(target)) {
    return { executed: false, action: 'text_input', reason: 'no_editable_target' };
  }
  insertTextIntoControlTarget(target, text);
  return { executed: true, action: 'text_input' };
}

function isDisabledControlTarget(target: RemoteAssistInlineControlElement): boolean {
  return Boolean(target.disabled || target.getAttribute?.('aria-disabled') === 'true');
}

function isEditableControlTarget(target: RemoteAssistInlineControlElement): boolean {
  const tagName = String(target.tagName || '').toUpperCase();
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || Boolean(target.isContentEditable);
}

function insertTextIntoControlTarget(target: RemoteAssistInlineControlElement, text: string): void {
  if (typeof target.setRangeText === 'function') {
    const start = typeof target.selectionStart === 'number' ? target.selectionStart : String(target.value || '').length;
    const end = typeof target.selectionEnd === 'number' ? target.selectionEnd : start;
    target.setRangeText(text, start, end, 'end');
  } else if (typeof target.value === 'string') {
    target.value += text;
  } else {
    target.textContent = `${target.textContent || ''}${text}`;
  }
  dispatchInputEvent(target, text);
}

function dispatchInputEvent(target: RemoteAssistInlineControlElement, text: string): void {
  if (!target.dispatchEvent) return;
  const scope = globalThis as typeof globalThis & {
    InputEvent?: BrowserInputEventConstructor;
    Event?: BrowserEventConstructor;
  };
  if (scope.InputEvent) {
    target.dispatchEvent(new scope.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return;
  }
  if (scope.Event) {
    target.dispatchEvent(new scope.Event('input', { bubbles: true }));
  }
}

function defaultInlineControlSurface(): RemoteAssistInlineControlSurface | null {
  const scope = globalThis as typeof globalThis & {
    window?: BrowserWindowLike;
    document?: BrowserDocumentLike;
  };
  const browserWindow = scope.window;
  const browserDocument = scope.document;
  if (!browserWindow || !browserDocument) return null;
  return {
    get width() {
      return browserWindow.innerWidth || browserDocument.documentElement?.clientWidth || 1;
    },
    get height() {
      return browserWindow.innerHeight || browserDocument.documentElement?.clientHeight || 1;
    },
    get activeElement() {
      return browserDocument.activeElement as RemoteAssistInlineControlElement | null;
    },
    elementFromPoint: (x, y) => browserDocument.elementFromPoint(x, y) as RemoteAssistInlineControlElement | null,
    scrollBy: (input) => browserWindow.scrollBy(input)
  };
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

function clampControlDelta(value: number): number {
  return Math.max(-2000, Math.min(2000, Math.round(value)));
}
