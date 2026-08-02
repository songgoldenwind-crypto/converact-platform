import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const goalDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = realpathSync(resolve(goalDirectory, '../../..'));
const generatedAt = '2026-08-02T00:00:00.000Z';

const binding = Object.freeze({
  goal_path: 'goals/goal-03-sip-call-durable-foundation.md',
  goal_sha256: '05ce7f940782ab0efcd013d413220d068a7d3be1bab981f2c2c4f6a6f2a217af',
  amendment_path: 'goals/amendments/2026-08-02-g02-g03-gate-split-v1.json',
  amendment_sha256: '3f55c9afdc2af68d8a93a5cfe19311cb9aaefb63192c85475d479af98fa2049b',
  manifest_path: 'goals/manifest.json',
  manifest_sha256: '11b026b5014dc344d4e5b2459aafc0b251190075a212fc68f40dce62fbbda912',
  g02_development_gate_commit: '16ab4af98c5f3b453ad3d9bdd1ae5fe959a37720',
  gate_split_commit: 'e5f4c81e8eb796131313aab8f5b3a47231fe41b7',
});

const sourceIdentity = Object.freeze({
  rustpbx_commit: '6c49ee76baa54fdbf8f98020cc9bee158c7c15de',
  rsipstack_commit: '8318e97b1170de4e5245b120afec1cdf53e3d716',
  rustrtc_commit: '166c6d22984429eb6b509920c14fcd69f974f0b3',
  patchset: 'ivekit.40',
  current_adapter: 'rsipstack',
  target_adapter: 'rvoip_low_level_slices_after_separate_gates',
});

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
  for (const [pathKey, digestKey] of [
    ['goal_path', 'goal_sha256'],
    ['amendment_path', 'amendment_sha256'],
    ['manifest_path', 'manifest_sha256'],
  ]) {
    const actual = sha256File(join(repositoryRoot, binding[pathKey]));
    if (actual !== binding[digestKey]) {
      throw new Error(`${binding[pathKey]} SHA-256 drifted: ${actual}`);
    }
  }
  for (const commit of [
    binding.g02_development_gate_commit,
    binding.gate_split_commit,
  ]) {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], {
      cwd: repositoryRoot,
      stdio: 'ignore',
    });
  }
  const amendment = readJson(join(repositoryRoot, binding.amendment_path));
  if (amendment.development_gate?.status !== 'completed' ||
      amendment.production_gate?.status !== 'blocked_external' ||
      amendment.effective_dependency?.dependent_goal !== 'G03' ||
      amendment.effective_dependency?.effective_gate !==
        'platform_foundation_gate_completed' ||
      amendment.development_gate?.production_eligible !== false ||
      amendment.production_gate?.production_eligible !== false) {
    throw new Error('G02→G03 gate amendment semantics drifted');
  }
}

function targetStatus() {
  return {
    current_runtime: 'partial_existing_not_requalified',
    target_contract: 'frozen',
    production_eligible: false,
  };
}

function envelope(contractId) {
  return {
    contract_id: contractId,
    version: '1.0.0',
    generated_at: generatedAt,
    binding,
    status: targetStatus(),
  };
}

