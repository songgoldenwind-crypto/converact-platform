import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  REMOTE_ASSIST_DATA_TOPIC,
  buildRemoteAssistControlClickPayload,
  buildRemoteAssistControlResultPayload,
  buildRemoteAssistControlScrollPayload,
  buildRemoteAssistControlTextInputPayload,
  buildRemoteAssistAnnotationPayload,
  buildRemoteAssistPointerPayload,
  drawRemoteAssistAnnotation,
  executeRemoteAssistInlineControlAction,
  publishRemoteAssistDataEvent,
  readRemoteAssistDataEvent,
  sendRemoteAssistRealtimeEvent
} from '../frontend/src/pages/remote-assist-data-channel.js';

test('remote assist data channel publishes event payloads under one topic', async () => {
  const room = new FakeRoom();

  const published = await publishRemoteAssistDataEvent(room, {
    remoteSessionId: 'remote-1',
    actorIdentity: 'buyer-1',
    eventType: 'pointer.move',
    payload: { x_percent: 24, y_percent: 48 },
    createdAt: '2099-01-01T00:00:00.000Z'
  });

  assert.equal(published, true);
  assert.equal(room.packets.length, 1);
  assert.equal(room.packets[0].options?.topic, REMOTE_ASSIST_DATA_TOPIC);
  assert.equal(room.packets[0].options?.reliable, false);

  const event = readRemoteAssistDataEvent(room.packets[0].data, REMOTE_ASSIST_DATA_TOPIC, 'remote-1');
  assert.equal(event?.remote_session_id, 'remote-1');
  assert.equal(event?.actor_identity, 'buyer-1');
  assert.equal(event?.event_type, 'pointer.move');
  assert.deepEqual(event?.payload, { x_percent: 24, y_percent: 48 });
});

test('remote assist realtime sender prefers data channel and skips fallback', async () => {
  const room = new FakeRoom();
  const fallbackCalls: unknown[] = [];

  const result = await sendRemoteAssistRealtimeEvent(room, {
    remoteSessionId: 'remote-1',
    actorIdentity: 'engineer-1',
    eventType: 'annotation.draw',
    payload: { phase: 'begin', x_percent: 10, y_percent: 20 },
    reliable: true,
    fallback: async (event) => {
      fallbackCalls.push(event);
    }
  });

  assert.equal(result.transport, 'data_channel');
  assert.equal(result.fallback_reason, undefined);
  assert.equal(room.packets.length, 1);
  assert.equal(fallbackCalls.length, 0);
});

test('remote assist realtime sender falls back for reliable events when data channel is unavailable', async () => {
  const fallbackCalls: unknown[] = [];

  const result = await sendRemoteAssistRealtimeEvent(null, {
    remoteSessionId: 'remote-1',
    actorIdentity: 'engineer-1',
    eventType: 'annotation.draw',
    payload: { phase: 'end', x_percent: 80, y_percent: 90 },
    reliable: true,
    fallback: async (event) => {
      fallbackCalls.push(event);
    }
  });

  assert.equal(result.transport, 'http_fallback');
  assert.equal(result.fallback_reason, 'data_channel_unavailable');
  assert.deepEqual(fallbackCalls, [
    {
      remoteSessionId: 'remote-1',
      actorIdentity: 'engineer-1',
      eventType: 'annotation.draw',
      payload: { phase: 'end', x_percent: 80, y_percent: 90 },
      createdAt: undefined,
      reliable: true
    }
  ]);
});

test('remote assist realtime sender does not fall back for high frequency unreliable events', async () => {
  const fallbackCalls: unknown[] = [];

  const result = await sendRemoteAssistRealtimeEvent(null, {
    remoteSessionId: 'remote-1',
    actorIdentity: 'buyer-1',
    eventType: 'pointer.move',
    payload: { x_percent: 20, y_percent: 30 },
    reliable: false,
    fallback: async (event) => {
      fallbackCalls.push(event);
    }
  });

  assert.equal(result.transport, 'skipped');
  assert.equal(result.fallback_reason, 'unreliable_event_not_fallbacked');
  assert.equal(fallbackCalls.length, 0);
});

