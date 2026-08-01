import { resolveBrandEnv } from '../src/config/converact-env.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createConveractFabricRustDeskHttpClient,
  projectRustDeskClientDistributionProfile,
  type GetConveractFabricRustDeskClientProfileInput
} from '../src/agent-runtime/converact/index.js';
import type { RustDeskClientDistributionProfile } from '../sdk/converact/src/index.js';

const TARGETS = [
  { platform: 'windows', architecture: 'x86_64' },
  { platform: 'macos', architecture: 'x86_64' },
  { platform: 'macos', architecture: 'aarch64' },
  { platform: 'linux', architecture: 'x86_64' },
  { platform: 'linux', architecture: 'aarch64' }
] as const;

export interface RustDeskClientProfilePackConfig {
  outputFile?: string;
  title: string;
  baseUrl: string;
  apiKey: string;
  tenantId: string;
  userId?: string;
  expectedServerVersion: '1.1.16';
  expectedServerKeyFingerprint: string;
}

export interface RustDeskClientProfilePackClient {
  getClientProfile(input: GetConveractFabricRustDeskClientProfileInput): Promise<unknown>;
}

export interface RustDeskClientProfilePack {
  schema_version: 1;
  title: string;
  ready: boolean;
  client_version: '1.4.9';
  server_version: '1.1.16';
  generated_at: string;
  expires_at: string;
  manual_fields: RustDeskClientDistributionProfile['manual_fields'];
  server_key_fingerprint: string;
  unattended_policy: RustDeskClientDistributionProfile['unattended_policy'];
  targets: Array<Pick<
    RustDeskClientDistributionProfile,
    'platform' | 'architecture' | 'install_source' | 'protocol_handler'
  >>;
  missing_targets: string[];
  operator_instructions: string[];
}

export interface RustDeskClientProfilePackWriteResult {
  outputFile: string;
  ready: boolean;
  targets: number;
  missingTargets: number;
}

export function createRustDeskClientProfilePackConfigFromEnv(
  env: NodeJS.ProcessEnv
): RustDeskClientProfilePackConfig {
  const baseUrl = normalizeBaseUrl(
    resolveBrandEnv(env, 'RUSTDESK_CLIENT_PROFILE_PACK_BASE_URL') ||
    resolveBrandEnv(env, 'RUSTDESK_CLIENT_CONFIG_BASE_URL') ||
    resolveBrandEnv(env, 'RUSTDESK_FABRIC_BASE_URL') ||
    resolveBrandEnv(env, 'RUSTDESK_IVEKIT_BASE_URL') ||
    resolveBrandEnv(env, 'BASE_URL') ||
    ''
  );
  const apiKey = requiredString(
    resolveBrandEnv(env, 'RUSTDESK_CLIENT_PROFILE_PACK_API_KEY') ||
    resolveBrandEnv(env, 'RUSTDESK_CLIENT_CONFIG_API_KEY') ||
    resolveBrandEnv(env, 'RUSTDESK_FABRIC_API_KEY') ||
    resolveBrandEnv(env, 'RUSTDESK_IVEKIT_API_KEY') ||
    resolveBrandEnv(env, 'API_KEY'),
    'CONVERACT_RUSTDESK_CLIENT_PROFILE_PACK_API_KEY or CONVERACT_API_KEY is required'
  );
  const tenantId = requiredString(
    resolveBrandEnv(env, 'RUSTDESK_CLIENT_PROFILE_PACK_TENANT_ID') ||
    resolveBrandEnv(env, 'RUSTDESK_CLIENT_CONFIG_TENANT_ID') ||
    resolveBrandEnv(env, 'RUSTDESK_FABRIC_TENANT_ID') ||
    resolveBrandEnv(env, 'RUSTDESK_IVEKIT_TENANT_ID') ||
    resolveBrandEnv(env, 'TENANT_ID'),
    'CONVERACT_RUSTDESK_CLIENT_PROFILE_PACK_TENANT_ID or CONVERACT_TENANT_ID is required'
  );
  const expectedServerVersion = requiredString(
    resolveBrandEnv(env, 'RUSTDESK_CLIENT_PROFILE_EXPECTED_SERVER_VERSION'),
    'CONVERACT_RUSTDESK_CLIENT_PROFILE_EXPECTED_SERVER_VERSION is required'
  );
  if (expectedServerVersion !== '1.1.16') {
    throw new Error('RustDesk client profile expected server version must equal 1.1.16');
  }
  const expectedServerKeyFingerprint = requiredString(
    resolveBrandEnv(env, 'RUSTDESK_CLIENT_PROFILE_EXPECTED_FINGERPRINT'),
    'CONVERACT_RUSTDESK_CLIENT_PROFILE_EXPECTED_FINGERPRINT is required'
  );
  if (!/^sha256:[a-f0-9]{16}$/.test(expectedServerKeyFingerprint)) {
    throw new Error('RustDesk client profile expected fingerprint is invalid');
  }
  const outputFile = optionalString(resolveBrandEnv(env, 'RUSTDESK_CLIENT_PROFILE_PACK_FILE'));
  const userId = optionalString(
    resolveBrandEnv(env, 'RUSTDESK_CLIENT_PROFILE_PACK_USER_ID') || resolveBrandEnv(env, 'RUSTDESK_CLIENT_CONFIG_USER_ID')
  );
  return {
    ...(outputFile ? { outputFile } : {}),
    title: optionalString(resolveBrandEnv(env, 'RUSTDESK_CLIENT_PROFILE_PACK_TITLE')) || 'RustDesk Client Distribution Profile',
    baseUrl,
    apiKey,
    tenantId,
    ...(userId ? { userId } : {}),
    expectedServerVersion: '1.1.16',
    expectedServerKeyFingerprint
  };
}

