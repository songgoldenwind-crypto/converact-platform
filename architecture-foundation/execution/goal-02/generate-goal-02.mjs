import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const goalDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = realpathSync(resolve(goalDirectory, '../../..'));
const generatedAt = '2026-08-01T00:00:00Z';
const goalPath = 'goals/goal-02-platform-foundation-security-observability.md';
const goalSha = '742e194e6b2d3e2b6fe9390bbabe96a6bbe0f40bdf99d8ed4ae4060a711a87f9';

const sourceMaps = {
  identity: {
    patterns: /(?:tenant|identity|auth|rbac|rls|token|session|mtls|tls|certificate|subject)/iu,
    implementation_paths: [
      'src/agent-runtime/converact/platform-foundation/identity.ts',
      'src/middleware/auth.ts',
      'src/db-pg-tenant.ts',
      'src/migrations/108_converact_platform_identity_consent.sql',
    ],
    test_paths: [
      'test/converact-platform-identity-isolation.test.ts',
      'test/converact-platform-foundation-migration.test.ts',
    ],
  },
  consent: {
    patterns: /(?:consent|purpose|retention|legal.?hold|deletion|region|recording|transcript|translation)/iu,
    implementation_paths: [
      'src/agent-runtime/converact/platform-foundation/policy.ts',
      'src/migrations/108_converact_platform_identity_consent.sql',
    ],
    test_paths: [
      'test/converact-platform-consent-policy.test.ts',
      'test/converact-platform-foundation-migration.test.ts',
    ],
  },
  events: {
    patterns: /(?:event|outbox|inbox|webhook|replay|schema|version|ordering|nats|jetstream)/iu,
    implementation_paths: [
      'src/agent-runtime/converact/platform-foundation/event-envelope.ts',
      'src/agent-runtime/converact/platform-foundation/postgres-event-receipt-store.ts',
      'src/migrations/109_converact_platform_event_receipts.sql',
    ],
    test_paths: [
      'test/converact-platform-event-compatibility.test.ts',
      'test/converact-platform-event-receipt-postgres.test.ts',
      'test/converact-platform-foundation-migration.test.ts',
    ],
  },
  audit_receipts: {
    patterns: /(?:audit|effect|receipt|action|reconcile|idempotenc)/iu,
    implementation_paths: [
      'src/agent-runtime/converact/platform-foundation/effect-receipt.ts',
      'src/agent-runtime/converact/platform-foundation/postgres-event-receipt-store.ts',
      'src/migrations/109_converact_platform_event_receipts.sql',
    ],
    test_paths: [
      'test/converact-platform-audit-effect.test.ts',
      'test/converact-platform-event-receipt-postgres.test.ts',
      'test/converact-platform-foundation-migration.test.ts',
    ],
  },
  billing: {
    patterns: /(?:billing|meter|usage|quota|cdr|charge|cost)/iu,
    implementation_paths: [
      'src/agent-runtime/converact/platform-foundation/billing-ledger.ts',
      'src/agent-runtime/converact/platform-foundation/postgres-billing-ledger-store.ts',
      'src/migrations/110_converact_platform_usage_ledger.sql',
      'src/migrations/112_converact_platform_history_receipt_integrity.sql',
    ],
    test_paths: [
      'test/converact-platform-billing-ledger.test.ts',
      'test/converact-platform-billing-postgres.test.ts',
      'test/converact-platform-foundation-migration.test.ts',
    ],
  },
  key_lifecycle: {
    patterns: /(?:secret|key|kms|pki|cert|credential|core.?dump|unsafe|ffi|native|supply)/iu,
    implementation_paths: [
      'src/agent-runtime/converact/platform-foundation/key-lifecycle.ts',
      'src/migrations/111_converact_platform_key_lifecycle.sql',
    ],
    test_paths: [
      'test/converact-platform-key-rotation.test.ts',
      'test/converact-platform-foundation-migration.test.ts',
    ],
  },
  observability: {
    patterns: /(?:observab|telemetry|trace|metric|prometheus|otel|victoria|log|correlat)/iu,
    implementation_paths: [
      'src/agent-runtime/converact/platform-foundation/correlation.ts',
      'src/telemetry.ts',
      'src/metrics.ts',
    ],
    test_paths: ['test/converact-platform-observability-correlation.test.ts'],
  },
  clock: {
    patterns: /(?:clock|time|deadline|ttl|skew|jump|monotonic)/iu,
    implementation_paths: ['src/agent-runtime/converact/platform-foundation/clock.ts'],
    test_paths: ['test/converact-platform-clock.test.ts'],
  },
  resilience: {
    patterns: /(?:worker|queue|retry|bulkhead|circuit|backpressure|capacity|health|ready|drain|deploy|backup|restore|recovery|rto|rpo)/iu,
    implementation_paths: [
      'src/agent-runtime/converact/platform-foundation/resilience.ts',
      'src/agent-runtime/converact/operations/readiness.ts',
    ],
    test_paths: ['test/converact-platform-resilience.test.ts'],
  },
  fault_matrix: {
    patterns: /(?:fault|failure|crash|partition|dns|object.?store|gpu|provider|long.?run|media)/iu,
    implementation_paths: ['src/agent-runtime/converact/platform-foundation/fault-policy.ts'],
    test_paths: ['test/converact-platform-fault-matrix-contract.test.ts'],
  },
  legacy_assessment: {
    patterns: /.*/u,
    implementation_paths: ['architecture-foundation/execution/goal-02/source-test-path-map.md'],
    test_paths: ['architecture-foundation/execution/goal-02/goal-02-contract.test.mjs'],
  },
};

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(name, value) {
  writeFileSync(join(goalDirectory, name), `${JSON.stringify(value, null, 2)}\n`);
}