test('remote assist realtime sender falls back when reliable publish fails', async () => {
  const room = new FakeRoom();
  room.failPublish = true;
  const fallbackCalls: unknown[] = [];

  const result = await sendRemoteAssistRealtimeEvent(room, {
    remoteSessionId: 'remote-1',
    actorIdentity: 'engineer-1',
    eventType: 'annotation.draw',
    payload: { phase: 'begin', x_percent: 10, y_percent: 20 },
    reliable: true,
    fallback: async (event) => {
      fallbackCalls.push(event);
    }
  });

  assert.equal(result.transport, 'http_fallback');
  assert.equal(result.fallback_reason, 'data_channel_publish_failed');
  assert.equal(fallbackCalls.length, 1);
});

test('remote assist data channel ignores wrong topic session and malformed payloads', () => {
  const encoded = new TextEncoder().encode(
    JSON.stringify({
      remote_session_id: 'remote-1',
      actor_identity: 'buyer-1',
      event_type: 'pointer.move',
      payload: { x_percent: 24, y_percent: 48 },
      created_at: '2099-01-01T00:00:00.000Z'
    })
  );

  assert.equal(readRemoteAssistDataEvent(encoded, 'other.topic', 'remote-1'), null);
  assert.equal(readRemoteAssistDataEvent(encoded, REMOTE_ASSIST_DATA_TOPIC, 'remote-2'), null);
  assert.equal(readRemoteAssistDataEvent(new TextEncoder().encode('{'), REMOTE_ASSIST_DATA_TOPIC, 'remote-1'), null);
  assert.equal(
    readRemoteAssistDataEvent(
      new TextEncoder().encode(JSON.stringify({ event_type: 'pointer.move' })),
      REMOTE_ASSIST_DATA_TOPIC,
      'remote-1'
    ),
    null
  );
});

test('remote assist pointer payload is expressed as clamped screen percentages', () => {
  assert.deepEqual(
    buildRemoteAssistPointerPayload(
      { clientX: 150, clientY: 260 },
      { left: 100, top: 200, width: 200, height: 300 }
    ),
    { x_percent: 25, y_percent: 20 }
  );

  assert.deepEqual(
    buildRemoteAssistPointerPayload(
      { clientX: 20, clientY: 700 },
      { left: 100, top: 200, width: 200, height: 300 }
    ),
    { x_percent: 0, y_percent: 100 }
  );

  assert.equal(
    buildRemoteAssistPointerPayload(
      { clientX: 150, clientY: 260 },
      { left: 100, top: 200, width: 0, height: 300 }
    ),
    null
  );
});

test('remote assist annotation payload is expressed as clamped screen percentages', () => {
  assert.deepEqual(
    buildRemoteAssistAnnotationPayload(
      { clientX: 180, clientY: 350 },
      { left: 100, top: 200, width: 200, height: 300 },
      'move'
    ),
    { phase: 'move', x_percent: 40, y_percent: 50 }
  );

  assert.deepEqual(
    buildRemoteAssistAnnotationPayload(
      { clientX: 400, clientY: 100 },
      { left: 100, top: 200, width: 200, height: 300 },
      'end'
    ),
    { phase: 'end', x_percent: 100, y_percent: 0 }
  );

  assert.equal(
    buildRemoteAssistAnnotationPayload(
      { clientX: 180, clientY: 350 },
      { left: 100, top: 200, width: 0, height: 300 },
      'begin'
    ),
    null
  );
});