function sipFoundationContract() {
  return {
    $schema: './sip-foundation-contract-v1.schema.json',
    ...envelope('converact-sip-foundation-contract-v1'),
    authority: {
      sip_edge: 'Kamailio',
      call_leg_business_dialog: 'Unified RustPBX',
      protocol_transaction_dialog: 'selected_SipFoundation_adapter',
      durable_effect_ledger: 'Unified RustPBX SipEffect ledger',
      ordinary_media: 'RTPengine',
      forbidden_second_authorities: [
        'rvoip_high_level_call_orchestrator',
        'adapter_business_call_store',
        'adapter_cdr_writer',
        'adapter_route_or_billing_writer',
      ],
    },
    source_identity: sourceIdentity,
    anti_corruption_boundary: {
      public_types_owned_by: 'Converact Platform',
      forbidden_public_types: [
        'rsipstack::*',
        'rvoip_*::*',
        'rustrtc::*',
        'audio_codec::*',
      ],
      protocol_session_is_not: [
        'Call',
        'BusinessDialog',
        'MediaSession',
      ],
    },
    ingress_events: [
      'request_received',
      'response_received',
      'provisional_received',
      'final_received',
      'transport_accepted',
      'transport_failed',
      'transaction_timed_out',
      'protocol_dialog_changed',
      'dns_candidate_exhausted',
    ],
    control_interface: {
      current_binding: 'RustPBX_call_path_outside_target_control_port',
      target_binding: 'Converact_owned_SipFoundationControlPort',
      implementation_status: 'interface_frozen_adapter_activation_not_run',
      commands: {
        originate: {
          required_fields: [
            'tenant_id', 'call_id', 'leg_id', 'interaction_id',
            'command_id', 'owner_epoch', 'generation', 'request_uri',
            'route_id', 'offer',
          ],
          success: 'durable_effect_identity_and_protocol_session_handle',
        },
        answer: {
          required_fields: [
            'tenant_id', 'call_id', 'leg_id', 'protocol_dialog_id',
            'command_id', 'owner_epoch', 'generation', 'answer',
          ],
          success: 'durable_effect_identity',
        },
        terminate: {
          required_fields: [
            'tenant_id', 'call_id', 'leg_id', 'command_id',
            'owner_epoch', 'generation', 'hangup_cause',
          ],
          success: 'durable_effect_identity_or_terminal_observation',
        },
      },
      command_rule: 'prepare_then_durable_decision_then_commit_send',
      direct_socket_write_by_call_core: 'forbidden',
    },
    egress_events: {
      envelope_fields: [
        'tenant_id', 'call_id', 'leg_id', 'interaction_id',
        'protocol_session_id', 'protocol_session_generation',
        'protocol_dialog_id', 'transaction_id', 'event_id',
        'owner_epoch', 'generation', 'observed_at_wall_clock',
        'received_at_monotonic_offset', 'event_type', 'payload',
      ],
      delivery: 'bounded_ordered_per_protocol_session',
      duplicate_and_reorder: 'event_id_hash_dedupe_then_state_fence',
      business_mutation: 'forbidden_until_Call_authority_durable_decision',
    },
    sdp_interface: {
      representation: 'Converact_owned_immutable_exact_bytes_plus_sha256',
      roles: ['offer', 'answer'],
      negotiation_identity: [
        'leg_id', 'protocol_dialog_id', 'negotiation_generation',
      ],
      parser_types_exposed: false,
      maximum_bytes: 32768,
      mutation_after_prepare: 'forbidden',
    },
    timer_interface: {
      runtime_deadlines: 'monotonic_clock_only',
      persisted_values: [
        'semantic_timer_kind', 'remaining_duration_ms_at_snapshot',
        'wall_clock_audit_timestamp',
      ],
      persisted_monotonic_instant: 'forbidden',
      restoration: 'recompute_bounded_deadline_after_owner_fence',
    },
    hangup_cause_interface: {
      categories: [
        'normal_clearing', 'caller_cancelled', 'no_answer', 'busy',
        'rejected', 'temporary_failure', 'service_unavailable',
        'protocol_error', 'security_rejected', 'timeout', 'unknown',
      ],
      fields: [
        'category', 'sip_status', 'q850_cause', 'reason_token',
        'retryable', 'source',
      ],
      raw_backend_error_as_business_cause: 'forbidden',
    },
    error_interface: {
      categories: [
        'invalid_input', 'capacity', 'store', 'dns', 'transport',
        'transaction', 'dialog', 'security', 'timeout', 'internal',
      ],
      fields: [
        'category', 'stable_code', 'retryable', 'sip_status',
        'retry_after_seconds', 'hangup_cause',
      ],
      secret_or_raw_wire_details: 'forbidden',
    },
    commands: {
      prepare_effect: 'freeze_bytes_hash_route_attempt_without_send',
      commit_send: 'owner_fenced_idempotent_visible_effect',
      query_effect: 'read_without_mutation',
      reconcile_effect: 'fenced_unknown_resolution',
      snapshot: 'protocol_state_without_business_or_secret_authority',
      restore: 'confirmed_quiescent_same_adapter_only',
      drain: 'reject_new_protocol_sessions_preserve_existing_sessions',
    },
    command_identity_fields: [
      'tenant_id',
      'protocol_session_id',
      'protocol_session_generation',
      'effect_id',
      'command_id',
      'owner_epoch',
      'command_sequence',
      'idempotency_key',
      'request_hash',
      'wire_freeze_sha256',
    ],
    protocol_coverage: {
      methods: [
        'INVITE', 'ACK', 'BYE', 'CANCEL', 'REGISTER', 'OPTIONS',
        'UPDATE', 'PRACK', 'REFER', 'NOTIFY', 'INFO',
      ],
      transaction: [
        'invite_client_server',
        'non_invite_client_server',
        'ack_2xx_core_dialog',
        'ack_non_2xx_transaction',
        'cancel_correlation',
        'timers_A_B_D_E_F_G_H_I_J_K',
        'udp_retransmission_same_committed_bytes',
        'reliable_transport_no_udp_retransmission',
        'forked_final_responses',
        '401_407_retry',
      ],
      protocol_dialog: [
        'early_confirmed_terminated',
        'route_set_and_target_refresh',
        'local_remote_cseq_monotonicity',
        'reinvite_update_glare',
        'prack_100rel',
        'refer_notify_replaces',
      ],
      transport_dns: {
        transports: ['udp', 'tcp', 'tls'],
        websocket_status: 'not_run',
        maximum_candidates: 8,
        dns_deadline_ms: 2000,
        connect_candidate_deadline_ms: 3000,
        resolution_connect_deadline_ms: 10000,
        retry_per_candidate_ceiling: 1,
      },
    },
    edge_core_sip_v1: {
      wire_mode: 'raw_bytes_with_trusted_metadata',
      trusted_metadata: [
        'source_identity',
        'ingress_transport',
        'tls_verification',
        'raw_message_length',
        'raw_message_sha256',
        'parser_policy_version',
      ],
      untrusted_internal_metadata_policy: 'strip_then_rebuild_at_trusted_edge',
      limits: {
        message_bytes: 65535,
        start_line_bytes: 4096,
        uri_bytes: 2048,
        header_section_bytes: 32768,
        header_count: 128,
        header_line_bytes: 8192,
        body_bytes: 32768,
        multipart_depth: 2,
        multipart_parts: 16,
      },
      duplicate_header_policy: 'fail_closed_on_ambiguous_or_conflicting_values',
      secret_logging: 'forbidden',
    },
    admission_and_store_slo: {
      transaction_admission_precedes_trying: true,
      trying_precedes_business_durable_decision: true,
      trying_p99_budget_ms: 100,
      trying_hard_deadline_ms: 200,
      durable_transaction_p99_budget_ms: 20,
      call_setup_cumulative_store_p99_budget_ms: 60,
      store_write_timeout_ms: 250,
      pool_wait_p99_budget_ms: 10,
      pool_size_ceiling: 256,
      queue_depth_ceiling: 1024,
      retry_attempt_ceiling: 3,
      new_call_store_failure: '503_with_deterministic_retry_after',
      established_call_store_failure: 'bounded_repair_without_media_dependency',
      business_visible_18x_2xx_before_durable_decision: false,
    },
    boundedness: {
      lookup_complexity: 'expected_O(1)',
      timer_complexity: 'amortized_O(1)_or_bounded_O(logN)',
      global_hot_lock: 'forbidden',
      unbounded_queue: 'forbidden',
      per_message_task: 'forbidden',
      per_packet_database_or_http: 'forbidden',
      metrics: 'low_cardinality_only',
    },
    deletion_gate: {
      rsipstack_delete_before_g06: false,
      requires: [
        'new_call_selection_moved',
        'old_call_active_zero',
        'unknown_effect_zero',
        'repair_zero',
        'rollback_window_closed',
      ],
    },
  };
}

