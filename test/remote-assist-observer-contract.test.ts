import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  buildRemoteAssistObserverMediaJoinPath,
  buildRemoteAssistObserverTimelinePath,
  deriveRemoteAssistObserverState,
  filterRemoteAssistObserverEvents,
  fetchRemoteAssistObserverTimelineEvents,
  readRemoteAssistObserverTimelineEvents,
  readRemoteAssistObserverEvent
} from '../frontend/src/pages/remote-assist-observer.js';

test('remote assist observer accepts only matching Web Assist events', () => {
  const event = readRemoteAssistObserverEvent(
    'remote.web_assist.event',
    {
      remote_session_id: 'remote-1',
      actor_identity: 'buyer-1',
      event_type: 'screen.share_started',
      payload: { video: true },
      created_at: '2099-01-01T00:00:00.000Z'
    },
    'remote-1'
  );

  assert.equal(event?.remote_session_id, 'remote-1');
  assert.equal(event?.actor_identity, 'buyer-1');
  assert.equal(event?.event_type, 'screen.share_started');
  assert.deepEqual(event?.payload, { video: true });

  assert.equal(
    readRemoteAssistObserverEvent(
      'remote.web_assist.event',
      {
        remote_session_id: 'remote-2',
        actor_identity: 'buyer-2',
        event_type: 'screen.share_started',
        payload: {},
        created_at: '2099-01-01T00:00:00.000Z'
      },
      'remote-1'
    ),
    null
  );
  assert.equal(readRemoteAssistObserverEvent('call.completed', event, 'remote-1'), null);
  assert.equal(readRemoteAssistObserverEvent('remote.web_assist.event', { event_type: 'pointer.move' }, 'remote-1'), null);
});

test('remote assist observer derives sharing and pointer state from event history', () => {
  const state = deriveRemoteAssistObserverState([
    {
      remote_session_id: 'remote-1',
      actor_identity: 'buyer-1',
      event_type: 'screen.share_started',
      payload: { video: true },
      created_at: '2099-01-01T00:00:00.000Z'
    },
    {
      remote_session_id: 'remote-1',
      actor_identity: 'buyer-1',
      event_type: 'pointer.move',
      payload: { x: 32, y: 48 },
      created_at: '2099-01-01T00:00:01.000Z'
    },
    {
      remote_session_id: 'remote-1',
      actor_identity: 'buyer-1',
      event_type: 'screen.share_stopped',
      payload: {},
      created_at: '2099-01-01T00:00:02.000Z'
    }
  ]);

  assert.equal(state.sharing, false);
  assert.deepEqual(state.pointer, { x: 32, y: 48 });
  assert.equal(state.lastActor, 'buyer-1');
  assert.equal(state.lastEventType, 'screen.share_stopped');
});

test('remote assist observer derives the latest inline control result', () => {
  const state = deriveRemoteAssistObserverState([
    {
      remote_session_id: 'remote-1',
      actor_identity: 'buyer-1',
      event_type: 'control.result',
      payload: { executed: true, action: 'click' },
      created_at: '2099-01-01T00:00:00.000Z'
    },
    {
      remote_session_id: 'remote-1',
      actor_identity: 'buyer-1',
      event_type: 'control.result',
      payload: { executed: false, action: 'text_input', reason: 'no_editable_target' },
      created_at: '2099-01-01T00:00:01.000Z'
    }
  ]);

  assert.deepEqual(state.lastControlResult, {
    executed: false,
    action: 'text_input',
    reason: 'no_editable_target',
    actorIdentity: 'buyer-1',
    createdAt: '2099-01-01T00:00:01.000Z'
  });
});

test('remote assist observer filters inline control history', () => {
  const events = [
    {
      remote_session_id: 'remote-1',
      actor_identity: 'buyer-1',
      event_type: 'screen.share_started',
      payload: {},
      created_at: '2099-01-01T00:00:00.000Z'
    },
    {
      remote_session_id: 'remote-1',
      actor_identity: 'engineer-1',
      event_type: 'control.action',
      payload: { action: 'click' },
      created_at: '2099-01-01T00:00:01.000Z'
    },
    {
      remote_session_id: 'remote-1',
      actor_identity: 'buyer-1',
      event_type: 'control.result',
      payload: { executed: true, action: 'click' },
      created_at: '2099-01-01T00:00:02.000Z'
    },
    {
      remote_session_id: 'remote-1',
      actor_identity: 'engineer-1',
      event_type: 'annotation.draw',
      payload: { phase: 'begin' },
      created_at: '2099-01-01T00:00:03.000Z'
    }
  ];

  assert.deepEqual(
    filterRemoteAssistObserverEvents(events, 'all').map((event) => event.event_type),
    ['screen.share_started', 'control.action', 'control.result', 'annotation.draw']
  );
  assert.deepEqual(
    filterRemoteAssistObserverEvents(events, 'control-actions').map((event) => event.event_type),
    ['control.action']
  );
  assert.deepEqual(
    filterRemoteAssistObserverEvents(events, 'control-results').map((event) => event.event_type),
    ['control.result']
  );
});