test('remote assist control payloads are normalized for inline execution', () => {
  assert.deepEqual(
    buildRemoteAssistControlClickPayload(
      { clientX: 150, clientY: 260 },
      { left: 100, top: 200, width: 200, height: 300 }
    ),
    { action: 'click', x_percent: 25, y_percent: 20, button: 'left' }
  );

  assert.deepEqual(
    buildRemoteAssistControlScrollPayload({ deltaX: -20, deltaY: 160 }),
    { action: 'scroll', delta_x: -20, delta_y: 160 }
  );

  assert.deepEqual(
    buildRemoteAssistControlTextInputPayload('hello'),
    { action: 'text_input', text: 'hello' }
  );

  assert.equal(buildRemoteAssistControlTextInputPayload(''), null);
});

test('remote assist control result payloads are normalized for engineer feedback', () => {
  assert.deepEqual(
    buildRemoteAssistControlResultPayload({ executed: true, action: 'click' }),
    { executed: true, action: 'click' }
  );

  assert.deepEqual(
    buildRemoteAssistControlResultPayload({
      executed: false,
      action: 'text_input',
      reason: 'no_editable_target'
    }),
    { executed: false, action: 'text_input', reason: 'no_editable_target' }
  );
});

test('remote assist inline execution clicks scrolls and inputs text in the page', () => {
  const button = new FakeControlElement('BUTTON');
  const input = new FakeControlElement('INPUT');
  input.value = 'ab';
  input.selectionStart = 1;
  input.selectionEnd = 1;
  const surface = new FakeControlSurface(800, 600, button, input);

  assert.deepEqual(
    executeRemoteAssistInlineControlAction(
      { action: 'click', x_percent: 25, y_percent: 50, button: 'left' },
      surface
    ),
    { executed: true, action: 'click' }
  );
  assert.equal(button.clicks, 1);
  assert.deepEqual(surface.lastPoint, { x: 200, y: 300 });

  assert.deepEqual(
    executeRemoteAssistInlineControlAction(
      { action: 'scroll', delta_x: 0, delta_y: 120 },
      surface
    ),
    { executed: true, action: 'scroll' }
  );
  assert.deepEqual(surface.scrolls, [{ left: 0, top: 120, behavior: 'auto' }]);

  assert.deepEqual(
    executeRemoteAssistInlineControlAction(
      { action: 'text_input', text: 'Z' },
      surface
    ),
    { executed: true, action: 'text_input' }
  );
  assert.equal(input.value, 'aZb');
  assert.equal(input.inputEvents, 1);
});

test('remote assist inline execution rejects disabled click targets and non-editable text targets', () => {
  const disabled = new FakeControlElement('BUTTON');
  disabled.disabled = true;
  const passive = new FakeControlElement('DIV');
  const surface = new FakeControlSurface(800, 600, disabled, passive);

  assert.deepEqual(
    executeRemoteAssistInlineControlAction(
      { action: 'click', x_percent: 50, y_percent: 50, button: 'left' },
      surface
    ),
    { executed: false, action: 'click', reason: 'target_disabled' }
  );

  assert.deepEqual(
    executeRemoteAssistInlineControlAction(
      { action: 'text_input', text: 'nope' },
      surface
    ),
    { executed: false, action: 'text_input', reason: 'no_editable_target' }
  );
});

test('remote assist annotation draw helper converts percentages into canvas strokes', () => {
  const context = new FakeCanvasContext(800, 600);

  assert.equal(
    drawRemoteAssistAnnotation(context, {
      phase: 'begin',
      x_percent: 25,
      y_percent: 50
    }),
    true
  );
  assert.equal(
    drawRemoteAssistAnnotation(context, {
      phase: 'move',
      x_percent: 75,
      y_percent: 100
    }),
    true
  );
  assert.equal(
    drawRemoteAssistAnnotation(context, {
      phase: 'end',
      x_percent: 100,
      y_percent: 0
    }),
    true
  );

  assert.deepEqual(context.commands, [
    'beginPath',
    'moveTo:200:300',
    'lineTo:600:600',
    'stroke',
    'lineTo:800:0',
    'stroke',
    'closePath'
  ]);
});