export async function buildRustDeskClientProfilePack(
  config: RustDeskClientProfilePackConfig,
  client: RustDeskClientProfilePackClient = createConveractFabricRustDeskHttpClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    tenantId: config.tenantId,
    userId: config.userId
  }),
  now: () => Date = () => new Date()
): Promise<RustDeskClientProfilePack> {
  if (!String(config.expectedServerVersion || '').trim()) {
    throw new Error('RustDesk client profile expected server version is required');
  }
  if (config.expectedServerVersion !== '1.1.16') {
    throw new Error('RustDesk client profile expected server version must equal 1.1.16');
  }
  if (!String(config.expectedServerKeyFingerprint || '').trim()) {
    throw new Error('RustDesk client profile expected server key fingerprint is required');
  }
  if (!/^sha256:[a-f0-9]{16}$/.test(config.expectedServerKeyFingerprint)) {
    throw new Error('RustDesk client profile expected server key fingerprint is invalid');
  }
  const generatedAt = now();
  if (Number.isNaN(generatedAt.getTime())) throw new Error('RustDesk client profile pack clock is invalid');
  const profiles: RustDeskClientDistributionProfile[] = [];
  for (const target of TARGETS) {
    const input: GetConveractFabricRustDeskClientProfileInput = {
      ...target,
      client_version: '1.4.9',
      expected_server_version: config.expectedServerVersion,
      expected_server_key_fingerprint: config.expectedServerKeyFingerprint
    };
    const value = await client.getClientProfile(input);
    const receivedAt = now();
    if (Number.isNaN(receivedAt.getTime())) {
      throw new Error('RustDesk client profile pack response clock is invalid');
    }
    profiles.push(await projectRustDeskClientDistributionProfile(value, input, receivedAt));
  }

  const first = profiles[0];
  for (const profile of profiles.slice(1)) {
    if (profile.server_key_fingerprint !== first.server_key_fingerprint) {
      throw new Error('RustDesk client profile pack server_key_fingerprint drift');
    }
    if (profile.server_version !== first.server_version) {
      throw new Error('RustDesk client profile pack server_version drift');
    }
    if (JSON.stringify(profile.manual_fields) !== JSON.stringify(first.manual_fields)) {
      throw new Error('RustDesk client profile pack manual_fields drift');
    }
  }

  const targets = profiles.map((profile) => ({
    platform: profile.platform,
    architecture: profile.architecture,
    install_source: profile.install_source,
    protocol_handler: profile.protocol_handler
  }));
  const missingTargets = targets
    .filter((target) => target.install_source.state === 'not_configured')
    .map((target) => `${target.platform}/${target.architecture}`);
  const expiresAt = profiles
    .map((profile) => profile.expires_at)
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
  const completedAt = now();
  if (Number.isNaN(completedAt.getTime())) throw new Error('RustDesk client profile pack completion clock is invalid');
  for (const profile of profiles) {
    await projectRustDeskClientDistributionProfile(profile, {
      platform: profile.platform,
      architecture: profile.architecture,
      client_version: profile.client_version.exact,
      expected_server_version: config.expectedServerVersion,
      expected_server_key_fingerprint: config.expectedServerKeyFingerprint
    }, completedAt);
  }
  if (Date.parse(expiresAt) <= completedAt.getTime()) {
    throw new Error('RustDesk client profile pack expired before completion');
  }

  return {
    schema_version: 1,
    title: config.title,
    ready: missingTargets.length === 0,
    client_version: '1.4.9',
    server_version: '1.1.16',
    generated_at: generatedAt.toISOString(),
    expires_at: expiresAt,
    manual_fields: first.manual_fields,
    server_key_fingerprint: first.server_key_fingerprint,
    unattended_policy: { mode: 'attended_only', state: 'not_configured' },
    targets,
    missing_targets: missingTargets,
    operator_instructions: [
      'Select the artifact matching the terminal platform and architecture.',
      'Verify the artifact SHA-256 before starting the platform installer manually.',
      'Enter the ID, relay, optional API, and public-key fields exactly as listed.',
      'Confirm the server key fingerprint before each attended support session.',
      'Launch the native protocol handler only from an explicit operator action.',
      'Treat unattended access as unavailable until a later policy task configures it.'
    ]
  };
}

