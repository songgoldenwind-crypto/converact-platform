import { randomUUID } from 'node:crypto';

import {
  MEDIA_CONTROL_PROTOCOL_VERSION,
  checkedMediaControlCommand,
  checkedMediaControlResult,
  mediaControlPayloadHash,
  type MediaControlAction,
  type MediaControlCommand,
  type MediaControlResult
} from '../src/agent-runtime/ivekit/media-control/protocol.js';
import {
  buildEndpointSdp,
  createSdesKeyMaterial,
  openRtpMediaEndpoint,
  parseRelayEndpoint,
  parseSdesCrypto,
  type RtpMediaEndpointEvidence
} from './capacity/generators/rtpengine-media.js';

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SOURCE_COMMIT = /^[a-f0-9]{40}$/;
const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/;
const MAX_EVIDENCE_BYTES = 1_048_576;

export const RTPENGINE_ACCEPTANCE_REQUIRED_CHECKS = [
  'plaintext_offer_answer',
  'plaintext_relay_endpoint',
  'plaintext_bidirectional_rtp',
  'plaintext_packet_integrity',
  'plaintext_sequence_and_ssrc',
  'plaintext_loss_and_jitter',
  'plaintext_rtcp',
  'sdes_srtp_offer_answer',
  'sdes_srtp_bidirectional',
  'srtp_plaintext_absent',
  'control_plane_outage_continuity',
  'wal_restart_recovery',
  'idempotent_delete',
  'drain_rejects_new',
  'hard_capacity_rejects_new',
  'stale_epoch_rejected',
  'higher_epoch_takeover',
  'before_write_failure_classified',
  'after_write_disconnect_reconciled',
  'rtpengine_failure_classified'
] as const;

export type RtpengineAcceptanceCheck =
  typeof RTPENGINE_ACCEPTANCE_REQUIRED_CHECKS[number];

export interface RtpengineAcceptanceIdentity {
  source_commit: string;
  rtpengine_image_digest: string;
  config_hash: string;
  runtime_mode: 'userspace' | 'kernel';
}

export interface RtpengineAcceptanceEvidence {
  schema_version: 1;
  goal: 'voice-media-control-goal2-task9';
  environment_class: 'real_server';
  capacity_claim: 'none';
  status: 'passed' | 'failed';
  source_commit: string;
  rtpengine_image_digest: string;
  config_hash: string;
  runtime_mode: 'userspace' | 'kernel';
  generated_at: string;
  checks: Record<RtpengineAcceptanceCheck, boolean>;
  observations: Record<string, unknown>;
  not_run: Array<{
    dependency: 'kernel-forwarding' | 'recording' | 'transcoding';
    reason: string;
  }>;
}

export interface RtpengineMediaScenarioResult {
  mode: 'rtp' | 'sdes_srtp';
  scenario_id: string;
  offer_result_class: MediaControlResult['result_class'];
  answer_result_class: MediaControlResult['result_class'];
  query_result_class?: MediaControlResult['result_class'];
  deleted_result_class: MediaControlResult['result_class'];
  delete_replay_result_class?: MediaControlResult['result_class'];
  endpoint_a: RtpMediaEndpointEvidence;
  endpoint_b: RtpMediaEndpointEvidence;
  relay_for_a: {
    address: string;
    port: number;
    profile: string;
    payload_types: number[];
  };
  relay_for_b: {
    address: string;
    port: number;
    profile: string;
    payload_types: number[];
  };
  continuity?: {
    received_before_callback: number;
    received_after_callback: number;
    relay_port_preserved_after_restart: boolean;
  };
}

export interface RtpengineControlMatrixResult {
  checks: Pick<
    Record<RtpengineAcceptanceCheck, boolean>,
    | 'drain_rejects_new'
    | 'hard_capacity_rejects_new'
    | 'stale_epoch_rejected'
    | 'higher_epoch_takeover'
    | 'before_write_failure_classified'
    | 'after_write_disconnect_reconciled'
    | 'rtpengine_failure_classified'
  >;
  observations: {
    drain_result: MediaControlResult;
    capacity_result: MediaControlResult;
    stale_epoch_result: MediaControlResult;
    higher_epoch_result: MediaControlResult;
    rtpengine_failure_result: MediaControlResult;
  };
}