function assertBinding() {
  const actual = sha256File(join(repositoryRoot, goalPath));
  if (actual !== goalSha) throw new Error(`G02 binding SHA drifted: ${actual}`);
  for (const commit of [
    'c10a3a2c636fa0f62f8108a113a729138e367929',
    '051ad988edcc204fbd716f6ea73ce92ec08ab4b2',
  ]) {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], {
      cwd: repositoryRoot,
      stdio: 'ignore',
    });
  }
}

function bindingGoal() {
  return { path: goalPath, sha256: goalSha };
}

function targetStatus() {
  return {
    contract: 'target_contract',
    runtime: 'not_run',
    production_eligible: false,
  };
}

function identityContract() {
  const scopes = [
    ['phone_audio', 'human_communication'],
    ['video', 'human_video'],
    ['recording', 'quality_legal_or_support_evidence'],
    ['transcription', 'captions_or_case_notes'],
    ['translation', 'language_assistance'],
    ['ai_processing', 'agent_assist_or_summary'],
    ['tool_action', 'authorized_external_effect'],
    ['remote_control', 'attended_remote_assistance'],
  ].map(([scope, purpose]) => ({
    scope,
    purpose,
    independent_authorization: true,
    unknown_or_store_failure: 'deny_new_capability',
    revocation_behavior: 'detach_capability_keep_human_media',
  }));
  return {
    $schema: './identity-consent-policy-v1.schema.json',
    contract_id: 'converact-platform-identity-consent-policy-v1',
    version: '1.0.0',
    generated_at: generatedAt,
    binding_goal: bindingGoal(),
    status: targetStatus(),
    identity: {
      authority: 'Converact Platform Identity',
      kinds: ['human', 'service', 'workload', 'edge', 'provider'],
      required_claims: [
        'tenant_id', 'identity_id', 'identity_kind', 'session_id', 'token_id',
        'issuer', 'audience', 'key_id', 'issued_at', 'not_before', 'expires_at', 'policy_version',
        'revocation_epoch', 'role', 'capabilities', 'purpose',
      ],
      production_dev_fallback: 'forbidden',
      edge_to_core: 'mtls_or_equivalent_strong_identity',
      resource_tenant_check: 'exact_match_before_store_and_force_rls_in_store',
    },
    authorization: {
      default_decision: 'deny',
      allow_requires: [
        'cryptographically_verified_identity', 'tenant_match', 'audience_match',
        'unexpired_session_and_token', 'current_policy_version',
        'revocation_epoch_not_stale', 'declared_capability', 'allowed_purpose',
      ],
      deny_conditions: [
        'missing_claim', 'unknown_identity_kind', 'cross_tenant', 'expired',
        'stale_policy', 'stale_revocation', 'unknown_capability', 'unknown_purpose',
        'pki_or_kms_unavailable_for_new_session',
      ],
      plaintext_downgrade: 'forbidden',
    },
    consent: {
      authority: 'Converact Platform Consent Policy',
      scopes,
      evidence_fields: [
        'consent_id', 'tenant_id', 'subject_id', 'scope', 'purpose',
        'policy_version', 'region_policy', 'retention_policy', 'legal_hold_policy',
        'evidence_ref', 'actor_id', 'occurred_at', 'status', 'revision',
      ],
      lease: {
        fields: [
          'lease_id', 'tenant_id', 'subject_id', 'scope', 'purpose', 'generation',
          'policy_version', 'revocation_epoch', 'issued_at', 'expires_at',
          'monotonic_duration_ms', 'issuer_key_id', 'evidence_digest',
        ],
        max_ttl_ms: 300000,
        expiry_behavior: 'detach_capability_keep_human_media',
        normal_revocation: 'versioned_event_snapshot',
        urgent_revocation: 'signed_independent_control_channel',
        stale_snapshot: 'deny_or_detach_capability',
      },
    },
    policy: {
      versioning: 'immutable_revision',
      region_selection: 'before_provider_selection',
      retention: 'separate_per_data_category',
      legal_hold: 'resource_and_category_scoped',
      deletion: 'append_only_request_receipt_verification',
      backup_restore: 'preserve_region_hold_and_deletion_tombstone',
    },
    key_lifecycle: {
      authority: 'Converact Platform Key Lifecycle',
      states: ['generated', 'staged', 'active', 'retiring', 'revoked', 'expired', 'destroyed'],
      rotation: 'dual_read_single_write_bounded_overlap',
      raw_material_storage: 'kms_pki_or_locked_memory_only',
      forbidden_sinks: ['database_payload', 'event', 'log', 'metric', 'prompt', 'evidence', 'core_dump'],
      native_gate: [
        'exact_source', 'abi_review', 'bounded_memory', 'zeroize', 'core_dump_disabled',
        'fuzz_or_sanitizer_evidence', 'independent_fault_isolation',
      ],
    },
    invariants: [
      'cross_tenant_unknown_or_mismatch_denies',
      'one_identity_and_policy_authority',
      'consent_scopes_do_not_imply_each_other',
      'revoking_optional_capability_does_not_terminate_human_media',
      'ordinary_media_does_not_read_identity_or_consent_store_per_packet',
    ],
  };
}

