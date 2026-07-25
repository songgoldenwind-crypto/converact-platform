import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
import {
  mediaControlPayloadHash,
  type MediaControlAction,
  type MediaControlCommand
} from '../src/agent-runtime/ivekit/media-control/protocol.js';

const OWNER_EPOCH = ((7n << 32n) | 11n).toString();

export interface VoiceMediaGoal1AcceptanceInput {
  source_dir: string;
  container_name: string;
  rendered_config_file: string;
  output_dir: string;
  generated_at?: string;
  identity_provider?: VoiceMediaGoal1IdentityProvider;
}

export interface VoiceMediaGoal1DeploymentIdentity {
  source_commit: string;
  image_digest: string;
  config_hash: string;
  verification_mode: 'docker-runtime' | 'injected-test';
  deployment_identity_verified: boolean;
}

export type VoiceMediaGoal1IdentityProvider = (input: {
  source_dir: string;
  container_name: string;
  rendered_config_file: string;
}) => Promise<VoiceMediaGoal1DeploymentIdentity>;

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
    media_reservation_id: string;
    call_id: string;
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
  const identity = await (
    input.identity_provider ?? inspectDeploymentIdentity
  )({
    source_dir: requiredText(input.source_dir, 'source directory is required'),
    container_name: requiredText(
      input.container_name,
      'container name is required'
    ),
    rendered_config_file: requiredText(
      input.rendered_config_file,
      'rendered configuration file is required'
    )
  });
  const sourceCommit = exactHash(
    identity.source_commit,
    40,
    'full source commit is required'
  );
  const imageDigest = digest(
    identity.image_digest,
    'image digest is required'
  );
  const configHash = digest(
    identity.config_hash,
    'configuration hash is required'
  );
  if (!['docker-runtime', 'injected-test'].includes(
    identity.verification_mode
  )) {
    throw new Error('deployment identity verification mode is invalid');
  }
  if ((identity.verification_mode === 'docker-runtime') !==
      (identity.deployment_identity_verified === true)) {
    throw new Error('deployment identity verification claim is invalid');
  }
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
      lifecycle.cancelled_state === 'closed' &&
      lifecycle.expired_state === 'expired',
    before_apply_reconciled_exactly_once:
      beforeApply.initial_result_class === 'unknown' &&
      beforeApply.reconciled_result_class === 'committed' &&
      beforeApply.prepare_side_effects === 1,
    after_apply_reconciled_exactly_once:
      afterApply.initial_result_class === 'unknown' &&
      afterApply.reconciled_result_class === 'committed' &&
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
    identity_verification: {
      mode: identity.verification_mode,
      deployment_identity_verified:
        identity.deployment_identity_verified === true
    },
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
      },
      {
        dependency: 'rustpbx-runtime-wiring',
        status: 'not_run',
        reason: 'Goal 1 validates the adapter contract; Goal 3 wires it into the RustPBX runtime.'
      },
      {
        dependency: 'container-restart-persistence',
        status: 'not_run',
        reason: 'The simulator is process-local; Goal 2 validates restart recovery against the durable rtpengine transport.'
      }
    ]
  };
  const evidenceFile = resolve(evidenceDir, 'media-control-controlled.json');
  writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  const report = {
    schema_version: 1,
    goal: evidence.goal,
    status: 'controlled_passed',
    environment_class: evidence.environment_class,
    deployment_identity_verified:
      evidence.identity_verification.deployment_identity_verified,
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
  command_sequence: number,
  reservationId: string,
  overrides: Partial<MediaControlCommand> = {}
): MediaControlCommand {
  const payload = overrides.payload ?? (action === 'offer'
    ? { offer_sdp: 'v=0\r\n', media_profile_id: 'g711-relay-v1' }
    : {});
  return {
    protocol_version: 'ivekit.media-control.v1',
    action,
    command_id: `${reservationId}-${action}-${command_sequence}`,
    tenant_id: 'controlled-tenant-handle',
    call_id: `${reservationId}-interaction`,
    leg_id: `${reservationId}-leg`,
    cell_id: 'controlled-cell',
    owner_node_id: 'controlled-rustpbx',
    owner_epoch: OWNER_EPOCH,
    media_reservation_id: reservationId,
    command_sequence,
    idempotency_key: `${reservationId}-${action}-${command_sequence}`,
    expires_at: new Date(now.getTime() + 60_000).toISOString(),
    ...overrides,
    payload,
    payload_hash: overrides.payload_hash ?? mediaControlPayloadHash(payload)
  };
}

async function staleEpochScenario(now: Date) {
  const { agent, transport } = fixture(now);
  const result = await agent.execute(command(
    now,
    'offer',
    1,
    'controlled-stale',
    { owner_epoch: ((6n << 32n) | 99n).toString() }
  ), now);
  const rejected = result.result_class === 'rejected_epoch' &&
    result.error_code === 'stale_owner_epoch';
  return { rejected, side_effects: transport.sideEffectCount() };
}

async function replayScenario(now: Date) {
  const { agent, transport } = fixture(now);
  const input = command(now, 'offer', 1, 'controlled-replay');
  const first = await agent.execute(input, now);
  const repeated = await agent.execute(structuredClone(input), now);
  return {
    results_equal:
      first.result_class === 'committed' &&
      repeated.result_class === 'replayed' &&
      JSON.stringify(first.session) === JSON.stringify(repeated.session),
    prepare_side_effects: transport.sideEffectCount('offer')
  };
}