export function createRtpengineAcceptanceCommand(input: {
  action: MediaControlAction;
  command_id: string;
  call_id: string;
  admission_reservation_id?: string;
  media_reservation_id: string;
  owner_epoch: string;
  command_sequence: number;
  expires_at: string;
  payload: Record<string, unknown>;
}): MediaControlCommand {
  for (const [label, value] of [
    ['command ID', input.command_id],
    ['call ID', input.call_id],
    ['media reservation ID', input.media_reservation_id]
  ] as const) {
    if (!IDENTIFIER.test(value)) throw new Error(`${label} is invalid`);
  }
  const payload = structuredClone(input.payload);
  return checkedMediaControlCommand({
    protocol_version: MEDIA_CONTROL_PROTOCOL_VERSION,
    action: input.action,
    command_id: input.command_id,
    tenant_id: 'ivekit-acceptance',
    call_id: input.call_id,
    leg_id: 'ivekit-acceptance-leg',
    cell_id: 'ivekit-acceptance-cell',
    owner_node_id: 'ivekit-acceptance-node',
    owner_epoch: input.owner_epoch,
    admission_reservation_id:
      input.admission_reservation_id ?? input.media_reservation_id,
    media_reservation_id: input.media_reservation_id,
    command_sequence: input.command_sequence,
    idempotency_key: input.command_id,
    expires_at: input.expires_at,
    payload,
    payload_hash: mediaControlPayloadHash(payload)
  });
}

export function buildRtpengineAcceptanceEvidence(input: {
  identity: RtpengineAcceptanceIdentity;
  generated_at: string;
  checks: Record<RtpengineAcceptanceCheck, boolean>;
  observations: Record<string, unknown>;
  not_run: RtpengineAcceptanceEvidence['not_run'];
}): RtpengineAcceptanceEvidence {
  const identity = checkedIdentity(input.identity);
  if (!canonicalDate(input.generated_at)) {
    throw new Error('canonical evidence generation time is required');
  }
  if (!isPlainRecord(input.checks) ||
      Object.keys(input.checks).length !==
        RTPENGINE_ACCEPTANCE_REQUIRED_CHECKS.length) {
    throw new Error('complete RTPengine acceptance checks are required');
  }
  const checks = {} as Record<RtpengineAcceptanceCheck, boolean>;
  for (const name of RTPENGINE_ACCEPTANCE_REQUIRED_CHECKS) {
    if (typeof input.checks[name] !== 'boolean') {
      throw new Error(`RTPengine acceptance check ${name} is required`);
    }
    checks[name] = input.checks[name];
  }
  if (Object.keys(input.checks).some((name) =>
    !RTPENGINE_ACCEPTANCE_REQUIRED_CHECKS.includes(
      name as RtpengineAcceptanceCheck
    ))) {
    throw new Error('unknown RTPengine acceptance check');
  }
  const observations = checkedBoundedRecord(
    input.observations,
    'RTPengine acceptance observations'
  );
  const notRun = checkedNotRun(input.not_run, identity.runtime_mode);
  const evidence: RtpengineAcceptanceEvidence = {
    schema_version: 1,
    goal: 'voice-media-control-goal2-task9',
    environment_class: 'real_server',
    capacity_claim: 'none',
    status: Object.values(checks).every(Boolean) ? 'passed' : 'failed',
    source_commit: identity.source_commit,
    rtpengine_image_digest: identity.rtpengine_image_digest,
    config_hash: identity.config_hash,
    runtime_mode: identity.runtime_mode,
    generated_at: input.generated_at,
    checks,
    observations,
    not_run: notRun
  };
  const encodedBytes = Buffer.byteLength(JSON.stringify(evidence), 'utf8');
  if (encodedBytes > MAX_EVIDENCE_BYTES) {
    throw new Error('RTPengine acceptance evidence exceeds 1 MiB');
  }
  return evidence;
}

