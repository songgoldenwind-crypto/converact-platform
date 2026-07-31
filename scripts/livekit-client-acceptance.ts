import { resolveBrandEnv } from '../src/config/converact-env.js';
import { createHash, verify as verifySignature } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type LiveKitAcceptanceDeploymentMode = 'standalone-vm' | 'external';

export const LIVEKIT_REFERENCE_CLIENT_ACCEPTANCE_CHECKS = Object.freeze([
  'reference_client.two_identity_lifecycle',
  'reference_client.device_prejoin_switch',
  'reference_client.layout_desktop_mobile',
  'reference_client.host_moderation_revoke',
  'reference_client.recording_evidence',
  'reference_client.offline_reconnect',
  'reference_client.token_non_persistence'
] as const);

export interface LiveKitAcceptanceEvidenceReference {
  artifact_file: string;
  sha256: string;
  captured_at: string;
  tool: string;
  run_id: string;
}

export interface LiveKitAcceptanceCheck {
  passed: boolean;
  evidence: LiveKitAcceptanceEvidenceReference;
}

export interface LiveKitClientAcceptanceConfig {
  reportFile: string;
  outputFile?: string;
  qaPublicKeyFile?: string;
  qaPublicKeyFingerprint?: string;
  preflightReportFile?: string;
  serverEvidenceFile?: string;
  readinessReportFile?: string;
}

export interface LiveKitClientAcceptanceTemplateConfig {
  templateFile?: string;
  environmentId: string;
  deploymentMode: LiveKitAcceptanceDeploymentMode;
  deployedCommit: string;
  operator: string;
  checkedAt: string;
  runId: string;
  deploymentFingerprint: string;
  runStartedAt: string;
}

export interface LiveKitClientAcceptanceFailure {
  id: string;
  reason: string;
}

export interface LiveKitClientAcceptanceResult {
  schema_version: 1;
  ok: boolean;
  status: 'ready_for_review' | 'incomplete';
  run_id: string;
  run_started_at: string;
  environment_id: string;
  deployment_mode: string;
  deployed_commit: string;
  deployment_fingerprint: string;
  checked_at: string;
  qa_approver: string;
  qa_public_key_fingerprint: string;
  qa_attestation_sha256: string;
  summary: {
    required_checks: number;
    passed_checks: number;
    failed: number;
    missing: number;
  };
  failures: LiveKitClientAcceptanceFailure[];
}

export interface LiveKitClientAcceptanceTemplateWriteResult {
  templateFile: string;
  checks: number;
}

interface EvidenceContext {
  runId: string;
  environmentId: string;
  deployedCommit: string;
  deploymentFingerprint: string;
  runStartedAt: string;
  deploymentMode: LiveKitAcceptanceDeploymentMode;
}

interface ValidatedEvidence {
  sha256: string;
  content: Buffer;
  document: Record<string, unknown>;
}

const CHECK_DESCRIPTIONS = {
  'deployment.media_workloads_healthy': 'Confirm LiveKit, Egress, SIP, Redis and edge workloads are healthy in the real environment.',
  'deployment.versions_match': 'Record deployed image/chart versions and confirm they match the approved release matrix.',
  'deployment.redis_persistence': 'Confirm Redis persistence and restart recovery with timestamps and workload evidence.',
  'deployment.object_storage_private_persistent': 'Confirm recording storage is private, persistent and readable after service restart.',
  'network.signal_wss_trusted': 'Capture a trusted WSS connection and certificate evidence from a real browser.',
  'network.ice_udp_selected': 'Capture selected candidate-pair evidence proving direct ICE UDP media.',
  'network.ice_tcp_fallback': 'Capture selected candidate-pair evidence proving ICE TCP fallback.',
  'network.turn_udp_forced_relay': 'Capture forced relay candidate evidence over TURN UDP.',
  'network.turn_tls_forced_relay': 'Capture forced relay candidate evidence over TURN TLS.',
  'media.two_browser_audio': 'Record two real browsers hearing bidirectional audio on different networks.',
  'media.two_browser_video': 'Record two real browsers receiving bidirectional video on different networks.',
  'media.screen_share': 'Record screen-share publish, subscribe and visible remote frames.',
  'media.customer_browser_join': 'Confirm a signed customer H5 link joins the intended tenant room.',
  'media.web_assist_screen_share': 'Confirm Web Assist customer screen share is visible to the engineer observer.',
  'media.reconnect': 'Record disconnect and reconnect behavior without stale participant state.',
  'recording.egress_completed': 'Record Egress start and completed state with room and egress identifiers.',
  'recording.object_readable_nonempty': 'Record the persisted recording object size and successful authenticated read.',
  'recording.controlled_export_checksum': 'Record controlled export authorization and matching SHA-256 checksum.',
  'recording.webhook_idempotent': 'Confirm duplicate LiveKit webhook delivery does not duplicate recording or evidence rows.',
  'lifecycle.participant_join_leave': 'Confirm participant joined/left timestamps and final room snapshot.',
  'lifecycle.closed_room_rejects_join': 'Confirm closed room rejects token/join/recording/dispatch requests.',
  'isolation.cross_tenant_denied': 'Capture cross-tenant room, recording and participant access denial.',
  'isolation.postgres_rls_verified': 'Capture PostgreSQL RLS tenant context and direct cross-tenant query denial.',
  'led.sdk_room_join': 'Confirm LED uses the iveKit HTTP SDK to create a room and obtain a Join Plan.',
  'led.business_ref_traceable': 'Confirm tenant and business_ref trace from LED object through room, recording and evidence.',
  'resilience.media_restart_reconnect': 'Record LiveKit/edge restart and browser recovery behavior.',
  'resilience.redis_recovery': 'Record Redis restart/recovery without lost room routing or stuck Egress jobs.',
  'resilience.multi_replica_routing_draining': 'Record multi-replica routing, node drain and reconnect evidence.',
  'sip.inbound_audio': 'Record a real inbound SIP call bridged to LiveKit with bidirectional audio.',
  'sip.outbound_audio': 'Record a real outbound SIP call bridged from LiveKit with bidirectional audio.',
  'reference_client.two_identity_lifecycle': 'Run the iveKit reference client as two real identities through ring, accept, active and terminal states.',
  'reference_client.device_prejoin_switch': 'Capture real prejoin permission, preview and in-call input/output device switching.',
  'reference_client.layout_desktop_mobile': 'Capture nonblank desktop and mobile stages, screen-share priority and stable controls.',
  'reference_client.host_moderation_revoke': 'Confirm host mute/remove and immediate removed-participant revocation in the reference client.',
  'reference_client.recording_evidence': 'Confirm host recording, evidence display and authenticated export in the reference client.',
  'reference_client.offline_reconnect': 'Confirm reference-client offline, reconnect and converged participant state.',
  'reference_client.token_non_persistence': 'Confirm short-lived tokens are absent from browser persistent storage, captures and logs.'
} as const;