function callLegContract() {
  const transitions = [
    ['planned', 'start_invite', 'inviting', 'none'],
    ['inviting', 'provisional', 'early', 'none'],
    ['inviting', 'final_2xx', 'confirmed', 'ack_2xx'],
    ['early', 'final_2xx', 'confirmed', 'ack_2xx'],
    ['planned', 'cancel_requested', 'terminating', 'cancel_if_invite_exists'],
    ['inviting', 'cancel_requested', 'terminating', 'send_cancel'],
    ['early', 'cancel_requested', 'terminating', 'send_cancel'],
    ['terminating', 'late_final_2xx', 'terminating', 'ack_then_bye'],
    ['confirmed', 'hold_committed', 'held', 'none'],
    ['held', 'resume_committed', 'confirmed', 'none'],
    ['confirmed', 'transfer_prepare', 'transferring', 'none'],
    ['held', 'transfer_prepare', 'transferring', 'none'],
    ['transferring', 'transfer_abort', 'confirmed', 'none'],
    ['transferring', 'transfer_commit', 'terminating', 'bye_old_selected_leg'],
    ['confirmed', 'bye_requested', 'terminating', 'send_bye'],
    ['held', 'bye_requested', 'terminating', 'send_bye'],
    ['terminating', 'termination_observed', 'terminated', 'none'],
    ['planned', 'protocol_failure', 'failed', 'none'],
    ['inviting', 'protocol_failure', 'failed', 'none'],
    ['early', 'protocol_failure', 'failed', 'none'],
    ['confirmed', 'protocol_failure', 'failed', 'none'],
    ['held', 'protocol_failure', 'failed', 'none'],
    ['transferring', 'protocol_failure', 'failed', 'none'],
    ['terminating', 'protocol_failure', 'failed', 'none'],
  ].map(([from, event, to, required_effect]) => ({
    from, event, to, required_effect,
  }));
  return {
    $schema: './call-leg-state-machine-v1.schema.json',
    ...envelope('converact-call-leg-state-machine-v1'),
    authority: 'Unified RustPBX Call Core',
    identifiers: {
      common_representation: 'opaque_ascii_1_to_128_no_whitespace',
      generated_identity: 'sha256_length_prefixed_tenant_namespace_components',
      generated_digest_characters: 32,
      types: [
        { type: 'CallId', prefix: 'call_', legacy_inputs: ['vcall_*', 'uuid'] },
        { type: 'LegId', prefix: 'leg_', legacy_inputs: [] },
        { type: 'ProtocolDialogId', prefix: 'pdlg_', legacy_inputs: [] },
        { type: 'TransactionId', prefix: 'ptxn_', legacy_inputs: [] },
        { type: 'MediaSessionId', prefix: 'media_', legacy_inputs: [] },
        { type: 'InteractionId', prefix: 'interaction_', legacy_inputs: ['CallId_string_when_one_call_is_the_interaction'] },
      ],
      invariants: [
        'sip_call_id_is_not_CallId',
        'one_Call_has_many_Legs',
        'one_Leg_has_bounded_ProtocolDialog_history',
        'one_Leg_has_at_most_one_active_ProtocolDialog',
        'InteractionId_can_span_calls_but_is_never_inferred_from_SIP_Call-ID',
        'MediaSessionId_does_not_own_Call_state',
      ],
    },
    call_states: [
      'planned', 'queued', 'dialing', 'ringing', 'active', 'held',
      'transferring', 'completed', 'cancelled', 'missed', 'rejected',
      'failed', 'timed_out',
    ],
    leg_states: [
      'planned', 'inviting', 'early', 'confirmed', 'held',
      'transferring', 'terminating', 'terminated', 'failed',
    ],
    terminal_leg_states: ['terminated', 'failed'],
    events: [
      'start_invite', 'provisional', 'final_2xx', 'cancel_requested',
      'late_final_2xx', 'hold_committed', 'resume_committed',
      'transfer_prepare', 'transfer_abort', 'transfer_commit',
      'bye_requested', 'termination_observed', 'protocol_failure',
    ],
    transitions,
    concurrency: {
      mutation_fence: ['tenant_id', 'call_id', 'owner_epoch', 'generation', 'expected_revision'],
      owner_epoch: 'positive_uint64_monotonic',
      generation: 'positive_uint64_monotonic_per_leg_binding',
      revision: 'positive_uint64_advance_exactly_one',
      duplicate_event: 'same_event_id_and_hash_returns_original_receipt',
      conflicting_duplicate: 'fail_closed',
      stale_owner: 'query_only',
      sequence_gap: 'fail_closed_then_reconcile',
    },
    race_policy: {
      cancel_before_final: 'CANCEL_then_487_ACK',
      cancel_races_2xx: 'ACK_2xx_then_BYE_without_second_CDR',
      bye_duplicate: 'idempotent_same_effect_identity',
      fork_winner: 'first_durably_selected_2xx_leg_only',
      late_fork_2xx: 'ACK_then_BYE_non_winner',
      remaining_early_forks: 'CANCEL',
      reinvite: 'same_leg_same_dialog_new_negotiation_generation',
      reinvite_glare: '491_and_bounded_retry_without_new_leg',
      transfer: 'old_selected_leg_remains_until_transfer_commit',
    },
    bounds: {
      active_calls_hard_ceiling: 1000000,
      legs_per_call_default: 32,
      legs_per_call_hard_ceiling: 256,
      fork_branches_per_attempt_hard_ceiling: 32,
      protocol_dialog_history_per_leg_hard_ceiling: 16,
      mailbox_per_call_default: 256,
      mailbox_per_call_hard_ceiling: 1024,
      dedupe_receipts_per_call_hard_ceiling: 2048,
      timers_per_call_hard_ceiling: 128,
      overflow_policy: 'reject_new_work_without_mutating_existing_call',
    },
    complexity: {
      call_lookup: 'expected_O(1)',
      leg_lookup: 'expected_O(1)',
      dialog_lookup: 'expected_O(1)',
      transition: 'O(1)',
      bounded_call_reconciliation: 'O(legs_per_call)',
      global_active_call_scan_on_hot_path: 'forbidden',
    },
  };
}