function eventContract() {
  return {
    $schema: './event-audit-billing-contract-v1.schema.json',
    contract_id: 'converact-platform-event-audit-billing-v1',
    version: '1.0.0',
    generated_at: generatedAt,
    binding_goal: bindingGoal(),
    status: targetStatus(),
    event: {
      authority: 'Converact Platform Event Contract',
      write_version: 2,
      read_versions: [2, 1],
      max_payload_bytes: 65536,
      envelope_fields: [
        'schema_version', 'event_id', 'event_type', 'tenant_id', 'producer_identity',
        'authority', 'aggregate_type', 'aggregate_id', 'aggregate_revision',
        'ordering_key', 'idempotency_key', 'payload_digest', 'occurred_at',
        'observed_at', 'correlation', 'causation_event_id', 'purpose',
        'region_policy', 'retention_policy', 'data',
      ],
      compatibility: 'N_and_N_minus_1_readers_additive_minor_only',
      unknown_minor: 'preserve_and_ignore_only_if_no_effect_semantics',
      unknown_major: 'quarantine_fail_closed',
      ordering: 'per_tenant_authority_aggregate_or_declared_ordering_key',
    },
    outbox: {
      transaction: 'same_domain_transaction_as_authoritative_state',
      claim: 'bounded_batch_lease_skip_locked',
      delivery: 'at_least_once',
      retry: 'bounded_with_dead_letter_and_query',
      media_hot_path: 'forbidden',
    },
    inbox: {
      uniqueness: 'tenant_consumer_event_id',
      same_id_same_digest: 'replay_noop',
      same_id_different_digest: 'conflict',
      stale_revision: 'ignore_with_receipt',
      gap_or_unknown: 'freeze_effect_then_query_reconcile',
    },
    audit: {
      authority: 'Converact Platform Audit',
      append_only: true,
      integrity: 'per_tenant_hash_chain_plus_verification_receipt',
      links: ['event_id', 'effect_id', 'receipt_id', 'billing_key', 'correlation_id'],
      correction: 'append_reversal_or_tombstone_never_mutate_history',
    },
    effect_receipt: {
      stages: ['accepted', 'completed', 'state_observed'],
      uniqueness: 'tenant_effect_stage_generation',
      monotonic_stage_progression: true,
      same_key_same_digest: 'replay_noop',
      same_key_different_digest: 'conflict',
      unknown_effect: 'query_reconcile_no_blind_retry',
      stale_writer: 'reject_by_owner_epoch_and_generation',
    },
    billing: {
      authority: 'Converact Metering Billing',
      writer_policy: 'one_writer_identity_and_epoch_per_billing_key',
      ledger: 'append_only_immutable_usage_and_reversal_entries',
      sources: [
        {
          source: 'directed_media_edge_generation',
          key_template: 'edge:{tenant}:{interaction}:{edge}:{generation}:{direction}',
          writer: 'media_receipt_projector',
        },
        {
          source: 'ai_run_generation',
          key_template: 'ai:{tenant}:{agent_run}:{generation}',
          writer: 'agent_runtime_usage_adapter',
        },
        {
          source: 'recording_segment',
          key_template: 'recording:{tenant}:{manifest}:{segment}:{owner_epoch}',
          writer: 'recording_receipt_projector',
        },
        {
          source: 'external_action_attempt',
          key_template: 'action:{tenant}:{intent}:{attempt_generation}',
          writer: 'engage_action_receipt_projector',
        },
      ],
      duplicate_same_digest: 'replay_no_charge',
      duplicate_different_digest_or_writer: 'conflict_freeze_rating',
      reconstruction: 'from_verified_receipts_and_immutable_usage_entries',
    },
    invariants: [
      'event_bus_is_not_a_domain_or_media_authority',
      'network_delivery_is_not_exactly_once',
      'unknown_effect_is_never_blindly_retried',
      'one_billing_key_and_writer_per_generation',
      'ordinary_media_has_no_event_audit_or_billing_io_per_packet',
    ],
  };
}

function observabilityContract() {
  return {
    $schema: './observability-correlation-contract-v1.schema.json',
    contract_id: 'converact-platform-observability-correlation-v1',
    version: '1.0.0',
    generated_at: generatedAt,
    binding_goal: bindingGoal(),
    status: targetStatus(),
    correlation: {
      fields: [
        'tenant_id', 'engagement_id', 'profile_binding_id', 'interaction_id',
        'communication_session_id', 'call_id', 'leg_id', 'room_id', 'resolution_id',
        'action_intent_id', 'agent_run_id', 'media_edge_id', 'generation',
        'owner_epoch', 'trace_id', 'span_id', 'request_id',
      ],
      propagation: 'signed_or_authenticated_boundary_metadata',
      maximum_field_length: 256,
      unknown_or_invalid: 'omit_and_record_bounded_validation_counter',
    },
    metrics: {
      allowed_low_cardinality_labels: [
        'service', 'region', 'zone', 'cell', 'component', 'operation', 'status',
        'error_class', 'dependency', 'queue', 'capability', 'identity_kind',
      ],
      prohibited_unbounded_labels: [
        'tenant_id', 'profile_type', 'user_id', 'engagement_id', 'interaction_id',
        'call_id', 'leg_id', 'room_id', 'resolution_id', 'action_intent_id',
        'agent_run_id', 'media_edge_id', 'trace_id', 'request_id',
      ],
      cardinality_policy: 'allowlist_only_with_ci_and_runtime_budget',
    },
    logging: {
      format: 'structured_json',
      redaction: 'key_and_value_before_sink',
      forbidden_values: ['secret', 'token', 'password', 'authorization', 'cookie', 'raw_pii', 'media_payload'],
      high_cardinality: 'controlled_log_or_trace_only_never_metric_label',
    },
    tracing: {
      sampling: 'parent_based_bounded_ratio_with_error_override_budget',
      payload_capture: 'forbidden_by_default',
      cross_domain_links: 'correlation_context_and_effect_receipt_links',
    },
    exporter: {
      queue: 'bounded',
      retries: 'bounded',
      timeout: 'bounded',
      failure_behavior: 'drop_bounded_telemetry_never_backpressure_media',
    },
    worker: {
      concurrency: 'fixed_or_admission_bounded',
      pending: 'bounded',
      retry: 'bounded_with_deadline_and_jitter',
      fanout: 'bounded',
      overload: 'reject_or_defer_optional_work',
      fairness: 'tenant_or_partition_aware',
    },
    health: {
      liveness: 'process_and_supervisor_only',
      readiness: 'new_admission_capability_specific',
      drain: 'withdraw_readiness_then_stop_claim_then_active_zero',
      rolling: 'reader_before_writer_N_and_N_minus_1',
    },
    media_hot_path: {
      observability_dependency: 'forbidden',
      database_io_per_packet: 0,
      event_io_per_packet: 0,
      http_io_per_packet: 0,
      ai_io_per_packet: 0,
      external_io_per_packet: 0,
      global_lock: 'forbidden',
      task_per_packet: 'forbidden',
    },
    clocks: {
      wall: 'durable_utc_audit_and_correlation_only',
      monotonic: 'elapsed_deadline_lease_and_latency_only',
      rtp: 'sequence_timestamp_jitter_and_drift_only',
      cross_node: 'record_offset_quality_and_skew',
      jump_behavior: 'wall_jump_must_not_change_monotonic_deadline',
    },
    invariants: [
      'observability_failure_does_not_change_business_success',
      'observability_failure_does_not_terminate_human_media',
      'profile_type_is_not_an_unbounded_metric_label',
      'all_queues_retries_and_fanout_are_bounded',
    ],
  };
}