export const LIVEKIT_REQUIRED_ACCEPTANCE_CHECKS = Object.freeze(
  Object.keys(CHECK_DESCRIPTIONS) as Array<keyof typeof CHECK_DESCRIPTIONS>
);

export const LIVEKIT_ACCEPTANCE_DETAIL_REQUIREMENTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'deployment.media_workloads_healthy': ['workloads', 'health_snapshot'],
  'deployment.versions_match': ['approved_versions', 'deployed_versions'],
  'deployment.redis_persistence': ['restart_started_at', 'restart_completed_at', 'recovery_observation'],
  'deployment.object_storage_private_persistent': ['object_key', 'size_bytes', 'post_restart_read_at'],
  'network.signal_wss_trusted': ['browser', 'certificate_fingerprint', 'wss_url'],
  'network.ice_udp_selected': ['candidate_pair', 'transport', 'candidate_type'],
  'network.ice_tcp_fallback': ['candidate_pair', 'transport', 'candidate_type'],
  'network.turn_udp_forced_relay': ['candidate_pair', 'transport', 'candidate_type'],
  'network.turn_tls_forced_relay': ['candidate_pair', 'transport', 'candidate_type'],
  'media.two_browser_audio': ['room_name', 'participants', 'bidirectional_observation'],
  'media.two_browser_video': ['room_name', 'participants', 'remote_frame_observation'],
  'media.screen_share': ['room_name', 'publisher', 'subscriber', 'remote_frame_observation'],
  'media.customer_browser_join': ['room_name', 'customer_identity', 'join_observation'],
  'media.web_assist_screen_share': ['session_id', 'customer_identity', 'engineer_identity', 'remote_frame_observation'],
  'media.reconnect': ['room_name', 'disconnect_at', 'reconnect_at', 'participant_state'],
  'recording.egress_completed': ['room_name', 'egress_id', 'status', 'completed_at'],
  'recording.object_readable_nonempty': ['object_key', 'size_bytes', 'read_at'],
  'recording.controlled_export_checksum': ['export_id', 'object_sha256', 'export_sha256'],
  'recording.webhook_idempotent': ['event_id', 'delivery_count', 'recording_row_count'],
  'lifecycle.participant_join_leave': ['room_name', 'identity', 'joined_at', 'left_at'],
  'lifecycle.closed_room_rejects_join': ['room_name', 'closed_at', 'rejection_status'],
  'isolation.cross_tenant_denied': ['source_tenant', 'target_tenant', 'operation', 'denial_status'],
  'isolation.postgres_rls_verified': ['source_tenant', 'target_tenant', 'query_id', 'denial_status'],
  'led.sdk_room_join': ['business_ref', 'room_name', 'sdk_request_id'],
  'led.business_ref_traceable': ['business_ref', 'room_name', 'recording_id', 'evidence_id'],
  'resilience.media_restart_reconnect': ['restart_started_at', 'restart_completed_at', 'reconnected_participants'],
  'resilience.redis_recovery': ['restart_started_at', 'restart_completed_at', 'routing_observation'],
  'resilience.multi_replica_routing_draining': ['replicas', 'drained_node', 'routing_observation'],
  'sip.inbound_audio': ['call_id', 'trunk_id', 'room_name', 'bidirectional_observation'],
  'sip.outbound_audio': ['call_id', 'trunk_id', 'room_name', 'bidirectional_observation'],
  'reference_client.two_identity_lifecycle': ['call_id', 'caller_identity', 'callee_identity', 'terminal_statuses'],
  'reference_client.device_prejoin_switch': ['identity', 'permission_observation', 'input_devices', 'output_device'],
  'reference_client.layout_desktop_mobile': ['desktop_viewport', 'mobile_viewport', 'screen_share_observation', 'overflow_observation'],
  'reference_client.host_moderation_revoke': ['host_identity', 'target_identity', 'mute_observation', 'revoke_observation'],
  'reference_client.recording_evidence': ['call_id', 'recording_id', 'evidence_id', 'authenticated_export_sha256'],
  'reference_client.offline_reconnect': ['call_id', 'offline_at', 'reconnected_at', 'participant_state'],
  'reference_client.token_non_persistence': ['browser', 'storage_surfaces', 'token_absent_observation'],
  performance: ['load_command', 'metrics_file', 'time_range', 'rooms', 'participants']
});

const REQUIRED_VERSION_KEYS = ['server', 'egress', 'sip', 'redis', 'edge'] as const;