export async function runRtpengineMediaScenario(input: {
  media_control_base_url: string;
  media_control_token: string;
  media_control_fetch?: typeof fetch;
  bind_address: string;
  mode: 'rtp' | 'sdes_srtp';
  scenario_id: string;
  owner_epoch: string;
  expires_at?: string;
  packet_count: number;
  packet_interval_ms: number;
  receive_timeout_ms: number;
  during_stream?: () => Promise<void>;
}): Promise<RtpengineMediaScenarioResult> {
  const baseUrl = checkedBaseUrl(input.media_control_base_url);
  const token = checkedToken(input.media_control_token);
  const fetchImpl = input.media_control_fetch ?? globalThis.fetch;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(input.scenario_id)) {
    throw new Error('RTPengine scenario ID is invalid');
  }
  if (input.mode !== 'rtp' && input.mode !== 'sdes_srtp') {
    throw new Error('RTPengine scenario mode is invalid');
  }
  const packetCount = boundedInteger(
    input.packet_count,
    1,
    1_000_000,
    'RTPengine packet count'
  );
  const packetIntervalMs = boundedInteger(
    input.packet_interval_ms,
    0,
    60_000,
    'RTPengine packet interval'
  );
  const receiveTimeoutMs = boundedInteger(
    input.receive_timeout_ms,
    1,
    300_000,
    'RTPengine receive timeout'
  );
  const ssrcA = 0x1a1a_0001;
  const ssrcB = 0x2b2b_0002;
  const endpointA = await openRtpMediaEndpoint({
    bind_address: input.bind_address,
    ssrc: ssrcA,
    expected_remote_ssrc: ssrcB,
    maximum_packets: packetCount + 16
  });
  const endpointB = await openRtpMediaEndpoint({
    bind_address: input.bind_address,
    ssrc: ssrcB,
    expected_remote_ssrc: ssrcA,
    maximum_packets: packetCount + 16
  });
  const callId = `task9-call-${input.scenario_id}`;
  const reservationId = `task9-reservation-${input.scenario_id}`;
  const fromTag = `task9-from-${input.scenario_id}`;
  const toTag = `task9-to-${input.scenario_id}`;
  const expiresAt = input.expires_at ||
    new Date(Date.now() + 10 * 60_000).toISOString();
  if (!canonicalDate(expiresAt) || Date.parse(expiresAt) <= Date.now()) {
    throw new Error('future media reservation expiry is required');
  }
  const keyA = input.mode === 'sdes_srtp'
    ? createSdesKeyMaterial()
    : undefined;
  const keyB = input.mode === 'sdes_srtp'
    ? createSdesKeyMaterial()
    : undefined;
  try {
    const localA = endpointA.localEndpoint();
    const localB = endpointB.localEndpoint();
    const offerSdp = buildEndpointSdp({
      address: input.bind_address,
      port: localA.port,
      session_id: '900000001',
      ssrc: ssrcA,
      mode: input.mode,
      key_material: keyA
    });
    const offer = createRtpengineAcceptanceCommand({
      action: 'offer',
      command_id: `task9-offer-${input.scenario_id}`,
      call_id: callId,
      media_reservation_id: reservationId,
      owner_epoch: input.owner_epoch,
      command_sequence: 1,
      expires_at: expiresAt,
      payload: {
        offer_sdp: offerSdp,
        media_profile_id: 'g711-relay-v1',
        from_tag: fromTag
      }
    });
    const offerResult = await postMediaCommand(baseUrl, token, offer, fetchImpl);
    const offerSession = successfulSession(offerResult, 'offer');
    const relayForB = parseRelayEndpoint(offerSession.effective_sdp);

    const answerSdp = buildEndpointSdp({
      address: input.bind_address,
      port: localB.port,
      session_id: '900000002',
      ssrc: ssrcB,
      mode: input.mode,
      key_material: keyB
    });
    const answer = createRtpengineAcceptanceCommand({
      action: 'answer',
      command_id: `task9-answer-${input.scenario_id}`,
      call_id: callId,
      media_reservation_id: reservationId,
      owner_epoch: input.owner_epoch,
      command_sequence: 2,
      expires_at: expiresAt,
      payload: {
        answer_sdp: answerSdp,
        from_tag: fromTag,
        to_tag: toTag
      }
    });
    const answerResult = await postMediaCommand(baseUrl, token, answer, fetchImpl);
    const answerSession = successfulSession(answerResult, 'answer');
    const relayForA = parseRelayEndpoint(answerSession.effective_sdp);

    if (input.mode === 'sdes_srtp') {
      endpointA.configureSrtp({
        send_key_material: keyA!,
        receive_key_material: parseSdesCrypto(answerSession.effective_sdp)
      });
      endpointB.configureSrtp({
        send_key_material: keyB!,
        receive_key_material: parseSdesCrypto(offerSession.effective_sdp)
      });
    }

    const sending = Promise.all([
      endpointA.sendPcmu({
        target: relayForA,
        packet_count: packetCount,
        packet_interval_ms: packetIntervalMs,
        payload_seed: 0x31
      }),
      endpointB.sendPcmu({
        target: relayForB,
        packet_count: packetCount,
        packet_interval_ms: packetIntervalMs,
        payload_seed: 0x61
      })
    ]);
    let continuity: RtpengineMediaScenarioResult['continuity'];
    let queryResult: MediaControlResult | undefined;
    if (input.during_stream) {
      await waitForTrafficStart(endpointA, endpointB, packetCount);
      const receivedBefore = receivedTotal(endpointA, endpointB, packetCount);
      await input.during_stream();
      const receivedAfter = receivedTotal(endpointA, endpointB, packetCount);
      const query = createRtpengineAcceptanceCommand({
        action: 'query',
        command_id: `task9-query-${input.scenario_id}`,
        call_id: callId,
        media_reservation_id: reservationId,
        owner_epoch: input.owner_epoch,
        command_sequence: 3,
        expires_at: expiresAt,
        payload: { from_tag: fromTag, to_tag: toTag }
      });
      queryResult = await postMediaCommand(baseUrl, token, query, fetchImpl);
      const querySession = successfulSession(queryResult, 'query');
      const recoveredRelay = parseRelayEndpoint(querySession.effective_sdp);
      continuity = {
        received_before_callback: receivedBefore,
        received_after_callback: receivedAfter,
        relay_port_preserved_after_restart:
          recoveredRelay.address === relayForA.address &&
          recoveredRelay.port === relayForA.port
      };
    }
    await sending;
    if (input.mode === 'rtp') {
      await Promise.all([
        endpointA.sendRtcp(relayForA),
        endpointB.sendRtcp(relayForB)
      ]);
    }
    await Promise.all([
      endpointA.waitFor({
        rtp_packets: packetCount,
        rtcp_packets: input.mode === 'rtp' ? 1 : 0,
        timeout_ms: receiveTimeoutMs
      }),
      endpointB.waitFor({
        rtp_packets: packetCount,
        rtcp_packets: input.mode === 'rtp' ? 1 : 0,
        timeout_ms: receiveTimeoutMs
      })
    ]);
    const deleteCommand = createRtpengineAcceptanceCommand({
      action: 'delete',
      command_id: `task9-delete-${input.scenario_id}`,
      call_id: callId,
      media_reservation_id: reservationId,
      owner_epoch: input.owner_epoch,
      command_sequence: input.during_stream ? 4 : 3,
      expires_at: expiresAt,
      payload: { from_tag: fromTag, to_tag: toTag }
    });
    const deleteResult = await postMediaCommand(
      baseUrl,
      token,
      deleteCommand,
      fetchImpl
    );
    successfulSession(deleteResult, 'delete');
    const replayedDelete = input.during_stream
      ? await postMediaCommand(baseUrl, token, deleteCommand, fetchImpl)
      : undefined;
    if (replayedDelete) successfulSession(replayedDelete, 'delete replay');

    return {
      mode: input.mode,
      scenario_id: input.scenario_id,
      offer_result_class: offerResult.result_class,
      answer_result_class: answerResult.result_class,
      ...(queryResult
        ? { query_result_class: queryResult.result_class }
        : {}),
      deleted_result_class: deleteResult.result_class,
      ...(replayedDelete
        ? { delete_replay_result_class: replayedDelete.result_class }
        : {}),
      endpoint_a: endpointA.snapshot({ expected_packets: packetCount }),
      endpoint_b: endpointB.snapshot({ expected_packets: packetCount }),
      relay_for_a: relayForA,
      relay_for_b: relayForB,
      ...(continuity ? { continuity } : {})
    };
  } finally {
    await Promise.all([endpointA.close(), endpointB.close()]);
  }
}