function faultEntry(dependency, failureModes, newWork, attachment, recovery, media = 'continue') {
  return {
    dependency,
    failure_modes: failureModes,
    established_human_media: media,
    new_work: newWork,
    optional_attachment: attachment,
    recovery,
    hot_path_dependency: false,
    evidence: { status: 'not_run', production_eligible: false, evidence_uris: [] },
  };
}

function faultContract() {
  return {
    $schema: './fault-matrix-v1.schema.json',
    contract_id: 'converact-platform-fault-matrix-v1',
    version: '1.0.0',
    generated_at: generatedAt,
    binding_goal: bindingGoal(),
    status: targetStatus(),
    dependencies: [
      faultEntry('database', ['timeout', 'partition', 'pool_exhaustion', 'restart'], 'reject_durable_new_work', 'degrade_or_bounded_spool', 'reconnect_query_reconcile'),
      faultEntry('event_system', ['timeout', 'partition', 'duplicate', 'reorder'], 'commit_domain_state_and_bound_outbox_or_reject', 'degrade', 'replay_inbox_query_reconcile'),
      faultEntry('object_store', ['timeout', 'partition', 'partial_write', 'stale_read'], 'reject_object_required_work', 'bounded_spool_or_detach', 'checksum_query_reconcile'),
      faultEntry('pki_kms', ['timeout', 'partition', 'revoked_key', 'expired_cert'], 'reject_new_secure_session_or_effect', 'detach_at_lease_expiry', 'rotate_reauthorize_no_plaintext_downgrade'),
      faultEntry('dns', ['timeout', 'nxdomain', 'stale_answer', 'poisoned_answer'], 'reject_or_use_unexpired_signed_snapshot', 'keep_pinned_generation', 'new_generation_after_resolution'),
      faultEntry('configuration', ['missing', 'invalid', 'stale', 'conflicting_revision'], 'reject_new_admission', 'keep_pinned_generation', 'load_signed_revision_then_reconcile'),
      faultEntry('wall_clock', ['backward_jump', 'forward_jump', 'cross_node_skew', 'quality_unknown'], 'reject_new_lease_when_skew_exceeds_policy', 'monotonic_deadline_continues', 'resync_then_reissue_lease'),
      faultEntry('ai_gpu', ['timeout', 'oom', 'process_crash', 'capacity_exhaustion'], 'defer_or_reject_ai_work', 'detach_ai_keep_human_media', 'fenced_worker_restart'),
      faultEntry('recording_upload', ['timeout', 'partition', 'checksum_mismatch', 'capacity_exhaustion'], 'reject_or_degrade_new_recording', 'bounded_capture_spool_or_detach', 'owner_epoch_checksum_reconcile'),
      faultEntry('provider', ['timeout', 'duplicate', 'reorder', 'unknown_effect'], 'reject_or_mark_unknown', 'degrade_provider_feature', 'query_reconcile_compensate'),
      faultEntry('observability', ['collector_down', 'exporter_timeout', 'queue_full'], 'continue', 'drop_bounded_telemetry', 'resume_without_unbounded_replay'),
      faultEntry('node_crash', ['process_abort', 'oom', 'host_loss'], 'reroute_new_admission', 'interrupt_only_process_owned_edges', 'owner_epoch_takeover_and_reconcile', 'continue_if_external_edge_owner'),
    ],
    acceptance: {
      required_campaigns: [
        'local_deterministic', 'real_dependency', 'rolling_schema', 'key_rotation',
        'backup_restore', 'node_loss', 'region_recovery', 'long_media_fault',
        'bounded_overload_capacity', 'independent_security_review',
      ],
      mock_or_loopback_production_evidence: 'forbidden',
      historical_evidence_inheritance: 'forbidden',
      any_unproved_item: 'not_run',
    },
    invariants: [
      'ordinary_media_bypasses_all_platform_dependencies',
      'optional_failure_never_sends_call_termination',
      'stale_generation_or_owner_epoch_never_writes',
      'unknown_effect_requires_query_reconcile',
      'capacity_exhaustion_rejects_new_optional_work_before_human_media',
    ],
  };
}