export function createLiveKitClientAcceptanceTemplate(
  config: Omit<LiveKitClientAcceptanceTemplateConfig, 'templateFile'>
): Record<string, unknown> {
  const checks: Record<string, unknown> = {};
  for (const checkId of LIVEKIT_REQUIRED_ACCEPTANCE_CHECKS) {
    setPath(checks, checkId, {
      passed: false,
      evidence: evidenceTemplate(config.runId, CHECK_DESCRIPTIONS[checkId], checkId)
    });
  }
  return {
    schema_version: 1,
    source: 'real_environment',
    run_id: config.runId,
    run_started_at: config.runStartedAt,
    environment_id: config.environmentId,
    deployment_mode: config.deploymentMode,
    deployed_commit: config.deployedCommit,
    deployment_fingerprint: config.deploymentFingerprint,
    operator: config.operator,
    checked_at: config.checkedAt,
    qa_attestation: {
      approver: 'replace-with-independent-qa-approver',
      signed_at: '',
      evidence: evidenceTemplate(config.runId, 'Attach the independent QA attestation artifact.'),
      signature_base64: 'replace-with-ed25519-signature'
    },
    versions: {
      server: '',
      egress: '',
      sip: '',
      redis: '',
      edge: ''
    },
    checks,
    performance: {
      target_concurrent_rooms: 0,
      observed_concurrent_rooms: 0,
      target_participants_per_room: 0,
      observed_participants_per_room: 0,
      target_max_join_p95_ms: 0,
      join_p95_ms: 0,
      target_max_packet_loss_pct: 0,
      packet_loss_pct: 0,
      target_max_error_rate_pct: 0,
      error_rate_pct: 0,
      passed: false,
      evidence: evidenceTemplate(config.runId, 'Attach raw load metrics with time range, rooms and participants.', 'performance')
    }
  };
}

export function writeLiveKitClientAcceptanceTemplate(
  config: LiveKitClientAcceptanceTemplateConfig
): LiveKitClientAcceptanceTemplateWriteResult {
  if (!config.templateFile) throw new Error('CONVERACT_LIVEKIT_ACCEPTANCE_TEMPLATE_FILE is required');
  const template = createLiveKitClientAcceptanceTemplate(config);
  mkdirSync(dirname(config.templateFile), { recursive: true });
  writeFileSync(config.templateFile, `${JSON.stringify(template, null, 2)}\n`, 'utf8');
  return {
    templateFile: config.templateFile,
    checks: LIVEKIT_REQUIRED_ACCEPTANCE_CHECKS.length
  };
}