function effectReceiptContract() {
  return {
    $schema: './sip-effect-receipt-contract-v1.schema.json',
    ...envelope('converact-sip-effect-receipt-contract-v1'),
    authority: 'Unified RustPBX SipEffect ledger',
    persistence: 'PostgreSQL Region durable store',
    schema_identity: {
      schema_id: 'ivekit.sip-effect-oracle',
      current_schema_version: 1,
      current_schema_hash: 'ae27a73dac95c90686f8020c2fb5e92dd016cc1712216d03b227ec3a6d6ca5ba',
      writer_identity: 'unified-rustpbx.sip-foundation',
      physical_activation_status: 'not_run',
    },
    states: [
      'prepared', 'durable_decision', 'send_attempted',
      'transport_accepted', 'protocol_observed', 'failed', 'unknown',
    ],
    semantic_receipt_classes: {
      accepted: {
        level: 'transport_accepted',
        from_state: 'send_attempted',
        proves: 'local_transport_accepted_bytes_only',
        does_not_prove: 'peer_received_or_protocol_completed',
      },
      completed: {
        level: 'protocol_observed',
        from_states: ['send_attempted', 'transport_accepted'],
        proves: 'selected_protocol_completion_observed_on_primary_path',
      },
      state_observed: {
        level: 'protocol_observed',
        from_state: 'unknown',
        proves: 'query_or_reconcile_observed_external_state',
      },
      unknown: {
        level: 'unknown',
        retry_policy: 'never_blindly_issue_new_effect_identity',
      },
    },
    identity_fields: [
      'tenant_id', 'protocol_effect_id', 'protocol_session_id',
      'protocol_session_generation', 'decision_id', 'idempotency_key',
      'request_hash', 'command_id', 'adapter_identity_hash',
      'wire_bytes_hash', 'route_binding_hash', 'wire_attempt_facts_hash',
      'wire_freeze_sha256', 'owner_epoch', 'command_sequence',
    ],
    transitions: [
      ['prepared', 'durable_decision'],
      ['prepared', 'failed'],
      ['durable_decision', 'send_attempted'],
      ['durable_decision', 'failed'],
      ['send_attempted', 'transport_accepted'],
      ['send_attempted', 'protocol_observed'],
      ['send_attempted', 'unknown'],
      ['send_attempted', 'failed'],
      ['transport_accepted', 'protocol_observed'],
      ['transport_accepted', 'unknown'],
      ['transport_accepted', 'failed'],
      ['unknown', 'protocol_observed'],
      ['unknown', 'unknown'],
      ['unknown', 'failed'],
    ].map(([from, to]) => ({ from, to })),
    atomic_boundaries: {
      call_admission: [
        'call_session', 'protocol_effect', 'effect_wal',
        'capacity_reservation_receipt', 'idempotency_record',
      ],
      media_generation: [
        'media_plan', 'directed_media_edges', 'backend_binding_groups',
        'capacity_reservation_receipt',
      ],
      bridge_head: [
        'bridge_command', 'bridge_decision', 'bridge_receipt',
        'head_compare_and_swap',
      ],
      recording: [
        'recording_intent', 'root_recording_manifest', 'source_chain',
        'segment_reference',
      ],
      commit_rule: 'all_or_nothing_single_region_transaction',
    },
    retry_after: {
      formula: 'clamp(1,30,1+ceil(pool_wait_ms/1000)+ceil(queue_depth/256)+retry_attempt)',
      failure_codes: [
        'store_timeout', 'store_pool_exhausted', 'store_unavailable',
        'store_schema_incompatible',
      ],
      pool_wait_ms_maximum: 250,
      queue_depth_maximum: 1024,
      retry_attempt_maximum: 3,
      jitter: 'forbidden',
      invalid_input: 'reject_without_fabricated_retry_after',
    },
    repair: {
      query_before_reconcile: true,
      batch_hard_ceiling: 100,
      attempts_hard_ceiling: 8,
      lease_ms_hard_ceiling: 30000,
      fence_fields: [
        'repair_owner_id', 'repair_owner_epoch', 'repair_claim_token',
        'repair_claim_revision',
      ],
      exhaustion: 'operator_visible_auditable_no_infinite_retry',
    },
    network_claim: 'idempotent_effect_plus_observation_not_exactly_once',
  };
}

function sipRequest(method, uri, headers, body = '') {
  const normalizedHeaders = [
    ...headers,
    `Content-Length: ${Buffer.byteLength(body)}`,
  ];
  return `${method} ${uri} SIP/2.0\r\n${normalizedHeaders.join('\r\n')}\r\n\r\n${body}`;
}

function sipResponse(status, reason, headers, body = '') {
  return `SIP/2.0 ${status} ${reason}\r\n${[
    ...headers,
    `Content-Length: ${Buffer.byteLength(body)}`,
  ].join('\r\n')}\r\n\r\n${body}`;
}

const baseHeaders = Object.freeze([
  'Via: SIP/2.0/UDP edge.example.invalid:5060;branch=z9hG4bKfreeze001;rport',
  'Max-Forwards: 70',
  'From: <sip:alice@example.invalid>;tag=from-freeze',
  'To: <sip:bob@example.invalid>',
  'Call-ID: wire-freeze-call@example.invalid',
  'CSeq: 1 INVITE',
  'Contact: <sip:alice@edge.example.invalid:5060>',
]);

const offer = [
  'v=0',
  'o=alice 1 1 IN IP4 192.0.2.10',
  's=Converact wire freeze',
  'c=IN IP4 192.0.2.10',
  't=0 0',
  'm=audio 40000 RTP/AVP 0 8 101',
  'a=rtpmap:0 PCMU/8000',
  'a=rtpmap:8 PCMA/8000',
  'a=rtpmap:101 telephone-event/8000',
  'a=fmtp:101 0-16',
  'a=sendrecv',
  '',
].join('\r\n');