function classifyTrace(row) {
  const haystack = `${row.source_path}\n${row.source_pointer}\n${row.requirement}`;
  for (const [domain, mapping] of Object.entries(sourceMaps)) {
    if (mapping.patterns.test(haystack)) return { domain, mapping };
  }
  return { domain: 'legacy_assessment', mapping: sourceMaps.legacy_assessment };
}

function traceabilityContract() {
  const g00 = readJson(join(
    repositoryRoot,
    'architecture-foundation/execution/goal-00/requirement-traceability-v1.json',
  ));
  const sourceRows = g00.requirements.filter((row) => row.target_goals.includes('G02'));
  const rows = sourceRows.map((row) => {
    const { domain, mapping } = classifyTrace(row);
    return {
      requirement_id: row.requirement_id,
      source_id: row.source_id,
      source_path: row.source_path,
      source_pointer: row.source_pointer,
      source_kind: row.source_kind,
      requirement: row.requirement,
      source_prior_status: row.prior_status,
      source_disposition: row.disposition,
      source_evidence_status: row.evidence_status,
      g02_domain: domain,
      g02_disposition: row.disposition === 'deferred'
        ? 'deferred_preserved'
        : row.source_kind === 'legacy_local_change'
          ? 'assess_before_migrate'
          : 'contract_and_test_mapping',
      implementation_paths: mapping.implementation_paths,
      test_paths: mapping.test_paths,
      status: 'not_run',
      production_eligible: false,
      evidence_uris: row.evidence_uris,
      rationale: row.evidence_status === 'evidence_exists_not_requalified'
        ? 'Historical evidence is preserved but is not requalified for current G02.'
        : 'Mapped to an exact G02 domain and test boundary; runtime evidence remains not_run.',
    };
  });
  const domainCounts = Object.fromEntries(Object.keys(sourceMaps).map((domain) => [
    domain,
    rows.filter((row) => row.g02_domain === domain).length,
  ]));
  return {
    $schema: './traceability-v1.schema.json',
    contract_id: 'converact-goal-02-traceability-v1',
    version: '1.0.0',
    generated_at: generatedAt,
    binding_goal: bindingGoal(),
    status: targetStatus(),
    rows,
    summary: {
      source_rows: sourceRows.length,
      mapped_rows: rows.length,
      unmapped_rows: 0,
      production_eligible_rows: 0,
      historical_evidence_not_requalified: rows.filter(
        (row) => row.source_evidence_status === 'evidence_exists_not_requalified',
      ).length,
      domain_counts: domainCounts,
    },
  };
}

function evidenceIndex() {
  const localEvidenceUri =
    'architecture-foundation/execution/goal-02/evidence/local-verification-2026-08-02.md';
  const supersededDatabaseEvidenceUri =
    'architecture-foundation/execution/goal-02/evidence/database-restart-db-4fc7b59-01.md';
  const entry = (
    id,
    evidenceClass,
    scope,
    requiredEvidence,
    status = 'not_run',
    evidenceUris = [],
  ) => ({
    evidence_id: id,
    evidence_class: evidenceClass,
    scope,
    status,
    production_eligible: false,
    required_evidence: requiredEvidence,
    evidence_uris: evidenceUris,
    non_claim: status === 'target_contract'
      ? 'Document contract only; it does not prove runtime or production behavior.'
      : status === 'verified_local'
        ? 'Deterministic local tests passed; this does not prove controlled or production behavior, real dependencies, RLS enforcement, PKI/KMS rotation, crash recovery, long media, capacity, or DR.'
        : status === 'verified_controlled'
          ? 'One isolated PostgreSQL restart was verified with synthetic transport; synthetic transport is not real human media and this does not prove the remaining dependency matrix, production behavior, long media, capacity, restore, drain, region recovery, PKI/KMS, or DR.'
          : 'No current-commit raw evidence has been accepted; remains not_run.',
  });
  const local = (id, evidenceClass, scope, requiredEvidence) =>
    entry(id, evidenceClass, scope, requiredEvidence, 'verified_local', [localEvidenceUri]);
  const supersededDatabase = (id, evidenceClass, scope, requiredEvidence) => ({
    ...entry(id, evidenceClass, scope, requiredEvidence, 'not_run', [supersededDatabaseEvidenceUri]),
    non_claim: 'The prior controlled run is preserved only as a superseded diagnostic: its usage row referenced a receipt that was not persisted by the effect authority. Current exact-source evidence remains not_run until a corrected campaign passes.',
  });
  const entries = [
    entry('G02-E00-DESIGN', 'document_contract', 'design_authority_threat_recovery', ['contract test'], 'target_contract'),
    local('G02-E01-IDENTITY', 'local_test', 'tenant_identity_cross_tenant', ['focused tests', 'RLS integration']),
    local('G02-E02-CONSENT', 'local_test', 'consent_purpose_region_lease', ['focused tests']),
    local('G02-E03-EVENT', 'local_test', 'event_N_N_minus_1_replay_unknown', ['schema/property tests']),
    local('G02-E04-RECEIPT', 'local_test', 'audit_effect_receipt_rebuild', ['focused tests']),
    local('G02-E05-BILLING', 'local_test', 'single_writer_usage_ledger', ['focused tests', 'crash boundary tests']),
    local('G02-E06-KEY', 'key_rotation', 'secret_key_cert_lifecycle', ['focused lifecycle and certificate policy tests', 'real PKI/KMS rotation and revoke']),
    local('G02-E07-OBSERVABILITY', 'local_test', 'correlation_redaction_cardinality', ['focused tests']),
    local('G02-E08-CLOCK', 'local_test', 'wall_monotonic_skew_jump', ['deterministic fault tests']),
    entry('G02-E09-DEPENDENCY', 'real_dependency', 'postgres_event_object_pki_dns_config_ai_recording', ['raw dependency fault output']),
    supersededDatabase(
      'G02-E09A-DATABASE-RESTART',
      'controlled_dependency_fault',
      'postgres_restart_runtime_rls_reconcile_synthetic_transport',
      ['raw database restart output', 'source and runtime identity', 'post-run integrity verification'],
    ),
    entry('G02-E10-RESTORE', 'backup_restore', 'backup_restore_rehearsal', ['raw restore output', 'RPO/RTO']),
    entry('G02-E11-DRAIN', 'rolling_drain', 'node_loss_rolling_schema_active_zero', ['raw multi-node output']),
    entry('G02-E12-LONG-MEDIA', 'long_media_fault', 'established_human_media_fault_isolation', ['real long media and fault schedule']),
    entry('G02-E13-CAPACITY', 'capacity', 'bounded_queue_retry_fanout_overload', ['same-hardware raw capacity output']),
    entry('G02-E14-REGION', 'region_recovery', 'region_failover_split_brain_reconcile', ['raw region recovery output']),
    entry('G02-E15-NATIVE', 'native_safety', 'core_dump_unsafe_ffi_source', ['exact-source review', 'fault/fuzz evidence']),
    entry('G02-E16-REVIEW', 'independent_review', 'spec_security_quality', ['independent review with no open high risk']),
  ];
  return {
    $schema: './evidence-index-v1.schema.json',
    contract_id: 'converact-goal-02-evidence-index-v1',
    version: '1.0.0',
    generated_at: generatedAt,
    binding_goal: bindingGoal(),
    status: targetStatus(),
    entries,
    summary: {
      entries: entries.length,
      target_contract_entries: entries.filter((value) => value.status === 'target_contract').length,
      verified_local_entries: entries.filter((value) => value.status === 'verified_local').length,
      verified_controlled_entries: entries.filter((value) => value.status === 'verified_controlled').length,
      not_run_entries: entries.filter((value) => value.status === 'not_run').length,
      production_eligible_entries: 0,
    },
  };
}

