import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canAcceptVoiceWork,
  estimateQueueWaitSeconds,
  rankContactCenterAgents,
  transitionAssignment,
  transitionPresence,
  transitionQueueEntry,
  transitionSupervisorSession,
  type ContactCenterRoutingCandidate
} from '../src/agent-runtime/converact/contact-center/index.js';

test('Contact Center queue entries follow the durable lifecycle', () => {
  assert.equal(transitionQueueEntry('waiting', 'offer'), 'offered');
  assert.equal(transitionQueueEntry('offered', 'reject'), 'waiting');
  assert.equal(transitionQueueEntry('offered', 'accept'), 'assigned');
  assert.equal(transitionQueueEntry('assigned', 'answer'), 'answered');
  assert.equal(transitionQueueEntry('answered', 'complete'), 'completed');
  assert.equal(transitionQueueEntry('waiting', 'request_callback'), 'callback_requested');
  assert.throws(() => transitionQueueEntry('completed', 'offer'), /invalid_queue_entry_transition/);
  assert.throws(() => transitionQueueEntry('waiting', 'answer'), /invalid_queue_entry_transition/);
});

test('Contact Center assignment and supervisor states reject invalid jumps', () => {
  assert.equal(transitionAssignment('offered', 'accept'), 'accepted');
  assert.equal(transitionAssignment('accepted', 'connect'), 'connected');
  assert.equal(transitionAssignment('connected', 'complete'), 'completed');
  assert.equal(transitionAssignment('offered', 'expire'), 'expired');
  assert.throws(() => transitionAssignment('expired', 'connect'), /invalid_assignment_transition/);

  assert.equal(transitionSupervisorSession('requested', 'authorize'), 'active');
  assert.equal(transitionSupervisorSession('requested', 'deny'), 'denied');
  assert.equal(transitionSupervisorSession('active', 'end'), 'ended');
  assert.throws(() => transitionSupervisorSession('denied', 'authorize'), /invalid_supervisor_transition/);
});

test('Contact Center presence enforces voice capacity before assignment', () => {
  assert.equal(transitionPresence('offline', 'available'), 'available');
  assert.equal(transitionPresence('available', 'reserve'), 'busy');
  assert.equal(transitionPresence('busy', 'release'), 'available');
  assert.equal(transitionPresence('busy', 'wrap_up'), 'after_call');
  assert.equal(transitionPresence('after_call', 'available'), 'available');
  assert.equal(canAcceptVoiceWork({ state: 'available', active_voice_count: 0, voice_capacity: 1 }), true);
  assert.equal(canAcceptVoiceWork({ state: 'available', active_voice_count: 1, voice_capacity: 1 }), false);
  assert.equal(canAcceptVoiceWork({ state: 'busy', active_voice_count: 1, voice_capacity: 2 }), true);
  assert.equal(canAcceptVoiceWork({ state: 'away', active_voice_count: 0, voice_capacity: 2 }), false);
  assert.throws(() => transitionPresence('offline', 'reserve'), /invalid_presence_transition/);
});

test('Contact Center routing strategies are deterministic and capacity aware', () => {
  const candidates: ContactCenterRoutingCandidate[] = [
    candidate('agent-a', { idle_since: '2026-07-13T00:00:10.000Z', handled_count: 4, member_priority: 1, skills: { sales: 90 } }),
    candidate('agent-b', { idle_since: '2026-07-13T00:00:00.000Z', handled_count: 8, member_priority: 3, skills: { sales: 70 } }),
    candidate('agent-c', { idle_since: '2026-07-13T00:00:05.000Z', handled_count: 1, member_priority: 2, skills: { sales: 95 }, active_voice_count: 1 })
  ];

  assert.deepEqual(rankContactCenterAgents(candidates, { strategy: 'longest_idle', required_skills: { sales: 60 } }).map(id), ['agent-b', 'agent-a']);
  assert.deepEqual(rankContactCenterAgents(candidates, { strategy: 'least_calls', required_skills: { sales: 60 } }).map(id), ['agent-a', 'agent-b']);
  assert.deepEqual(rankContactCenterAgents(candidates, { strategy: 'skill_priority', required_skills: { sales: 60 } }).map(id), ['agent-b', 'agent-a']);
  assert.deepEqual(rankContactCenterAgents(candidates, { strategy: 'round_robin', required_skills: { sales: 60 }, round_robin_after: 'agent-a' }).map(id), ['agent-b', 'agent-a']);
  assert.deepEqual(rankContactCenterAgents(candidates, { strategy: 'longest_idle', required_skills: { support: 1 } }), []);
});

test('Contact Center wait estimate is bounded and scales with available capacity', () => {
  assert.equal(estimateQueueWaitSeconds({ position: 1, average_handle_seconds: 180, available_agents: 2 }), 90);
  assert.equal(estimateQueueWaitSeconds({ position: 5, average_handle_seconds: 180, available_agents: 2 }), 450);
  assert.equal(estimateQueueWaitSeconds({ position: 2, average_handle_seconds: 0, available_agents: 0 }), 120);
  assert.throws(() => estimateQueueWaitSeconds({ position: 0, average_handle_seconds: 60, available_agents: 1 }), /position/);
});

function candidate(
  agent_id: string,
  patch: Partial<ContactCenterRoutingCandidate> = {}
): ContactCenterRoutingCandidate {
  return {
    agent_id,
    presence_state: 'available',
    active_voice_count: 0,
    voice_capacity: 1,
    idle_since: '2026-07-13T00:00:00.000Z',
    handled_count: 0,
    member_priority: 1,
    skills: {},
    ...patch
  };
}

function id(value: ContactCenterRoutingCandidate): string {
  return value.agent_id;
}