function corpusCases() {
  const dialogHeaders = [
    'Via: SIP/2.0/UDP edge.example.invalid:5060;branch=z9hG4bKfreeze002;rport',
    'Max-Forwards: 70',
    'From: <sip:alice@example.invalid>;tag=from-freeze',
    'To: <sip:bob@example.invalid>;tag=to-freeze',
    'Call-ID: wire-freeze-call@example.invalid',
    'Contact: <sip:alice@edge.example.invalid:5060>',
  ];
  const definitions = [
    ['invite-offer', 'INVITE', 'accept', sipRequest('INVITE', 'sip:bob@example.invalid', [
      ...baseHeaders, 'Content-Type: application/sdp',
    ], offer), 'invite_server_transaction', 'create_early_dialog'],
    ['ack-2xx', 'ACK', 'accept', sipRequest('ACK', 'sip:bob@uas.example.invalid', [
      ...dialogHeaders, 'CSeq: 1 ACK',
    ]), 'uas_core_dialog', 'confirm_ack'],
    ['bye', 'BYE', 'accept', sipRequest('BYE', 'sip:bob@uas.example.invalid', [
      ...dialogHeaders, 'CSeq: 2 BYE',
    ]), 'non_invite_transaction', 'terminate_dialog'],
    ['cancel', 'CANCEL', 'accept', sipRequest('CANCEL', 'sip:bob@example.invalid', [
      ...baseHeaders.slice(0, 5), 'CSeq: 1 CANCEL',
    ]), 'cancel_correlated_to_invite', 'cancel_early_dialog'],
    ['register', 'REGISTER', 'accept', sipRequest('REGISTER', 'sip:example.invalid', [
      'Via: SIP/2.0/TCP ua.example.invalid:5060;branch=z9hG4bKreg001',
      'Max-Forwards: 70',
      'From: <sip:alice@example.invalid>;tag=register-freeze',
      'To: <sip:alice@example.invalid>',
      'Call-ID: register-freeze@example.invalid',
      'CSeq: 1 REGISTER',
      'Contact: <sip:alice@ua.example.invalid:5060>;expires=300',
    ]), 'non_invite_transaction', 'standalone_register_only'],
    ['options', 'OPTIONS', 'accept', sipRequest('OPTIONS', 'sip:service@example.invalid', [
      'Via: SIP/2.0/UDP edge.example.invalid:5060;branch=z9hG4bKopt001',
      'Max-Forwards: 70',
      'From: <sip:probe@example.invalid>;tag=probe-freeze',
      'To: <sip:service@example.invalid>',
      'Call-ID: options-freeze@example.invalid',
      'CSeq: 1 OPTIONS',
    ]), 'non_invite_transaction', 'no_business_call'],
    ['reinvite-hold', 'INVITE', 'accept', sipRequest('INVITE', 'sip:bob@uas.example.invalid', [
      ...dialogHeaders, 'CSeq: 3 INVITE', 'Content-Type: application/sdp',
    ], offer.replace('a=sendrecv', 'a=sendonly')), 'invite_server_transaction', 'same_leg_new_negotiation_generation'],
    ['update', 'UPDATE', 'accept', sipRequest('UPDATE', 'sip:bob@uas.example.invalid', [
      ...dialogHeaders, 'CSeq: 4 UPDATE', 'Content-Type: application/sdp',
    ], offer), 'non_invite_transaction', 'same_dialog_update'],
    ['prack', 'PRACK', 'accept', sipRequest('PRACK', 'sip:bob@uas.example.invalid', [
      ...dialogHeaders, 'CSeq: 2 PRACK', 'RAck: 1 1 INVITE',
    ]), 'non_invite_transaction', 'close_reliable_provisional'],
    ['refer', 'REFER', 'accept', sipRequest('REFER', 'sip:bob@uas.example.invalid', [
      ...dialogHeaders, 'CSeq: 5 REFER',
      'Refer-To: <sip:carol@example.invalid>',
      'Referred-By: <sip:alice@example.invalid>',
    ]), 'non_invite_transaction', 'prepare_transfer'],
    ['notify-refer', 'NOTIFY', 'accept', sipRequest('NOTIFY', 'sip:alice@edge.example.invalid', [
      ...dialogHeaders, 'CSeq: 1 NOTIFY', 'Event: refer',
      'Subscription-State: terminated;reason=noresource',
      'Content-Type: message/sipfrag',
    ], 'SIP/2.0 200 OK\r\n'), 'non_invite_transaction', 'observe_transfer_result'],
    ['reliable-provisional-183', '183', 'accept', sipResponse(183, 'Session Progress', [
      'Via: SIP/2.0/UDP edge.example.invalid:5060;branch=z9hG4bKfreeze001;rport',
      'From: <sip:alice@example.invalid>;tag=from-freeze',
      'To: <sip:bob@example.invalid>;tag=to-freeze',
      'Call-ID: wire-freeze-call@example.invalid',
      'CSeq: 1 INVITE',
      'Require: 100rel',
      'RSeq: 1',
      'Contact: <sip:bob@uas.example.invalid>',
    ]), 'invite_client_transaction', 'create_early_dialog_require_prack'],
    ['fork-final-a', '200', 'accept', sipResponse(200, 'OK', [
      'Via: SIP/2.0/UDP edge.example.invalid:5060;branch=z9hG4bKfreeze001;rport',
      'From: <sip:alice@example.invalid>;tag=from-freeze',
      'To: <sip:bob@example.invalid>;tag=fork-a',
      'Call-ID: wire-freeze-call@example.invalid',
      'CSeq: 1 INVITE',
      'Contact: <sip:bob@fork-a.example.invalid>',
    ]), 'invite_client_transaction', 'durably_select_one_winner'],
    ['fork-final-b-late', '200', 'accept', sipResponse(200, 'OK', [
      'Via: SIP/2.0/UDP edge.example.invalid:5060;branch=z9hG4bKfreeze001;rport',
      'From: <sip:alice@example.invalid>;tag=from-freeze',
      'To: <sip:bob@example.invalid>;tag=fork-b',
      'Call-ID: wire-freeze-call@example.invalid',
      'CSeq: 1 INVITE',
      'Contact: <sip:bob@fork-b.example.invalid>',
    ]), 'invite_client_transaction', 'ack_then_bye_non_winner'],
    ['auth-challenge', '401', 'accept', sipResponse(401, 'Unauthorized', [
      'Via: SIP/2.0/UDP edge.example.invalid:5060;branch=z9hG4bKfreeze001;rport',
      'From: <sip:alice@example.invalid>;tag=from-freeze',
      'To: <sip:bob@example.invalid>;tag=auth-freeze',
      'Call-ID: wire-freeze-call@example.invalid',
      'CSeq: 1 INVITE',
      'WWW-Authenticate: Digest realm="example.invalid",nonce="test-only",algorithm=SHA-256,qop="auth"',
    ]), 'invite_client_transaction', 'bounded_auth_retry_new_attempt'],
    ['auth-retry', 'INVITE', 'accept', sipRequest('INVITE', 'sip:bob@example.invalid', [
      ...baseHeaders.map((value) => value.startsWith('Via:')
        ? 'Via: SIP/2.0/UDP edge.example.invalid:5060;branch=z9hG4bKfreeze-auth;rport'
        : value.startsWith('CSeq:')
          ? 'CSeq: 2 INVITE'
          : value),
      'Authorization: Digest username="alice",realm="example.invalid",nonce="test-only",uri="sip:bob@example.invalid",response="00000000000000000000000000000000",algorithm=SHA-256,qop=auth,nc=00000001,cnonce="test-only"',
    ]), 'invite_client_transaction', 'derived_attempt_same_semantic_intent'],
    ['dtmf-info', 'INFO', 'accept', sipRequest('INFO', 'sip:bob@uas.example.invalid', [
      ...dialogHeaders, 'CSeq: 6 INFO',
      'Content-Type: application/dtmf-relay',
    ], 'Signal=5\r\nDuration=160\r\n'), 'non_invite_transaction', 'dedupe_and_emit_one_canonical_dtmf'],
    ['dtmf-rfc4733-offer', 'INVITE', 'accept', sipRequest('INVITE', 'sip:bob@example.invalid', [
      ...baseHeaders, 'Content-Type: application/sdp',
    ], offer), 'invite_server_transaction', 'negotiate_one_outbound_dtmf_mechanism'],
    ['malformed-conflicting-content-length', 'INVITE', 'reject', [
      'INVITE sip:bob@example.invalid SIP/2.0',
      ...baseHeaders,
      'Content-Length: 0',
      'Content-Length: 4',
      '',
      'body',
    ].join('\r\n'), 'none', 'reject_before_call_creation'],
    ['malformed-uri-percent', 'INVITE', 'reject', sipRequest('INVITE', 'sip:bo%ZZb@example.invalid', baseHeaders), 'none', 'reject_before_call_creation'],
    ['malformed-folded-authorization', 'INVITE', 'reject', [
      'INVITE sip:bob@example.invalid SIP/2.0',
      ...baseHeaders,
      'Authorization: Digest username="alice",',
      ' response="test-only"',
      'Content-Length: 0',
      '',
      '',
    ].join('\r\n'), 'none', 'reject_before_secret_logging'],
    ['malformed-oversized-header', 'OPTIONS', 'reject', sipRequest('OPTIONS', 'sip:service@example.invalid', [
      'Via: SIP/2.0/UDP edge.example.invalid:5060;branch=z9hG4bKoversized',
      'Max-Forwards: 70',
      'From: <sip:probe@example.invalid>;tag=oversized',
      'To: <sip:service@example.invalid>',
      'Call-ID: oversized@example.invalid',
      'CSeq: 1 OPTIONS',
      `X-Oversized: ${'x'.repeat(8192)}`,
    ]), 'none', 'reject_header_line_limit'],
  ];
  return definitions.map(([
    id, method_or_status, expected_disposition, wire,
    transaction_semantics, dialog_semantics,
  ]) => ({
    id,
    file: `wire-corpus/${id}.sip`,
    transport: id === 'register' ? 'tcp' : 'udp',
    method_or_status,
    expected_disposition,
    transaction_semantics,
    dialog_semantics,
    bytes: wire,
  }));
}