function type(type, extras = {}) {
  return { type, ...extras };
}

function strings(options = {}) {
  return type('array', { items: type('string', options.items || {}), minItems: options.minItems ?? 1, uniqueItems: true });
}

function object(properties, required = Object.keys(properties)) {
  return type('object', { additionalProperties: false, required, properties });
}

function statusSchema() {
  return object({
    contract: type('string', { enum: ['target_contract', 'verified_contract'] }),
    runtime: type('string', { enum: ['not_run', 'verified_local', 'verified_controlled', 'failed'] }),
    production_eligible: type('boolean', { const: false }),
  });
}

function bindingSchema() {
  return object({
    path: type('string', { const: goalPath }),
    sha256: type('string', { const: goalSha }),
  });
}

function schemaBase(id, properties) {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: id,
    ...object({
      $schema: type('string'),
      contract_id: type('string', { minLength: 1 }),
      version: type('string', { pattern: '^1\\.0\\.0$' }),
      generated_at: type('string', { pattern: '^\\d{4}-\\d{2}-\\d{2}T' }),
      binding_goal: bindingSchema(),
      status: statusSchema(),
      ...properties,
    }),
  };
}

function identitySchema() {
  const scope = object({
    scope: type('string'),
    purpose: type('string'),
    independent_authorization: type('boolean', { const: true }),
    unknown_or_store_failure: type('string', { const: 'deny_new_capability' }),
    revocation_behavior: type('string', { const: 'detach_capability_keep_human_media' }),
  });
  return schemaBase('identity-consent-policy-v1.schema.json', {
    identity: object({
      authority: type('string'), kinds: strings(), required_claims: strings(),
      production_dev_fallback: type('string', { const: 'forbidden' }),
      edge_to_core: type('string'), resource_tenant_check: type('string'),
    }),
    authorization: object({
      default_decision: type('string', { const: 'deny' }), allow_requires: strings(),
      deny_conditions: strings(), plaintext_downgrade: type('string', { const: 'forbidden' }),
    }),
    consent: object({
      authority: type('string'),
      scopes: type('array', { items: scope, minItems: 8, maxItems: 8 }),
      evidence_fields: strings(),
      lease: object({
        fields: strings(), max_ttl_ms: type('integer', { minimum: 1, maximum: 300000 }),
        expiry_behavior: type('string'), normal_revocation: type('string'),
        urgent_revocation: type('string'), stale_snapshot: type('string'),
      }),
    }),
    policy: object({
      versioning: type('string'), region_selection: type('string'), retention: type('string'),
      legal_hold: type('string'), deletion: type('string'), backup_restore: type('string'),
    }),
    key_lifecycle: object({
      authority: type('string'), states: strings(), rotation: type('string'),
      raw_material_storage: type('string'), forbidden_sinks: strings(), native_gate: strings(),
    }),
    invariants: strings(),
  });
}