export function renderRustDeskClientProfilePack(pack: RustDeskClientProfilePack): string {
  return `${JSON.stringify(pack, null, 2)}\n`;
}

export async function writeRustDeskClientProfilePack(
  config: RustDeskClientProfilePackConfig,
  client?: RustDeskClientProfilePackClient,
  now?: () => Date
): Promise<RustDeskClientProfilePackWriteResult> {
  if (!config.outputFile) {
    throw new Error('CONVERACT_RUSTDESK_CLIENT_PROFILE_PACK_FILE is required when writing client profile pack');
  }
  const pack = await buildRustDeskClientProfilePack(config, client, now);
  mkdirSync(dirname(config.outputFile), { recursive: true });
  writeFileSync(config.outputFile, renderRustDeskClientProfilePack(pack), 'utf8');
  return {
    outputFile: config.outputFile,
    ready: pack.ready,
    targets: pack.targets.length,
    missingTargets: pack.missing_targets.length
  };
}

function normalizeBaseUrl(raw: unknown): string {
  const value = requiredString(raw, 'RustDesk client profile pack base URL is required');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('RustDesk client profile pack base URL is invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('RustDesk client profile pack base URL must use http(s)');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('RustDesk client profile pack base URL must not include credentials, query, or fragment');
  }
  if (url.pathname !== '/') {
    throw new Error('RustDesk client profile pack base URL must not include a path');
  }
  return url.origin;
}

function requiredString(value: unknown, message: string): string {
  const result = String(value || '').trim();
  if (!result) throw new Error(message);
  return result;
}

function optionalString(value: unknown): string | undefined {
  const result = String(value || '').trim();
  return result || undefined;
}

async function main(): Promise<void> {
  const config = createRustDeskClientProfilePackConfigFromEnv(process.env);
  if (config.outputFile) {
    console.log(JSON.stringify(await writeRustDeskClientProfilePack(config), null, 2));
    return;
  }
  console.log(renderRustDeskClientProfilePack(await buildRustDeskClientProfilePack(config)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}
