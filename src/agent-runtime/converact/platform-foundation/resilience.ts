declare const admissionLeaseBrand: unique symbol;

export interface AdmissionLease {
  readonly [admissionLeaseBrand]: true;
}

type AdmissionKind = 'active' | 'pending';

interface LeaseState {
  kind: AdmissionKind;
  generation: number;
}

class OpaqueAdmissionLease {}

const MAX_ADMISSION_LIMIT = 1_000_000;

export interface BoundedWorkLimits {
  active: number;
  pending: number;
  retry: number;
  fanout: number;
}

export type BoundedWorkRejection = 'overloaded' | 'retry_exhausted' | 'fanout_exceeded';

export class BoundedAdmissionGate {
  readonly #limits: Readonly<Record<AdmissionKind, number>>;
  readonly #leases = new WeakMap<object, LeaseState>();
  #active = 0;
  #pending = 0;
  #nextGeneration = 1;

  constructor(limits: { active: number; pending: number }) {
    if (!plainRecord(limits) || Object.keys(limits).length !== 2
      || !boundedLimit(limits.active) || !boundedLimit(limits.pending)) {
      throw new Error('admission_limits_invalid');
    }
    this.#limits = Object.freeze({ active: limits.active, pending: limits.pending });
  }

  tryAcquire(kind: AdmissionKind):
    { accepted: true; lease: AdmissionLease } | { accepted: false; reason: 'overloaded' } {
    if (kind !== 'active' && kind !== 'pending') throw new Error('admission_kind_invalid');
    const current = kind === 'active' ? this.#active : this.#pending;
    if (current >= this.#limits[kind]) return Object.freeze({ accepted: false, reason: 'overloaded' });
    if (!Number.isSafeInteger(current + 1) || !Number.isSafeInteger(this.#nextGeneration)
      || this.#nextGeneration >= Number.MAX_SAFE_INTEGER) {
      throw new Error('admission_counter_overflow');
    }
    const token = Object.freeze(new OpaqueAdmissionLease());
    this.#leases.set(token, { kind, generation: this.#nextGeneration });
    this.#nextGeneration += 1;
    if (kind === 'active') this.#active += 1;
    else this.#pending += 1;
    return Object.freeze({ accepted: true, lease: token as AdmissionLease });
  }

  release(lease: AdmissionLease): void {
    if (!lease || typeof lease !== 'object') throw new Error('admission_lease_invalid');
    const state = this.#leases.get(lease as object);
    if (!state || !Number.isSafeInteger(state.generation)) throw new Error('admission_lease_invalid');
    this.#leases.delete(lease as object);
    if (state.kind === 'active') {
      if (this.#active < 1) throw new Error('admission_counter_invalid');
      this.#active -= 1;
    } else {
      if (this.#pending < 1) throw new Error('admission_counter_invalid');
      this.#pending -= 1;
    }
  }

  snapshot(): Readonly<{ active: number; pending: number }> {
    return Object.freeze({ active: this.#active, pending: this.#pending });
  }
}

export class BoundedWorkGate {
  readonly #admission: BoundedAdmissionGate;
  readonly #limits: Readonly<BoundedWorkLimits>;

  constructor(limits: BoundedWorkLimits) {
    if (!plainRecord(limits) || Object.keys(limits).length !== 4
      || !boundedLimit(limits.active) || !boundedLimit(limits.pending)
      || !nonNegativeLimit(limits.retry) || !positiveLimit(limits.fanout)) {
      throw new Error('work_limits_invalid');
    }
    this.#limits = Object.freeze({ ...limits });
    this.#admission = new BoundedAdmissionGate({
      active: limits.active,
      pending: limits.pending
    });
  }

  tryAcquire(input: { kind: AdmissionKind; retry: number; fanout: number }):
    { accepted: true; lease: AdmissionLease }
    | { accepted: false; reason: BoundedWorkRejection } {
    if (!plainRecord(input) || Object.keys(input).length !== 3
      || (input.kind !== 'active' && input.kind !== 'pending')
      || !nonNegativeLimit(input.retry) || !nonNegativeLimit(input.fanout)) {
      throw new Error('work_request_invalid');
    }
    if (input.retry > this.#limits.retry) {
      return Object.freeze({ accepted: false, reason: 'retry_exhausted' });
    }
    if (input.fanout > this.#limits.fanout) {
      return Object.freeze({ accepted: false, reason: 'fanout_exceeded' });
    }
    return this.#admission.tryAcquire(input.kind);
  }

  release(lease: AdmissionLease): void {
    this.#admission.release(lease);
  }

  snapshot(): Readonly<{
    active: number;
    pending: number;
    active_limit: number;
    pending_limit: number;
    retry_limit: number;
    fanout_limit: number;
  }> {
    const current = this.#admission.snapshot();
    return Object.freeze({
      active: current.active,
      pending: current.pending,
      active_limit: this.#limits.active,
      pending_limit: this.#limits.pending,
      retry_limit: this.#limits.retry,
      fanout_limit: this.#limits.fanout
    });
  }
}

function boundedLimit(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_ADMISSION_LIMIT;
}

function nonNegativeLimit(value: unknown): value is number {
  return boundedLimit(value);
}

function positiveLimit(value: unknown): value is number {
  return boundedLimit(value) && Number(value) > 0;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
