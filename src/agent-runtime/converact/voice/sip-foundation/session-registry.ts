import { randomUUID } from 'node:crypto';

import {
  backendRuntimeIdentityFromCapabilitySet,
  createBackendCapabilitySet,
  sameRuntimeIdentity,
  validateBackendRuntimeIdentity
} from './capabilities.js';
import { snapshotClosedRecord } from './closed-schema.js';
import {
  bindSipProtocolSession,
  sipProtocolSessionBindingSha256
} from './route-binding.js';
import {
  SipFoundationError,
  type OpenProtocolSessionInput,
  type PreparedProtocolEffect,
  type PrepareProtocolEffectInput,
  type SipFoundationAdapter,
  type SipFoundationBackendSession,
  type PreparedProtocolEffectAuthority,
  type SipProtocolSession,
  type SipProtocolSessionBinding,
  type SipProtocolSessionLease
} from './types.js';

const MAX_PROTOCOL_SESSIONS = 1_000_000;
const MAX_PROTOCOL_ATTEMPTS = 1_000_000;
const SESSION_REGISTRY_INPUT_KEYS = [
  'maximum_sessions',
  'maximum_attempts'
] as const;
const OPEN_SESSION_KEYS = ['protocol_session_id', 'session_binding'] as const;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const SESSION_LEASES = new WeakSet<SipProtocolSessionLease>();
interface BackendSessionRuntime {
  readonly receiver: SipFoundationBackendSession;
  readonly prepare: SipFoundationBackendSession['prepareEffect'];
  readonly verify: SipFoundationBackendSession['verifyPreparedEffect'];
}
const BACKEND_SESSION_RUNTIMES = new WeakMap<
  SipProtocolSession,
  BackendSessionRuntime
>();
const PREPARED_EFFECT_SESSIONS = new WeakMap<
  PreparedProtocolEffect,
  SipProtocolSession
>();

export class SipFoundationSessionRegistry
implements PreparedProtocolEffectAuthority {
  readonly #maximumSessions: number;
  readonly #maximumAttempts: number;
  #activeAttempts = 0;
  readonly #sessions = new Map<string, {
    session: SipProtocolSession;
    lease: RegistrySessionLease;
  }>();

  constructor(input: {
    maximum_sessions: number;
    maximum_attempts: number;
  }) {
    const value = snapshotClosedRecord(
      input,
      SESSION_REGISTRY_INPUT_KEYS,
      inputError
    );
    this.#maximumSessions = boundedInteger(
      value.maximum_sessions,
      1,
      MAX_PROTOCOL_SESSIONS
    );
    this.#maximumAttempts = boundedInteger(
      value.maximum_attempts,
      1,
      MAX_PROTOCOL_ATTEMPTS
    );
    Object.freeze(this);
  }

  get active_session_count(): number {
    return this.#sessions.size;
  }

  get active_attempt_count(): number {
    return this.#activeAttempts;
  }

  openProtocolSession(
    adapter: SipFoundationAdapter,
    input: OpenProtocolSessionInput
  ): SipProtocolSession {
    const identity = validateBackendRuntimeIdentity(adapter.runtime_identity);
    const capabilitySet = createBackendCapabilitySet(
      adapter.capability_set
    );
    if (adapter.backend_id !== identity.backend_id ||
        capabilitySet.backend_id !== adapter.backend_id ||
        !sameRuntimeIdentity(
          identity,
          backendRuntimeIdentityFromCapabilitySet(capabilitySet)
        )) {
      throw new SipFoundationError(
        'sip_foundation_adapter_identity_mismatch'
      );
    }
    const value = snapshotClosedRecord(input, OPEN_SESSION_KEYS, inputError);
    const protocolSessionId = identifier(value.protocol_session_id);
    const requestedBinding = bindSipProtocolSession(
      value.session_binding as SipProtocolSessionBinding
    );
    const existing = this.#sessions.get(protocolSessionId);
    if (existing) {
      if (!sameRuntimeIdentity(
        existing.session.adapter_identity,
        identity
      )) {
        throw new SipFoundationError(
          'sip_foundation_session_identity_conflict'
        );
      }
      if (sipProtocolSessionBindingSha256(
        existing.session.session_binding
      ) !== sipProtocolSessionBindingSha256(requestedBinding)) {
        throw new SipFoundationError(
          'sip_foundation_session_binding_conflict'
        );
      }
      return existing.session;
    }
    if (this.#sessions.size >= this.#maximumSessions) {
      throw new SipFoundationError(
        'sip_foundation_session_capacity_exhausted'
      );
    }

    const lease = new RegistrySessionLease(
      () => {
        if (this.#activeAttempts >= this.#maximumAttempts) {
          throw new SipFoundationError(
            'sip_foundation_session_capacity_exhausted'
          );
        }
        this.#activeAttempts += 1;
      },
      (count) => {
        this.#activeAttempts -= count;
      }
    );
    SESSION_LEASES.add(lease);
    try {
      const candidate = adapter.createProtocolSession(
        {
          protocol_session_id: protocolSessionId,
          session_binding: requestedBinding
        },
        lease
      );
      const runtime = captureBackendRuntime(candidate);
      const session = new RegistryProtocolSession(
        protocolSessionId,
        lease.generation,
        identity,
        requestedBinding
      );
      BACKEND_SESSION_RUNTIMES.set(session, runtime);
      this.#sessions.set(protocolSessionId, {
        session,
        lease
      });
      return session;
    } catch (error) {
      lease.revoke();
      throw error;
    }
  }

  release(session: SipProtocolSession): void {
    const id = identifier(session?.protocol_session_id);
    const existing = this.#sessions.get(id);
    if (!existing) {
      throw new SipFoundationError('sip_foundation_session_not_found');
    }
    if (existing.session !== session) {
      throw new SipFoundationError(
        'sip_foundation_session_binding_conflict'
      );
    }
    existing.lease.revoke();
    BACKEND_SESSION_RUNTIMES.delete(existing.session);
    this.#sessions.delete(id);
  }

  verifyPreparedEffect(prepared: PreparedProtocolEffect): Uint8Array {
    const session = PREPARED_EFFECT_SESSIONS.get(prepared);
    if (!session) {
      throw new SipFoundationError('sip_foundation_wire_invalid');
    }
    return verifyPreparedProtocolEffect(prepared, session);
  }
}