export function runLiveKitClientAcceptance(
  config: LiveKitClientAcceptanceConfig
): LiveKitClientAcceptanceResult {
  validateLiveKitClientAcceptancePaths(undefined, config.reportFile, config.outputFile);
  const report = readJsonObject(config.reportFile);
  const failures: LiveKitClientAcceptanceFailure[] = [];
  let missing = 0;
  let passedChecks = 0;

  requireEqual(failures, 'report.schema_version', report.schema_version, 1);
  requireEqual(failures, 'report.source', report.source, 'real_environment');
  const runId = requiredRunId(report.run_id, failures);
  const runStartedAt = String(report.run_started_at || '').trim();
  if (!isIsoTimestamp(runStartedAt)) {
    failures.push({ id: 'report.run_started_at', reason: 'run_started_at must be a valid ISO timestamp' });
  }
  const environmentId = requiredIdentity(report.environment_id, 'report.environment_id', failures);
  const deploymentMode = String(report.deployment_mode || '').trim();
  if (deploymentMode !== 'standalone-vm' && deploymentMode !== 'external') {
    failures.push({ id: 'report.deployment_mode', reason: 'deployment_mode must be standalone-vm or external' });
  }
  const deployedCommit = String(report.deployed_commit || '').trim();
  if (!/^[a-f0-9]{40}$/i.test(deployedCommit)) {
    failures.push({ id: 'report.deployed_commit', reason: 'deployed_commit must be a full 40-character Git SHA' });
  }
  const deploymentFingerprint = String(report.deployment_fingerprint || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(deploymentFingerprint)) {
    failures.push({ id: 'report.deployment_fingerprint', reason: 'deployment_fingerprint must be a SHA-256' });
  }
  const operator = requiredIdentity(report.operator, 'report.operator', failures);
  const checkedAt = String(report.checked_at || '').trim();
  if (!isIsoTimestamp(checkedAt)) {
    failures.push({ id: 'report.checked_at', reason: 'checked_at must be a valid ISO timestamp' });
  }
  validateRunWindow(runStartedAt, checkedAt, failures);
  const evidenceContext: EvidenceContext = {
    runId,
    environmentId,
    deployedCommit,
    deploymentFingerprint,
    runStartedAt,
    deploymentMode: deploymentMode as LiveKitAcceptanceDeploymentMode
  };
  const qaAttestation = objectValue(report.qa_attestation);
  const qaApprover = requiredIdentity(qaAttestation.approver, 'qa_attestation.approver', failures);
  if (qaApprover && qaApprover.toLowerCase() === operator.toLowerCase()) {
    failures.push({ id: 'qa_attestation.approver', reason: 'QA approver must differ from the evidence operator' });
  }
  const qaSignedAt = String(qaAttestation.signed_at || '').trim();
  if (!isIsoTimestamp(qaSignedAt)) {
    failures.push({ id: 'qa_attestation.signed_at', reason: 'QA signed_at must be a valid ISO timestamp' });
  } else if (isIsoTimestamp(checkedAt)) {
    const delay = Date.parse(qaSignedAt) - Date.parse(checkedAt);
    if (delay < 0 || delay > 24 * 60 * 60 * 1000) {
      failures.push({ id: 'qa_attestation.signed_at', reason: 'QA attestation must follow the run within 24 hours' });
    }
  }
  const qaEvidence = validateEvidenceReference(
    qaAttestation.evidence,
    'qa_attestation.evidence',
    config.reportFile,
    evidenceContext,
    failures,
    'livekit_qa_attestation'
  );
  if (containsSecret(report)) {
    failures.push({ id: 'report.secret_scan', reason: 'report contains a credential, private key, authorization header, cookie, or signed URL' });
  }

  const versions = objectValue(report.versions);
  for (const key of REQUIRED_VERSION_KEYS) {
    const value = String(versions[key] || '').trim();
    if (!validVersionValue(value)) {
      failures.push({ id: `versions.${key}`, reason: 'version must be non-empty and non-placeholder' });
    }
  }

  const checks = objectValue(report.checks);
  const checkEvidenceHashes = new Set<string>();
  for (const checkId of LIVEKIT_REQUIRED_ACCEPTANCE_CHECKS) {
    const raw = getPath(checks, checkId);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      failures.push({ id: checkId, reason: 'check is missing' });
      missing += 1;
      continue;
    }
    const check = raw as Record<string, unknown>;
    if (check.passed !== true) {
      failures.push({ id: checkId, reason: 'check did not pass' });
      continue;
    }
    const before = failures.length;
    const reference = validateEvidenceReference(
      check.evidence,
      checkId,
      config.reportFile,
      evidenceContext,
      failures,
      'livekit_acceptance_evidence',
      checkId
    );
    if (failures.length > before) {
      continue;
    }
    if (reference && checkEvidenceHashes.has(reference.sha256)) {
      failures.push({ id: checkId, reason: 'each acceptance check must use a distinct evidence artifact' });
    } else if (reference) {
      checkEvidenceHashes.add(reference.sha256);
    }
    passedChecks += 1;
  }

  const performanceEvidence = validatePerformance(
    objectValue(report.performance),
    failures,
    config.reportFile,
    evidenceContext
  );
  if (performanceEvidence && checkEvidenceHashes.has(performanceEvidence.sha256)) {
    failures.push({ id: 'performance.evidence', reason: 'performance must use a distinct evidence artifact' });
  } else if (performanceEvidence) {
    checkEvidenceHashes.add(performanceEvidence.sha256);
  }
  if (qaEvidence && checkEvidenceHashes.has(qaEvidence.sha256)) {
    failures.push({ id: 'qa_attestation.evidence', reason: 'QA attestation artifact must be distinct from check and performance evidence' });
  }
  const qaVerification = validateQaSignature(
    qaAttestation,
    qaEvidence,
    qaApprover,
    config,
    [...checkEvidenceHashes].sort(),
    report,
    failures
  );

  const result: LiveKitClientAcceptanceResult = {
    schema_version: 1,
    ok: failures.length === 0,
    status: failures.length === 0 ? 'ready_for_review' : 'incomplete',
    run_id: runId,
    run_started_at: runStartedAt,
    environment_id: environmentId,
    deployment_mode: deploymentMode,
    deployed_commit: deployedCommit,
    deployment_fingerprint: deploymentFingerprint,
    checked_at: checkedAt,
    qa_approver: qaApprover,
    qa_public_key_fingerprint: qaVerification.publicKeyFingerprint,
    qa_attestation_sha256: qaEvidence?.sha256 || '',
    summary: {
      required_checks: LIVEKIT_REQUIRED_ACCEPTANCE_CHECKS.length,
      passed_checks: passedChecks,
      failed: failures.length,
      missing
    },
    failures
  };
  if (config.outputFile) {
    mkdirSync(dirname(config.outputFile), { recursive: true });
    writeFileSync(config.outputFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  return result;
}

export function renderLiveKitClientAcceptanceRunbook(): string {
  return [
    '# LiveKit Real Client Acceptance Runbook',
    '',
    'This runbook requires a real deployed server, real browsers and real SIP endpoints. A generated template is not acceptance evidence.',
    '',
    '## Deployment',
    '',
    '- Confirm workloads, exact versions, Redis recovery and private persistent object storage.',
    '',
    '## Network And ICE',
    '',
    '- Capture trusted WSS, direct ICE UDP, ICE TCP fallback, forced TURN UDP and forced TURN TLS candidate pairs.',
    '- A UDP send probe is not candidate-pair evidence.',
    '',
    '## Media',
    '',
    '- Use two browsers on different networks for bidirectional audio/video, screen sharing and reconnect.',
    '- Verify signed customer H5 and Web Assist engineer observation.',
    '',
    '## Recording',
    '',
    '- Start and complete Egress, read the non-empty object, perform controlled export and compare SHA-256.',
    '- Replay the completion webhook and confirm local recording/evidence rows remain idempotent.',
    '',
    '## Lifecycle And Isolation',
    '',
    '- Verify participant join/leave and closed-room rejection.',
    '- Attempt cross-tenant API and PostgreSQL RLS access and retain the denied evidence.',
    '',
    '## LED Integration',
    '',
    '- Run the LED HTTP SDK room/join flow and trace tenant/business_ref through room, recording and evidence.',
    '',
    '## Resilience And Performance',
    '',
    '- Restart media and Redis, test multi-replica routing/draining, and capture reconnect behavior.',
    '- Declare concurrency and quality targets before the run; preserve raw metrics and fill every performance field.',
    '',
    '## SIP',
    '',
    '- Complete one real inbound and one real outbound call with bidirectional audio evidence.',
    '',
    '## Reference Client',
    '',
    '- Use two real identities to cover lifecycle, prejoin and device switching, desktop/mobile layouts, screen share, host moderation, recording/evidence and reconnect.',
    '- Inspect browser storage, captures and logs for token non-persistence. Controlled Playwright output is regression evidence only and cannot pass these checks.',
    '',
    '## Final Evidence',
    '',
    '1. Keep the bundle run ID, environment, full commit and deployment fingerprint unchanged across every report.',
    '2. For every passed check, reference a JSON artifact that names the check ID, run metadata, capture time/tool and structured details; record its full SHA-256.',
    '3. Have an independent QA approver sign a distinct attestation JSON with the trusted Ed25519 key within 24 hours of the run.',
    '4. Run `npm run livekit:client-acceptance` and require `ok=true`.',
    '5. Run `npm run livekit:evidence-pack` and require `ready_for_customer_review`.',
    ''
  ].join('\n');
}

function validatePerformance(
  performance: Record<string, unknown>,
  failures: LiveKitClientAcceptanceFailure[],
  reportFile: string,
  context: EvidenceContext
): ValidatedEvidence | undefined {
  comparePositiveInteger(performance, 'observed_concurrent_rooms', 'target_concurrent_rooms', failures);
  comparePositiveInteger(performance, 'observed_participants_per_room', 'target_participants_per_room', failures);
  compareMaximum(performance, 'join_p95_ms', 'target_max_join_p95_ms', failures, Number.POSITIVE_INFINITY, false);
  compareMaximum(performance, 'packet_loss_pct', 'target_max_packet_loss_pct', failures, 100);
  compareMaximum(performance, 'error_rate_pct', 'target_max_error_rate_pct', failures, 100);
  if (performance.passed !== true) {
    failures.push({ id: 'performance.passed', reason: 'performance.passed must be true' });
  }
  return validateEvidenceReference(
    performance.evidence,
    'performance.evidence',
    reportFile,
    context,
    failures,
    'livekit_acceptance_evidence',
    'performance'
  );
}

function comparePositiveInteger(
  values: Record<string, unknown>,
  observedKey: string,
  targetKey: string,
  failures: LiveKitClientAcceptanceFailure[]
): void {
  const observed = Number(values[observedKey]);
  const target = Number(values[targetKey]);
  if (!Number.isInteger(target) || target < 1) {
    failures.push({ id: `performance.${targetKey}`, reason: `${targetKey} must be a positive integer` });
  }
  if (!Number.isInteger(observed) || observed < target || observed < 1) {
    failures.push({ id: `performance.${observedKey}`, reason: `${observedKey} must reach ${targetKey}` });
  }
}

function compareMaximum(
  values: Record<string, unknown>,
  observedKey: string,
  targetKey: string,
  failures: LiveKitClientAcceptanceFailure[],
  absoluteMax: number,
  allowZeroTarget = true
): void {
  const observed = Number(values[observedKey]);
  const target = Number(values[targetKey]);
  if (!Number.isFinite(target) || target < (allowZeroTarget ? 0 : Number.EPSILON) || target > absoluteMax) {
    failures.push({ id: `performance.${targetKey}`, reason: `${targetKey} is invalid` });
  }
  if (!Number.isFinite(observed) || observed < 0 || observed > target || observed > absoluteMax) {
    failures.push({ id: `performance.${observedKey}`, reason: `${observedKey} exceeds ${targetKey}` });
  }
}

function validateEvidenceReference(
  raw: unknown,
  id: string,
  reportFile: string,
  context: EvidenceContext,
  failures: LiveKitClientAcceptanceFailure[],
  expectedKind: 'livekit_acceptance_evidence' | 'livekit_qa_attestation',
  expectedCheckId?: string
): ValidatedEvidence | undefined {
  const failureCount = failures.length;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    failures.push({ id, reason: 'evidence must be a structured artifact reference' });
    return undefined;
  }
  const evidence = raw as Record<string, unknown>;
  const artifactFile = String(evidence.artifact_file || '').trim();
  const expectedHash = String(evidence.sha256 || '').trim().toLowerCase();
  const capturedAt = String(evidence.captured_at || '').trim();
  const tool = String(evidence.tool || '').trim();
  if (!artifactFile || placeholder(artifactFile) || unsafeUrl(artifactFile)) {
    failures.push({ id, reason: 'artifact_file must be a local secret-free path without URL query or credentials' });
    return undefined;
  }
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
    failures.push({ id, reason: 'evidence sha256 must contain 64 hexadecimal characters' });
    return undefined;
  }
  if (!isIsoTimestamp(capturedAt) || !validTool(tool) || evidence.run_id !== context.runId) {
    failures.push({ id, reason: 'evidence captured_at, tool, and run_id must identify this acceptance run' });
    return undefined;
  }
  try {
    const absolutePath = resolve(dirname(reportFile), artifactFile);
    const content = readFileSync(absolutePath);
    const actualHash = createHash('sha256').update(content).digest('hex');
    if (actualHash !== expectedHash) failures.push({ id, reason: 'evidence artifact SHA-256 does not match' });
    const document = parseEvidenceDocument(content, id, failures);
    if (!document) return undefined;
    if (document.schema_version !== 1 || document.kind !== expectedKind ||
      document.run_id !== context.runId || document.environment_id !== context.environmentId ||
      String(document.deployed_commit || '').toLowerCase() !== context.deployedCommit.toLowerCase() ||
      String(document.deployment_fingerprint || '').toLowerCase() !== context.deploymentFingerprint.toLowerCase() ||
      document.run_started_at !== context.runStartedAt || document.deployment_mode !== context.deploymentMode ||
      document.captured_at !== capturedAt ||
      document.tool !== tool) {
      failures.push({ id, reason: 'evidence artifact schema or acceptance metadata does not match the report' });
    }
    if (expectedKind === 'livekit_acceptance_evidence' && document.source !== 'real_environment') {
      failures.push({ id, reason: 'evidence artifact source must equal real_environment; controlled E2E is not accepted' });
    }
    if (expectedCheckId && document.check_id !== expectedCheckId) {
      failures.push({ id, reason: `evidence artifact must identify only ${expectedCheckId}` });
    }
    if (expectedCheckId && !validCheckDetails(expectedCheckId, document.details)) {
      failures.push({ id, reason: `evidence artifact details do not satisfy the ${expectedCheckId} schema` });
    }
    if (!timestampWithinRun(String(document.captured_at || ''), context.runStartedAt)) {
      failures.push({ id, reason: 'evidence captured_at must fall within the 24-hour acceptance window' });
    }
    if (containsSecret(document)) {
      failures.push({ id, reason: 'evidence artifact contains credential-like keys or values' });
    }
    if (failures.length > failureCount) return undefined;
    return { sha256: actualHash, content, document };
  } catch (error) {
    failures.push({ id, reason: `evidence artifact is not readable: ${error instanceof Error ? error.message : String(error)}` });
    return undefined;
  }
}