function eventSchema() {
  const billingSource = object({
    source: type('string'), key_template: type('string'), writer: type('string'),
  });
  return schemaBase('event-audit-billing-contract-v1.schema.json', {
    event: object({
      authority: type('string'), write_version: type('integer', { const: 2 }),
      read_versions: type('array', { prefixItems: [type('integer', { const: 2 }), type('integer', { const: 1 })], minItems: 2, maxItems: 2 }),
      max_payload_bytes: type('integer', { maximum: 65536 }), envelope_fields: strings(),
      compatibility: type('string'), unknown_minor: type('string'),
      unknown_major: type('string', { const: 'quarantine_fail_closed' }), ordering: type('string'),
    }),
    outbox: object({ transaction: type('string'), claim: type('string'), delivery: type('string'), retry: type('string'), media_hot_path: type('string') }),
    inbox: object({ uniqueness: type('string'), same_id_same_digest: type('string'), same_id_different_digest: type('string', { const: 'conflict' }), stale_revision: type('string'), gap_or_unknown: type('string') }),
    audit: object({ authority: type('string'), append_only: type('boolean', { const: true }), integrity: type('string'), links: strings(), correction: type('string') }),
    effect_receipt: object({ stages: strings(), uniqueness: type('string'), monotonic_stage_progression: type('boolean', { const: true }), same_key_same_digest: type('string'), same_key_different_digest: type('string'), unknown_effect: type('string', { const: 'query_reconcile_no_blind_retry' }), stale_writer: type('string') }),
    billing: object({ authority: type('string'), writer_policy: type('string'), ledger: type('string'), sources: type('array', { items: billingSource, minItems: 4, maxItems: 4 }), duplicate_same_digest: type('string'), duplicate_different_digest_or_writer: type('string'), reconstruction: type('string') }),
    invariants: strings(),
  });
}

function observabilitySchema() {
  return schemaBase('observability-correlation-contract-v1.schema.json', {
    correlation: object({ fields: strings(), propagation: type('string'), maximum_field_length: type('integer', { maximum: 256 }), unknown_or_invalid: type('string') }),
    metrics: object({ allowed_low_cardinality_labels: strings(), prohibited_unbounded_labels: strings(), cardinality_policy: type('string') }),
    logging: object({ format: type('string'), redaction: type('string'), forbidden_values: strings(), high_cardinality: type('string') }),
    tracing: object({ sampling: type('string'), payload_capture: type('string'), cross_domain_links: type('string') }),
    exporter: object({ queue: type('string'), retries: type('string'), timeout: type('string'), failure_behavior: type('string') }),
    worker: object({ concurrency: type('string'), pending: type('string'), retry: type('string'), fanout: type('string'), overload: type('string'), fairness: type('string') }),
    health: object({ liveness: type('string'), readiness: type('string'), drain: type('string'), rolling: type('string') }),
    media_hot_path: object({ observability_dependency: type('string', { const: 'forbidden' }), database_io_per_packet: type('integer', { const: 0 }), event_io_per_packet: type('integer', { const: 0 }), http_io_per_packet: type('integer', { const: 0 }), ai_io_per_packet: type('integer', { const: 0 }), external_io_per_packet: type('integer', { const: 0 }), global_lock: type('string'), task_per_packet: type('string') }),
    clocks: object({ wall: type('string'), monotonic: type('string'), rtp: type('string'), cross_node: type('string'), jump_behavior: type('string') }),
    invariants: strings(),
  });
}

function faultSchema() {
  const evidence = object({
    status: type('string', { const: 'not_run' }),
    production_eligible: type('boolean', { const: false }),
    evidence_uris: type('array', { items: type('string') }),
  });
  const dependency = object({
    dependency: type('string'), failure_modes: strings(),
    established_human_media: type('string', { enum: ['continue', 'continue_if_external_edge_owner'] }),
    new_work: type('string'), optional_attachment: type('string'), recovery: type('string'),
    hot_path_dependency: type('boolean', { const: false }), evidence,
  });
  return schemaBase('fault-matrix-v1.schema.json', {
    dependencies: type('array', { items: dependency, minItems: 12, maxItems: 12 }),
    acceptance: object({ required_campaigns: strings(), mock_or_loopback_production_evidence: type('string'), historical_evidence_inheritance: type('string'), any_unproved_item: type('string', { const: 'not_run' }) }),
    invariants: strings(),
  });
}

function evidenceSchema() {
  const evidenceEntry = object({
    evidence_id: type('string'), evidence_class: type('string'), scope: type('string'),
    status: type('string', { enum: ['target_contract', 'not_run', 'verified_local', 'verified_controlled', 'failed'] }),
    production_eligible: type('boolean', { const: false }), required_evidence: strings(),
    evidence_uris: type('array', { items: type('string') }), non_claim: type('string'),
  });
  return schemaBase('evidence-index-v1.schema.json', {
    entries: type('array', { items: evidenceEntry, minItems: 1 }),
    summary: object({
      entries: type('integer', { minimum: 1 }), target_contract_entries: type('integer', { minimum: 0 }),
      verified_local_entries: type('integer', { minimum: 0 }), verified_controlled_entries: type('integer', { minimum: 0 }),
      not_run_entries: type('integer', { minimum: 0 }),
      production_eligible_entries: type('integer', { const: 0 }),
    }),
  });
}

function traceSchema() {
  const row = object({
    requirement_id: type('string'), source_id: type('string'), source_path: type('string'),
    source_pointer: type('string'), source_kind: type('string'), requirement: type('string'),
    source_prior_status: type('string'), source_disposition: type('string'),
    source_evidence_status: type('string'), g02_domain: type('string'),
    g02_disposition: type('string'), implementation_paths: strings(), test_paths: strings(),
    status: type('string', { const: 'not_run' }), production_eligible: type('boolean', { const: false }),
    evidence_uris: type('array', { items: type('string') }), rationale: type('string'),
  });
  return schemaBase('traceability-v1.schema.json', {
    rows: type('array', { items: row, minItems: 543, maxItems: 543 }),
    summary: object({
      source_rows: type('integer', { const: 543 }), mapped_rows: type('integer', { const: 543 }),
      unmapped_rows: type('integer', { const: 0 }), production_eligible_rows: type('integer', { const: 0 }),
      historical_evidence_not_requalified: type('integer', { minimum: 0 }),
      domain_counts: type('object', {
        additionalProperties: false,
        required: Object.keys(sourceMaps),
        properties: Object.fromEntries(Object.keys(sourceMaps).map((key) => [key, type('integer', { minimum: 0 })])),
      }),
    }),
  });
}

