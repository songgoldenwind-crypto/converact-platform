import { createHash, randomUUID } from 'node:crypto';

export interface LiveKitAcceptanceMetadata {
  run_id: string;
  environment_id: string;
  deployed_commit: string;
  deployment_fingerprint: string;
  started_at: string;
  deployment_mode: 'standalone-vm' | 'external';
}

export function createLiveKitAcceptanceMetadata(
  env: NodeJS.ProcessEnv,
  options: { generateRunId?: boolean } = {}
): LiveKitAcceptanceMetadata {
  const runId = value(env.OPC_LIVEKIT_ACCEPTANCE_RUN_ID) ||
    (options.generateRunId ? `lk-${randomUUID()}` : '');
  const environmentId = value(env.OPC_LIVEKIT_ACCEPTANCE_ENVIRONMENT_ID);
  const deployedCommit = value(env.OPC_LIVEKIT_ACCEPTANCE_DEPLOYED_COMMIT);
  const configuredFingerprint = value(env.OPC_LIVEKIT_ACCEPTANCE_DEPLOYMENT_FINGERPRINT);
  const startedAt = value(env.OPC_LIVEKIT_ACCEPTANCE_STARTED_AT) ||
    (options.generateRunId ? new Date().toISOString() : '');
  const coreDeploymentMode = value(env.OPC_LIVEKIT_DEPLOYMENT_MODE);
  const acceptanceDeploymentMode = value(env.OPC_LIVEKIT_ACCEPTANCE_DEPLOYMENT_MODE);
  if (coreDeploymentMode && acceptanceDeploymentMode && coreDeploymentMode !== acceptanceDeploymentMode) {
    throw new Error('OPC_LIVEKIT_ACCEPTANCE_DEPLOYMENT_MODE must match OPC_LIVEKIT_DEPLOYMENT_MODE');
  }
  const deploymentMode = coreDeploymentMode || acceptanceDeploymentMode;

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(runId)) {
    throw new Error('OPC_LIVEKIT_ACCEPTANCE_RUN_ID must be 8-128 safe identifier characters');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(environmentId) || placeholder(environmentId)) {
    throw new Error('OPC_LIVEKIT_ACCEPTANCE_ENVIRONMENT_ID must be a non-placeholder environment identifier');
  }
  if (!/^[a-f0-9]{40}$/i.test(deployedCommit)) {
    throw new Error('OPC_LIVEKIT_ACCEPTANCE_DEPLOYED_COMMIT must be a full 40-character Git SHA');
  }
  const deploymentFingerprint = configuredFingerprint || createHash('sha256').update([
    environmentId,
    deployedCommit.toLowerCase(),
    value(env.OPC_LIVEKIT_DEPLOYMENT_MODE),
    cleanUrl(value(env.LIVEKIT_PUBLIC_URL)),
    cleanUrl(value(env.LIVEKIT_URL || env.OPC_LIVEKIT_URL))
  ].join('\n')).digest('hex');
  if (!/^[a-f0-9]{64}$/i.test(deploymentFingerprint)) {
    throw new Error('OPC_LIVEKIT_ACCEPTANCE_DEPLOYMENT_FINGERPRINT must be a 64-character SHA-256');
  }
  if (!isIsoTimestamp(startedAt)) {
    throw new Error('OPC_LIVEKIT_ACCEPTANCE_STARTED_AT must be an ISO timestamp');
  }
  if (deploymentMode !== 'standalone-vm' && deploymentMode !== 'external') {
    throw new Error('OPC_LIVEKIT_ACCEPTANCE_DEPLOYMENT_MODE must be standalone-vm or external');
  }
  return {
    run_id: runId,
    environment_id: environmentId,
    deployed_commit: deployedCommit.toLowerCase(),
    deployment_fingerprint: deploymentFingerprint.toLowerCase(),
    started_at: startedAt,
    deployment_mode: deploymentMode
  };
}

export function optionalLiveKitAcceptanceMetadata(
  env: NodeJS.ProcessEnv
): LiveKitAcceptanceMetadata | undefined {
  const keys = [
    env.OPC_LIVEKIT_ACCEPTANCE_RUN_ID,
    env.OPC_LIVEKIT_ACCEPTANCE_ENVIRONMENT_ID,
    env.OPC_LIVEKIT_ACCEPTANCE_DEPLOYED_COMMIT,
    env.OPC_LIVEKIT_ACCEPTANCE_DEPLOYMENT_FINGERPRINT,
    env.OPC_LIVEKIT_ACCEPTANCE_STARTED_AT
  ];
  if (keys.every((item) => !value(item))) return undefined;
  return createLiveKitAcceptanceMetadata(env);
}

export function liveKitAcceptanceMetadataEnv(
  metadata: LiveKitAcceptanceMetadata
): NodeJS.ProcessEnv {
  return {
    OPC_LIVEKIT_ACCEPTANCE_RUN_ID: metadata.run_id,
    OPC_LIVEKIT_ACCEPTANCE_ENVIRONMENT_ID: metadata.environment_id,
    OPC_LIVEKIT_ACCEPTANCE_DEPLOYED_COMMIT: metadata.deployed_commit,
    OPC_LIVEKIT_ACCEPTANCE_DEPLOYMENT_FINGERPRINT: metadata.deployment_fingerprint,
    OPC_LIVEKIT_ACCEPTANCE_STARTED_AT: metadata.started_at,
    OPC_LIVEKIT_ACCEPTANCE_DEPLOYMENT_MODE: metadata.deployment_mode,
    OPC_LIVEKIT_DEPLOYMENT_MODE: metadata.deployment_mode
  };
}

export function isLiveKitAcceptanceMetadata(valueToCheck: unknown): valueToCheck is LiveKitAcceptanceMetadata {
  if (!valueToCheck || typeof valueToCheck !== 'object' || Array.isArray(valueToCheck)) return false;
  const candidate = valueToCheck as Record<string, unknown>;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(String(candidate.run_id || '')) &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(String(candidate.environment_id || '')) &&
    !placeholder(String(candidate.environment_id || '')) &&
    /^[a-f0-9]{40}$/i.test(String(candidate.deployed_commit || '')) &&
    /^[a-f0-9]{64}$/i.test(String(candidate.deployment_fingerprint || '')) &&
    isIsoTimestamp(String(candidate.started_at || '')) &&
    (candidate.deployment_mode === 'standalone-vm' || candidate.deployment_mode === 'external');
}

export function sameLiveKitAcceptanceMetadata(
  left: LiveKitAcceptanceMetadata,
  right: LiveKitAcceptanceMetadata
): boolean {
  return left.run_id === right.run_id &&
    left.environment_id === right.environment_id &&
    left.deployed_commit.toLowerCase() === right.deployed_commit.toLowerCase() &&
    left.deployment_fingerprint.toLowerCase() === right.deployment_fingerprint.toLowerCase() &&
    left.started_at === right.started_at && left.deployment_mode === right.deployment_mode;
}

function cleanUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return raw;
  }
}

function placeholder(valueToCheck: string): boolean {
  return /^(?:replace[-_ ]?with|todo|tbd|n\/?a)/i.test(valueToCheck);
}

function isIsoTimestamp(valueToCheck: string): boolean {
  const parsed = new Date(valueToCheck);
  return Boolean(valueToCheck) && Number.isFinite(parsed.getTime()) && parsed.toISOString() === valueToCheck;
}

function value(raw: string | undefined): string {
  return String(raw || '').trim();
}
