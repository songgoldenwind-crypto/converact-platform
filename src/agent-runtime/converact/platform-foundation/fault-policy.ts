export type PlatformFaultDependency =
  | 'database'
  | 'event_system'
  | 'object_store'
  | 'pki_kms'
  | 'dns'
  | 'configuration'
  | 'wall_clock'
  | 'ai_gpu'
  | 'recording_upload'
  | 'provider'
  | 'observability'
  | 'node_crash';

interface FaultPolicyDefinition {
  failure_modes: readonly string[];
  established_human_media: string;
  new_work: string;
  optional_attachment: string;
  recovery: string;
}

const POLICIES: Readonly<Record<PlatformFaultDependency, FaultPolicyDefinition>> = Object.freeze({
  database: policy(
    ['timeout', 'partition', 'pool_exhaustion', 'restart'],
    'continue', 'reject_durable_new_work', 'degrade_or_bounded_spool', 'reconnect_query_reconcile'
  ),
  event_system: policy(
    ['timeout', 'partition', 'duplicate', 'reorder'],
    'continue', 'commit_domain_state_and_bound_outbox_or_reject', 'degrade',
    'replay_inbox_query_reconcile'
  ),
  object_store: policy(
    ['timeout', 'partition', 'partial_write', 'stale_read'],
    'continue', 'reject_object_required_work', 'bounded_spool_or_detach', 'checksum_query_reconcile'
  ),
  pki_kms: policy(
    ['timeout', 'partition', 'revoked_key', 'expired_cert'],
    'continue', 'reject_new_secure_session_or_effect', 'detach_at_lease_expiry',
    'rotate_reauthorize_no_plaintext_downgrade'
  ),
  dns: policy(
    ['timeout', 'nxdomain', 'stale_answer', 'poisoned_answer'],
    'continue', 'reject_or_use_unexpired_signed_snapshot', 'keep_pinned_generation',
    'new_generation_after_resolution'
  ),
  configuration: policy(
    ['missing', 'invalid', 'stale', 'conflicting_revision'],
    'continue', 'reject_new_admission', 'keep_pinned_generation',
    'load_signed_revision_then_reconcile'
  ),
  wall_clock: policy(
    ['backward_jump', 'forward_jump', 'cross_node_skew', 'quality_unknown'],
    'continue', 'reject_new_lease_when_skew_exceeds_policy', 'monotonic_deadline_continues',
    'resync_then_reissue_lease'
  ),
  ai_gpu: policy(
    ['timeout', 'oom', 'process_crash', 'capacity_exhaustion'],
    'continue', 'defer_or_reject_ai_work', 'detach_ai_keep_human_media', 'fenced_worker_restart'
  ),
  recording_upload: policy(
    ['timeout', 'partition', 'checksum_mismatch', 'capacity_exhaustion'],
    'continue', 'reject_or_degrade_new_recording', 'bounded_capture_spool_or_detach',
    'owner_epoch_checksum_reconcile'
  ),
  provider: policy(
    ['timeout', 'duplicate', 'reorder', 'unknown_effect'],
    'continue', 'reject_or_mark_unknown', 'degrade_provider_feature', 'query_reconcile_compensate'
  ),
  observability: policy(
    ['collector_down', 'exporter_timeout', 'queue_full'],
    'continue', 'continue', 'drop_bounded_telemetry', 'resume_without_unbounded_replay'
  ),
  node_crash: policy(
    ['process_abort', 'oom', 'host_loss'],
    'continue_if_external_edge_owner', 'reroute_new_admission', 'interrupt_only_process_owned_edges',
    'owner_epoch_takeover_and_reconcile'
  )
});
const ORDINARY_MEDIA_DEPENDENCIES = Object.freeze([]) as readonly [];

export function platformFaultPolicy(input: {
  dependency: PlatformFaultDependency;
  failure_mode: string;
}): Readonly<{
  dependency: PlatformFaultDependency;
  failure_mode: string;
  established_human_media: string;
  new_work: string;
  optional_attachment: string;
  recovery: string;
  hot_path_dependency: false;
  sends_call_termination: false;
}> {
  const definition = Object.prototype.hasOwnProperty.call(POLICIES, input?.dependency)
    ? POLICIES[input.dependency]
    : null;
  if (!definition || typeof input.failure_mode !== 'string'
    || !definition.failure_modes.includes(input.failure_mode)) throw new Error('platform_fault_unknown');
  return Object.freeze({
    dependency: input.dependency,
    failure_mode: input.failure_mode,
    established_human_media: definition.established_human_media,
    new_work: definition.new_work,
    optional_attachment: definition.optional_attachment,
    recovery: definition.recovery,
    hot_path_dependency: false,
    sends_call_termination: false
  });
}

export function ordinaryMediaPlatformDependencies(): readonly [] {
  return ORDINARY_MEDIA_DEPENDENCIES;
}

function policy(
  failureModes: readonly string[],
  establishedHumanMedia: string,
  newWork: string,
  optionalAttachment: string,
  recovery: string
): FaultPolicyDefinition {
  return Object.freeze({
    failure_modes: Object.freeze([...failureModes]),
    established_human_media: establishedHumanMedia,
    new_work: newWork,
    optional_attachment: optionalAttachment,
    recovery
  });
}