async function lifecycleScenario(now: Date) {
  const committed = fixture(now);
  const preparedResult = await committed.agent.execute(
    command(now, 'offer', 1, 'controlled-lifecycle-commit'),
    now
  );
  const committedResult = await committed.agent.execute(
    command(now, 'answer', 2, 'controlled-lifecycle-commit'),
    now
  );

  const cancelled = fixture(now);
  await cancelled.agent.execute(
    command(now, 'offer', 1, 'controlled-lifecycle-cancel'),
    now
  );
  const cancelledResult = await cancelled.agent.execute(
    command(now, 'delete', 2, 'controlled-lifecycle-cancel'),
    now
  );

  const expired = fixture(now);
  await expired.agent.execute(
    command(now, 'offer', 1, 'controlled-lifecycle-expire'),
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
  const input = command(now, 'offer', 1, `controlled-${failure}`);
  const initial = await agent.execute(input, now);
  const reconciled = await agent.reconcile({
    protocol_version: 'ivekit.media-control.v1',
    action: 'reconcile',
    command: input
  }, now);
  return {
    initial_result_class: initial.result_class,
    reconciled_result_class: reconciled.result_class,
    prepare_side_effects: transport.sideEffectCount('offer')
  };
}

async function restartScenario(now: Date) {
  const { authority, transport } = fixture(now);
  const first = new MediaControlAgent({ authority, transport });
  const reservationId = 'controlled-restart';
  await first.execute(command(now, 'offer', 1, reservationId), now);
  await first.execute(command(now, 'answer', 2, reservationId), now);
  const forwardedBeforeRestart = transport.forwardPackets(reservationId, 10);

  const restarted = new MediaControlAgent({ authority, transport });
  const closed = await restarted.execute(
    command(now, 'delete', 3, reservationId),
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
  await agent.execute(command(now, 'offer', 1, reservationId), now);
  await agent.execute(command(now, 'answer', 2, reservationId), now);
  authority.available = false;
  const result = await agent.execute(
    command(now, 'delete', 3, reservationId),
    now
  );
  const controlCommandRejected =
    result.result_class === 'terminal_error' &&
    result.error_code === 'media_control_authority_unavailable';
  return {
    control_command_rejected: controlCommandRejected,
    forwarded_packets: transport.forwardPackets(reservationId, 500),
    still_forwarding: transport.isForwarding(reservationId),
    metrics: agent.renderMetrics()
  };
}

export async function inspectDeploymentIdentity(input: {
  source_dir: string;
  container_name: string;
  rendered_config_file: string;
}): Promise<VoiceMediaGoal1DeploymentIdentity> {
  const sourceDir = resolve(input.source_dir);
  const configFile = resolve(input.rendered_config_file);
  if (!existsSync(configFile) || !statSync(configFile).isFile()) {
    throw new Error('rendered configuration file is not a regular file');
  }
  const sourceCommit = commandOutput(
    'git',
    ['-C', sourceDir, 'rev-parse', 'HEAD'],
    'source commit inspection failed'
  ).toLowerCase();
  const dirty = commandOutput(
    'git',
    ['-C', sourceDir, 'status', '--porcelain'],
    'source status inspection failed'
  );
  if (dirty) throw new Error('source checkout must be clean');

  const containerName = requiredText(
    input.container_name,
    'container name is required'
  );
  const imageDigest = commandOutput(
    'docker',
    ['container', 'inspect', '--format={{.Image}}', containerName],
    'deployed container image inspection failed'
  ).toLowerCase();
  const imageRevision = commandOutput(
    'docker',
    [
      'container',
      'inspect',
      '--format={{index .Config.Labels "org.opencontainers.image.revision"}}',
      containerName
    ],
    'deployed container source label inspection failed'
  ).toLowerCase();
  const running = commandOutput(
    'docker',
    ['container', 'inspect', '--format={{.State.Running}}', containerName],
    'deployed container state inspection failed'
  );
  const health = commandOutput(
    'docker',
    [
      'container',
      'inspect',
      '--format={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',
      containerName
    ],
    'deployed container health inspection failed'
  );
  if (running !== 'true' || health !== 'healthy') {
    throw new Error('deployed media-control container is not healthy');
  }
  if (imageRevision !== sourceCommit) {
    throw new Error('deployed image source revision does not match checkout');
  }
  const configHash = `sha256:${createHash('sha256')
    .update(readFileSync(configFile))
    .digest('hex')}`;
  return {
    source_commit: sourceCommit,
    image_digest: imageDigest,
    config_hash: configHash,
    verification_mode: 'docker-runtime',
    deployment_identity_verified: true
  };
}

function commandOutput(
  executable: string,
  arguments_: string[],
  message: string
): string {
  try {
    return execFileSync(executable, arguments_, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    throw new Error(message);
  }
}

function requiredText(value: string, message: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(message);
  return normalized;
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
    source_dir:
      process.env.OPC_IVEKIT_MEDIA_GOAL1_SOURCE_DIR || process.cwd(),
    container_name:
      process.env.OPC_IVEKIT_MEDIA_GOAL1_CONTAINER_NAME || '',
    rendered_config_file:
      process.env.OPC_IVEKIT_MEDIA_GOAL1_RENDERED_CONFIG_FILE || '',
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