function parseEvidenceDocument(
  content: Buffer,
  id: string,
  failures: LiveKitClientAcceptanceFailure[]
): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(content.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('root must be an object');
    return parsed as Record<string, unknown>;
  } catch (error) {
    failures.push({ id, reason: `evidence artifact must be valid JSON: ${error instanceof Error ? error.message : String(error)}` });
    return undefined;
  }
}

function validateQaSignature(
  qaAttestation: Record<string, unknown>,
  evidence: ValidatedEvidence | undefined,
  approver: string,
  config: LiveKitClientAcceptanceConfig,
  evidenceHashes: string[],
  report: Record<string, unknown>,
  failures: LiveKitClientAcceptanceFailure[]
): { publicKeyFingerprint: string } {
  if (!evidence) return { publicKeyFingerprint: '' };
  if (evidence.document.approver !== approver || evidence.document.signed_at !== qaAttestation.signed_at) {
    failures.push({ id: 'qa_attestation', reason: 'signed QA artifact approver and signed_at must match the report' });
  }
  if (evidence.document.decision !== 'approved_for_customer_review') {
    failures.push({ id: 'qa_attestation.decision', reason: 'QA decision must be approved_for_customer_review' });
  }
  const expectedInputs = expectedQaInputs(config, evidenceHashes, report, failures);
  if (canonicalJson(evidence.document.inputs) !== canonicalJson(expectedInputs)) {
    failures.push({ id: 'qa_attestation.inputs', reason: 'QA attestation must sign the exact preflight, server, readiness, and client evidence hashes' });
  }
  if (!config.qaPublicKeyFile) {
    failures.push({ id: 'qa_attestation.signature', reason: 'trusted QA public key file is required' });
    return { publicKeyFingerprint: '' };
  }
  const encoded = String(qaAttestation.signature_base64 || '').trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    failures.push({ id: 'qa_attestation.signature', reason: 'QA signature must be base64-encoded' });
    return { publicKeyFingerprint: '' };
  }
  try {
    const publicKey = readFileSync(config.qaPublicKeyFile, 'utf8');
    const publicKeyFingerprint = createHash('sha256').update(publicKey).digest('hex');
    if (!/^[a-f0-9]{64}$/i.test(String(config.qaPublicKeyFingerprint || '')) ||
      publicKeyFingerprint !== String(config.qaPublicKeyFingerprint || '').toLowerCase()) {
      failures.push({ id: 'qa_attestation.public_key', reason: 'QA public key fingerprint does not match the trusted configured fingerprint' });
    }
    const valid = verifySignature(null, evidence.content, publicKey, Buffer.from(encoded, 'base64'));
    if (!valid) failures.push({ id: 'qa_attestation.signature', reason: 'QA Ed25519 signature is invalid' });
    return { publicKeyFingerprint };
  } catch (error) {
    failures.push({ id: 'qa_attestation.signature', reason: `QA public key/signature could not be verified: ${error instanceof Error ? error.message : String(error)}` });
    return { publicKeyFingerprint: '' };
  }
}