Object.freeze(SipFoundationSessionRegistry.prototype);

export function assertSipFoundationSessionLease(
  lease: SipProtocolSessionLease
): void {
  if (!lease || !SESSION_LEASES.has(lease)) {
    throw inputError();
  }
  lease.assertActive();
}

export function verifyPreparedProtocolEffect(
  prepared: PreparedProtocolEffect,
  session: SipProtocolSession
): Uint8Array {
  const runtime = BACKEND_SESSION_RUNTIMES.get(session);
  if (!runtime) {
    throw new SipFoundationError('sip_foundation_session_closed');
  }
  return Reflect.apply(runtime.verify, runtime.receiver, [prepared]);
}

class RegistryProtocolSession implements SipProtocolSession {
  readonly backend_id;
  readonly adapter_identity;

  constructor(
    readonly protocol_session_id: string,
    readonly protocol_session_generation: string,
    adapterIdentity: SipProtocolSession['adapter_identity'],
    readonly session_binding: SipProtocolSession['session_binding']
  ) {
    this.adapter_identity = validateBackendRuntimeIdentity(adapterIdentity);
    this.backend_id = this.adapter_identity.backend_id;
    Object.freeze(this);
  }

  prepareEffect(input: PrepareProtocolEffectInput): PreparedProtocolEffect {
    const runtime = BACKEND_SESSION_RUNTIMES.get(this);
    if (!runtime) {
      throw new SipFoundationError('sip_foundation_session_closed');
    }
    const prepared = Reflect.apply(runtime.prepare, runtime.receiver, [input]);
    if ((typeof prepared !== 'object' && typeof prepared !== 'function') ||
        prepared === null) {
      throw new SipFoundationError('sip_foundation_wire_invalid');
    }
    Reflect.apply(runtime.verify, runtime.receiver, [prepared]);
    PREPARED_EFFECT_SESSIONS.set(prepared, this);
    return prepared;
  }
}

Object.freeze(RegistryProtocolSession.prototype);

function captureBackendRuntime(
  candidate: SipFoundationBackendSession
): BackendSessionRuntime {
  if ((typeof candidate !== 'object' && typeof candidate !== 'function') ||
      candidate === null ||
      !Object.isFrozen(candidate)) {
    throw new SipFoundationError('sip_foundation_adapter_identity_mismatch');
  }
  return Object.freeze({
    receiver: candidate,
    prepare: captureFrozenMethod(candidate, 'prepareEffect'),
    verify: captureFrozenMethod(candidate, 'verifyPreparedEffect')
  });
}

function captureFrozenMethod<
  Key extends 'prepareEffect' | 'verifyPreparedEffect'
>(
  candidate: SipFoundationBackendSession,
  key: Key
): SipFoundationBackendSession[Key] {
  const own = Object.getOwnPropertyDescriptor(candidate, key);
  if (own) {
    if ('value' in own && typeof own.value === 'function' &&
        own.writable === false && own.configurable === false) {
      return own.value as SipFoundationBackendSession[Key];
    }
    throw new SipFoundationError('sip_foundation_adapter_identity_mismatch');
  }
  const prototype = Object.getPrototypeOf(candidate);
  if (!prototype || !Object.isFrozen(prototype)) {
    throw new SipFoundationError('sip_foundation_adapter_identity_mismatch');
  }
  const inherited = Object.getOwnPropertyDescriptor(prototype, key);
  if (!inherited ||
      !('value' in inherited) ||
      typeof inherited.value !== 'function' ||
      inherited.writable !== false ||
      inherited.configurable !== false) {
    throw new SipFoundationError('sip_foundation_adapter_identity_mismatch');
  }
  return inherited.value as SipFoundationBackendSession[Key];
}

class RegistrySessionLease implements SipProtocolSessionLease {
  readonly generation = randomUUID();
  #active = true;
  #attemptCount = 0;

  constructor(
    private readonly reserveGlobalAttempt: () => void,
    private readonly releaseGlobalAttempts: (count: number) => void
  ) {}

  assertActive(): void {
    if (!this.#active) {
      throw new SipFoundationError('sip_foundation_session_closed');
    }
  }

  reserveAttempt(): void {
    this.assertActive();
    this.reserveGlobalAttempt();
    this.#attemptCount += 1;
  }

  revoke(): void {
    if (!this.#active) return;
    this.#active = false;
    this.releaseGlobalAttempts(this.#attemptCount);
    this.#attemptCount = 0;
  }
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw inputError();
  }
  return value;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) ||
      Number(value) < minimum ||
      Number(value) > maximum) {
    throw inputError();
  }
  return Number(value);
}

function inputError(): SipFoundationError {
  return new SipFoundationError('sip_foundation_input_invalid');
}
