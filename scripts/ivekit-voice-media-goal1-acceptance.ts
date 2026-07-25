import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MediaControlAgent,
  MediaControlError,
  type MediaControlAuthorityPort
} from '../src/agent-runtime/ivekit/media-control/agent.js';
import {
  InMemoryMediaTransport,
  type SimulatedFailure
} from '../src/agent-runtime/ivekit/media-control/simulator.js';
import type {
  MediaControlAction,
  MediaControlCommand
} from '../src/agent-runtime/ivekit/media-control/protocol.js';

const OWNER_EPOCH = ((7n << 32n) | 11n).toString();

export interface VoiceMediaGoal1AcceptanceInput {
  source_commit: string;
  image_digest: string;
  config_hash: string;
  output_dir: string;
  generated_at?: string;
}

export interface VoiceMediaGoal1AcceptanceResult {
  report_file: string;
  evidence_file: string;
}

class ControlledAuthority implements MediaControlAuthorityPort {
  available = true;
  ownerEpoch = OWNER_EPOCH;

  constructor(
    private readonly reservationExpiresAt: string,
    private readonly nodeLeaseExpiresAt: string
  ) {}

  async authorize(input: {
    reservation_id: string;
    interaction_id: string;
    owner_epoch: string;
    operation: 'open' | 'mutate' | 'close';
  }) {
    if (!this.available) throw new Error('controlled authority unavailable');
    if (input.owner_epoch !== this.ownerEpoch) {
      throw new MediaControlError('stale_owner_epoch', 409, false);
    }
    return {
      owner_epoch: this.ownerEpoch,
      reservation_expires_at: this.reservationExpiresAt,
      node_lease_expires_at: this.nodeLeaseExpiresAt
    };
  }
}

export async function runVoiceMediaGoal1ControlledAcceptance(
  input: VoiceMediaGoal1AcceptanceInput
): Promise<VoiceMediaGoal1AcceptanceResult> {
  const sourceCommit = exactHash(input.source_commit, 40, 'full source commit is required');
  const imageDigest = digest(input.image_digest, 'image digest is required');
  const configHash = digest(input.config_hash, 'configuration hash is required');
  const generatedAt = timestamp(input.generated_at || new Date().toISOString());
  const now = new Date(generatedAt);
  const outputDir = resolve(input.output_dir);
  refuseNonEmptyOutput(outputDir);
  const evidenceDir = resolve(outputDir, 'evidence');
  mkdirSync(evidenceDir, { recursive: true });

  const replay = await replayScenario(now);
  const stale = await staleEpochScenario(now);
  const lifecycle = await lifecycleScenario(now);
  const beforeApply = await uncertaintyScenario(now, 'before_apply_timeout');
  const afterApply = await uncertaintyScenario(now, 'after_apply_timeout');
  const restart = await restartScenario(now);
  const outage = await controlPlaneOutageScenario(now);

  const checks = {
    stale_epoch_rejected_before_transport: stale.rejected && stale.side_effects === 0,
    command_replay_exactly_once:
      replay.results_equal && replay.prepare_side_effects === 1,
    prepare_commit_cancel_expiry:
      lifecycle.prepared_state === 'prepared' &&
      lifecycle.committed_state === 'committed' &&
      lifecycle.cancelled_state === 'cancelled' &&
      lifecycle.expired_state === 'expired',
    before_apply_reconciled_exactly_once:
      beforeApply.initial_state === 'unknown' &&
      beforeApply.reconciled_state === 'succeeded' &&
      beforeApply.prepare_side_effects === 1,
    after_apply_reconciled_exactly_once:
      afterApply.initial_state === 'unknown' &&
      afterApply.reconciled_state === 'succeeded' &&
      afterApply.prepare_side_effects === 1,
    agent_restart_recovers_transport_state:
      restart.closed_state === 'closed' &&
      restart.forwarded_before_restart === 10 &&
      restart.forwarded_after_close === 0,
    committed_forwarding_survives_control_plane_outage:
      outage.control_command_rejected &&
      outage.forwarded_packets === 500 &&
      outage.still_forwarding,
    metrics_use_bounded_labels:
      ![
        'controlled-replay',
        'controlled-stale',
        'controlled-lifecycle',
        'controlled-outage'
      ].some((value) => outage.metrics.includes(value))
  };
  if (Object.values(checks).some((passed) => !passed)) {
    throw new Error(`Goal 1 controlled acceptance failed: ${JSON.stringify(checks)}`);
  }

  const evidence = {
    schema_version: 1,
    goal: 'voice-media-control-goal1',
    environment_class: 'controlled',
    capacity_claim: 'none',
    real_rtpengine_forwarding: false,
    source_commit: sourceCommit,
    image_digest: imageDigest,
    config_hash: configHash,
    generated_at: generatedAt,
    checks,
    observations: {
      stale_epoch: stale,
      command_replay: replay,
      lifecycle,
      before_apply: beforeApply,
      after_apply: afterApply,
      restart,
      outage: {
        control_command_rejected: outage.control_command_rejected,
        forwarded_packets: outage.forwarded_packets,
        still_forwarding: outage.still_forwarding
      }
    },
    not_run: [
      {
        dependency: 'rtpengine-wire-transport',
        status: 'not_run',
        reason: 'Goal 2 supplies the pinned rtpengine transport implementation.'
      },
      {
        dependency: 'physical-media-quality',
        status: 'not_run',
        reason: 'Controlled transport does not prove RTP quality, codec quality, or weak-network behavior.'
      },
      {
        dependency: 'physical-capacity',
        status: 'not_run',
        reason: 'Controlled acceptance makes no CPS, RTP-leg, packet-rate, or concurrency claim.'
      }
    ]
  };
  const evidenceFile = resolve(evidenceDir, 'media-control-controlled.json');
  writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  const report = {
    schema_version: 1,
    goal: evidence.goal,
    status: 'passed',
    environment_class: evidence.environment_class,
    capacity_claim: evidence.capacity_claim,
    source_commit: sourceCommit,
    image_digest: imageDigest,
    config_hash: configHash,
    evidence: [{
      path: 'evidence/media-control-controlled.json',
      bytes: statSync(evidenceFile).size,
      sha256: createHash('sha256').update(readFileSync(evidenceFile)).digest('hex')
    }]
  };
  const reportFile = resolve(outputDir, 'report.json');
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { report_file: reportFile, evidence_file: evidenceFile };
}