function expectedQaInputs(
  config: LiveKitClientAcceptanceConfig,
  evidenceHashes: string[],
  report: Record<string, unknown>,
  failures: LiveKitClientAcceptanceFailure[]
): Record<string, unknown> {
  return {
    preflight_report_sha256: requiredFileHash(config.preflightReportFile, 'qa_attestation.inputs.preflight', failures),
    server_evidence_sha256: requiredFileHash(config.serverEvidenceFile, 'qa_attestation.inputs.server', failures),
    readiness_report_sha256: requiredFileHash(config.readinessReportFile, 'qa_attestation.inputs.readiness', failures),
    client_evidence_sha256: evidenceHashes,
    client_report_payload_sha256: clientReportPayloadSha(report)
  };
}

function clientReportPayloadSha(report: Record<string, unknown>): string {
  const payload = { ...report };
  delete payload.qa_attestation;
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function requiredFileHash(
  file: string | undefined,
  id: string,
  failures: LiveKitClientAcceptanceFailure[]
): string {
  if (!file) {
    failures.push({ id, reason: 'QA input artifact path is required' });
    return '';
  }
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch (error) {
    failures.push({ id, reason: `QA input artifact is unreadable: ${error instanceof Error ? error.message : String(error)}` });
    return '';
  }
}

function evidenceTemplate(runId: string, instructions: string, checkId?: string): Record<string, unknown> {
  return {
    artifact_file: `replace-with-artifact-file: ${instructions}`,
    sha256: 'replace-with-full-sha256',
    captured_at: '',
    tool: 'replace-with-capture-tool',
    run_id: runId,
    ...(checkId ? {
      artifact_schema: {
        kind: 'livekit_acceptance_evidence',
        check_id: checkId,
        required_details: LIVEKIT_ACCEPTANCE_DETAIL_REQUIREMENTS[checkId] || []
      }
    } : {})
  };
}

function validVersionValue(value: string): boolean {
  if (!value) return false;
  if (/^(?:replace[-_ ]?with|todo|tbd|n\/?a)$/i.test(value)) return false;
  return !containsSecret(value);
}

function requiredRunId(
  value: unknown,
  failures: LiveKitClientAcceptanceFailure[]
): string {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(normalized) || placeholder(normalized)) {
    failures.push({ id: 'report.run_id', reason: 'run_id must be an 8-128 character non-placeholder identifier' });
  }
  return normalized;
}

function requiredIdentity(
  value: unknown,
  id: string,
  failures: LiveKitClientAcceptanceFailure[]
): string {
  const normalized = String(value || '').trim();
  if (!normalized || /^(?:replace[-_ ]?with|todo|tbd|n\/?a)/i.test(normalized)) {
    failures.push({ id, reason: `${id.split('.').at(-1)} is required and cannot be a placeholder` });
  }
  return normalized;
}