export async function runRtpengineControlMatrix(input: {
  media_control_base_url: string;
  media_control_token: string;
  media_control_fetch?: typeof fetch;
  bind_address: string;
  expires_at: string;
  maximum_active_calls: number;
  matrix_id?: string;
  set_drain(value: boolean): Promise<void>;
  stop_rtpengine(): Promise<void>;
  start_rtpengine(): Promise<void>;
  regression_checks: {
    before_write_failure_classified: boolean;
    after_write_disconnect_reconciled: boolean;
  };
}): Promise<RtpengineControlMatrixResult> {
  const baseUrl = checkedBaseUrl(input.media_control_base_url);
  const token = checkedToken(input.media_control_token);
  const fetchImpl = input.media_control_fetch ?? globalThis.fetch;
  if (!canonicalDate(input.expires_at) ||
      Date.parse(input.expires_at) <= Date.now()) {
    throw new Error('future control matrix expiry is required');
  }
  const maximumActiveCalls = boundedInteger(
    input.maximum_active_calls,
    1,
    32,
    'control matrix active-call limit'
  );
  const matrixId = input.matrix_id ||
    randomUUID().replaceAll('-', '').slice(0, 16);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/.test(matrixId)) {
    throw new Error('control matrix ID is invalid');
  }

  let drainResult: MediaControlResult;
  await input.set_drain(true);
  try {
    drainResult = await sendControlOffer({
      baseUrl,
      token,
      fetchImpl,
      bindAddress: input.bind_address,
      expiresAt: input.expires_at,
      id: `${matrixId}-drain`,
      ownerEpoch: '200'
    });
  } finally {
    await input.set_drain(false);
  }

  const capacitySessions: ControlSession[] = [];
  let capacityResult: MediaControlResult;
  try {
    for (let index = 0; index < maximumActiveCalls; index += 1) {
      const session = await openControlSession({
        baseUrl,
        token,
        fetchImpl,
        bindAddress: input.bind_address,
        expiresAt: input.expires_at,
        id: `${matrixId}-capacity-${index}`,
        ownerEpoch: String(300 + index)
      });
      if (!successfulResult(session.result)) {
        throw new Error('RTPengine capacity prefill was rejected');
      }
      capacitySessions.push(session);
    }
    capacityResult = await sendControlOffer({
      baseUrl,
      token,
      fetchImpl,
      bindAddress: input.bind_address,
      expiresAt: input.expires_at,
      id: `${matrixId}-capacity-overflow`,
      ownerEpoch: '399'
    });
  } finally {
    for (const session of capacitySessions.reverse()) {
      await deleteControlSession(
        baseUrl,
        token,
        input.expires_at,
        session,
        fetchImpl
      );
    }
  }

  const epochSession = await openControlSession({
    baseUrl,
    token,
    fetchImpl,
    bindAddress: input.bind_address,
    expiresAt: input.expires_at,
    id: `${matrixId}-epoch`,
    ownerEpoch: '500'
  });
  if (!successfulResult(epochSession.result)) {
    throw new Error('RTPengine epoch precondition was rejected');
  }
  const staleEpochResult = await postMediaCommand(
    baseUrl,
    token,
    createRtpengineAcceptanceCommand({
      action: 'query',
      command_id: `task9-query-${epochSession.id}-stale`,
      call_id: epochSession.call_id,
      media_reservation_id: epochSession.reservation_id,
      owner_epoch: '499',
      command_sequence: 1,
      expires_at: input.expires_at,
      payload: { from_tag: epochSession.from_tag }
    }),
    fetchImpl
  );
  const higherEpochResult = await postMediaCommand(
    baseUrl,
    token,
    createRtpengineAcceptanceCommand({
      action: 'query',
      command_id: `task9-query-${epochSession.id}-takeover`,
      call_id: epochSession.call_id,
      media_reservation_id: epochSession.reservation_id,
      owner_epoch: '501',
      command_sequence: 1,
      expires_at: input.expires_at,
      payload: { from_tag: epochSession.from_tag }
    }),
    fetchImpl
  );
  await deleteControlSession(
    baseUrl,
    token,
    input.expires_at,
    { ...epochSession, owner_epoch: '501', delete_sequence: 2 },
    fetchImpl
  );

  let rtpengineFailureResult: MediaControlResult;
  await input.stop_rtpengine();
  try {
    rtpengineFailureResult = await sendControlOffer({
      baseUrl,
      token,
      fetchImpl,
      bindAddress: input.bind_address,
      expiresAt: input.expires_at,
      id: `${matrixId}-engine-down`,
      ownerEpoch: '600'
    });
  } finally {
    await input.start_rtpengine();
  }

  return {
    checks: {
      drain_rejects_new:
        !successfulResult(drainResult) &&
        resultErrorCode(drainResult).includes('drain'),
      hard_capacity_rejects_new:
        !successfulResult(capacityResult) &&
        (capacityResult.result_class === 'rejected_capacity' ||
          resultErrorCode(capacityResult).includes('capacity')),
      stale_epoch_rejected:
        staleEpochResult.result_class === 'rejected_epoch' &&
        resultErrorCode(staleEpochResult).includes('stale'),
      higher_epoch_takeover: successfulResult(higherEpochResult),
      before_write_failure_classified:
        input.regression_checks.before_write_failure_classified === true,
      after_write_disconnect_reconciled:
        input.regression_checks.after_write_disconnect_reconciled === true,
      rtpengine_failure_classified:
        !successfulResult(rtpengineFailureResult) &&
        'retryable' in rtpengineFailureResult &&
        rtpengineFailureResult.retryable === true &&
        /(?:connect|disconnect|unavailable|deadline)/.test(
          resultErrorCode(rtpengineFailureResult)
        )
    },
    observations: {
      drain_result: drainResult,
      capacity_result: capacityResult,
      stale_epoch_result: staleEpochResult,
      higher_epoch_result: higherEpochResult,
      rtpengine_failure_result: rtpengineFailureResult
    }
  };
}