test('remote assist observer replays Web Assist events from the HTTP timeline', async () => {
  const timeline = {
    audit_events: [
      {
        remote_session_id: 'remote-1',
        actor_identity: 'buyer-1',
        event_type: 'remote.web_assist.screen.share_started',
        metadata: { web_assist_event_type: 'screen.share_started', payload: { video: true } },
        created_at: '2099-01-01T00:00:00.000Z'
      },
      {
        remote_session_id: 'remote-1',
        actor_identity: 'engineer-1',
        event_type: 'remote.web_assist.control.action',
        metadata: { web_assist_event_type: 'control.action', payload: { action: 'click' } },
        created_at: '2099-01-01T00:00:01.000Z'
      },
      {
        remote_session_id: 'remote-1',
        actor_identity: 'buyer-1',
        event_type: 'remote.consent.granted',
        metadata: { scopes: ['view_screen'] },
        created_at: '2099-01-01T00:00:02.000Z'
      },
      {
        remote_session_id: 'remote-2',
        actor_identity: 'buyer-2',
        event_type: 'remote.web_assist.control.result',
        metadata: { web_assist_event_type: 'control.result', payload: { executed: true } },
        created_at: '2099-01-01T00:00:03.000Z'
      }
    ]
  };

  assert.deepEqual(
    readRemoteAssistObserverTimelineEvents(timeline, 'remote-1').map((event) => event.event_type),
    ['screen.share_started', 'control.action']
  );

  let requestedPath = '';
  const fetched = await fetchRemoteAssistObserverTimelineEvents(
    async (path) => {
      requestedPath = path;
      return timeline;
    },
    { remoteSessionId: 'remote A/B' }
  );

  assert.equal(requestedPath, '/api/collaboration/remote-assistance/remote%20A%2FB/timeline');
  assert.deepEqual(fetched, []);
  assert.equal(
    buildRemoteAssistObserverTimelinePath({ remoteSessionId: 'remote A/B' }),
    '/api/collaboration/remote-assistance/remote%20A%2FB/timeline'
  );
});

test('remote assist observer page is protected and wired to tenant WebSocket events', () => {
  const appSource = readFileSync('frontend/src/App.tsx', 'utf8');
  const sidebarSource = readFileSync('frontend/src/components/Sidebar.tsx', 'utf8');
  const pageSource = readFileSync('frontend/src/pages/RemoteAssistObserverPage.tsx', 'utf8');

  assert.match(appSource, /RemoteAssistObserverPage/);
  assert.match(appSource, /path="\/remote-assist\/observe"/);
  assert.match(sidebarSource, /\/remote-assist\/observe/);
  assert.match(sidebarSource, /远程协助/);
  assert.match(pageSource, /useWebSocket/);
  assert.match(pageSource, /fetchRemoteAssistObserverMediaJoinPlan/);
  assert.match(pageSource, /fetchRemoteAssistObserverTimelineEvents/);
  assert.match(pageSource, /new Room\(\)/);
  assert.match(pageSource, /RoomEvent\.TrackSubscribed/);
  assert.match(pageSource, /Track\.Source\.ScreenShare/);
  assert.match(pageSource, /remote\.web_assist\.event/);
  assert.match(pageSource, /params\.get\('remote_session_id'\)/);
  assert.match(pageSource, /readRemoteAssistObserverEvent/);
  assert.match(pageSource, /deriveRemoteAssistObserverState/);
  assert.match(pageSource, /filterRemoteAssistObserverEvents/);
  assert.match(pageSource, /data-testid="remote-assist-observer-screen"/);
  assert.match(pageSource, /data-testid="remote-assist-observer-pointer"/);
  assert.match(pageSource, /data-testid="remote-assist-control-result"/);
  assert.match(pageSource, /data-testid="remote-assist-event-filter"/);
  assert.match(pageSource, /data-testid="remote-assist-event-filter-control-actions"/);
  assert.match(pageSource, /data-testid="remote-assist-event-filter-control-results"/);
  assert.match(pageSource, /data-testid="remote-assist-observer-events"/);
});

test('remote assist observer exposes engineer control toolbar and audited control actions', () => {
  const pageSource = readFileSync('frontend/src/pages/RemoteAssistObserverPage.tsx', 'utf8');

  assert.match(pageSource, /CONTROL_EVENT_TYPE = 'control\.action'/);
  assert.match(pageSource, /buildRemoteAssistControlClickPayload/);
  assert.match(pageSource, /buildRemoteAssistControlScrollPayload/);
  assert.match(pageSource, /buildRemoteAssistControlTextInputPayload/);
  assert.match(pageSource, /data-testid="remote-assist-annotation-mode"/);
  assert.match(pageSource, /data-testid="remote-assist-control-mode"/);
  assert.match(pageSource, /data-testid="remote-assist-control-text-input"/);
  assert.match(pageSource, /data-testid="remote-assist-control-text-send"/);
  assert.match(pageSource, /onWheel=\{handleControlWheel\}/);
  assert.match(pageSource, /eventType: CONTROL_EVENT_TYPE/);
  assert.match(pageSource, /reliable: true/);
  assert.match(pageSource, /transport_fallback: 'http'/);
  assert.match(pageSource, /control\.result/);
  assert.match(pageSource, /控制结果/);
});

test('remote assist observer media join path is scoped to one remote session', () => {
  const path = buildRemoteAssistObserverMediaJoinPath({
    remoteSessionId: 'remote A/B',
    identity: 'engineer 1'
  });

  const url = new URL(`http://localhost${path}`);
  assert.equal(url.pathname, '/api/collaboration/remote-assistance/remote%20A%2FB/media/join');
  assert.equal(url.searchParams.get('identity'), 'engineer 1');
});
