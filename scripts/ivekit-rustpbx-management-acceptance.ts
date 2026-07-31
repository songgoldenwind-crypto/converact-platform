import { resolveConveractEnv } from '../src/config/converact-env.js';
import { createHash } from 'node:crypto';

import {
  DEFAULT_RUSTPBX_MANAGEMENT_PATHS,
  RustPbxManagementClient
} from '../src/agent-runtime/converact/voice/adapters/rustpbx-management.js';
import { EnvVoiceSecretResolver } from '../src/agent-runtime/converact/voice/secret-resolver.js';

const runId = required('IVEKIT_ACCEPTANCE_RUN_ID');
if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(runId)) throw new Error('invalid IVEKIT_ACCEPTANCE_RUN_ID');

const managementTokenName = 'RUSTPBX_MANAGEMENT_TOKEN';
const trunkCredentialName = 'RUSTPBX_ACCEPTANCE_TRUNK_CREDENTIAL';
const extensionCredentialName = 'RUSTPBX_ACCEPTANCE_EXTENSION_CREDENTIAL';
const resolver = new EnvVoiceSecretResolver({
  env: process.env,
  allowlist: {
    rustpbx_management: [managementTokenName],
    rustpbx_resource_credential: [trunkCredentialName, extensionCredentialName]
  }
});
const client = new RustPbxManagementClient({
  base_url: required('RUSTPBX_BASE_URL'),
  profile_id: `acceptance-${runId}`,
  config_hash: createHash('sha256').update(runId).digest('hex'),
  service_token_ref: `env://${managementTokenName}`,
  secret_resolver: resolver,
  paths: { ...DEFAULT_RUSTPBX_MANAGEMENT_PATHS },
  internal_service: true,
  timeout_ms: 20_000
});

const providerName = `ivekit-acceptance-${runId}`;
const extensionNumber = required('RUSTPBX_ACCEPTANCE_EXTENSION');
const sipTarget = required('RUSTPBX_ACCEPTANCE_SIP_TARGET');
const sipSourceIp = requiredIpv4('RUSTPBX_ACCEPTANCE_SIP_SOURCE_IP');

const preflight = await client.preflight();
const trunkInput = {
  resource_id: `trunk-${runId}`,
  desired_state: {
    provider_name: providerName,
    name: `iveKit acceptance ${runId}`,
    direction: 'both',
    transport: 'udp',
    codecs: ['PCMU'],
    max_channels: 4,
    credential_secret_ref: `env://${trunkCredentialName}`,
    sip_server: sipTarget,
    allowed_ips: [sipSourceIp],
    status: 'active'
  }
};
const firstTrunk = await client.applyTrunk(trunkInput);
const replayedTrunk = await client.applyTrunk(trunkInput);
const trunkProbe = await client.testTrunk(trunkInput);

const extensionInput = {
  resource_id: `extension-${runId}`,
  desired_state: {
    identity: `agent-${runId}`,
    extension: extensionNumber,
    display_name: `Agent ${runId}`,
    credential_secret_ref: `env://${extensionCredentialName}`,
    permissions: {},
    webrtc_enabled: true,
    status: 'active'
  }
};
const firstExtension = await client.applyExtension(extensionInput);
const replayedExtension = await client.applyExtension(extensionInput);
const did = await client.applyDid({
  resource_id: `did-${runId}`,
  desired_state: { e164: '+12025550199' }
});
const route = await client.applyRoute({
  resource_id: `route-${runId}`,
  desired_state: { version: 1, rules: { action: 'reject', code: 486 } }
});

if (preflight.capabilities.management_http !== true || preflight.capabilities.postgres_backend !== true) {
  throw new Error('RustPBX management preflight did not converge');
}
if (firstTrunk.provider_ref !== replayedTrunk.provider_ref) throw new Error('trunk apply is not idempotent');
if (firstExtension.provider_ref !== replayedExtension.provider_ref) throw new Error('extension apply is not idempotent');
if (!trunkProbe.ready) {
  throw new Error(`RustPBX trunk probe failed: ${JSON.stringify(trunkProbe.safe_diagnostics)}`);
}

process.stdout.write(`${JSON.stringify({
  schema_version: 1,
  run_id: runId,
  provider_version: preflight.provider_version,
  capabilities: preflight.capabilities,
  trunk: {
    provider_ref: firstTrunk.provider_ref,
    replay_same: true,
    probe_ready: trunkProbe.ready,
    probe_diagnostics: trunkProbe.safe_diagnostics
  },
  extension: { provider_ref: firstExtension.provider_ref, replay_same: true },
  did: { provider_ref: did.provider_ref, authority: did.safe_diagnostics.authority },
  route: {
    provider_ref: route.provider_ref,
    provider_revision: route.provider_revision,
    authority: route.safe_diagnostics.authority
  }
}, null, 2)}\n`);

function required(name: string): string {
  const value = String(resolveConveractEnv(process.env, name) || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredIpv4(name: string): string {
  const value = required(name);
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^(?:0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255)) {
    throw new Error(`${name} must be an IPv4 address`);
  }
  return value;
}