function requireEqual(
  failures: LiveKitClientAcceptanceFailure[],
  id: string,
  actual: unknown,
  expected: unknown
): void {
  if (actual !== expected) failures.push({ id, reason: `${id} must equal ${String(expected)}` });
}

function isIsoTimestamp(value: string): boolean {
  if (!value) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validateRunWindow(
  startedAt: string,
  checkedAt: string,
  failures: LiveKitClientAcceptanceFailure[]
): void {
  if (!isIsoTimestamp(startedAt) || !isIsoTimestamp(checkedAt)) return;
  const start = Date.parse(startedAt);
  const checked = Date.parse(checkedAt);
  const now = Date.now();
  if (start > now + 5 * 60 * 1000 || now - start > 24 * 60 * 60 * 1000) {
    failures.push({ id: 'report.run_started_at', reason: 'acceptance run must start within the current 24-hour window' });
  }
  if (checked < start || checked - start > 24 * 60 * 60 * 1000 || checked > now + 5 * 60 * 1000) {
    failures.push({ id: 'report.checked_at', reason: 'checked_at must follow run_started_at within 24 hours and cannot be in the future' });
  }
}

function timestampWithinRun(timestamp: string, startedAt: string): boolean {
  if (!isIsoTimestamp(timestamp) || !isIsoTimestamp(startedAt)) return false;
  const offset = Date.parse(timestamp) - Date.parse(startedAt);
  return offset >= 0 && offset <= 24 * 60 * 60 * 1000 && Date.parse(timestamp) <= Date.now() + 5 * 60 * 1000;
}

function nonEmptyObject(value: unknown): boolean {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length > 0;
}

function validCheckDetails(checkId: string, value: unknown): boolean {
  if (!nonEmptyObject(value)) return false;
  const details = value as Record<string, unknown>;
  const required = LIVEKIT_ACCEPTANCE_DETAIL_REQUIREMENTS[checkId];
  if (!required || required.some((key) => !concreteDetail(details[key]))) return false;
  if (checkId === 'network.ice_udp_selected') {
    return details.transport === 'udp' && details.candidate_type !== 'relay';
  }
  if (checkId === 'network.ice_tcp_fallback') {
    return details.transport === 'tcp' && details.candidate_type !== 'relay';
  }
  if (checkId === 'network.turn_udp_forced_relay') {
    return details.transport === 'udp' && details.candidate_type === 'relay';
  }
  if (checkId === 'network.turn_tls_forced_relay') {
    return details.transport === 'tls' && details.candidate_type === 'relay';
  }
  if (checkId === 'recording.egress_completed') return details.status === 'complete';
  return true;
}

function concreteDetail(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length >= 2 && !placeholder(value);
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0;
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.length > 0 && value.every(concreteDetail);
  if (value && typeof value === 'object') {
    const values = Object.values(value as Record<string, unknown>);
    return values.length > 0 && values.every(concreteDetail);
  }
  return false;
}

function validTool(value: string): boolean {
  return value.length >= 3 && value.length <= 128 && !placeholder(value) && !containsSecret(value);
}

function placeholder(value: string): boolean {
  return /\b(?:replace[-_ ]?with|todo|tbd|n\/?a|fake|mock|local[-_ ]?only)\b/i.test(value);
}

function unsafeUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return Boolean(parsed.username || parsed.password || parsed.search || parsed.hash) ||
      (parsed.protocol !== 'file:' && parsed.protocol !== 'https:');
  } catch {
    return false;
  }
}

function containsSecret(value: unknown): boolean {
  if (typeof value === 'string') {
    return secretAssignment(value) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value) ||
      /\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:basic|bearer)\s+\S+/i.test(value) ||
      /\bcookie\s*[:=]\s*\S+/i.test(value) ||
      /(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]+[_-])*(?:password|passwd|api[_-]?key|api[_-]?secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|invite|token|secret)\s*[:=]\s*\S+/i.test(value) ||
      /\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/.test(value) ||
      /\b(?:https?|wss?):\/\/[^\s]+[?#][^\s]+/i.test(value) ||
      /\b(?:https?|wss?):\/\/[^\s/@]+:[^\s/@]+@/i.test(value);
  }
  if (Array.isArray(value)) return value.some(containsSecret);
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([key, nested]) =>
      (sensitiveKey(key) && String(nested || '').trim().length > 0) || containsSecret(nested)
    );
  }
  return false;
}

function sensitiveKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toLowerCase();
  return /(?:^|_)(?:password|passwd|private_key|api_key|api_secret|client_secret|access_token|refresh_token|invite|token|secret|authorization|cookie)$/.test(normalized);
}

function secretAssignment(value: string): boolean {
  return [...value.matchAll(/([A-Za-z][A-Za-z0-9_-]{2,})\s*[:=]\s*(\S+)/g)]
    .some((match) => sensitiveKey(match[1] || ''));
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function getPath(target: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => (
    current && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>)[part]
      : undefined
  ), target);
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== 'object') current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts.at(-1)!] = value;
}