interface ControlSession {
  id: string;
  call_id: string;
  reservation_id: string;
  from_tag: string;
  owner_epoch: string;
  delete_sequence: number;
  result: MediaControlResult;
}

async function sendControlOffer(input: {
  baseUrl: URL;
  token: string;
  fetchImpl: typeof fetch;
  bindAddress: string;
  expiresAt: string;
  id: string;
  ownerEpoch: string;
}): Promise<MediaControlResult> {
  return (await openControlSession(input)).result;
}

async function openControlSession(input: {
  baseUrl: URL;
  token: string;
  fetchImpl: typeof fetch;
  bindAddress: string;
  expiresAt: string;
  id: string;
  ownerEpoch: string;
}): Promise<ControlSession> {
  const endpoint = await openRtpMediaEndpoint({
    bind_address: input.bindAddress,
    ssrc: 0x3c3c_0003,
    expected_remote_ssrc: 0x4d4d_0004,
    maximum_packets: 1
  });
  const callId = `task9-call-${input.id}`;
  const reservationId = `task9-reservation-${input.id}`;
  const fromTag = `task9-from-${input.id}`;
  try {
    const local = endpoint.localEndpoint();
    const offerSdp = buildEndpointSdp({
      address: input.bindAddress,
      port: local.port,
      session_id: '900000003',
      ssrc: 0x3c3c_0003,
      mode: 'rtp'
    });
    const result = await postMediaCommand(
      input.baseUrl,
      input.token,
      createRtpengineAcceptanceCommand({
        action: 'offer',
        command_id: `task9-offer-${input.id}`,
        call_id: callId,
        media_reservation_id: reservationId,
        owner_epoch: input.ownerEpoch,
        command_sequence: 1,
        expires_at: input.expiresAt,
        payload: {
          offer_sdp: offerSdp,
          media_profile_id: 'g711-relay-v1',
          from_tag: fromTag
        }
      }),
      input.fetchImpl
    );
    return {
      id: input.id,
      call_id: callId,
      reservation_id: reservationId,
      from_tag: fromTag,
      owner_epoch: input.ownerEpoch,
      delete_sequence: 2,
      result
    };
  } finally {
    await endpoint.close();
  }
}

