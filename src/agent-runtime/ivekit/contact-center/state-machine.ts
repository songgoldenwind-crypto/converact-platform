import { ContactCenterError } from './errors.js';
import type {
  ContactCenterAssignmentState,
  ContactCenterPresenceState,
  ContactCenterQueueEntryState,
  ContactCenterSupervisorSessionState
} from './types.js';

export type ContactCenterQueueEntryEvent =
  | 'offer'
  | 'reject'
  | 'expire'
  | 'accept'
  | 'answer'
  | 'complete'
  | 'abandon'
  | 'timeout'
  | 'cancel'
  | 'overflow'
  | 'request_callback';
export type ContactCenterAssignmentEvent = 'accept' | 'connect' | 'reject' | 'expire' | 'revoke' | 'complete' | 'fail';
export type ContactCenterPresenceEvent = 'available' | 'reserve' | 'release' | 'wrap_up' | 'away' | 'offline';
export type ContactCenterSupervisorEvent = 'authorize' | 'deny' | 'end' | 'fail';

const QUEUE_ENTRY_TRANSITIONS: Record<ContactCenterQueueEntryState, Partial<Record<ContactCenterQueueEntryEvent, ContactCenterQueueEntryState>>> = {
  waiting: {
    offer: 'offered', abandon: 'abandoned', timeout: 'timed_out', cancel: 'cancelled',
    overflow: 'overflowed', request_callback: 'callback_requested'
  },
  offered: {
    accept: 'assigned', reject: 'waiting', expire: 'waiting', abandon: 'abandoned',
    timeout: 'timed_out', cancel: 'cancelled', request_callback: 'callback_requested'
  },
  assigned: { answer: 'answered', abandon: 'abandoned', timeout: 'timed_out', cancel: 'cancelled' },
  answered: { complete: 'completed' },
  completed: {},
  abandoned: {},
  timed_out: {},
  cancelled: {},
  overflowed: {},
  callback_requested: {}
};

const ASSIGNMENT_TRANSITIONS: Record<ContactCenterAssignmentState, Partial<Record<ContactCenterAssignmentEvent, ContactCenterAssignmentState>>> = {
  offered: { accept: 'accepted', reject: 'rejected', expire: 'expired', revoke: 'revoked', fail: 'failed' },
  accepted: { connect: 'connected', revoke: 'revoked', fail: 'failed' },
  connected: { complete: 'completed', revoke: 'revoked', fail: 'failed' },
  rejected: {},
  expired: {},
  revoked: {},
  completed: {},
  failed: {}
};

const PRESENCE_TRANSITIONS: Record<ContactCenterPresenceState, Partial<Record<ContactCenterPresenceEvent, ContactCenterPresenceState>>> = {
  offline: { available: 'available', away: 'away' },
  available: { reserve: 'busy', away: 'away', offline: 'offline' },
  busy: { reserve: 'busy', release: 'available', wrap_up: 'after_call', offline: 'offline' },
  after_call: { available: 'available', away: 'away', offline: 'offline' },
  away: { available: 'available', offline: 'offline' }
};

const SUPERVISOR_TRANSITIONS: Record<ContactCenterSupervisorSessionState, Partial<Record<ContactCenterSupervisorEvent, ContactCenterSupervisorSessionState>>> = {
  requested: { authorize: 'active', deny: 'denied', fail: 'failed' },
  active: { end: 'ended', fail: 'failed' },
  denied: {},
  ended: {},
  failed: {}
};

export function transitionQueueEntry(
  state: ContactCenterQueueEntryState,
  event: ContactCenterQueueEntryEvent
): ContactCenterQueueEntryState {
  return transition(QUEUE_ENTRY_TRANSITIONS, state, event, 'invalid_queue_entry_transition');
}

export function transitionAssignment(
  state: ContactCenterAssignmentState,
  event: ContactCenterAssignmentEvent
): ContactCenterAssignmentState {
  return transition(ASSIGNMENT_TRANSITIONS, state, event, 'invalid_assignment_transition');
}

export function transitionPresence(
  state: ContactCenterPresenceState,
  event: ContactCenterPresenceEvent
): ContactCenterPresenceState {
  return transition(PRESENCE_TRANSITIONS, state, event, 'invalid_presence_transition');
}

export function transitionSupervisorSession(
  state: ContactCenterSupervisorSessionState,
  event: ContactCenterSupervisorEvent
): ContactCenterSupervisorSessionState {
  return transition(SUPERVISOR_TRANSITIONS, state, event, 'invalid_supervisor_transition');
}

export function canAcceptVoiceWork(input: {
  state: ContactCenterPresenceState;
  active_voice_count: number;
  voice_capacity: number;
}): boolean {
  return (input.state === 'available' || input.state === 'busy') && Number.isInteger(input.active_voice_count) &&
    Number.isInteger(input.voice_capacity) && input.active_voice_count >= 0 &&
    input.voice_capacity > 0 && input.active_voice_count < input.voice_capacity;
}

function transition<
  State extends string,
  Event extends string
>(
  table: Record<State, Partial<Record<Event, State>>>,
  state: State,
  event: Event,
  code: ContactCenterError['code']
): State {
  const next = table[state]?.[event];
  if (!next) {
    throw new ContactCenterError({ code, details: { state, event } });
  }
  return next;
}