test('remote assist pages are wired to LiveKit data channel events', () => {
  const customerPage = readFileSync('frontend/src/pages/RemoteAssistPage.tsx', 'utf8');
  const observerPage = readFileSync('frontend/src/pages/RemoteAssistObserverPage.tsx', 'utf8');

  assert.match(customerPage, /sendRemoteAssistRealtimeEvent/);
  assert.match(customerPage, /buildRemoteAssistPointerPayload/);
  assert.match(customerPage, /drawRemoteAssistAnnotation/);
  assert.match(customerPage, /executeRemoteAssistInlineControlAction/);
  assert.match(customerPage, /control\.action/);
  assert.match(customerPage, /control\.result/);
  assert.match(customerPage, /buildRemoteAssistControlResultPayload/);
  assert.match(customerPage, /control_mouse_keyboard/);
  assert.match(customerPage, /RoomEvent\.DataReceived/);
  assert.match(customerPage, /onPointerMove/);
  assert.match(observerPage, /RoomEvent\.DataReceived/);
  assert.match(observerPage, /buildRemoteAssistAnnotationPayload/);
  assert.match(observerPage, /drawRemoteAssistAnnotation/);
  assert.match(observerPage, /sendRemoteAssistRealtimeEvent/);
  assert.match(observerPage, /apiPost/);
  assert.match(observerPage, /remote-assist-observer-annotation-layer/);
  assert.match(observerPage, /readRemoteAssistDataEvent/);
});

class FakeRoom {
  failPublish = false;
  packets: Array<{
    data: Uint8Array;
    options?: { reliable?: boolean; topic?: string };
  }> = [];

  localParticipant = {
    publishData: async (data: Uint8Array, options?: { reliable?: boolean; topic?: string }) => {
      if (this.failPublish) throw new Error('publish failed');
      this.packets.push({ data, options });
    }
  };
}

class FakeControlSurface {
  lastPoint: { x: number; y: number } | null = null;
  scrolls: Array<{ left: number; top: number; behavior: 'auto' }> = [];

  constructor(
    readonly width: number,
    readonly height: number,
    private readonly pointTarget: FakeControlElement | null,
    readonly activeElement: FakeControlElement | null
  ) {}

  elementFromPoint(x: number, y: number) {
    this.lastPoint = { x, y };
    return this.pointTarget;
  }

  scrollBy(input: { left: number; top: number; behavior: 'auto' }) {
    this.scrolls.push(input);
  }
}

class FakeControlElement {
  value = '';
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  disabled = false;
  clicks = 0;
  inputEvents = 0;
  textContent = '';

  constructor(readonly tagName: string) {}

  getAttribute(name: string) {
    return name === 'aria-disabled' && this.disabled ? 'true' : null;
  }

  click() {
    this.clicks += 1;
  }

  setRangeText(text: string, start = this.value.length, end = this.value.length) {
    this.value = `${this.value.slice(0, start)}${text}${this.value.slice(end)}`;
    this.selectionStart = start + text.length;
    this.selectionEnd = start + text.length;
  }

  dispatchEvent(event: Event) {
    if (event.type === 'input') this.inputEvents += 1;
    return true;
  }
}

class FakeCanvasContext {
  commands: string[] = [];
  canvas: { width: number; height: number };
  lineCap = '';
  lineJoin = '';
  strokeStyle = '';
  lineWidth = 0;

  constructor(
    width: number,
    height: number
  ) {
    this.canvas = { width, height };
  }

  beginPath() {
    this.commands.push('beginPath');
  }

  moveTo(x: number, y: number) {
    this.commands.push(`moveTo:${x}:${y}`);
  }

  lineTo(x: number, y: number) {
    this.commands.push(`lineTo:${x}:${y}`);
  }

  stroke() {
    this.commands.push('stroke');
  }

  closePath() {
    this.commands.push('closePath');
  }
}