function sourceTestPathMap(trace) {
  const rows = Object.entries(sourceMaps).map(([domain, mapping]) => {
    const count = trace.summary.domain_counts[domain];
    return `| \`${domain}\` | ${count} | ${mapping.implementation_paths.map((path) => `\`${path}\``).join('<br>')} | ${mapping.test_paths.map((path) => `\`${path}\``).join('<br>')} |`;
  });
  const historical = trace.rows.filter((row) => row.source_evidence_status === 'evidence_exists_not_requalified');
  return `# G02 Source → Test → Evidence Path Map

## 1. Closure

- G00 rows targeting G02: **${trace.summary.source_rows}**
- Mapped exactly once: **${trace.summary.mapped_rows}**
- Unmapped: **${trace.summary.unmapped_rows}**
- Production eligible: **${trace.summary.production_eligible_rows}**
- Historical evidence preserved but not requalified: **${historical.length}**

Every row is carried without evidence promotion in [\`traceability-v1.json\`](./traceability-v1.json).
This Markdown file is the human index; the JSON file is the row-level authority.

## 2. Exact domain paths

| G02 domain | G00 rows | implementation/review paths | test paths |
| --- | ---: | --- | --- |
${rows.join('\n')}

## 3. Current-source disposition

| Current slice | Disposition | Exact current sources | Existing tests | G02 boundary |
| --- | --- | --- | --- | --- |
| Tenant/RLS | reuse + harden | \`src/db-pg-tenant.ts\`; migrations 009/010/031/032/090 | \`test/db-pg-tenant.test.ts\`; \`test/db-pg-runtime-schema.test.ts\` | application tenant check + FORCE RLS; no bare production context |
| HTTP/service identity | replace facade | \`src/middleware/auth.ts\`; \`src/auth-http.ts\`; \`src/agent-runtime/converact/authorization.ts\`; \`src/agent-runtime/security/rbac-store.ts\` | auth/RBAC/internal-mTLS tests | one Subject/ServiceIdentity/session/revocation/capability vocabulary |
| Consent | isolate/retire duplicates | call-center \`consent-tracker.ts\`; voice \`compliance-service.ts\`; audio-tap grant | voice compliance and retention tests | one cross-media policy decision; adapters do not own consent |
| Event | reuse delivery primitives; replace envelope | tenant journal; integration-events; legacy event buses | tenant replay/websocket/integration-event tests | v2 + N/N-1 + digest conflict + inbox/outbox |
| Audit | reuse canonical hash-chain; retire legacy mutable audit | \`operations/audit/*\`; legacy call-center audit | converact audit tests | platform receipt links; never media hot path |
| Billing | replace mutable counters; isolate CDR input | quota store; call-center BillingStore; voice CDR convergence | quota/billing/CDR tests | append-only ledger + one writer key |
| Secret/key/cert | reuse loaders; add lifecycle | SSO store; integration secret refs; internal TLS; protectors | integration/TLS tests | eliminate plaintext secret path; versioned rotation/revoke |
| Observability | reuse bounded OTEL/VM; replace labels/correlation | \`src/telemetry.ts\`; \`src/metrics.ts\`; OTEL/VM infra | OTEL/VM/backlog tests | structured correlation/redaction/cardinality; fail-open exporter |
| Resilience/DR | reuse worker/backup patterns; add horizontal policy | readiness, heartbeat, placement, backup runner, Helm/CNPG | worker/deploy/backup tests | capability readiness + active-zero drain + real recovery evidence |
| Clock/fault | isolate domain clocks; add platform port/harness | component-node sync; IVR/Voice clocks; Rust \`Instant\`; fenced netem | component sync/network impairment tests | wall/monotonic separation + full fault matrix |

## 4. Historical evidence non-claim

The ${historical.length} G00 production-evidence rows retain their original paths and
\`evidence_exists_not_requalified\` status in the JSON trace. They do not prove this commit,
real dependency behavior, long media continuity, recovery, capacity, or production eligibility.
All dynamic tests not explicitly linked from the evidence index remain \`not_run\`.
`;
}

assertBinding();

const identity = identityContract();
const event = eventContract();
const observability = observabilityContract();
const fault = faultContract();
const trace = traceabilityContract();
const evidence = evidenceIndex();

for (const [name, value] of [
  ['identity-consent-policy-v1.json', identity],
  ['event-audit-billing-contract-v1.json', event],
  ['observability-correlation-contract-v1.json', observability],
  ['fault-matrix-v1.json', fault],
  ['evidence-index-v1.json', evidence],
  ['traceability-v1.json', trace],
  ['identity-consent-policy-v1.schema.json', identitySchema()],
  ['event-audit-billing-contract-v1.schema.json', eventSchema()],
  ['observability-correlation-contract-v1.schema.json', observabilitySchema()],
  ['fault-matrix-v1.schema.json', faultSchema()],
  ['evidence-index-v1.schema.json', evidenceSchema()],
  ['traceability-v1.schema.json', traceSchema()],
]) writeJson(name, value);

writeFileSync(join(goalDirectory, 'source-test-path-map.md'), sourceTestPathMap(trace));