function writeWireCorpus() {
  const cases = corpusCases();
  for (const item of cases) {
    writeFileSync(join(goalDirectory, item.file), item.bytes);
  }
  return {
    $schema: './wire-freeze-corpus-manifest-v1.schema.json',
    ...envelope('converact-wire-freeze-corpus-manifest-v1'),
    corpus_policy: {
      raw_bytes_are_authority: true,
      line_endings: 'CRLF',
      secrets: 'test_only_non_secret_values',
      baseline_adapter: 'rsipstack',
      target_adapter: 'rvoip_low_level_slices',
      semantic_diff_policy: 'explicit_versioned_compatibility_decision_only',
      baseline_semantic_capture_status: 'not_run',
    },
    required_feature_coverage: [
      'INVITE', 'ACK', 'BYE', 'CANCEL', 'REGISTER', 'OPTIONS',
      're-INVITE', 'UPDATE', 'PRACK', 'REFER', 'NOTIFY', '100rel',
      'fork', 'auth', 'DTMF', 'malformed',
    ],
    cases: cases.map(({ bytes, ...item }) => ({
      ...item,
      byte_length: Buffer.byteLength(bytes),
      sha256: sha256(bytes),
      current_adapter_result: 'not_run',
      target_adapter_result: 'not_run',
      production_eligible: false,
    })),
  };
}

function evidenceIndex() {
  const entry = (evidence_id, claim, status, evidence_uris = []) => ({
    evidence_id,
    claim,
    status,
    evidence_uris,
    source_commit: null,
    raw_output_sha256: null,
    production_eligible: false,
  });
  return {
    $schema: './evidence-index-v1.schema.json',
    evidence_index_id: 'converact-goal-03-evidence-index-v1',
    version: '1.0.0',
    generated_at: generatedAt,
    binding,
    current_state: 'implementation_in_progress',
    production_eligible: false,
    entries: [
      entry('G03-E01-CONTRACT', 'G03 machine contracts and binding validation', 'not_run'),
      entry('G03-E02-BASELINE', 'Existing SipFoundation focused baseline', 'not_run'),
      entry('G03-E03-ID-STATE', 'Strong IDs and Call/Leg race semantics', 'not_run'),
      entry('G03-E04-EFFECT', 'Durable effect and semantic receipt classes', 'not_run'),
      entry('G03-E05-POSTGRES', 'Physical PostgreSQL durability, ACL and restart replay', 'not_run'),
      entry('G03-E06-TRYING', '100 Trying and final/overload raw latency distribution', 'not_run'),
      entry('G03-E07-WIRE', 'Wire corpus rsipstack baseline and differential replay', 'not_run'),
      entry('G03-E08-RECOVERY', 'Confirmed-quiescent recovery, clock and fencing', 'not_run'),
      entry('G03-E09-DRAIN', 'New-call stop, old-call drain and active-zero', 'not_run'),
      entry('G03-E10-FAULT', 'Protocol/worker crash, panic, OOM and blocking isolation', 'not_run'),
      entry('G03-E11-INTEROP', 'SIPp and real peer interoperability', 'not_run'),
      entry('G03-E12-LONG-CALL', 'Long call control and restart stability', 'not_run'),
      entry('G03-E13-PERFORMANCE', 'Same-source hot-path latency, allocation and capacity baseline', 'not_run'),
      entry('G03-E14-TYPECHECK', 'Repository TypeScript typecheck', 'not_run'),
      entry('G03-E15-REVIEW', 'Independent G03 review', 'not_run'),
    ],
    inherited_claims: [],
    external_or_environment_blockers: [
      'physical_postgresql_runtime_not_started',
      'real_sip_peer_campaign_not_run',
      'host_fault_and_oom_campaign_not_run',
      'long_call_and_capacity_campaign_not_run',
    ],
  };
}

