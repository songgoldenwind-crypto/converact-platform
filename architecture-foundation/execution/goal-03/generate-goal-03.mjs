import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const goalDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = realpathSync(resolve(goalDirectory, '../../..'));
const generatedAt = '2026-08-02T00:00:00.000Z';
const evidenceGeneratedAt = '2026-08-09T00:00:00.000Z';
const sipFoundationControlSchemaId =
  'https://converact.invalid/schemas/sip-foundation-control-message-v1.schema.json';

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
  patchset: 'ivekit.77',
  current_adapter: 'rsipstack',
  target_adapter: 'rvoip_low_level_slices_after_separate_gates',
  native_runtime_authority: 'Unified RustPBX process',
  typescript_model_role:
    'conformance_and_migration_harness_not_live_runtime_authority',
});

const capabilityRecoveryServerVerification = Object.freeze({
  status:
    'isolated_postgresql_migration_and_contract_passed_Rust_adapter_physical_tests_not_run',
  campaign_id: 'converact-g03-77-204f4d5-physical',
  base_source_commit: '204f4d562299',
  candidate_patchset: 'ivekit.77',
  evidence_uri:
    'architecture-foundation/execution/goal-03/evidence/raw/capability-recovery-oracle-204f4d5-17/README.md',
  migration_chain: 'through_116_passed_isolated_PostgreSQL_16',
  physical_contract:
    'session_fence_exact_two_key_probe_receipt_replay_stale_insert_and_prepared_send_attempt_rejection_and_tenant_RLS_passed',
  rust_adapter_physical_tests: 'not_run',
  server_rust_compile: 'not_run_safe_disk_and_memory_floor',
  existing_service_state: 'unchanged_running_healthy',
  test_container_and_tmpfs_after_cleanup: 'absent',
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' ||
      typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
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

function closedObject(properties, required = Object.keys(properties)) {
  return {
    type: 'object',
    additionalProperties: false,
    required,
    properties,
  };
}

function schemaRef(name) {
  return { $ref: `#/$defs/${name}` };
}

function controlSchemaRef(name) {
  return `${sipFoundationControlSchemaId}#/$defs/${name}`;
}

function nullable(schema) {
  return { anyOf: [schema, { type: 'null' }] };
}

function boundedPositiveDecimalPattern(maximum) {
  const alternatives = [`[1-9][0-9]{0,${maximum.length - 2}}`];
  for (let index = 0; index < maximum.length; index += 1) {
    const upper = Number(maximum[index]) - 1;
    const lower = index === 0 ? 1 : 0;
    if (upper < lower) continue;
    const digit = upper === lower ? `${lower}` : `[${lower}-${upper}]`;
    const remaining = maximum.length - index - 1;
    alternatives.push(
      `${maximum.slice(0, index)}${digit}` +
      (remaining === 0 ? '' : `[0-9]{${remaining}}`),
    );
  }
  alternatives.push(maximum);
  return `^(?:${alternatives.join('|')})$`;
}

function sipFoundationMessageSchema() {
  const method = {
    enum: [
      'INVITE', 'ACK', 'BYE', 'CANCEL', 'REGISTER', 'OPTIONS',
      'UPDATE', 'PRACK', 'REFER', 'NOTIFY', 'INFO',
    ],
  };
  const eventTypes = [
    ['request_received', 'RequestReceivedPayload'],
    ['response_received', 'ResponseReceivedPayload'],
    ['provisional_received', 'ProvisionalReceivedPayload'],
    ['final_received', 'FinalReceivedPayload'],
    ['transport_accepted', 'TransportAcceptedPayload'],
    ['transport_failed', 'TransportFailedPayload'],
    ['transaction_timed_out', 'TransactionTimedOutPayload'],
    ['protocol_dialog_changed', 'ProtocolDialogChangedPayload'],
    ['dns_candidate_exhausted', 'DnsCandidateExhaustedPayload'],
  ];
  const commonCommand = {
    tenant_id: schemaRef('TenantId'),
    call_id: schemaRef('CallId'),
    leg_id: schemaRef('LegId'),
    command_id: schemaRef('OpaqueIdentifier'),
    owner_epoch: schemaRef('PositiveUint64'),
    generation: schemaRef('PositiveUint64'),
  };
  const commonResult = {
    command_id: schemaRef('OpaqueIdentifier'),
    effect_id: schemaRef('OpaqueIdentifier'),
    request_hash: schemaRef('Sha256'),
    wire_freeze_sha256: schemaRef('Sha256'),
  };
  const commonEvent = {
    tenant_id: schemaRef('TenantId'),
    call_id: schemaRef('CallId'),
    leg_id: schemaRef('LegId'),
    interaction_id: schemaRef('InteractionId'),
    protocol_session_id: schemaRef('OpaqueIdentifier'),
    protocol_session_generation: schemaRef('PositiveUint64'),
    protocol_dialog_id: nullable(schemaRef('ProtocolDialogId')),
    transaction_id: nullable(schemaRef('TransactionId')),
    event_id: schemaRef('OpaqueIdentifier'),
    event_hash: schemaRef('Sha256'),
    owner_epoch: schemaRef('PositiveUint64'),
    generation: schemaRef('PositiveUint64'),
    observed_at_wall_clock: {
      type: 'string',
      format: 'date-time',
      pattern:
        '^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]{1,9})?Z$',
    },
    received_at_monotonic_offset_ns: {
      type: 'integer',
      minimum: 0,
      maximum: 9_007_199_254_740_991,
    },
    event_type: { enum: eventTypes.map(([eventType]) => eventType) },
    payload: { type: 'object' },
  };
  const sdpDocument = (role) => closedObject({
    role: role === null ? { enum: ['offer', 'answer'] } : { const: role },
    content_type: { const: 'application/sdp' },
    bytes_base64: {
      type: 'string',
      maxLength: 43_692,
      pattern: '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$',
    },
    byte_length: { type: 'integer', minimum: 0, maximum: 32_768 },
    sha256: schemaRef('Sha256'),
    negotiation_generation: schemaRef('PositiveUint64'),
  });
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: sipFoundationControlSchemaId,
    title: 'Converact SipFoundation control message v1',
    type: 'object',
    oneOf: [
      schemaRef('OriginateRequestMessage'),
      schemaRef('AnswerRequestMessage'),
      schemaRef('TerminateRequestMessage'),
      schemaRef('OriginateResultMessage'),
      schemaRef('AnswerResultMessage'),
      schemaRef('TerminateResultMessage'),
      schemaRef('CommandErrorMessage'),
      schemaRef('EgressEventMessage'),
    ],
    unevaluatedProperties: false,
    $defs: {
      TenantId: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        pattern: '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$',
      },
      OpaqueIdentifier: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        pattern: '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$',
      },
      CallId: { type: 'string', pattern: '^call_[a-f0-9]{32}$' },
      LegId: { type: 'string', pattern: '^leg_[a-f0-9]{32}$' },
      InteractionId: {
        type: 'string',
        pattern: '^interaction_[a-f0-9]{32}$',
      },
      ProtocolDialogId: {
        type: 'string',
        pattern: '^pdlg_[a-f0-9]{32}$',
      },
      TransactionId: {
        type: 'string',
        pattern: '^ptxn_[a-f0-9]{32}$',
      },
      PositiveUint64: {
        type: 'string',
        pattern: boundedPositiveDecimalPattern('18446744073709551615'),
      },
      Sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      RequestUri: {
        type: 'string',
        minLength: 5,
        maxLength: 2048,
        pattern: '^sips?:[^\\s]+$',
      },
      SdpDocument: sdpDocument(null),
      SdpOffer: sdpDocument('offer'),
      SdpAnswer: sdpDocument('answer'),
      HangupCause: closedObject({
        category: {
          enum: [
            'normal_clearing', 'caller_cancelled', 'no_answer', 'busy',
            'rejected', 'temporary_failure', 'service_unavailable',
            'protocol_error', 'security_rejected', 'timeout', 'unknown',
          ],
        },
        sip_status: nullable({ type: 'integer', minimum: 100, maximum: 699 }),
        q850_cause: nullable({ type: 'integer', minimum: 0, maximum: 127 }),
        reason_token: nullable({
          type: 'string', minLength: 1, maxLength: 64,
          pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$',
        }),
        retryable: { type: 'boolean' },
        source: { enum: ['call_core', 'sip_edge', 'sip_peer', 'sip_foundation'] },
      }),
      SipFoundationError: closedObject({
        category: {
          enum: [
            'invalid_input', 'capacity', 'store', 'dns', 'transport',
            'transaction', 'dialog', 'security', 'timeout', 'internal',
          ],
        },
        stable_code: {
          type: 'string', minLength: 1, maxLength: 96,
          pattern: '^[a-z][a-z0-9_]{0,95}$',
        },
        retryable: { type: 'boolean' },
        sip_status: nullable({ type: 'integer', minimum: 100, maximum: 699 }),
        retry_after_seconds: nullable({
          type: 'integer', minimum: 0, maximum: 86_400,
        }),
        hangup_cause: nullable(schemaRef('HangupCause')),
      }),
      SemanticTimerSnapshot: closedObject({
        timer_kind: {
          enum: [
            'A', 'B', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K',
            'glare_retry', 'dns', 'connect', 'application',
          ],
        },
        remaining_duration_ms_at_snapshot: {
          type: 'integer', minimum: 0, maximum: 600_000,
        },
        wall_clock_audit_timestamp: { type: 'string', format: 'date-time' },
        owner_epoch: schemaRef('PositiveUint64'),
        generation: schemaRef('PositiveUint64'),
      }),
      OriginateRequest: closedObject({
        ...commonCommand,
        interaction_id: schemaRef('InteractionId'),
        request_uri: schemaRef('RequestUri'),
        route_id: schemaRef('OpaqueIdentifier'),
        offer: schemaRef('SdpOffer'),
      }),
      AnswerRequest: closedObject({
        ...commonCommand,
        protocol_dialog_id: schemaRef('ProtocolDialogId'),
        answer: schemaRef('SdpAnswer'),
      }),
      TerminateRequest: closedObject({
        ...commonCommand,
        hangup_cause: schemaRef('HangupCause'),
      }),
      OriginateResult: closedObject({
        ...commonResult,
        outcome: { const: 'effect_committed' },
        protocol_session_id: schemaRef('OpaqueIdentifier'),
        protocol_session_generation: schemaRef('PositiveUint64'),
      }),
      AnswerResult: closedObject({
        ...commonResult,
        outcome: { const: 'effect_committed' },
      }),
      TerminateResult: {
        ...closedObject({
          command_id: schemaRef('OpaqueIdentifier'),
          outcome: { enum: ['effect_committed', 'terminal_observed'] },
          effect_id: nullable(schemaRef('OpaqueIdentifier')),
          terminal_event_id: nullable(schemaRef('OpaqueIdentifier')),
          request_hash: schemaRef('Sha256'),
          wire_freeze_sha256: nullable(schemaRef('Sha256')),
        }),
        oneOf: [
          {
            type: 'object',
            required: ['outcome', 'effect_id', 'terminal_event_id', 'wire_freeze_sha256'],
            properties: {
              outcome: { const: 'effect_committed' },
              effect_id: schemaRef('OpaqueIdentifier'),
              terminal_event_id: { type: 'null' },
              wire_freeze_sha256: schemaRef('Sha256'),
            },
          },
          {
            type: 'object',
            required: ['outcome', 'effect_id', 'terminal_event_id', 'wire_freeze_sha256'],
            properties: {
              outcome: { const: 'terminal_observed' },
              effect_id: { type: 'null' },
              terminal_event_id: schemaRef('OpaqueIdentifier'),
              wire_freeze_sha256: { type: 'null' },
            },
          },
        ],
      },
      OriginateRequestMessage: closedObject({
        message_kind: { const: 'command_request' },
        command: { const: 'originate' },
        request: schemaRef('OriginateRequest'),
      }),
      AnswerRequestMessage: closedObject({
        message_kind: { const: 'command_request' },
        command: { const: 'answer' },
        request: schemaRef('AnswerRequest'),
      }),
      TerminateRequestMessage: closedObject({
        message_kind: { const: 'command_request' },
        command: { const: 'terminate' },
        request: schemaRef('TerminateRequest'),
      }),
      OriginateResultMessage: closedObject({
        message_kind: { const: 'command_result' },
        command: { const: 'originate' },
        result: schemaRef('OriginateResult'),
      }),
      AnswerResultMessage: closedObject({
        message_kind: { const: 'command_result' },
        command: { const: 'answer' },
        result: schemaRef('AnswerResult'),
      }),
      TerminateResultMessage: closedObject({
        message_kind: { const: 'command_result' },
        command: { const: 'terminate' },
        result: schemaRef('TerminateResult'),
      }),
      CommandErrorMessage: closedObject({
        message_kind: { const: 'command_error' },
        command: { enum: ['originate', 'answer', 'terminate'] },
        command_id: schemaRef('OpaqueIdentifier'),
        error: schemaRef('SipFoundationError'),
      }),
      RequestReceivedPayload: closedObject({
        method,
        request_uri: schemaRef('RequestUri'),
        cseq: { type: 'integer', minimum: 1, maximum: 2_147_483_647 },
        wire_length_bytes: { type: 'integer', minimum: 1, maximum: 65_535 },
        wire_sha256: schemaRef('Sha256'),
      }),
      ResponseReceivedPayload: closedObject({
        sip_status: { type: 'integer', minimum: 100, maximum: 699 },
        reason_phrase: { type: 'string', maxLength: 128 },
        cseq_method: method,
        cseq: { type: 'integer', minimum: 1, maximum: 2_147_483_647 },
        wire_length_bytes: { type: 'integer', minimum: 1, maximum: 65_535 },
        wire_sha256: schemaRef('Sha256'),
      }),
      ProvisionalReceivedPayload: closedObject({
        sip_status: { type: 'integer', minimum: 100, maximum: 199 },
        reason_phrase: { type: 'string', maxLength: 128 },
        cseq_method: method,
        cseq: { type: 'integer', minimum: 1, maximum: 2_147_483_647 },
        wire_length_bytes: { type: 'integer', minimum: 1, maximum: 65_535 },
        wire_sha256: schemaRef('Sha256'),
      }),
      FinalReceivedPayload: closedObject({
        sip_status: { type: 'integer', minimum: 200, maximum: 699 },
        reason_phrase: { type: 'string', maxLength: 128 },
        cseq_method: method,
        cseq: { type: 'integer', minimum: 1, maximum: 2_147_483_647 },
        wire_length_bytes: { type: 'integer', minimum: 1, maximum: 65_535 },
        wire_sha256: schemaRef('Sha256'),
      }),
      TransportAcceptedPayload: closedObject({
        transport: { enum: ['udp', 'tcp', 'tls'] },
        connection_id: schemaRef('OpaqueIdentifier'),
        peer_address: { type: 'string', minLength: 1, maxLength: 255 },
        peer_port: { type: 'integer', minimum: 1, maximum: 65_535 },
        tls_verified: { type: 'boolean' },
      }),
      TransportFailedPayload: closedObject({
        transport: { enum: ['udp', 'tcp', 'tls'] },
        connection_id: nullable(schemaRef('OpaqueIdentifier')),
        stable_code: {
          type: 'string', minLength: 1, maxLength: 96,
          pattern: '^[a-z][a-z0-9_]{0,95}$',
        },
        retryable: { type: 'boolean' },
      }),
      TransactionTimedOutPayload: closedObject({
        timer_kind: { enum: ['A', 'B', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'] },
        elapsed_ms: { type: 'integer', minimum: 1, maximum: 600_000 },
      }),
      ProtocolDialogChangedPayload: closedObject({
        previous_state: nullable({ enum: ['early', 'confirmed', 'terminated'] }),
        state: { enum: ['early', 'confirmed', 'terminated'] },
        route_set_sha256: nullable(schemaRef('Sha256')),
        local_cseq: { type: 'integer', minimum: 0, maximum: 2_147_483_647 },
        remote_cseq: { type: 'integer', minimum: 0, maximum: 2_147_483_647 },
      }),
      DnsCandidateExhaustedPayload: closedObject({
        query_name_sha256: schemaRef('Sha256'),
        candidate_count: { type: 'integer', minimum: 0, maximum: 8 },
        elapsed_ms: { type: 'integer', minimum: 1, maximum: 10_000 },
      }),
      EgressEventEnvelope: {
        ...closedObject(commonEvent),
        oneOf: eventTypes.map(([eventType, payload]) => ({
          type: 'object',
          required: ['event_type', 'payload'],
          properties: {
            event_type: { const: eventType },
            payload: schemaRef(payload),
          },
        })),
      },
      EgressEventMessage: closedObject({
        message_kind: { const: 'egress_event' },
        event: schemaRef('EgressEventEnvelope'),
      }),
    },
  };
}

function sipFoundationMessageExamples() {
  const ids = {
    call: `call_${'a'.repeat(32)}`,
    leg: `leg_${'b'.repeat(32)}`,
    interaction: `interaction_${'c'.repeat(32)}`,
    dialog: `pdlg_${'d'.repeat(32)}`,
    transaction: `ptxn_${'e'.repeat(32)}`,
  };
  const wireSha = sha256('INVITE sip:bob@example.invalid SIP/2.0\r\n\r\n');
  const sdpBytes = Buffer.from('v=0\r\n', 'utf8');
  const sdp = (role) => ({
    role,
    content_type: 'application/sdp',
    bytes_base64: sdpBytes.toString('base64'),
    byte_length: sdpBytes.byteLength,
    sha256: sha256(sdpBytes),
    negotiation_generation: '1',
  });
  const command = {
    tenant_id: 'tenant-foundation',
    call_id: ids.call,
    leg_id: ids.leg,
    command_id: 'command-foundation-1',
    owner_epoch: '7',
    generation: '1',
  };
  const hangupCause = {
    category: 'normal_clearing',
    sip_status: null,
    q850_cause: 16,
    reason_token: 'normal_call_clearing',
    retryable: false,
    source: 'call_core',
  };
  const event = (eventType, payload, index) => {
    const hashInput = {
      tenant_id: 'tenant-foundation',
      call_id: ids.call,
      leg_id: ids.leg,
      interaction_id: ids.interaction,
      protocol_session_id: 'protocol-session-foundation',
      protocol_session_generation: '1',
      protocol_dialog_id: ids.dialog,
      transaction_id: ids.transaction,
      event_id: `event-foundation-${index}`,
      owner_epoch: '7',
      generation: '1',
      observed_at_wall_clock: '2026-08-02T00:00:00.000Z',
      received_at_monotonic_offset_ns: index,
      event_type: eventType,
      payload,
    };
    return {
      message_kind: 'egress_event',
      event: {
        ...hashInput,
        event_hash: sha256(Buffer.from(canonicalJson(hashInput), 'utf8')),
      },
    };
  };
  const response = (sipStatus, reasonPhrase) => ({
    sip_status: sipStatus,
    reason_phrase: reasonPhrase,
    cseq_method: 'INVITE',
    cseq: 1,
    wire_length_bytes: 128,
    wire_sha256: wireSha,
  });
  return {
    originate_request: {
      message_kind: 'command_request',
      command: 'originate',
      request: {
        ...command,
        interaction_id: ids.interaction,
        request_uri: 'sip:bob@example.invalid',
        route_id: 'route-primary',
        offer: sdp('offer'),
      },
    },
    answer_request: {
      message_kind: 'command_request',
      command: 'answer',
      request: {
        ...command,
        protocol_dialog_id: ids.dialog,
        answer: sdp('answer'),
      },
    },
    terminate_request: {
      message_kind: 'command_request',
      command: 'terminate',
      request: { ...command, hangup_cause: hangupCause },
    },
    originate_result: {
      message_kind: 'command_result',
      command: 'originate',
      result: {
        command_id: command.command_id,
        effect_id: 'effect-foundation-1',
        request_hash: wireSha,
        wire_freeze_sha256: wireSha,
        outcome: 'effect_committed',
        protocol_session_id: 'protocol-session-foundation',
        protocol_session_generation: '1',
      },
    },
    answer_result: {
      message_kind: 'command_result',
      command: 'answer',
      result: {
        command_id: command.command_id,
        effect_id: 'effect-foundation-2',
        request_hash: wireSha,
        wire_freeze_sha256: wireSha,
        outcome: 'effect_committed',
      },
    },
    terminate_result: {
      message_kind: 'command_result',
      command: 'terminate',
      result: {
        command_id: command.command_id,
        outcome: 'terminal_observed',
        effect_id: null,
        terminal_event_id: 'event-terminal-1',
        request_hash: wireSha,
        wire_freeze_sha256: null,
      },
    },
    command_error: {
      message_kind: 'command_error',
      command: 'originate',
      command_id: command.command_id,
      error: {
        category: 'transport',
        stable_code: 'sip_transport_unavailable',
        retryable: true,
        sip_status: 503,
        retry_after_seconds: 1,
        hangup_cause: null,
      },
    },
    request_received: event('request_received', {
      method: 'INVITE',
      request_uri: 'sip:bob@example.invalid',
      cseq: 1,
      wire_length_bytes: 128,
      wire_sha256: wireSha,
    }, 1),
    response_received: event('response_received', response(401, 'Unauthorized'), 2),
    provisional_received: event('provisional_received', response(180, 'Ringing'), 3),
    final_received: event('final_received', response(200, 'OK'), 4),
    transport_accepted: event('transport_accepted', {
      transport: 'tls',
      connection_id: 'connection-foundation-1',
      peer_address: '192.0.2.10',
      peer_port: 5061,
      tls_verified: true,
    }, 5),
    transport_failed: event('transport_failed', {
      transport: 'tcp',
      connection_id: null,
      stable_code: 'connect_timeout',
      retryable: true,
    }, 6),
    transaction_timed_out: event('transaction_timed_out', {
      timer_kind: 'B',
      elapsed_ms: 32_000,
    }, 7),
    protocol_dialog_changed: event('protocol_dialog_changed', {
      previous_state: 'early',
      state: 'confirmed',
      route_set_sha256: wireSha,
      local_cseq: 1,
      remote_cseq: 1,
    }, 8),
    dns_candidate_exhausted: event('dns_candidate_exhausted', {
      query_name_sha256: sha256('sip-edge.example.invalid'),
      candidate_count: 8,
      elapsed_ms: 2_000,
    }, 9),
  };
}

function sipFoundationContract() {
  return {
    $schema: './sip-foundation-contract-v1.schema.json',
    ...envelope('converact-sip-foundation-contract-v1'),
    authority: {
      sip_edge: 'Kamailio',
      call_leg_business_dialog: 'Unified RustPBX native process',
      protocol_transaction_dialog: 'selected_SipFoundation_adapter',
      durable_effect_ledger: 'Unified RustPBX SipEffect ledger',
      ordinary_media: 'RTPengine',
      control_plane_voice_call: 'call_intent_and_rebuildable_projection',
      typescript_sip_foundation:
        'conformance_and_migration_harness_not_live_runtime_authority',
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
      provider_call_id: 'opaque_native_runtime_reference_never_CallId',
    },
    native_call_recovery: {
      authority: 'Unified_RustPBX_Native_Call_registry',
      binding_schema_id: 'converact.native-call-recovery-binding',
      binding_schema_version: '1.0.0',
      capsule_payload_versions_read: [1, 2],
      capsule_payload_version_write_for_recoverable_call: 2,
      legacy_v1_resume: 'forbidden_fail_closed',
      binding_field_presence: 'all_fields_required_no_nulls_no_unknowns',
      legacy_v1_native_call_binding_key: 'absent_only_explicit_null_rejected',
      stable_identity_fields: [
        'tenant_id',
        'call_id',
        'interaction_id',
        'provider_call_id',
      ],
      takeover_fence_fields: ['owner_epoch', 'generation', 'revision'],
      takeover_transition:
        'new_owner_epoch_must_increase_generation_and_revision_increment_exactly_once',
      numeric_wire_encoding: 'canonical_positive_uint64_decimal_strings',
      binding_authentication:
        'inside_A256GCM_capsule_and_equal_across_both_dialog_legs',
      capsule_authority_match: ['tenant_id', 'owner_epoch'],
      provider_call_match: 'provider_call_id_equals_call_session_ref',
      maximum_plaintext_bytes: 16384,
      cross_runtime_binding_sha256:
        'aa731eba74f64cc5b2eb67d10ea8da044e87cb87b30e5b0550b8a7dfaf759871',
      hot_path_work_added: 'none',
      current_status:
        'component_implemented_host_requalified_live_takeover_not_run',
    },
    native_matched_cancel_effects: {
      authority: 'Unified_RustPBX_Native_Call_registry',
      implementation_status: 'component_implemented_default_disabled',
      admitted_order:
        'Native_Call_then_two_one_use_capabilities_then_transaction_local_gate',
      peer_trigger: 'sealed_actual_matched_CANCEL_ingress',
      invite_termination_precondition: 'server_INVITE_state_trying_or_proceeding',
      late_cancel_after_existing_final: '200_CANCEL_only_no_487_capability',
      cancel_response_effect: '200_CANCEL_transport_completed',
      invite_response_effect: '487_INVITE_protocol_observed_only_after_matching_ACK',
      duplicate_or_mismatched_capability: 'fail_closed',
      adapter_source_identity: 'exact_pinned_rsipstack_commit_only',
      pre_reservation_authority_mismatch: 'reject_without_call_mutation',
      post_reservation_registration_failure:
        'remove_exact_original_Call_authority_only',
      successor_replacement_cleanup_fence:
        'implemented_identity_and_native_cell_pointer_fence',
      capability_restart_rebuild:
        'durable_PostgreSQL_oracle_component_implemented_default_disabled_live_wiring_not_run',
      format_scope_exception:
        'test_auth_constructor_compiled_and_full_tested_rustfmt_excluded_due_unrelated_upstream_drift',
      endpoint_global_gate: 'forbidden',
      component_transport_verified: ['udp'],
      remaining_transport_verification: ['tcp', 'ws', 'tls', 'wss'],
      local_functional_verification: {
        capability_recovery_oracle:
          '121_sip_effect_tests_passed_0_failed_10_physical_tests_ignored',
        rsipstack_library: '314_passed_0_failed',
        rustpbx_library: 'not_run_for_ivekit_77',
        affected_static_contract_tests:
          'targeted_contract_and_migration_suite_passed',
        repository_typecheck: 'passed',
      },
      activation_blockers: [
        'recovered_capability_live_wiring_not_implemented',
        'Rust_adapter_physical_PostgreSQL_ignored_tests_not_run',
        'live_endpoint_activation_not_run',
        'rustpbx_isolated_server_functional_verification_not_run_under_safe_disk_and_memory_floor',
      ],
      live_server_activation: 'not_run',
      server_functional_verification: capabilityRecoveryServerVerification,
      performance_verification: 'not_run',
    },
    native_ordinary_response_effects: {
      authority: 'Unified_RustPBX_Native_Call_registry',
      implementation_status: 'component_implemented_default_disabled',
      scope: 'initial_inbound_INVITE_ordinary_responses',
      response_classes: {
        provisional: '101_through_199',
        final_2xx: '200_through_299',
        final_non_2xx: '300_through_699',
        excluded: ['100', '700_through_999'],
      },
      call_state_policy:
        'multiple_provisional_responses_then_exactly_one_final_response',
      authority_order:
        'reserve_exact_Call_capability_then_register_exact_intent_then_durable_prepare_then_commit_Call_state_then_transport_send',
      exact_binding: [
        'tenant_id',
        'CallId',
        'Call_generation',
        'transaction_key',
        'canonical_wire_sha256',
      ],
      frozen_dialog_identity: [
        'SIP_Call_ID',
        'INVITE_CSeq_sequence_and_method',
        'From',
        'top_Via',
        'To_without_tag',
        'authority_generated_stable_local_To_tag',
      ],
      dialog_identity_drift: 'reject_before_durable_store_work',
      duplicate_exact_binding: 'fail_closed_without_second_wire_attempt',
      durable_prepare_cancellation_or_panic:
        'retain_exact_binding_for_query_reconcile',
      call_revision_race_after_durable_prepare:
        'record_TransportUnknown_and_require_query_reconcile',
      derived_and_peer_derived_effects:
        'forward_to_same_typed_durable_gate_without_new_authority',
      endpoint_global_gate: 'forbidden',
      local_functional_verification: {
        native_response_capabilities: '19_passed_0_failed',
        native_call_domain: '13_passed_0_failed',
        active_call_registry: '24_passed_0_failed',
        durable_sip_effect_gate:
          '121_sip_effect_tests_passed_0_failed_10_physical_tests_ignored',
        rustfmt_changed_sources: 'passed',
        locked_library_check: 'passed',
        full_rustpbx_library: 'not_run_for_ivekit_77',
      },
      activation_blockers: [
        'recovered_capability_live_wiring_not_implemented',
        'Rust_adapter_physical_PostgreSQL_ignored_tests_not_run',
        'live_endpoint_activation_not_run',
        'rustpbx_isolated_server_functional_verification_not_run_under_safe_disk_and_memory_floor',
      ],
      live_server_activation: 'not_run',
      server_functional_verification: capabilityRecoveryServerVerification,
      performance_verification: 'not_run',
      performance_policy: 'deferred_to_final_performance_goal',
    },
    native_call_cleanup_fencing: {
      authority: 'Unified_RustPBX_Native_Call_registry',
      implementation_status: 'component_implemented_default_disabled',
      failure_paths: [
        'partial_intent_registration',
        'ordinary_response_binding_freeze',
        'transaction_local_gate_installation',
      ],
      fence_fields: ['NativeCallIdentity', 'NativeCallCell_pointer_identity'],
      fence_issuance: 'exact_admitted_Call_reservation_only',
      fence_consumption: 'one_shot_by_value',
      fence_cloning: 'forbidden',
      stale_fence_outcome:
        'no_op_preserve_successor_Call_and_all_secondary_indexes',
      exact_fence_outcome:
        'remove_original_Call_and_all_owned_secondary_indexes',
      slot_teardown_atomicity:
        'hold_one_provider_slot_exclusively_through_secondary_index_cleanup',
      secondary_indexes: [
        'active_count',
        'providers_by_call',
        'native_calls',
        'dialog_by_session',
        'handles_by_dialog',
      ],
      global_lock_or_scan: 'none',
      local_functional_verification: {
        native_sip_effect_capabilities: '25_passed_0_failed',
        active_call_registry: '24_passed_0_failed',
        rustfmt_changed_sources: 'passed',
        locked_library_check: 'passed',
        full_rustpbx_library:
          '2082_passed_0_failed_9_external_prerequisites_ignored',
      },
      server_functional_verification:
        'not_run_existing_host_cannot_link_RustPBX_lib_test_within_safe_isolated_memory_ceiling',
      performance_verification: 'not_run',
    },
    native_call_capability_recovery: {
      authority: 'Unified_RustPBX_Native_Call_registry',
      implementation_status: 'component_implemented_default_disabled',
      scope: 'rebuild_only_unconsumed_matched_CANCEL_capability_pair',
      predecessor_binding: 'NativeCallRecoveryBinding_exact_closed_v1',
      oracle_contract:
        'atomically_fence_predecessor_owner_generation_then_prove_NoVisibleEffect',
      probe_outcomes: ['NoVisibleEffect', 'VisibleOrAmbiguous'],
      visible_or_ambiguous_outcome:
        'fail_closed_RecoveryReconciliationRequired_no_registry_or_intent_mutation',
      successor_fence_receipt: 'required_64_byte_lowercase_sha256',
      successor_revalidation: [
        'provider_call_id',
        'NativeCallIdentity',
        'server_INVITE_transaction_key',
      ],
      mutation_order:
        'validate_binding_and_transaction_then_await_oracle_then_revalidate_successor_then_reserve_and_install',
      stale_successor_outcome: 'fail_closed_AuthorityConflict_no_intent_installation',
      installed_gate_identity_fence:
        'exact_NativeCallIdentity_checked_before_every_prepare_path_and_after_async_durable_prepare',
      later_same_provider_successor_outcome:
        'fail_closed_no_successor_mutation_no_new_effect',
      durable_postgresql_oracle:
        'component_implemented_exact_key_session_fenced_physical_SQL_verified_Rust_adapter_physical_tests_not_run',
      live_recovery_wiring: 'not_run',
      local_functional_verification: {
        native_sip_effect_capabilities:
          '121_sip_effect_tests_passed_0_failed_10_physical_tests_ignored',
        locked_library_check: 'passed',
        rustfmt_changed_sources: 'passed',
        full_rustpbx_library: 'not_run_for_ivekit_77',
      },
      server_functional_verification: capabilityRecoveryServerVerification,
      performance_verification: 'not_run',
      performance_policy: 'deferred_to_final_performance_goal',
      activation_blockers: [
        'recovered_capability_live_wiring_not_implemented',
        'Rust_adapter_physical_PostgreSQL_ignored_tests_not_run',
        'real_process_restart_and_ambiguity_recovery_not_run',
        'live_endpoint_activation_not_run',
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
      schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
      field_presence: 'all_fields_required_optional_values_use_explicit_null',
      message_schema: sipFoundationMessageSchema(),
      message_examples: sipFoundationMessageExamples(),
      commands: {
        originate: {
          request_schema_ref: controlSchemaRef('OriginateRequestMessage'),
          success_schema_ref: controlSchemaRef('OriginateResultMessage'),
          error_schema_ref: controlSchemaRef('CommandErrorMessage'),
        },
        answer: {
          request_schema_ref: controlSchemaRef('AnswerRequestMessage'),
          success_schema_ref: controlSchemaRef('AnswerResultMessage'),
          error_schema_ref: controlSchemaRef('CommandErrorMessage'),
        },
        terminate: {
          request_schema_ref: controlSchemaRef('TerminateRequestMessage'),
          success_schema_ref: controlSchemaRef('TerminateResultMessage'),
          error_schema_ref: controlSchemaRef('CommandErrorMessage'),
        },
      },
      semantic_invariants: [
        'PositiveUint64 parses base10 without leading zero and is <=18446744073709551615',
        'SdpDocument role matches the command field and decoded bytes equal byte_length',
        'SdpDocument sha256 is SHA-256 of the exact decoded immutable bytes',
        'request_hash is SHA-256 of the canonical closed command request',
        'wire_freeze_sha256 is SHA-256 of the exact committed wire image',
        'wire event length and SHA-256 match the exact received bytes',
        'event_hash is SHA-256 lowercase hex of RFC8785 JCS UTF-8 event bytes with event_hash omitted',
        'observed_at_wall_clock is a calendar-valid RFC3339 UTC Z timestamp',
        'command result or error command_id exactly matches its request',
        'event_type selects exactly one closed payload schema',
      ],
      command_rule: 'prepare_then_durable_decision_then_commit_send',
      direct_socket_write_by_call_core: 'forbidden',
    },
    egress_events: {
      envelope_fields: [
        'tenant_id', 'call_id', 'leg_id', 'interaction_id',
        'protocol_session_id', 'protocol_session_generation',
        'protocol_dialog_id', 'transaction_id', 'event_id', 'event_hash',
        'owner_epoch', 'generation', 'observed_at_wall_clock',
        'received_at_monotonic_offset_ns', 'event_type', 'payload',
      ],
      envelope_schema_ref: controlSchemaRef('EgressEventEnvelope'),
      payload_schema_refs: {
        request_received: controlSchemaRef('RequestReceivedPayload'),
        response_received: controlSchemaRef('ResponseReceivedPayload'),
        provisional_received: controlSchemaRef('ProvisionalReceivedPayload'),
        final_received: controlSchemaRef('FinalReceivedPayload'),
        transport_accepted: controlSchemaRef('TransportAcceptedPayload'),
        transport_failed: controlSchemaRef('TransportFailedPayload'),
        transaction_timed_out: controlSchemaRef('TransactionTimedOutPayload'),
        protocol_dialog_changed: controlSchemaRef('ProtocolDialogChangedPayload'),
        dns_candidate_exhausted: controlSchemaRef('DnsCandidateExhaustedPayload'),
      },
      delivery: 'bounded_ordered_per_protocol_session',
      duplicate_and_reorder: 'event_id_hash_dedupe_then_state_fence',
      event_hash_canonicalization:
        'sha256_lowercase_hex_of_rfc8785_jcs_utf8_event_without_event_hash',
      business_mutation: 'forbidden_until_Call_authority_durable_decision',
    },
    sdp_interface: {
      schema_ref: controlSchemaRef('SdpDocument'),
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
      schema_ref: controlSchemaRef('SemanticTimerSnapshot'),
      runtime_deadlines: 'monotonic_clock_only',
      persisted_values: [
        'semantic_timer_kind', 'remaining_duration_ms_at_snapshot',
        'wall_clock_audit_timestamp',
      ],
      persisted_monotonic_instant: 'forbidden',
      restoration: 'recompute_bounded_deadline_after_owner_fence',
    },
    hangup_cause_interface: {
      schema_ref: controlSchemaRef('HangupCause'),
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
      schema_ref: controlSchemaRef('SipFoundationError'),
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
    protocol_session_lifecycle: {
      open_reservation:
        'counts_as_active_before_adapter_identity_or_create_callback',
      reentrant_same_id: 'fail_closed_open_in_progress',
      reentrant_capacity: 'opening_reservations_consume_session_capacity',
      drain_active_zero:
        'sessions_plus_opening_reservations_must_equal_zero',
      failed_open: 'revoke_lease_release_reservation_then_recompute_active_zero',
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
    [['outbound'], 'planned', 'start_invite', 'inviting', 'none'],
    [['outbound'], 'inviting', 'provisional', 'early', 'none'],
    [['outbound'], 'inviting', 'final_2xx', 'confirmed', 'ack_2xx'],
    [['outbound'], 'early', 'final_2xx', 'confirmed', 'ack_2xx'],
    [['outbound'], 'inviting', 'final_non_2xx', 'failed', 'ack_non_2xx'],
    [['outbound'], 'early', 'final_non_2xx', 'failed', 'ack_non_2xx'],
    [['outbound'], 'planned', 'cancel_requested', 'terminating', 'cancel_if_invite_exists'],
    [['outbound'], 'inviting', 'cancel_requested', 'terminating', 'send_cancel'],
    [['outbound'], 'early', 'cancel_requested', 'terminating', 'send_cancel'],
    [['outbound'], 'terminating', 'late_final_2xx', 'terminating', 'ack_then_bye'],
    [['inbound'], 'planned', 'inbound_invite_observed', 'inviting', 'none'],
    [['inbound'], 'inviting', 'provisional', 'early', 'none'],
    [['inbound'], 'inviting', 'final_2xx', 'awaiting_ack', 'none'],
    [['inbound'], 'early', 'final_2xx', 'awaiting_ack', 'none'],
    [['inbound'], 'inviting', 'final_non_2xx', 'failed', 'none'],
    [['inbound'], 'early', 'final_non_2xx', 'failed', 'none'],
    [['inbound'], 'awaiting_ack', 'invite_2xx_ack_observed', 'confirmed', 'none'],
    [['inbound'], 'awaiting_ack_terminate', 'invite_2xx_ack_observed', 'terminating', 'send_bye'],
    [['inbound'], 'inviting', 'remote_cancel_observed', 'terminating', 'respond_cancel_2xx_and_invite_487'],
    [['inbound'], 'early', 'remote_cancel_observed', 'terminating', 'respond_cancel_2xx_and_invite_487'],
    [['inbound'], 'awaiting_ack', 'remote_cancel_observed', 'awaiting_ack', 'respond_cancel_2xx'],
    [['inbound'], 'awaiting_ack_terminate', 'remote_cancel_observed', 'awaiting_ack_terminate', 'respond_cancel_2xx'],
    [['inbound'], 'awaiting_ack', 'bye_requested', 'awaiting_ack_terminate', 'defer_bye_until_ack'],
    [['inbound', 'outbound'], 'confirmed', 'hold_committed', 'held', 'none'],
    [['inbound', 'outbound'], 'held', 'resume_committed', 'confirmed', 'none'],
    [['inbound', 'outbound'], 'confirmed', 'transfer_prepare', 'transferring', 'none'],
    [['inbound', 'outbound'], 'held', 'transfer_prepare', 'transferring', 'none'],
    [['inbound', 'outbound'], 'transferring', 'transfer_abort', 'previous_confirmed_or_held_state', 'none'],
    [['inbound', 'outbound'], 'confirmed', 'bye_requested', 'terminating', 'send_bye'],
    [['inbound', 'outbound'], 'held', 'bye_requested', 'terminating', 'send_bye'],
    [['inbound', 'outbound'], 'confirmed', 'remote_bye_observed', 'terminating', 'respond_bye_2xx'],
    [['inbound', 'outbound'], 'held', 'remote_bye_observed', 'terminating', 'respond_bye_2xx'],
    [['inbound', 'outbound'], 'terminating', 'termination_observed', 'terminated', 'none'],
    ...[
      'planned', 'inviting', 'early', 'awaiting_ack',
      'awaiting_ack_terminate', 'confirmed', 'held', 'transferring',
      'terminating',
    ].map((state) => [
      ['inbound', 'outbound'], state, 'protocol_failure', 'failed', 'none',
    ]),
  ].map(([directions, from, event, to, required_effect]) => ({
    directions, from, event, to, required_effect,
  }));
  return {
    $schema: './call-leg-state-machine-v1.schema.json',
    ...envelope('converact-call-leg-state-machine-v1'),
    version: '1.1.0',
    authority: 'Unified RustPBX native Call Core',
    typescript_model_role: 'conformance_reference_not_live_native_authority',
    control_plane_voice_call_role: 'call_intent_and_rebuildable_projection',
    provider_call_id_role: 'opaque_native_runtime_reference_never_CallId',
    direction_semantics: {
      inbound: 'local_UAS_remote_UAC',
      outbound: 'local_UAC_remote_UAS',
      outbound_final_2xx: 'local_ACK_effect_required',
      inbound_final_2xx: 'wait_for_remote_ACK_no_local_ACK_effect',
      fork: 'outbound_only',
      registry_update: 'authoritative_direction_immutable_fail_closed',
    },
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
      legacy_call_id_import: {
        accepted_syntax: ['vcall_*', 'uuid'],
        authority:
          'trusted_projection_attestation_only_native_RustPBX_adoption_required',
        credential: 'module_private_issuer_no_caller_supplied_lookup_or_record',
        runtime_brand: 'constructor_issued_module_private_WeakSet_membership',
        repository_composition: 'native_private_field_not_structurally_replaceable',
        query_dispatch: 'captured_trusted_prototype_method_ignores_own_override',
        raw_sip_call_id_or_plain_object: 'rejected',
      },
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
      'planned', 'inviting', 'early', 'awaiting_ack',
      'awaiting_ack_terminate', 'confirmed', 'held',
      'transferring', 'terminating', 'terminated', 'failed',
    ],
    terminal_leg_states: ['terminated', 'failed'],
    events: [
      'start_invite', 'inbound_invite_observed', 'provisional',
      'final_2xx', 'final_non_2xx', 'invite_2xx_ack_observed',
      'cancel_requested', 'late_final_2xx', 'remote_cancel_observed',
      'remote_bye_observed', 'hold_committed', 'resume_committed',
      'transfer_prepare', 'transfer_abort',
      'bye_requested', 'termination_observed', 'protocol_failure',
    ],
    transitions,
    atomic_operations: {
      transfer_commit_selection: {
        required_fields: [
          'old_leg_id', 'old_leg_generation', 'new_leg_id',
          'event_id', 'event_hash',
        ],
        precondition:
          'old_is_selected_and_transferring_new_is_confirmed_and_both_are_fenced',
        mutation:
          'atomically_select_new_then_mark_old_terminating',
        required_effect: 'bye_old_selected_leg',
        generic_leg_event: 'forbidden',
      },
    },
    concurrency: {
      mutation_fence: ['tenant_id', 'call_id', 'owner_epoch', 'generation', 'expected_revision'],
      owner_epoch: 'positive_uint64_monotonic',
      generation: 'positive_uint64_bound_to_call_projection_and_every_leg',
      call_open_generation: 'required_positive_uint64_from_durable_authority',
      revision: 'positive_uint64_advance_exactly_one',
      duplicate_event: 'same_event_id_and_hash_returns_original_receipt',
      conflicting_duplicate: 'fail_closed',
      stale_owner: 'query_only',
      sequence_gap: 'fail_closed_then_reconcile',
      mailbox_and_timer_mutation:
        'same_tenant_owner_generation_revision_fence_as_leg_mutation',
      call_work_dispatch: 'dequeue_only_no_callback_execution',
    },
    race_policy: {
      direction_is_part_of_transition_key: true,
      inbound_2xx: 'await_remote_ACK_without_local_ACK_effect',
      inbound_2xx_local_bye: 'defer_until_remote_ACK_then_send_BYE',
      inbound_cancel_before_final:
        'durable_200_CANCEL_and_487_INVITE_effects_then_terminal_observation',
      inbound_cancel_after_2xx:
        'durable_200_CANCEL_without_reversing_awaiting_ACK',
      remote_bye:
        'durable_2xx_response_then_terminal_observation',
      cancel_before_final: 'CANCEL_then_487_ACK',
      cancel_races_2xx: 'ACK_2xx_then_BYE_without_second_CDR',
      bye_duplicate: 'idempotent_same_effect_identity',
      fork_winner: 'first_durably_selected_2xx_leg_only',
      fork_attempt_identity: 'explicit_and_bounded_per_attempt',
      fork_branch_registration: 'before_start_invite',
      fork_selection_sip_status: 'integer_200_through_299_only',
      late_fork_2xx: 'ACK_then_BYE_non_winner',
      already_acked_late_fork_2xx: 'BYE_without_duplicate_ACK',
      terminating_winner_retransmitted_2xx:
        'remain_terminating_and_emit_idempotent_ACK_then_BYE',
      remaining_early_forks: 'bounded_per_leg_send_cancel_effects_in_winner_receipt',
      reinvite: 'same_leg_same_dialog_new_negotiation_generation',
      reinvite_glare: '491_and_bounded_retry_without_new_leg',
      transfer: 'old_selected_leg_remains_until_transfer_commit',
      transfer_commit: 'atomic_selection_swap_then_BYE_old_leg',
      transfer_abort: 'restore_pre_transfer_confirmed_or_held_state',
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
      fork_attempt_tracking: 'bounded_by_dedupe_receipts_per_call',
      timers_per_call_hard_ceiling: 128,
      overflow_policy: 'reject_new_work_without_mutating_existing_call',
    },
    complexity: {
      call_lookup: 'expected_O(1)',
      leg_lookup: 'expected_O(1)',
      dialog_lookup: 'expected_O(1)',
      transition: 'O(1)_except_fork_winner',
      fork_winner: 'O(branches_in_attempt)_hard_ceiling_32',
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
      current_schema_version: 2,
      current_schema_hash: '7f4cd00c42bb4607c6b443261a06b06bd42117718c1f858293f1471e3ccb153b',
      supported_read_schemas: [
        {
          schema_version: 1,
          schema_hash: 'ae27a73dac95c90686f8020c2fb5e92dd016cc1712216d03b227ec3a6d6ca5ba',
          write_scope: 'drain_existing_effects_only',
        },
        {
          schema_version: 2,
          schema_hash: '7f4cd00c42bb4607c6b443261a06b06bd42117718c1f858293f1471e3ccb153b',
          write_scope: 'new_effects_after_activation_receipt',
        },
      ],
      writer_identity: 'unified-rustpbx.sip-foundation',
      physical_activation_status: 'not_run',
    },
    states: [
      'prepared', 'durable_decision', 'send_attempted',
      'transport_accepted', 'transport_completed',
      'protocol_observed', 'failed', 'unknown',
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
        proves: 'frozen_completion_scope_satisfied_on_primary_path',
        peer_received_proof:
          'only_for_transaction_peer_observation_scope_not_transport_accepted_terminal',
      },
      transport_completed: {
        level: 'transport_completed',
        from_state: 'transport_accepted',
        proves: 'local_transport_terminal_policy_satisfied',
        does_not_prove: 'peer_received_or_protocol_completed',
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
    completion_scopes: {
      wire_fact: 'completion_scope',
      writer_authority: 'Unified RustPBX rsipstack frozen effect classifier',
      missing_or_unrecognized: 'fail_closed_before_terminal_receipt',
      transaction_peer_observation: {
        applies_to:
          'client_requests_except_ACK_and_server_non_2xx_INVITE_final_responses',
        terminal_condition: 'exact_matching_final_response_or_ACK',
        transport_acceptance_alone: 'non_terminal',
      },
      transport_accepted_terminal: {
        applies_to:
          'ACK_and_server_responses_without_a_transaction_layer_peer_completion',
        terminal_condition:
          'durable_transport_accepted_then_transport_terminal_policy_observation',
        receipt_level: 'transport_completed',
        does_not_prove: 'peer_received_message',
        terminal_payload_compaction: 'allowed_only_after_terminal_receipt',
      },
      uas_core_deferred: {
        applies_to: 'server_2xx_INVITE_responses',
        current_owner_wiring: 'not_run',
        transaction_layer_disposition: 'unknown_not_completed',
        terminal_condition: 'UAS_Core_exact_ACK_observation_future_gate',
      },
    },
    completion_scope_invariants: [
      'completion_scope_is_hashed_inside_wire_attempt_facts_before_send',
      'completion_scope_mismatch_never_fabricates_protocol_observed',
      'transport_completed_never_aliases_protocol_observed',
      'transport_terminal_requires_prior_durable_transport_accepted',
      'uas_core_deferred_never_terminalizes_in_transaction_layer',
      'restart_and_drain_count_queued_inflight_retry_and_quarantined_observations',
    ],
    observation_supervision: {
      implementation_status: 'component_implemented_default_disabled',
      worker_model: 'one_fixed_task_per_configured_observation_shard',
      per_effect_task: 'forbidden',
      retryable_failure: 'same_armed_work_bounded_exponential_backoff',
      persist_future_panic: 'release_old_lease_then_atomic_restart',
      permanent_failure: 'quarantine_shard_and_fail_closed',
      cancellation: 'armed_work_retained_for_explicit_restart',
      live_endpoint_activation: 'not_run',
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
      ['transport_accepted', 'transport_completed'],
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
      claim_token_maximum_bytes: 512,
      claim_token_validation:
        'shared_SipEffectRepairFence_validator_in_memory_and_postgresql',
      fence_fields: [
        'repair_owner_id', 'repair_owner_epoch', 'repair_claim_token',
        'repair_claim_revision',
      ],
      exhaustion: 'operator_visible_auditable_no_infinite_retry',
      reconciler_supervisor: {
        contract_status: 'frozen_default_disabled',
        grant_issuer_authority:
          'Unified_RustPBX_durable_Call_session_authority',
        grant_capability: {
          construction:
            'sealed_module_private_until_authoritative_issuer_is_wired',
          clone: 'forbidden',
          caller_supplied_owner_epoch: 'forbidden',
          sibling_compile_fail_codes: ['E0603', 'E0451'],
        },
        exact_scope: {
          fields: [
            'tenant_id',
            'protocol_session_id',
            'protocol_session_generation',
          ],
          wildcard: 'forbidden',
          cross_session_or_generation: 'forbidden',
        },
        exact_targets: {
          minimum: 1,
          maximum: 100,
          ordering: 'strictly_ascending_protocol_effect_id',
          uniqueness: 'protocol_effect_id',
          fields: [
            'protocol_effect_id',
            'expected_revision',
            'expected_effect_identity_hash',
          ],
        },
        durable_lookup: {
          access_path: 'existing_composite_primary_key_exact_target_lookup',
          tenant_scan: 'forbidden',
          session_scan: 'forbidden',
          worker_enumeration: 'forbidden',
        },
        claim_transaction: {
          success:
            'all_targets_claimed_or_terminally_exhausted_in_one_transaction',
          partial_claim: 'rollback_and_return_FenceLost',
        },
        worker_model: {
          workers: 'fixed_configured_count',
          queue: 'bounded',
          enumerate_targets: 'forbidden',
          mint_or_reuse_owner_epoch: 'forbidden',
          send_SIP: 'forbidden',
        },
        lease_and_deadline: {
          grant_deadline_clock: 'monotonic',
          queue_dwell: 'debits_grant_deadline',
          execution_lease:
            'freeze_once_as_whole_milliseconds_before_store_claim',
          operation_timeout_maximum_ms: 29000,
          database_lease_clock: 'database_relative',
          minimum_remaining_lease_margin_ms: 500,
          submit_without_margin: 'reject_before_enqueue',
          dequeue_without_margin: 'drop_without_store_claim',
          parent_cancelled_submission:
            'reject_Stopped_without_queue_metric_churn',
        },
        outcomes: {
          FenceLost: 'superseded_continue_worker',
          Terminal: 'superseded_continue_worker',
          port_panic:
            'cancel_child_supervisor_stop_all_workers_reject_new_grants_and_never_reuse_shared_dependencies',
          schema_conflict: 'quarantine',
          identity_conflict: 'quarantine',
          receipt_conflict: 'quarantine',
          partial_progress_metrics:
            'advance_per_confirmed_durable_effect_even_if_later_work_fails',
          progress_metrics_authority:
            'process_local_observability_not_a_durable_completion_sink',
        },
        implementation_status: {
          live_grant_issuer: 'not_run',
          durable_completion_sink: 'not_run',
          physical_postgresql_exact_target_claim: 'not_run',
          distractor_query_plan: 'not_run',
          process_crash_and_two_node_takeover: 'not_run',
          activation: 'not_run',
        },
      },
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
      baseline_semantic_capture_status: 'verified_controlled',
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
      current_adapter_result: 'matches_frozen_expected',
      target_adapter_result: 'not_run',
      production_eligible: false,
    })),
  };
}

function evidenceIndex() {
  const evidenceSourceCommit =
    'a18229cde752e2fbd4a3ffa3b8d8a8cc7cef7beb';
  const controlledHostSourceCommit =
    'b63383bda16bcd9d311c9ce5e0761877d474797b';
  const localEvidenceRoot =
    'architecture-foundation/execution/goal-03/evidence/raw/local-verification-a18229c';
  const postgresEvidenceRoot =
    'architecture-foundation/execution/goal-03/evidence/raw/postgres-restart-a18229cd-02';
  const staleRecoveryEvidenceRoot =
    'architecture-foundation/execution/goal-03/evidence/raw/stale-nonterminal-recovery-6abf714-11';
  const fullLinuxSuiteEvidenceRoot =
    'architecture-foundation/execution/goal-03/evidence/raw/full-linux-suites-6abf714-12';
  const observerFullLinuxSuiteEvidenceRoot =
    'architecture-foundation/execution/goal-03/evidence/raw/full-linux-suites-1ebbd76-13';
  const staleRecoverySourceCommit =
    '6abf714ea8b71817e91fa9493e882c360050cf7f';
  const observerFullLinuxSuiteSourceCommit =
    '1ebbd765c3e88ef157fde54bed9e4680aa708da3';
  const entry = (
    evidence_id,
    claim,
    status,
    evidence_uris = [],
    raw_output_sha256 = null,
    source_commit = status === 'not_run' ? null : evidenceSourceCommit,
  ) => ({
    evidence_id,
    claim,
    status,
    evidence_uris,
    source_commit,
    raw_output_sha256,
    production_eligible: false,
  });
  return {
    $schema: './evidence-index-v1.schema.json',
    evidence_index_id: 'converact-goal-03-evidence-index-v1',
    version: '1.0.0',
    generated_at: evidenceGeneratedAt,
    binding,
    current_state: 'implementation_in_progress',
    production_eligible: false,
    entries: [
      entry(
        'G03-E01-CONTRACT',
        'G03 machine contracts and binding validation',
        'verified_local',
        [`${localEvidenceRoot}/contract.log`],
        'ab36ff826e117234cf8a46ed3bc4cc304ca10709ef1f45b18f6901c2de50baee',
      ),
      entry(
        'G03-E02-BASELINE',
        'Existing SipFoundation focused baseline',
        'verified_local',
        [
          `${localEvidenceRoot}/README.md`,
          `${localEvidenceRoot}/focused.log`,
          `${localEvidenceRoot}/part-manifest.sha256`,
        ],
        '40aa77621bd95b6528dcbe4e9770238a589ea4098a9cb57ffe790fcf3f5a6892',
      ),
      entry(
        'G03-E03-ID-STATE',
        'Strong IDs and Call/Leg race semantics',
        'verified_local',
        [`${localEvidenceRoot}/focused.log`],
        '9d212173335acf075dd07ab0ef198b8e76b1fd97dacc820f8b5c6f5c071025b9',
      ),
      entry(
        'G03-E04-EFFECT',
        'Durable effect and semantic receipt classes',
        'verified_controlled',
        [
          `${observerFullLinuxSuiteEvidenceRoot}/README.md`,
          `${observerFullLinuxSuiteEvidenceRoot}/SHA256SUMS`,
          `${observerFullLinuxSuiteEvidenceRoot}/server-suite-results.txt`,
        ],
        '343daec5381eb949a2848d2a539d2416941ef31c104c5ac7fff51a1f6f9cbfc0',
        observerFullLinuxSuiteSourceCommit,
      ),
      entry(
        'G03-E05-POSTGRES',
        'Physical PostgreSQL durability, ACL and restart replay',
        'verified_controlled',
        [
          `${postgresEvidenceRoot}/README.md`,
          `${postgresEvidenceRoot}/retained-output.sha256`,
          `${postgresEvidenceRoot}/verify.json`,
          'architecture-foundation/execution/goal-03/controlled-postgres-restart-report.md',
        ],
        'a4aa58ab2c1006830cfffe400be87741775becbaa8a85a02b1edaf02e393d8aa',
      ),
      entry(
        'G03-E06-TRYING',
        '100 Trying and final/overload raw latency distribution',
        'verified_controlled',
        [
          'architecture-foundation/execution/goal-03/evidence/raw/host-campaign-b63383b-ivekit53-01/sip-latency-b63383b-v1/report.json',
          'architecture-foundation/execution/goal-03/evidence/raw/host-campaign-b63383b-ivekit53-01/sip-latency-b63383b-v1/SHA256SUMS',
        ],
        '3a08cc4e8b029011e4da9c1563def535c815b2fc7643bdebe875ef5280e853c6',
        controlledHostSourceCommit,
      ),
      entry(
        'G03-E07-WIRE',
        'Wire corpus rsipstack baseline and differential replay',
        'verified_controlled',
        [
          'architecture-foundation/execution/goal-03/evidence/raw/host-campaign-b63383b-ivekit53-01/wire-differential-b63383b-v1/report.json',
          'architecture-foundation/execution/goal-03/evidence/raw/host-campaign-b63383b-ivekit53-01/wire-differential-b63383b-v1/REMOTE-SHA256SUMS',
        ],
        '2ea3716a40fe497bb32771481b50475634e5bb92ef78d83156f11469f31201aa',
        controlledHostSourceCommit,
      ),
      entry(
        'G03-E08-RECOVERY',
        'Confirmed-quiescent recovery, clock and fencing',
        'verified_controlled',
        [
          `${staleRecoveryEvidenceRoot}/README.md`,
          `${staleRecoveryEvidenceRoot}/remote-artifacts.sha256`,
          `${staleRecoveryEvidenceRoot}/server-verify.log`,
          `${staleRecoveryEvidenceRoot}/verification.txt`,
          `${fullLinuxSuiteEvidenceRoot}/README.md`,
          `${fullLinuxSuiteEvidenceRoot}/SHA256SUMS`,
          `${fullLinuxSuiteEvidenceRoot}/server-suite-results.txt`,
        ],
        '45072f23e6e8eff7a3f77b1ec075c596d8049a2072437934278898e14f9666ca',
        staleRecoverySourceCommit,
      ),
      entry(
        'G03-E09-DRAIN',
        'New-call stop, old-call drain and active-zero',
        'verified_local',
        [`${localEvidenceRoot}/focused.log`],
        '9d212173335acf075dd07ab0ef198b8e76b1fd97dacc820f8b5c6f5c071025b9',
      ),
      entry('G03-E10-FAULT', 'Protocol/worker crash, panic, OOM and blocking isolation', 'not_run'),
      entry(
        'G03-E11-INTEROP',
        'SIPp and real peer interoperability',
        'verified_controlled',
        [
          'architecture-foundation/execution/goal-03/evidence/raw/host-campaign-b63383b-ivekit53-01/interoperability-summary.json',
          'architecture-foundation/execution/goal-03/evidence/raw/host-campaign-b63383b-ivekit53-01/sipp-short-b63383b-v1/report.json',
          'architecture-foundation/execution/goal-03/evidence/raw/host-campaign-b63383b-ivekit53-01/real-asterisk-peer-b63383b-v1/SHA256SUMS',
        ],
        'ec49df9a5a707bbd099dc88e28590c18f4604feaf6bccce76e3c5da3c914130a',
        controlledHostSourceCommit,
      ),
      entry(
        'G03-E12-LONG-CALL',
        'Long call control and restart stability',
        'verified_controlled',
        [
          'architecture-foundation/execution/goal-03/evidence/raw/host-campaign-b63383b-ivekit53-01/long-call-2h-b63383b-v1/summary.json',
          'architecture-foundation/execution/goal-03/evidence/raw/host-campaign-b63383b-ivekit53-01/long-call-2h-b63383b-v1/SHA256SUMS',
          'architecture-foundation/execution/goal-03/evidence/raw/host-campaign-b63383b-ivekit53-01/harness/long-call.sh',
        ],
        '34b0095202f2cff3b7d2ea65e5241a492eefba6a06a6c4a8563b950f60925a90',
        controlledHostSourceCommit,
      ),
      entry('G03-E13-PERFORMANCE', 'Same-source hot-path latency, allocation and capacity baseline', 'not_run'),
      entry(
        'G03-E14-TYPECHECK',
        'Repository TypeScript typecheck',
        'verified_local',
        [`${localEvidenceRoot}/typecheck.log`],
        '40bc31d5c95fb879712acd5d1ffc8bcac91b04826d82c408f5246ca6e9bdcea9',
      ),
      entry('G03-E15-REVIEW', 'Independent G03 review', 'not_run'),
      entry(
        'G03-E16-NATIVE-AUTHORITY',
        'Unified RustPBX native Call/Leg and SipEffect activation',
        'not_run',
      ),
    ],
    inherited_claims: [],
    external_or_environment_blockers: [
      'host_fault_and_oom_campaign_not_run',
      'allocation_and_2_4_8_core_scaling_not_run',
      'native_call_leg_and_effect_authority_activation_not_run',
      'final_independent_review_not_run',
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
      'infra/converact/rustpbx/patches/rsipstack-converact-transaction-local-matched-cancel-pair.patch',
      'infra/converact/rustpbx/patches/rustpbx-converact-native-matched-cancel-capabilities.patch',
      'infra/converact/rustpbx/patches/rustpbx-converact-native-response-capabilities.patch',
      'infra/converact/rustpbx/patches/rustpbx-converact-native-call-cleanup-fence.patch',
      'infra/converact/rustpbx/patches/rustpbx-converact-native-call-capability-recovery.patch',
      'infra/converact/rustpbx/patches/rustpbx-converact-capability-recovery-oracle.patch',
      'src/migrations/116_converact_sip_capability_recovery_fence.sql',
    ],
    test_paths: [
      'test/converact-sip-foundation.test.ts',
      'test/converact-rustpbx-build.test.ts',
      'test/converact-rsipstack-single-trying-patch.test.ts',
      'test/converact-rustpbx-native-matched-cancel-capabilities-patch.test.ts',
      'test/converact-rustpbx-native-response-capabilities-patch.test.ts',
      'test/converact-rustpbx-native-call-cleanup-fence-patch.test.ts',
      'test/converact-rustpbx-native-call-capability-recovery-patch.test.ts',
      'test/converact-rustpbx-capability-recovery-oracle-patch.test.ts',
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
      'infra/converact/rustpbx/patches/rustpbx-converact-native-call-cleanup-fence.patch',
      'infra/converact/rustpbx/patches/rustpbx-converact-native-call-capability-recovery.patch',
      'infra/converact/rustpbx/patches/rustpbx-converact-capability-recovery-oracle.patch',
      'src/migrations/116_converact_sip_capability_recovery_fence.sql',
    ],
    test_paths: [
      'test/converact-call-leg-foundation.test.ts',
      'test/converact-voice-application.test.ts',
      'test/converact-dialog-owner-takeover.test.ts',
      'test/converact-voice-cdr-convergence.test.ts',
      'test/converact-rustpbx-native-call-cleanup-fence-patch.test.ts',
      'test/converact-rustpbx-native-call-capability-recovery-patch.test.ts',
      'test/converact-rustpbx-capability-recovery-oracle-patch.test.ts',
    ],
  },
  effect_receipt: {
    patterns: /(?:effect|receipt|idempoten|unknown|reconcil|store|postgres|schema|durable|retry-after)/iu,
    implementation_paths: [
      'src/agent-runtime/converact/voice/sip-foundation/effect-oracle.ts',
      'src/agent-runtime/converact/voice/sip-foundation/postgres-effect-store.ts',
      'src/migrations/107_ivekit_sip_effect_oracle.sql',
      'src/migrations/113_converact_sip_effect_transport_completed.sql',
      'src/migrations/114_converact_sip_effect_transport_completed_validate.sql',
      'src/migrations/115_converact_sip_effect_stale_nonterminal_recovery.sql',
      'src/migrations/116_converact_sip_capability_recovery_fence.sql',
    ],
    test_paths: [
      'test/converact-sip-receipt-drain.test.ts',
      'test/converact-sip-effect-oracle.test.ts',
      'test/converact-sip-effect-postgres.test.ts',
      'test/converact-rustpbx-capability-recovery-oracle-patch.test.ts',
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
      'infra/converact/rustpbx/patches/rsipstack-ivekit-bounded-protocol-mailboxes.patch',
      'infra/converact/rustpbx/patches/rustpbx-ivekit-dialog-recovery.patch',
      'infra/converact/rustpbx/patches/rustpbx-ivekit-bounded-call-mailboxes.patch',
      'infra/converact/rustpbx/patches/rustpbx-converact-stale-nonterminal-recovery.patch',
      'infra/converact/rustpbx/patches/rustpbx-converact-stale-nonterminal-recovery-test-fixture.patch',
      'infra/converact/rustpbx/patches/rustpbx-converact-stale-nonterminal-recovery-role-scoped-fixture.patch',
      'infra/converact/rustpbx/patches/rustpbx-converact-stale-nonterminal-recovery-db-clock-fixture.patch',
      'infra/converact/rustpbx/patches/rustpbx-converact-stale-nonterminal-recovery-returning-alias.patch',
      'infra/converact/rustpbx/patches/rustpbx-converact-sip-effect-observer-supervisor.patch',
    ],
    test_paths: [
      'test/converact-sip-receipt-drain.test.ts',
      'test/converact-sip-foundation-recovery.test.ts',
      'test/converact-rsipstack-server-invite-lifecycle-patch.test.ts',
      'test/converact-rustpbx-dialog-recovery-patch.test.ts',
      'test/converact-rustpbx-bounded-control-mailboxes-patch.test.ts',
      'test/converact-rustpbx-stale-nonterminal-recovery-patch.test.ts',
      'test/converact-rustpbx-sip-effect-observer-supervisor-patch.test.ts',
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
        minItems: 16,
        maxItems: 16,
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
