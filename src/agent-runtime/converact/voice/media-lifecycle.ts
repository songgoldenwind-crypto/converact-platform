export const RUSTPBX_MEDIA_LIFECYCLE_STATES = [
  'unallocated',
  'preparing',
  'prepared',
  'early',
  'committed',
  'updating',
  'deleting',
  'cancelling',
  'uncertain',
  'reconciling',
  'closed',
  'expired'
] as const;

export type RustPbxMediaLifecycleState =
  typeof RUSTPBX_MEDIA_LIFECYCLE_STATES[number];

export const RUSTPBX_MEDIA_LIFECYCLE_EVENTS = [
  'prepare',
  'prepare_committed',
  'early_update',
  'early_committed',
  'answer_update',
  'answer_committed',
  'update',
  'update_committed',
  'delete',
  'cancel',
  'delete_committed',
  'command_unknown',
  'reconcile',
  'reconciled_prepared',
  'reconciled_early',
  'reconciled_committed',
  'reconciled_closed',
  'reconciled_expired',
  'lease_expired'
] as const;

export type RustPbxMediaLifecycleEvent =
  typeof RUSTPBX_MEDIA_LIFECYCLE_EVENTS[number];

const TRANSITIONS: Readonly<
  Partial<Record<
    RustPbxMediaLifecycleState,
    Partial<Record<RustPbxMediaLifecycleEvent, RustPbxMediaLifecycleState>>
  >>
> = Object.freeze({
  unallocated: Object.freeze({
    prepare: 'preparing'
  }),
  preparing: Object.freeze({
    prepare_committed: 'prepared',
    command_unknown: 'uncertain'
  }),
  prepared: Object.freeze({
    early_update: 'updating',
    answer_update: 'updating',
    cancel: 'cancelling',
    delete: 'deleting',
    lease_expired: 'expired'
  }),
  early: Object.freeze({
    early_update: 'updating',
    answer_update: 'updating',
    cancel: 'cancelling',
    delete: 'deleting',
    lease_expired: 'expired'
  }),
  committed: Object.freeze({
    update: 'updating',
    delete: 'deleting',
    lease_expired: 'expired'
  }),
  updating: Object.freeze({
    early_committed: 'early',
    answer_committed: 'committed',
    update_committed: 'committed',
    command_unknown: 'uncertain'
  }),
  deleting: Object.freeze({
    delete_committed: 'closed',
    command_unknown: 'uncertain'
  }),
  cancelling: Object.freeze({
    delete_committed: 'closed',
    command_unknown: 'uncertain'
  }),
  uncertain: Object.freeze({
    reconcile: 'reconciling'
  }),
  reconciling: Object.freeze({
    reconciled_prepared: 'prepared',
    reconciled_early: 'early',
    reconciled_committed: 'committed',
    reconciled_closed: 'closed',
    reconciled_expired: 'expired',
    command_unknown: 'uncertain'
  })
});

export function transitionRustPbxMediaLifecycle(
  state: RustPbxMediaLifecycleState,
  event: RustPbxMediaLifecycleEvent
): RustPbxMediaLifecycleState {
  const next = TRANSITIONS[state]?.[event];
  if (!next) {
    throw new Error(
      `media_lifecycle_transition_invalid:${state}:${event}`
    );
  }
  return next;
}
