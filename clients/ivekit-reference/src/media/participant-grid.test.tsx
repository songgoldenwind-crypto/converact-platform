import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { cleanup, render } from '@testing-library/react';

import type { IveKitMediaCallParticipant } from '@opc/ivekit-sdk';
import { installTestDom } from '../test-dom.js';
import { initialMediaCallState, mediaCallReducer } from './media-reducer.js';
import { ParticipantGrid } from './participant-grid.js';
import type { MediaTrackHandle, MediaTrackSource } from './types.js';

let closeDom: () => void;
before(() => { closeDom = installTestDom(); });
after(() => { cleanup(); closeDom?.(); });
afterEach(() => cleanup());

test('grid renders one to nine stable participant tiles and orders the active speaker first', () => {
  const participants = Array.from({ length: 9 }, (_, index) => participant(`user-${index + 1}`));
  const view = render(<ParticipantGrid participants={participants} tracks={{}} activeSpeakerIdentities={['user-9']} networkQuality={{}} layout="grid" />);
  const tiles = [...view.container.querySelectorAll('[data-participant]')];
  assert.equal(tiles.length, 9);
  assert.equal((tiles[0] as HTMLElement).dataset.participant, 'user-9');
  assert.equal(view.container.querySelector('.participant-grid')?.getAttribute('data-count'), '9');
});

test('camera-off tile shows avatar, speaking state, mute state, and network quality', () => {
  const view = render(<ParticipantGrid
    participants={[participant('customer-1')]}
    tracks={{}}
    activeSpeakerIdentities={['customer-1']}
    networkQuality={{ 'customer-1': 'poor' }}
    layout="grid"
  />);
  const tile = view.container.querySelector('[data-participant="customer-1"]') as HTMLElement;
  assert.equal(tile.dataset.speaking, 'true');
  assert.ok(view.getByLabelText('Customer 1 camera off'));
  assert.ok(view.getByTitle('Microphone muted'));
  assert.ok(view.getByTitle('Network quality: poor'));
});

test('screen share owns the main stage while participant camera remains in the rail', () => {
  const camera = track('TR_CAMERA', 'customer-1', 'camera', 'video');
  const share = track('TR_SHARE', 'customer-1', 'screen_share', 'video');
  const shareAudio = track('TR_SHARE_AUDIO', 'customer-1', 'screen_share_audio', 'audio');
  const view = render(<ParticipantGrid
    participants={[participant('customer-1'), participant('agent-1')]}
    tracks={{ TR_CAMERA: camera.handle, TR_SHARE: share.handle, TR_SHARE_AUDIO: shareAudio.handle }}
    activeSpeakerIdentities={[]}
    networkQuality={{}}
    layout="grid"
  />);
  assert.ok(view.getByLabelText('Screen shared by customer-1'));
  assert.ok(view.container.querySelector('.screen-share-rail [data-participant="customer-1"]'));
  assert.equal(share.attachCalls, 1);
  assert.equal(shareAudio.attachCalls, 1);
  view.unmount();
  assert.equal(share.detachCalls, 1);
  assert.equal(shareAudio.detachCalls, 1);
});

test('speaker layout keeps one focus tile and a participant rail', () => {
  const view = render(<ParticipantGrid
    participants={[participant('agent-1'), participant('customer-1'), participant('observer-1')]}
    tracks={{}}
    activeSpeakerIdentities={['customer-1']}
    networkQuality={{}}
    layout="speaker"
  />);
  assert.equal(view.container.querySelector('.speaker-stage [data-participant]')?.getAttribute('data-participant'), 'customer-1');
  assert.equal(view.container.querySelectorAll('.speaker-rail [data-participant]').length, 2);
});

test('duplicate subscription stays singular and participant leave removes all of its tracks', () => {
  const camera = track('TR_DUP', 'customer-1', 'camera', 'video').handle;
  let state = initialMediaCallState();
  state = mediaCallReducer(state, { type: 'adapter_event', generation: 1, event: { type: 'track_subscribed', generation: 1, track: camera } });
  state = mediaCallReducer(state, { type: 'adapter_event', generation: 1, event: { type: 'track_subscribed', generation: 1, track: camera } });
  assert.equal(Object.keys(state.tracks).length, 1);
  state = mediaCallReducer(state, { type: 'adapter_event', generation: 1, event: { type: 'participant_joined', generation: 1, identity: 'customer-1', display_name: 'Customer' } });
  state = mediaCallReducer(state, { type: 'adapter_event', generation: 1, event: { type: 'participant_left', generation: 1, identity: 'customer-1' } });
  assert.equal(Object.keys(state.tracks).length, 0);
});

function participant(identity: string): IveKitMediaCallParticipant {
  return {
    id: identity, tenant_id: 'tenant-1', call_id: 'call-1', identity, role: 'participant', status: 'joined',
    display_name: identity.replace('-', ' ').replace(/\b\w/g, (value) => value.toUpperCase()), metadata: {},
    invited_at: '2026-07-11T10:00:00.000Z', accepted_at: '2026-07-11T10:00:01.000Z',
    joined_at: '2026-07-11T10:00:02.000Z', left_at: null, updated_at: '2026-07-11T10:00:02.000Z'
  };
}

function track(id: string, identity: string, source: MediaTrackSource, kind: 'audio' | 'video') {
  const result = {
    attachCalls: 0,
    detachCalls: 0,
    handle: null as unknown as MediaTrackHandle
  };
  result.handle = Object.freeze({
    id, participantIdentity: identity, source, kind, muted: false,
    attach: (element: HTMLMediaElement) => { result.attachCalls += 1; return element; },
    detach: () => { result.detachCalls += 1; }
  });
  return result;
}