function fixture(now: Date, failure?: SimulatedFailure) {
  const reservationExpiresAt = new Date(now.getTime() + 60_000).toISOString();
  const nodeLeaseExpiresAt = new Date(now.getTime() + 30_000).toISOString();
  const authority = new ControlledAuthority(reservationExpiresAt, nodeLeaseExpiresAt);
  const transport = new InMemoryMediaTransport();
  if (failure) transport.failNext(failure);
  const agent = new MediaControlAgent({
    authority,
    transport,
    max_reservations: 100,
    max_terminal_reservations: 100,
    max_commands_per_reservation: 8,
    terminal_retention_ms: 1_000
  });
  return { agent, authority, transport, reservationExpiresAt };
}

function command(
  now: Date,
  action: MediaControlAction,
  sequence: number,
  reservationId: string,
  overrides: Partial<MediaControlCommand> = {}
): MediaControlCommand {
  return {
    protocol_version: 'ivekit.media-control.v1',
    action,
    command_id: `${reservationId}-${action}-${sequence}`,
    reservation_id: reservationId,
    interaction_id: `${reservationId}-interaction`,
    owner_epoch: OWNER_EPOCH,
    sequence,
    lease_expires_at: new Date(now.getTime() + 60_000).toISOString(),
    payload: action === 'prepare'
      ? { offer_sdp: 'v=0\r\n', media_profile_id: 'g711-relay-v1' }
      : {},
    ...overrides
  };
}

async function staleEpochScenario(now: Date) {
  const { agent, transport } = fixture(now);
  let rejected = false;
  try {
    await agent.execute(command(now, 'prepare', 1, 'controlled-stale', {
      owner_epoch: ((6n << 32n) | 99n).toString()
    }), now);
  } catch (error) {
    rejected = error instanceof MediaControlError &&
      error.code === 'stale_owner_epoch';
  }
  return { rejected, side_effects: transport.sideEffectCount() };
}

async function replayScenario(now: Date) {
  const { agent, transport } = fixture(now);
  const input = command(now, 'prepare', 1, 'controlled-replay');
  const first = await agent.execute(input, now);
  const repeated = await agent.execute(structuredClone(input), now);
  return {
    results_equal: JSON.stringify(first) === JSON.stringify(repeated),
    prepare_side_effects: transport.sideEffectCount('prepare')
  };
}

