import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { type ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';

const schemaPath =
  'docs/capacity/schemas/rvoip-capability-integration.schema.json';
const contractPath =
  'docs/capacity/contracts/rvoip-capability-integration-v1.json';

const implementedLocalIds = [
  'authority_livekit_webrtc',
  'authority_ordinary_g711_relay_excluded',
  'authority_processing_no_remote_packet_dependency',
  'authority_rtpengine_ordinary_rtp_fast_path',
  'authority_rustpbx_call',
  'authority_rustpbx_dialog',
  'authority_rustpbx_leg',
  'authority_tinode_im',
  'codec_g711_opus_bidirectional_pairs',
  'codec_opus_registry',
  'codec_pcma_registry',
  'codec_pcmu_registry',
  'g729_source_archive_hash_pin',
  'g729_source_codec_only_boundary',
  'g729_source_repository_commit_tree_pin',
  'g729_source_selected_136_tuple_pin',
  'media_bounded_jitter_reorder',
  'media_duplicate_suppression',
  'media_g711_opus_plc',
  'media_late_packet_drop',
  'media_sequence_wrap',
  'media_timestamp_wrap',
  'provider_asr_partial_final_events',
  'provider_bounded_audio_input_queue',
  'provider_bounded_projection_output_queue',
  'provider_cancelable_tts_playback',
  'provider_dialog_semantic_absorption',
  'provider_governed_capability_deadline_quota_circuit_fallback',
  'provider_media_frame_request_separation',
  'provider_realtime_offline_quality_separation',
  'provider_recording_manifest_semantic_absorption',
  'provider_safe_trace_redaction',
  'provider_streaming_asr_lifecycle',
  'rtp_datagram_pool_arrayqueue',
  'rtp_datagram_pool_exhaustion_drop',
  'rtp_datagram_pool_hard_ceiling',
  'rtp_datagram_pool_sync_return',
  'rtp_fixed_packet_budget',
  'rtp_fixed_session_budget',
  'rtp_fixed_socket_budget',
  'rtp_fixed_worker_count',
  'rtp_no_async_mutex_hot_path',
  'rtp_no_drop_spawn',
  'rtp_no_per_packet_task',
  'rtp_owned_bytes_parse',
  'rtp_packet_session_transport_layering',
  'rtp_reusable_serialization_scratch',
  'sdp_structured_offer_answer_update',
  'sdp_symmetric_rtp_source_validation',
  'session_processing_command_sequence',
  'session_processing_idempotent_replay',
  'session_processing_owner_epoch',
  'test_rfc4733_duplicate_end',
  'test_rfc4733_duration',
  'test_rtcp_malformed',
  'test_rtcp_parse',
  'test_rtp_malformed'
] as const;

const partialIds = [
  'authority_media_control_single_entrypoint',
  'authority_rtpengine_wire_sdp_transport',
  'authority_voice_media_processing',
  'extraction_one_authority_guardrail',
  'media_rtcp_per_leg_accounting',
  'processing_security_mode_capacity_identity',
  'processing_terminal_event_durable_handoff',
  'provider_execution_context_owner_epoch',
  'provider_recording_goal5_operational_closure',
  'provider_tts_owner_sequence_fencing',
  'provider_tts_slow_consumer_policy'
] as const;

const notRunIds = [
  'authority_rustpbx_logical_media_graph',
  'benchmark_codec',
  'benchmark_demux',
  'benchmark_jitter',
  'benchmark_packet_loop',
  'benchmark_rtp_parse',
  'benchmark_rtp_serialize',
  'benchmark_srtp',
  'benchmark_udp_loopback',
  'deployment_carrier_cell_profile',
  'deployment_rust_native_carrier_profile',
  'deployment_unified_standalone_profile',
  'evidence_24h_endurance',
  'evidence_goal4_immutable_finalizer',
  'evidence_rvoip_2k_one_hour_harness_nonclaim',
  'evidence_same_hardware_rvoip_ab',
  'g711_opus_capacity',
  'g711_opus_failure_isolation',
  'g711_opus_quality',
  'g711_opus_real_rtp',
  'g729_annex_a_encode_decode',
  'g729_annex_b_asymmetric_explicit_no_wins',
  'g729_annex_b_cng',
  'g729_annex_b_dtx',
  'g729_annex_b_fmtp',
  'g729_annex_b_missing_defaults_yes',
  'g729_annex_b_vad',
  'g729_bitstream_vectors',
  'g729_dynamic_payload_type_remap',
  'g729_frame_10ms_80_samples',
  'g729_legal_supply_chain_production_gate',
  'g729_no_data_frames',
  'g729_packetization_10ms',
  'g729_packetization_20ms',
  'g729_packetization_30ms',
  'g729_packetization_40ms',
  'g729_packetization_60ms',
  'g729_p99_latency',
  'g729_plc',
  'g729_reference_vectors',
  'g729_rtp_encoding_g729_8000',
  'g729_sessions_per_core',
  'g729_sid_frames',
  'g729_speech_sid_payload_framing',
  'g729_static_payload_type_18',
  'g729_steady_state_allocation',
  'g729a_g711_pairs',
  'g729a_independent_peer',
  'g729a_mandatory_mode_identity',
  'g729a_opus_pairs',
  'g729a_quality',
  'g729ab_g711_pairs',
  'g729ab_independent_peer',
  'g729ab_mandatory_mode_identity',
  'g729ab_opus_pairs',
  'g729ab_quality',
  'identity_registrar_credential_adapter',
  'identity_scim_enterprise_route',
  'identity_stir_shaken_adapter',
  'identity_vcon_export_exchange',
  'integration_curated_cargo_build_graph',
  'integration_no_rustpbx_rvoip_rpc',
  'integration_single_unified_rustpbx_binary',
  'integration_upstream_type_isolation',
  'media_backend_single_writer',
  'media_embedded_dual_backend_migration',
  'media_engine_facade',
  'media_inband_dtmf',
  'media_rust_native_24h_endurance',
  'media_rust_native_2_4_8_scaling',
  'media_rust_native_failure_isolation',
  'media_rust_native_feature_parity',
  'media_rust_native_kernel_nic_numa',
  'media_rust_native_ordinary_rtp_fast_path',
  'media_rust_native_same_hardware_performance',
  'media_sip_info_rustpbx_command_path',
  'media_standalone_wire_binding_single_authority',
  'perf_allocator_steady_state',
  'perf_cache_line_atomic_counters',
  'processing_end_to_end_mtls',
  'processing_full_metrics_alerts',
  'provider_real_latency_capacity',
  'provider_real_media_failure_isolation',
  'provider_real_vendor_asr',
  'provider_real_vendor_tts',
  'rtp_processing_packet_session_adapter',
  'sip_attended_refer_replaces',
  'sip_blind_refer',
  'sip_carrier_sbc_topology',
  'sip_compatibility_matrix',
  'sip_core_invite_bye_cancel_register_cases',
  'sip_foundation_2_4_8_scaling',
  'sip_foundation_bounded_state_overload',
  'sip_foundation_cell_canary_rollback',
  'sip_foundation_digest_aka_auth_adapter',
  'sip_foundation_effect_fence',
  'sip_foundation_message_codec_adapter',
  'sip_foundation_minimal_dependency_source_slice',
  'sip_foundation_protocol_dialog_runtime_adapter',
  'sip_foundation_protocol_session_facade',
  'sip_foundation_register_mechanics_adapter',
  'sip_foundation_rfc3263_dns_adapter',
  'sip_foundation_rsipstack_baseline_adapter',
  'sip_foundation_rvoip_composite_adapter',
  'sip_foundation_shadow_equivalence_migration',
  'sip_foundation_shadow_noninterference',
  'sip_foundation_snapshot_restore_mapping',
  'sip_foundation_transaction_runtime_adapter',
  'sip_foundation_udp_tcp_tls_transport_adapter',
  'sip_ipv6',
  'sip_prack',
  'sip_rfc5626_outbound',
  'sip_rfc_compliance_matrix',
  'sip_session_timer',
  'sip_subscribe_notify',
  'sip_update',
  'sip_wss_outbound',
  'test_fuzz_sip_sdp_rtp_rtcp_srtp',
  'test_security_matrix',
  'test_topology_profiles'
] as const;

const rejectedIds = [
  'reject_parallel_rvoip_pbx',
  'reject_rvoip_conversation_session_participant_model',
  'reject_rvoip_generic_rtp_transport_runtime',
  'reject_rvoip_quic_uctp_webtransport_moq_dataplane',
  'reject_rvoip_recording_sink_evidence_authority',
  'reject_rvoip_webrtc_dtls_ice_turn_runtime',
  'reject_rvoip_whole_workspace_dependency',
  'reject_second_media_authority',
  'reject_second_sip_b2bua',
  'reject_vcon_durable_session_authority'
] as const;

const replacementGateIds = [
  'replacement_dual_leg_cdr_region_receipt_terminal_repair',
  'replacement_dual_leg_shadow_takeover_recovery',
  'replacement_endurance_fault_rollback',
  'replacement_external_contracts',
  'replacement_goal6_sip_matrix',
  'replacement_maintenance_cost',
  'replacement_multi_node_scaling',
  'replacement_owner_sequence_idempotency_prepare_commit',
  'replacement_per_cell_migration',
  'replacement_recording_ai_provider_isolation',
  'replacement_route_snapshot_cell_admission_placement',
  'replacement_rtpengine_control_dtmf_renegotiation',
  'replacement_same_hardware_performance',
  'replacement_wss_webphone_compatibility'
] as const;

const expectedStatuses = [
  'implemented_local',
  'partial',
  'not_run',
  'rejected'
] as const;

const expectedCategories = [
  'authority_boundary',
  'media_data_plane',
  'g729',
  'provider_semantics',
  'sip_interop',
  'test_evidence',
  'identity_extension',
  'integration_topology',
  'sip_foundation',
  'rust_native_media'
] as const;

const expectedIntegrationModes = [
  'existing_authority',
  'semantic_rewrite',
  'semantic_absorption',
  'direct_exact_source_candidate',
  'test_input_only',
  'method_absorption',
  'future_adapter',
  'non_claim_evidence',
  'production_gate_only',
  'explicit_rejection',
  'build_integration',
  'deployment_profile',
  'backend_qualification',
  'diagnostic_topology'
] as const;

const expectedAuthorities = [
  'rustpbx',
  'rtpengine',
  'voice-media-rs',
  'media-control-v1',
  'livekit',
  'tinode',
  'rvoip-g729-source-candidate',
  'ivekit-provider-layer',
  'ivekit-dialog-shadow',
  'ivekit-recording-manifest',
  'kamailio-rustpbx',
  'goal4-evidence',
  'goal6-interop',
  'goal7-performance',
  'goal9-security',
  'goal10-fleet',
  'goal11-finalizer',
  'opc-enterprise-identity',
  'rsipstack',
  'rvoip-foundation-source-candidate',
  'rust-native-media',
  'none'
] as const;

const expectedTargetGoals = [
  'architecture_boundary',
  'goal_0',
  'goal_1',
  'goal_2',
  'goal_3',
  'goal_4',
  'goal_5',
  'goal_6',
  'goal_7',
  'goal_8',
  'goal_9',
  'goal_10',
  'goal_11',
  'opc_enterprise_identity',
  'none_rejected'
] as const;

const statusIds = {
  implemented_local: implementedLocalIds,
  partial: partialIds,
  not_run: notRunIds,
  rejected: rejectedIds
} as const;

type CapabilityId =
  | typeof implementedLocalIds[number]
  | typeof partialIds[number]
  | typeof notRunIds[number]
  | typeof rejectedIds[number];
type ReplacementGateId = typeof replacementGateIds[number];
type CapabilityStatus = typeof expectedStatuses[number];
type CapabilityCategory = typeof expectedCategories[number];
type IntegrationMode = typeof expectedIntegrationModes[number];
type Authority = typeof expectedAuthorities[number];
type TargetGoal = typeof expectedTargetGoals[number];
type TopologyIdentity =
  | {
      identity_id: 'CARRIER-CELL-V1';
      identity_kind: 'production_deployment_profile';
      production_authorizing: true;
    }
  | {
      identity_id: 'RUST-NATIVE-FAST-PATH-CANDIDATE';
      identity_kind: 'backend_qualification';
      production_authorizing: false;
    }
  | {
      identity_id: 'UNIFIED-STANDALONE-V1';
      identity_kind: 'diagnostic_topology';
      production_authorizing: false;
    };

interface CapabilityEntry {
  capability_id: CapabilityId;
  category: CapabilityCategory;
  status: CapabilityStatus;
  integration_mode: IntegrationMode;
  current_authority: Authority;
  target_goal: TargetGoal;
  evidence_paths: string[];
  non_claim: true;
  next_gate: string;
}

interface ReplacementGateEntry {
  gate_id: ReplacementGateId;
  category: 'rustpbx_replacement';
  status: 'not_run';
  integration_mode: 'replacement_gate';
  current_authority: 'rustpbx';
  target_goal: TargetGoal;
  evidence_paths: string[];
  non_claim: true;
  next_gate: string;
}

interface IntegrationContract {
  summary: {
    capability_count: number;
    replacement_gate_count: number;
    total_item_count: number;
    status_counts: Record<CapabilityStatus, number>;
  };
  claim_boundary: {
    capacity_claim: string;
    production_eligible: boolean;
    runtime_enablement: boolean;
    upstream_result_is_ivekit_evidence: boolean;
  };
  topology_identities: TopologyIdentity[];
  g729_legal_boundary: {
    status: CapabilityStatus;
    blocks: string[];
    does_not_block: string[];
    external_legal_conclusion_required: boolean;
  };
  capabilities: CapabilityEntry[];
  replacement_gates: ReplacementGateEntry[];
}

const expectedCapabilityIds: CapabilityId[] = [
  ...implementedLocalIds,
  ...partialIds,
  ...notRunIds,
  ...rejectedIds
].sort();
const expectedReplacementGateIds = [...replacementGateIds].sort();

function json(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function object(
  value: unknown,
  label: string
): asserts value is Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`
  );
}

function schemaEnum(name: string): string[] {
  const schema = json(schemaPath);
  object(schema, 'schema');
  const definitions = schema.$defs;
  object(definitions, 'schema.$defs');
  const definition = definitions[name];
  object(definition, `schema.$defs.${name}`);
  const values = definition.enum;
  assert.ok(
    Array.isArray(values) &&
      values.every((value: unknown) => typeof value === 'string'),
    `schema.$defs.${name}.enum must contain only strings`
  );
  return values;
}

function validator(): ValidateFunction<IntegrationContract> {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat('date-time', {
    type: 'string',
    validate: (value: string) => {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) &&
        new Date(parsed).toISOString() === value;
    }
  });
  const schema = json(schemaPath);
  object(schema, 'schema');
  return ajv.compile<IntegrationContract>(schema);
}

function contract(): IntegrationContract {
  const value = json(contractPath);
  const validate = validator();
  if (!validate(value)) {
    assert.fail(validate.errors?.map((error) =>
      `${error.instancePath || '/'} ${error.message}`
    ).join('\n'));
  }
  return value;
}

test('rvoip integration schema and contract exist and validate', () => {
  assert.ok(existsSync(schemaPath), `missing ${schemaPath}`);
  assert.ok(existsSync(contractPath), `missing ${contractPath}`);
  const validate = validator();
  const contract = json(contractPath);
  assert.equal(
    validate(contract),
    true,
    validate.errors?.map((error) =>
      `${error.instancePath || '/'} ${error.message}`
    ).join('\n')
  );
});

test('rvoip integration schema freezes every exact vocabulary', () => {
  assert.deepEqual(
    schemaEnum('capabilityId'),
    expectedCapabilityIds
  );
  assert.deepEqual(
    schemaEnum('replacementGateId'),
    expectedReplacementGateIds
  );
  assert.deepEqual(schemaEnum('status'), [...expectedStatuses]);
  assert.deepEqual(schemaEnum('category'), [...expectedCategories]);
  assert.deepEqual(
    schemaEnum('integrationMode'),
    [...expectedIntegrationModes]
  );
  assert.deepEqual(schemaEnum('authority'), [...expectedAuthorities]);
  assert.deepEqual(schemaEnum('targetGoal'), [...expectedTargetGoals]);
});

test('rvoip integration freezes 198 sorted unique capability IDs', () => {
  const value = contract();
  const ids = value.capabilities.map((entry) => entry.capability_id);
  assert.equal(ids.length, 198);
  assert.equal(new Set(ids).size, 198);
  assert.deepEqual(ids, [...ids].sort());
  assert.deepEqual(ids, expectedCapabilityIds);
});

test('rvoip integration freezes exact capability status sets and counts', () => {
  const value = contract();
  assert.deepEqual(value.summary, {
    capability_count: 198,
    replacement_gate_count: 14,
    total_item_count: 212,
    status_counts: {
      implemented_local: 57,
      partial: 11,
      not_run: 120,
      rejected: 10
    }
  });
  for (const [status, expected] of Object.entries(statusIds)) {
    const actual = value.capabilities
      .filter((entry) => entry.status === status)
      .map((entry) => entry.capability_id)
      .sort();
    assert.deepEqual(actual, [...expected].sort(), status);
  }
});

test('rvoip integration retains 14 historical non-authorizing replacement checks as not run', () => {
  const value = contract();
  const ids = value.replacement_gates.map((entry) => entry.gate_id);
  assert.equal(new Set(ids).size, 14);
  assert.deepEqual(ids, expectedReplacementGateIds);
  assert.ok(value.replacement_gates.every(
    (entry) =>
      entry.status === 'not_run' &&
      entry.category === 'rustpbx_replacement' &&
      entry.current_authority === 'rustpbx' &&
      entry.non_claim === true
  ));
  assert.ok(value.replacement_gates.every(
    (entry) => /superseding ADR/.test(entry.next_gate)
  ));
});

test('rvoip integration entries preserve evidence and non-claim rules', () => {
  const value = contract();
  const entries = [...value.capabilities, ...value.replacement_gates];
  for (const entry of entries) {
    const id = 'capability_id' in entry
      ? entry.capability_id
      : entry.gate_id;
    assert.equal(entry.non_claim, true, id);
    assert.ok(entry.next_gate.trim().length > 0);
    assert.ok(entry.evidence_paths.length > 0);
    for (const path of entry.evidence_paths) {
      if (path.startsWith('future:')) {
        assert.equal(entry.status, 'not_run', path);
        assert.match(path, /^future:[a-z0-9][a-z0-9_./-]*$/);
      } else {
        assert.ok(existsSync(path), `missing evidence path: ${path}`);
      }
    }
  }
});

test('rvoip integration keeps production and capacity claims closed', () => {
  const value = contract();
  assert.deepEqual(value.claim_boundary, {
    capacity_claim: 'none',
    production_eligible: false,
    runtime_enablement: false,
    upstream_result_is_ivekit_evidence: false
  });
  assert.ok(value.capabilities.every(
    (entry) =>
      ['implemented_local', 'partial', 'not_run', 'rejected']
        .includes(entry.status)
  ));
});

test('rvoip integration has one production topology and non-authorizing alternatives', () => {
  const value = contract();
  assert.deepEqual(value.topology_identities, [
    {
      identity_id: 'CARRIER-CELL-V1',
      identity_kind: 'production_deployment_profile',
      production_authorizing: true
    },
    {
      identity_id: 'RUST-NATIVE-FAST-PATH-CANDIDATE',
      identity_kind: 'backend_qualification',
      production_authorizing: false
    },
    {
      identity_id: 'UNIFIED-STANDALONE-V1',
      identity_kind: 'diagnostic_topology',
      production_authorizing: false
    }
  ]);
  assert.deepEqual(
    value.topology_identities
      .filter((identity) => identity.production_authorizing)
      .map((identity) => identity.identity_id),
    ['CARRIER-CELL-V1']
  );

  const byId = new Map<CapabilityId, CapabilityEntry>(
    value.capabilities.map((entry) => [entry.capability_id, entry])
  );
  assert.equal(
    byId.get('deployment_carrier_cell_profile')?.integration_mode,
    'deployment_profile'
  );
  assert.equal(
    byId.get('deployment_rust_native_carrier_profile')?.integration_mode,
    'backend_qualification'
  );
  assert.equal(
    byId.get('deployment_unified_standalone_profile')?.integration_mode,
    'diagnostic_topology'
  );
});

test('rvoip integration keeps complete G.729 wire semantics and both modes mandatory', () => {
  const value = contract();
  const byId = new Map<CapabilityId, CapabilityEntry>(
    value.capabilities.map((entry) => [entry.capability_id, entry])
  );
  for (const id of [
    'g729a_mandatory_mode_identity',
    'g729ab_mandatory_mode_identity',
    'g729a_g711_pairs',
    'g729ab_g711_pairs',
    'g729a_opus_pairs',
    'g729ab_opus_pairs',
    'g729a_independent_peer',
    'g729ab_independent_peer',
    'g729a_quality',
    'g729ab_quality',
    'g729_annex_b_asymmetric_explicit_no_wins',
    'g729_annex_b_missing_defaults_yes',
    'g729_dynamic_payload_type_remap',
    'g729_packetization_30ms',
    'g729_packetization_40ms',
    'g729_packetization_60ms',
    'g729_rtp_encoding_g729_8000',
    'g729_speech_sid_payload_framing',
    'g729_static_payload_type_18'
  ] as const) {
    assert.equal(byId.get(id)?.status, 'not_run', id);
    assert.equal(byId.get(id)?.category, 'g729', id);
  }
  assert.deepEqual(value.g729_legal_boundary, {
    status: 'not_run',
    blocks: [
      'production_distribution',
      'runtime_enablement',
      'production_eligibility'
    ],
    does_not_block: [
      'engineering_implementation',
      'source_extraction',
      'compilation',
      'testing'
    ],
    external_legal_conclusion_required: true
  });
});

test('rvoip integration schema rejects duplicate IDs and semantic drift', () => {
  const validate = validator();

  const duplicateCapability = structuredClone(contract());
  duplicateCapability.capabilities[1].capability_id =
    duplicateCapability.capabilities[0].capability_id;
  assert.equal(validate(duplicateCapability), false, 'duplicate capability ID');

  const duplicateGate = structuredClone(contract());
  duplicateGate.replacement_gates[1].gate_id =
    duplicateGate.replacement_gates[0].gate_id;
  assert.equal(validate(duplicateGate), false, 'duplicate replacement gate ID');

  const rejectedDrift = structuredClone(contract());
  const rejected = rejectedDrift.capabilities.find(
    (entry) => entry.capability_id === 'reject_parallel_rvoip_pbx'
  );
  assert.ok(rejected);
  rejected.integration_mode = 'semantic_rewrite';
  rejected.target_goal = 'goal_4';
  assert.equal(validate(rejectedDrift), false, 'rejected semantic drift');

  const futurePromotion = structuredClone(contract());
  const implemented = futurePromotion.capabilities.find(
    (entry) => entry.status === 'implemented_local'
  );
  assert.ok(implemented);
  implemented.evidence_paths = ['future:test/unsupported-promotion.json'];
  assert.equal(
    validate(futurePromotion),
    false,
    'implemented evidence cannot be future-only'
  );

  const topologyPromotion = structuredClone(contract()) as unknown as {
    topology_identities: Array<{
      identity_id: string;
      production_authorizing: boolean;
    }>;
  };
  const fastPath = topologyPromotion.topology_identities.find(
    (identity) =>
      identity.identity_id === 'RUST-NATIVE-FAST-PATH-CANDIDATE'
  );
  assert.ok(fastPath);
  fastPath.production_authorizing = true;
  assert.equal(
    validate(topologyPromotion),
    false,
    'backend qualification cannot authorize production'
  );

  const topologyModeDrift = structuredClone(contract());
  const standalone = topologyModeDrift.capabilities.find(
    (entry) =>
      entry.capability_id === 'deployment_unified_standalone_profile'
  );
  assert.ok(standalone);
  standalone.integration_mode = 'deployment_profile';
  assert.equal(
    validate(topologyModeDrift),
    false,
    'diagnostic topology cannot become a deployment profile'
  );
});
