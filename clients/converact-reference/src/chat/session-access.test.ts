import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConveractFabricChatParticipant, ConveractFabricChatSession } from '@converact/sdk';
import { eventRevokesSession, sessionAllowsWrites } from './session-access.js';

test('only active participants in an open session may write', () => {
  assert.equal(sessionAllowsWrites(session('open'), [participant(null)], 'agent-1'), true);
  assert.equal(sessionAllowsWrites(session('closed'), [participant(null)], 'agent-1'), false);
  assert.equal(sessionAllowsWrites(session('open'), [participant('2026-07-11T08:00:00.000Z')], 'agent-1'), false);
  assert.equal(sessionAllowsWrites(session('open'), [participant(null)], 'missing-user'), false);
});

test('session close and current participant leave events revoke access', () => {
  assert.equal(eventRevokesSession({ type: 'collaboration.session.closed', data: {} }, 'agent-1'), true);
  assert.equal(eventRevokesSession({
    type: 'collaboration.participant.left', data: { participant: { identity: 'agent-1' } }
  }, 'agent-1'), true);
  assert.equal(eventRevokesSession({
    type: 'collaboration.participant.left', data: { participant: { identity: 'customer-1' } }
  }, 'agent-1'), false);
});

function session(status: 'open' | 'closed'): ConveractFabricChatSession {
  return { status } as ConveractFabricChatSession;
}

function participant(leftAt: string | null): ConveractFabricChatParticipant {
  return { identity: 'agent-1', left_at: leftAt } as ConveractFabricChatParticipant;
}