const sourceMaps = Object.freeze({
  sip_foundation: {
    patterns: /(?:sip|invite|ack|bye|cancel|register|options|transaction|dialog|rsipstack|rvoip|trying|transport|dns)/iu,
    implementation_paths: [
      'src/agent-runtime/converact/voice/sip-foundation/types.ts',
      'src/agent-runtime/converact/voice/sip-foundation/session-registry.ts',
      'src/agent-runtime/converact/voice/sip-foundation/rsipstack-adapter.ts',
      'infra/converact/rustpbx/build.sh',
    ],
    test_paths: [
      'test/converact-sip-foundation.test.ts',
      'test/converact-rustpbx-build.test.ts',
      'test/converact-rsipstack-single-trying-patch.test.ts',
    ],
  },
  call_leg: {
    patterns: /(?:call|leg|fork|transfer|owner|generation|cdr|race|business dialog)/iu,
    implementation_paths: [
      'src/agent-runtime/converact/voice/foundation-identifiers.ts',
      'src/agent-runtime/converact/voice/call-leg-state-machine.ts',
      'src/agent-runtime/converact/voice/types.ts',
      'src/agent-runtime/converact/voice/state-machine.ts',
      'src/agent-runtime/converact/voice/dialog-owner-takeover.ts',
      'src/agent-runtime/converact/voice/cdr-convergence.ts',
    ],
    test_paths: [
      'test/converact-call-leg-foundation.test.ts',
      'test/converact-voice-application.test.ts',
      'test/converact-dialog-owner-takeover.test.ts',
      'test/converact-voice-cdr-convergence.test.ts',
    ],
  },
  effect_receipt: {
    patterns: /(?:effect|receipt|idempoten|unknown|reconcil|store|postgres|schema|durable|retry-after)/iu,
    implementation_paths: [
      'src/agent-runtime/converact/voice/sip-foundation/effect-oracle.ts',
      'src/agent-runtime/converact/voice/sip-foundation/postgres-effect-store.ts',
      'src/migrations/107_ivekit_sip_effect_oracle.sql',
    ],
    test_paths: [
      'test/converact-sip-receipt-drain.test.ts',
      'test/converact-sip-effect-oracle.test.ts',
      'test/converact-sip-effect-postgres.test.ts',
    ],
  },
  wire_security: {
    patterns: /(?:wire|parser|header|uri|sdp|malformed|auth|dtmf|content-length|100rel|prack|refer|notify)/iu,
    implementation_paths: [
      'src/agent-runtime/converact/voice/sip-foundation/route-binding.ts',
      'src/agent-runtime/converact/voice/sip-foundation/rsipstack-adapter.ts',
      'architecture-foundation/execution/goal-03/wire-corpus',
    ],
    test_paths: [
      'test/converact-sip-foundation.test.ts',
      'architecture-foundation/execution/goal-03/goal-03-contract.test.mjs',
    ],
  },
  recovery_fault_drain: {
    patterns: /(?:recover|restart|clock|drain|fault|panic|oom|worker|blocking|timer|overload|capacity)/iu,
    implementation_paths: [
      'src/agent-runtime/converact/voice/sip-foundation/recovery.ts',
      'src/agent-runtime/converact/voice/sip-foundation/session-registry.ts',
      'infra/converact/rustpbx/patches/rsipstack-ivekit-capacity.patch',
      'infra/converact/rustpbx/patches/rustpbx-ivekit-dialog-recovery.patch',
    ],
    test_paths: [
      'test/converact-sip-receipt-drain.test.ts',
      'test/converact-sip-foundation-recovery.test.ts',
      'test/converact-rsipstack-server-invite-lifecycle-patch.test.ts',
      'test/converact-rustpbx-dialog-recovery-patch.test.ts',
    ],
  },
  legacy_assessment: {
    patterns: /.*/u,
    implementation_paths: [
      'architecture-foundation/execution/goal-03/source-test-path-map.md',
    ],
    test_paths: [
      'architecture-foundation/execution/goal-03/goal-03-contract.test.mjs',
    ],
  },
});

function traceability() {
  const g00 = readJson(join(
    repositoryRoot,
    'architecture-foundation/execution/goal-00/requirement-traceability-v1.json',
  ));
  const rows = g00.requirements.filter((row) => row.target_goals.includes('G03'));
  const requirements = rows.map((row) => {
    const text = `${row.requirement_id} ${row.requirement}`;
    const [domain, map] = Object.entries(sourceMaps)
      .find(([, candidate]) => candidate.patterns.test(text));
    return {
      requirement_id: row.requirement_id,
      source_id: row.source_id,
      source_path: row.source_path,
      source_pointer: row.source_pointer,
      requirement: row.requirement,
      source_prior_status: row.prior_status,
      source_evidence_status: row.evidence_status,
      g03_domain: domain,
      implementation_paths: map.implementation_paths,
      test_paths: map.test_paths,
      status: 'not_run',
      evidence_uris: [],
      production_eligible: false,
      rationale: 'Mapped exactly once; no G00 or historical evidence is requalified by G03.',
    };
  });
  const domainCounts = Object.fromEntries(
    Object.keys(sourceMaps).map((domain) => [
      domain,
      requirements.filter((row) => row.g03_domain === domain).length,
    ]),
  );
  return {
    $schema: './traceability-v1.schema.json',
    traceability_id: 'converact-goal-03-traceability-v1',
    version: '1.0.0',
    generated_at: generatedAt,
    binding,
    source_traceability: {
      path: 'architecture-foundation/execution/goal-00/requirement-traceability-v1.json',
      sha256: sha256File(join(
        repositoryRoot,
        'architecture-foundation/execution/goal-00/requirement-traceability-v1.json',
      )),
    },
    requirements,
    closure: {
      source_rows_targeting_g03: rows.length,
      mapped_exactly_once: requirements.length,
      unmapped: 0,
      production_eligible: 0,
      domain_counts: domainCounts,
    },
  };
}

function exactDocumentSchema(id, title, document) {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: id,
    title,
    description: 'Closed identity schema for the frozen versioned contract document.',
    ...schemaForValue(document),
  };
}