async function lifecycleScenario(now: Date) {
  const committed = fixture(now);
  const preparedResult = await committed.agent.execute(
    command(now, 'prepare', 1, 'controlled-lifecycle-commit'),
    now
  );
  const committedResult = await committed.agent.execute(
    command(now, 'commit', 2, 'controlled-lifecycle-commit'),
    now
  );

  const cancelled = fixture(now);
  await cancelled.agent.execute(
    command(now, 'prepare', 1, 'controlled-lifecycle-cancel'),
    now
  );
  const cancelledResult = await cancelled.agent.execute(
    command(now, 'cancel', 2, 'controlled-lifecycle-cancel'),
    now
  );

  const expired = fixture(now);
  await expired.agent.execute(
    command(now, 'prepare', 1, 'controlled-lifecycle-expire'),
    now
  );
  await expired.agent.sweep(new Date(now.getTime() + 61_000));

  return {
    prepared_state: preparedResult.session?.state || '',
    committed_state: committedResult.session?.state || '',
    cancelled_state: cancelledResult.session?.state || '',
    expired_state: expired.agent.session('controlled-lifecycle-expire')?.state || ''
  };
}

async function uncertaintyScenario(now: Date, failure: SimulatedFailure) {
  const { agent, transport } = fixture(now, failure);
  const input = command(now, 'prepare', 1, `controlled-${failure}`);
  const initial = await agent.execute(input, now);
  const reconciled = await agent.reconcile({
    protocol_version: 'ivekit.media-control.v1',
    action: 'reconcile',
    reservation_id: input.reservation_id,
    interaction_id: input.interaction_id,
    owner_epoch: input.owner_epoch,
    command_id: input.command_id
  }, now);
  return {
    initial_state: initial.state,
    reconciled_state: reconciled.state,
    prepare_side_effects: transport.sideEffectCount('prepare')
  };
}

async function restartScenario(now: Date) {
  const { authority, transport } = fixture(now);
  const first = new MediaControlAgent({ authority, transport });
  const reservationId = 'controlled-restart';
  await first.execute(command(now, 'prepare', 1, reservationId), now);
  await first.execute(command(now, 'commit', 2, reservationId), now);
  const forwardedBeforeRestart = transport.forwardPackets(reservationId, 10);

  const restarted = new MediaControlAgent({ authority, transport });
  const closed = await restarted.execute(
    command(now, 'close', 3, reservationId),
    now
  );
  return {
    forwarded_before_restart: forwardedBeforeRestart,
    closed_state: closed.session?.state || '',
    forwarded_after_close: transport.forwardPackets(reservationId, 10)
  };
}

async function controlPlaneOutageScenario(now: Date) {
  const { agent, authority, transport } = fixture(now);
  const reservationId = 'controlled-outage';
  await agent.execute(command(now, 'prepare', 1, reservationId), now);
  await agent.execute(command(now, 'commit', 2, reservationId), now);
  authority.available = false;
  let controlCommandRejected = false;
  try {
    await agent.execute(command(now, 'close', 3, reservationId), now);
  } catch {
    controlCommandRejected = true;
  }
  return {
    control_command_rejected: controlCommandRejected,
    forwarded_packets: transport.forwardPackets(reservationId, 500),
    still_forwarding: transport.isForwarding(reservationId),
    metrics: agent.renderMetrics()
  };
}

function exactHash(value: string, length: number, message: string): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (!new RegExp(`^[a-f0-9]{${length}}$`).test(normalized)) throw new Error(message);
  return normalized;
}

function digest(value: string, message: string): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(normalized)) throw new Error(message);
  return normalized;
}

function timestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error('generated_at must be an ISO-8601 UTC timestamp');
  }
  return value;
}

function refuseNonEmptyOutput(outputDir: string): void {
  if (existsSync(outputDir) && readdirSync(outputDir).length) {
    throw new Error('Goal 1 acceptance output directory must be empty');
  }
}

async function main(): Promise<void> {
  const result = await runVoiceMediaGoal1ControlledAcceptance({
    source_commit: process.env.OPC_IVEKIT_MEDIA_GOAL1_SOURCE_COMMIT || '',
    image_digest: process.env.OPC_IVEKIT_MEDIA_GOAL1_IMAGE_DIGEST || '',
    config_hash: process.env.OPC_IVEKIT_MEDIA_GOAL1_CONFIG_HASH || '',
    generated_at: process.env.OPC_IVEKIT_MEDIA_GOAL1_GENERATED_AT,
    output_dir: process.env.OPC_IVEKIT_MEDIA_GOAL1_ACCEPTANCE_DIR ||
      resolve('.tmp/ivekit-voice-media-goal1-acceptance')
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