function readJsonObject(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('LiveKit client acceptance report must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function configFromEnv(env: NodeJS.ProcessEnv): LiveKitClientAcceptanceConfig {
  const reportFile = String(resolveBrandEnv(env, 'LIVEKIT_ACCEPTANCE_REPORT_FILE') || '').trim();
  if (!reportFile) throw new Error('CONVERACT_LIVEKIT_ACCEPTANCE_REPORT_FILE is required');
  const outputFile = String(resolveBrandEnv(env, 'LIVEKIT_ACCEPTANCE_OUTPUT_FILE') || '').trim();
  const qaPublicKeyFile = String(resolveBrandEnv(env, 'LIVEKIT_ACCEPTANCE_QA_PUBLIC_KEY_FILE') || '').trim();
  const qaPublicKeyFingerprint = String(resolveBrandEnv(env, 'LIVEKIT_ACCEPTANCE_QA_PUBLIC_KEY_FINGERPRINT') || '').trim();
  const preflightReportFile = String(resolveBrandEnv(env, 'LIVEKIT_ACCEPTANCE_PREFLIGHT_REPORT_FILE') || '').trim();
  const serverEvidenceFile = String(resolveBrandEnv(env, 'LIVEKIT_ACCEPTANCE_SERVER_EVIDENCE_FILE') || '').trim();
  const readinessReportFile = String(resolveBrandEnv(env, 'LIVEKIT_ACCEPTANCE_READINESS_REPORT_FILE') || '').trim();
  return {
    reportFile,
    ...(outputFile ? { outputFile } : {}),
    ...(qaPublicKeyFile ? { qaPublicKeyFile } : {}),
    ...(qaPublicKeyFingerprint ? { qaPublicKeyFingerprint } : {}),
    ...(preflightReportFile ? { preflightReportFile } : {}),
    ...(serverEvidenceFile ? { serverEvidenceFile } : {}),
    ...(readinessReportFile ? { readinessReportFile } : {})
  };
}

export function runLiveKitClientAcceptanceFromEnv(env: Record<string, string | undefined>):
  | LiveKitClientAcceptanceResult
  | { ok: false; status: 'not_run'; missing_environment: string[] } {
  const reportFile = String(resolveBrandEnv(env, 'LIVEKIT_ACCEPTANCE_REPORT_FILE') || '').trim();
  if (!reportFile) {
    return { ok: false, status: 'not_run', missing_environment: ['CONVERACT_LIVEKIT_ACCEPTANCE_REPORT_FILE'] };
  }
  return runLiveKitClientAcceptance(configFromEnv(env));
}

export function validateLiveKitClientAcceptancePaths(
  templateFile: string | undefined,
  reportFile: string | undefined,
  outputFile: string | undefined
): void {
  const template = templateFile ? resolve(templateFile) : '';
  const report = reportFile ? resolve(reportFile) : '';
  const output = outputFile ? resolve(outputFile) : '';
  if (template && report && template === report) {
    throw new Error('LiveKit acceptance template and report files must differ');
  }
  if (report && output && report === output) {
    throw new Error('LiveKit acceptance report and output files must differ');
  }
  if (template && output && template === output) {
    throw new Error('LiveKit acceptance template and output files must differ');
  }
}

function templateConfigFromEnv(env: NodeJS.ProcessEnv): LiveKitClientAcceptanceTemplateConfig {
  const templateFile = String(resolveBrandEnv(env, 'LIVEKIT_ACCEPTANCE_TEMPLATE_FILE') || '').trim();
  if (!templateFile) throw new Error('CONVERACT_LIVEKIT_ACCEPTANCE_TEMPLATE_FILE is required');
  const mode = String(resolveBrandEnv(env, 'LIVEKIT_ACCEPTANCE_DEPLOYMENT_MODE') || 'standalone-vm').trim();
  if (mode !== 'standalone-vm' && mode !== 'external') {
    throw new Error('CONVERACT_LIVEKIT_ACCEPTANCE_DEPLOYMENT_MODE must be standalone-vm or external');
  }
  return {
    templateFile,
    environmentId: String(resolveBrandEnv(env, 'LIVEKIT_ACCEPTANCE_ENVIRONMENT_ID') || 'replace-with-environment-id').trim(),
    deploymentMode: mode,
    deployedCommit: String(resolveBrandEnv(env, 'LIVEKIT_ACCEPTANCE_DEPLOYED_COMMIT') || 'replace-with-40-char-git-sha').trim(),
    operator: String(resolveBrandEnv(env, 'LIVEKIT_ACCEPTANCE_OPERATOR') || 'replace-with-operator').trim(),
    checkedAt: String(resolveBrandEnv(env, 'LIVEKIT_ACCEPTANCE_CHECKED_AT') || '').trim(),
    runId: String(resolveBrandEnv(env, 'LIVEKIT_ACCEPTANCE_RUN_ID') || 'replace-with-run-id').trim(),
    deploymentFingerprint: String(
      resolveBrandEnv(env, 'LIVEKIT_ACCEPTANCE_DEPLOYMENT_FINGERPRINT') || 'replace-with-deployment-fingerprint'
    ).trim(),
    runStartedAt: String(resolveBrandEnv(env, 'LIVEKIT_ACCEPTANCE_STARTED_AT') || '').trim()
  };
}

async function main(): Promise<void> {
  const templateFile = String(resolveBrandEnv(process.env, 'LIVEKIT_ACCEPTANCE_TEMPLATE_FILE') || '').trim();
  const runbookFile = String(resolveBrandEnv(process.env, 'LIVEKIT_ACCEPTANCE_RUNBOOK_FILE') || '').trim();
  const reportFile = String(resolveBrandEnv(process.env, 'LIVEKIT_ACCEPTANCE_REPORT_FILE') || '').trim();
  if (!templateFile && !runbookFile && !reportFile) {
    const result = runLiveKitClientAcceptanceFromEnv(process.env);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 2;
    return;
  }
  const outputFile = String(resolveBrandEnv(process.env, 'LIVEKIT_ACCEPTANCE_OUTPUT_FILE') || '').trim();
  validateLiveKitClientAcceptancePaths(templateFile || undefined, reportFile || undefined, outputFile || undefined);
  if (templateFile && reportFile) {
    throw new Error('Template generation and report validation are mutually exclusive modes');
  }
  if (templateFile) writeLiveKitClientAcceptanceTemplate(templateConfigFromEnv(process.env));
  if (runbookFile) {
    mkdirSync(dirname(runbookFile), { recursive: true });
    writeFileSync(runbookFile, renderLiveKitClientAcceptanceRunbook(), 'utf8');
  }
  if (reportFile) {
    const result = runLiveKitClientAcceptanceFromEnv(process.env);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } else {
    const result = runLiveKitClientAcceptanceFromEnv(process.env);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