async function deleteControlSession(
  baseUrl: URL,
  token: string,
  expiresAt: string,
  session: ControlSession,
  fetchImpl: typeof fetch
): Promise<MediaControlResult> {
  const result = await postMediaCommand(
    baseUrl,
    token,
    createRtpengineAcceptanceCommand({
      action: 'delete',
      command_id: `task9-delete-${session.id}-${session.owner_epoch}`,
      call_id: session.call_id,
      media_reservation_id: session.reservation_id,
      owner_epoch: session.owner_epoch,
      command_sequence: session.delete_sequence,
      expires_at: expiresAt,
      payload: { from_tag: session.from_tag }
    }),
    fetchImpl
  );
  if (!successfulResult(result)) {
    throw new Error(
      `RTPengine control cleanup failed: ${resultErrorCode(result)}`
    );
  }
  return result;
}

function successfulResult(result: MediaControlResult): boolean {
  return result.result_class === 'committed' ||
    result.result_class === 'replayed';
}

function resultErrorCode(result: MediaControlResult): string {
  return 'error_code' in result ? String(result.error_code) : '';
}

async function postMediaCommand(
  baseUrl: URL,
  token: string,
  command: MediaControlCommand,
  fetchImpl: typeof fetch
): Promise<MediaControlResult> {
  const response = await fetchImpl(new URL('/v1/commands', baseUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(10_000)
  });
  const encoded = Buffer.from(await response.arrayBuffer());
  if (encoded.length > MAX_EVIDENCE_BYTES) {
    throw new Error('media-control response exceeds 1 MiB');
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(encoded.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('media-control response is not JSON');
  }
  if (!response.ok) {
    const error = isPlainRecord(payload.error)
      ? String(payload.error.code || '')
      : '';
    throw new Error(`media-control HTTP ${response.status}: ${error}`);
  }
  if (!isPlainRecord(payload.data)) {
    throw new Error('media-control response data is invalid');
  }
  return checkedMediaControlResult(
    payload.data as unknown as MediaControlResult
  );
}

function successfulSession(
  result: MediaControlResult,
  action: string
): Extract<
  MediaControlResult,
  { result_class: 'committed' | 'replayed' }
>['session'] {
  if (result.result_class === 'committed' ||
      result.result_class === 'replayed') {
    return result.session;
  }
  const errorCode = 'error_code' in result
    ? String(result.error_code)
    : 'media_control_result_invalid';
  throw new Error(`RTPengine ${action} failed: ${errorCode}`);
}

async function waitForTrafficStart(
  endpointA: Awaited<ReturnType<typeof openRtpMediaEndpoint>>,
  endpointB: Awaited<ReturnType<typeof openRtpMediaEndpoint>>,
  expectedPackets: number
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (receivedTotal(endpointA, endpointB, expectedPackets) >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('RTP traffic did not start before lifecycle callback');
}

function receivedTotal(
  endpointA: Awaited<ReturnType<typeof openRtpMediaEndpoint>>,
  endpointB: Awaited<ReturnType<typeof openRtpMediaEndpoint>>,
  expectedPackets: number
): number {
  return endpointA.snapshot({ expected_packets: expectedPackets }).received_packets +
    endpointB.snapshot({ expected_packets: expectedPackets }).received_packets;
}

function checkedBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('media-control base URL is invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('media-control base URL is invalid');
  }
  return url;
}

function checkedToken(value: string): string {
  if (typeof value !== 'string' ||
      value.length < 24 ||
      value.length > 512 ||
      /[\0\r\n]/.test(value)) {
    throw new Error('media-control token is invalid');
  }
  return value;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function checkedIdentity(
  input: RtpengineAcceptanceIdentity
): RtpengineAcceptanceIdentity {
  if (!input || !SOURCE_COMMIT.test(input.source_commit)) {
    throw new Error('full source commit is required');
  }
  if (!SHA256_DIGEST.test(input.rtpengine_image_digest)) {
    throw new Error('immutable RTPengine image digest is required');
  }
  if (!SHA256_DIGEST.test(input.config_hash)) {
    throw new Error('immutable RTPengine config hash is required');
  }
  if (input.runtime_mode !== 'userspace' &&
      input.runtime_mode !== 'kernel') {
    throw new Error('RTPengine runtime mode is invalid');
  }
  return structuredClone(input);
}

function checkedNotRun(
  input: RtpengineAcceptanceEvidence['not_run'],
  runtimeMode: RtpengineAcceptanceIdentity['runtime_mode']
): RtpengineAcceptanceEvidence['not_run'] {
  if (!Array.isArray(input) || input.length > 3) {
    throw new Error('RTPengine not-run evidence is invalid');
  }
  const allowed = new Set(['kernel-forwarding', 'recording', 'transcoding']);
  const seen = new Set<string>();
  const result = input.map((entry) => {
    if (!entry ||
        !allowed.has(entry.dependency) ||
        seen.has(entry.dependency) ||
        typeof entry.reason !== 'string' ||
        entry.reason.length < 3 ||
        entry.reason.length > 512 ||
        /[\0\r\n]/.test(entry.reason)) {
      throw new Error('RTPengine not-run evidence is invalid');
    }
    if (entry.dependency === 'kernel-forwarding' && runtimeMode === 'kernel') {
      throw new Error('kernel forwarding cannot be not-run in kernel mode');
    }
    seen.add(entry.dependency);
    return structuredClone(entry);
  });
  return result;
}

function checkedBoundedRecord(
  input: Record<string, unknown>,
  label: string
): Record<string, unknown> {
  if (!isPlainRecord(input)) throw new Error(`${label} is invalid`);
  let nodes = 0;
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: input, depth: 0 }
  ];
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > 8_192 || current.depth > 16) {
      throw new Error(`${label} is invalid`);
    }
    const value = current.value;
    if (value === null ||
        typeof value === 'boolean' ||
        typeof value === 'string') {
      if (typeof value === 'string' && Buffer.byteLength(value) > 65_536) {
        throw new Error(`${label} is invalid`);
      }
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error(`${label} is invalid`);
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length > 1_024) throw new Error(`${label} is invalid`);
      for (const entry of value) {
        pending.push({ value: entry, depth: current.depth + 1 });
      }
      continue;
    }
    if (!isPlainRecord(value) || Object.keys(value).length > 1_024) {
      throw new Error(`${label} is invalid`);
    }
    for (const entry of Object.values(value)) {
      pending.push({ value: entry, depth: current.depth + 1 });
    }
  }
  return structuredClone(input);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalDate(value: string): boolean {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