function schemaForValue(value) {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return {
        type: 'array',
        maxItems: 0,
      };
    }
    return {
      type: 'array',
      minItems: value.length,
      maxItems: value.length,
      prefixItems: value.map(schemaForValue),
      items: false,
    };
  }
  if (typeof value === 'object') {
    return {
      type: 'object',
      additionalProperties: false,
      required: Object.keys(value),
      properties: Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, schemaForValue(item)]),
      ),
    };
  }
  return { const: value };
}

function evidenceSchema() {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://converact.invalid/schemas/goal-03-evidence-index-v1.schema.json',
    type: 'object',
    additionalProperties: false,
    required: [
      '$schema', 'evidence_index_id', 'version', 'generated_at', 'binding',
      'current_state', 'production_eligible', 'entries', 'inherited_claims',
      'external_or_environment_blockers',
    ],
    properties: {
      $schema: { const: './evidence-index-v1.schema.json' },
      evidence_index_id: { const: 'converact-goal-03-evidence-index-v1' },
      version: { const: '1.0.0' },
      generated_at: { type: 'string', format: 'date-time' },
      binding: schemaForValue(binding),
      current_state: {
        enum: ['implementation_in_progress', 'completed', 'blocked_external'],
      },
      production_eligible: { const: false },
      entries: {
        type: 'array',
        minItems: 15,
        maxItems: 15,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'evidence_id', 'claim', 'status', 'evidence_uris',
            'source_commit', 'raw_output_sha256', 'production_eligible',
          ],
          properties: {
            evidence_id: {
              type: 'string',
              pattern: '^G03-E[0-9]{2}-[A-Z0-9-]+$',
            },
            claim: { type: 'string', minLength: 1 },
            status: {
              enum: [
                'not_run', 'verified_source', 'verified_local',
                'verified_controlled', 'blocked_external', 'failed',
              ],
            },
            evidence_uris: {
              type: 'array',
              uniqueItems: true,
              items: { type: 'string', minLength: 1 },
            },
            source_commit: {
              anyOf: [
                { type: 'null' },
                { type: 'string', pattern: '^[a-f0-9]{40}$' },
              ],
            },
            raw_output_sha256: {
              anyOf: [
                { type: 'null' },
                { type: 'string', pattern: '^[a-f0-9]{64}$' },
              ],
            },
            production_eligible: { const: false },
          },
        },
      },
      inherited_claims: { type: 'array', maxItems: 0 },
      external_or_environment_blockers: {
        type: 'array',
        uniqueItems: true,
        items: { type: 'string', minLength: 1 },
      },
    },
  };
}

function traceSchema() {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://converact.invalid/schemas/goal-03-traceability-v1.schema.json',
    type: 'object',
    additionalProperties: false,
    required: [
      '$schema', 'traceability_id', 'version', 'generated_at', 'binding',
      'source_traceability', 'requirements', 'closure',
    ],
    properties: {
      $schema: { const: './traceability-v1.schema.json' },
      traceability_id: { const: 'converact-goal-03-traceability-v1' },
      version: { const: '1.0.0' },
      generated_at: { type: 'string', format: 'date-time' },
      binding: schemaForValue(binding),
      source_traceability: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'sha256'],
        properties: {
          path: { const: 'architecture-foundation/execution/goal-00/requirement-traceability-v1.json' },
          sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        },
      },
      requirements: {
        type: 'array',
        minItems: 143,
        maxItems: 143,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'requirement_id', 'source_id', 'source_path', 'source_pointer',
            'requirement', 'source_prior_status', 'source_evidence_status',
            'g03_domain', 'implementation_paths', 'test_paths', 'status',
            'evidence_uris', 'production_eligible', 'rationale',
          ],
          properties: {
            requirement_id: { type: 'string', minLength: 1 },
            source_id: { type: 'string', minLength: 1 },
            source_path: { type: 'string', minLength: 1 },
            source_pointer: { type: 'string', minLength: 1 },
            requirement: { type: 'string', minLength: 1 },
            source_prior_status: { type: 'string', minLength: 1 },
            source_evidence_status: { type: 'string', minLength: 1 },
            g03_domain: { enum: Object.keys(sourceMaps) },
            implementation_paths: {
              type: 'array', minItems: 1, uniqueItems: true,
              items: { type: 'string', minLength: 1 },
            },
            test_paths: {
              type: 'array', minItems: 1, uniqueItems: true,
              items: { type: 'string', minLength: 1 },
            },
            status: { const: 'not_run' },
            evidence_uris: { type: 'array', maxItems: 0 },
            production_eligible: { const: false },
            rationale: { type: 'string', minLength: 1 },
          },
        },
      },
      closure: {
        type: 'object',
        additionalProperties: false,
        required: [
          'source_rows_targeting_g03', 'mapped_exactly_once', 'unmapped',
          'production_eligible', 'domain_counts',
        ],
        properties: {
          source_rows_targeting_g03: { const: 143 },
          mapped_exactly_once: { const: 143 },
          unmapped: { const: 0 },
          production_eligible: { const: 0 },
          domain_counts: {
            type: 'object',
            additionalProperties: false,
            required: Object.keys(sourceMaps),
            properties: Object.fromEntries(
              Object.keys(sourceMaps).map((key) => [key, { type: 'integer', minimum: 0 }]),
            ),
          },
        },
      },
    },
  };
}

assertBinding();

const contracts = [
  [
    'sip-foundation-contract-v1',
    'Converact SipFoundation contract v1',
    sipFoundationContract(),
  ],
  [
    'call-leg-state-machine-v1',
    'Converact Call/Leg state machine v1',
    callLegContract(),
  ],
  [
    'sip-effect-receipt-contract-v1',
    'Converact SIP effect/receipt contract v1',
    effectReceiptContract(),
  ],
  [
    'wire-freeze-corpus-manifest-v1',
    'Converact SIP wire freeze corpus v1',
    writeWireCorpus(),
  ],
];

for (const [name, title, document] of contracts) {
  writeJson(`${name}.json`, document);
  writeJson(
    `${name}.schema.json`,
    exactDocumentSchema(
      `https://converact.invalid/schemas/${name}.schema.json`,
      title,
      document,
    ),
  );
}

writeJson('evidence-index-v1.json', evidenceIndex());
writeJson('evidence-index-v1.schema.json', evidenceSchema());
writeJson('traceability-v1.json', traceability());
writeJson('traceability-v1.schema.json', traceSchema());
