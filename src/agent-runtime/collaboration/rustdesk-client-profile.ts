import { rustDeskClientConfig } from './rustdesk-client-config.js';

export const RUSTDESK_CLIENT_VERSION = '1.4.7' as const;
export const RUSTDESK_SERVER_VERSION = '1.1.15' as const;

export type RustDeskClientDistributionPlatform = 'windows' | 'macos' | 'linux';
export type RustDeskClientDistributionArchitecture = 'x86_64' | 'aarch64';

export const SUPPORTED_RUSTDESK_CLIENT_TARGETS = [
  { platform: 'windows', architecture: 'x86_64' },
  { platform: 'macos', architecture: 'x86_64' },
  { platform: 'macos', architecture: 'aarch64' },
  { platform: 'linux', architecture: 'x86_64' },
  { platform: 'linux', architecture: 'aarch64' }
] as const satisfies readonly {
  platform: RustDeskClientDistributionPlatform;
  architecture: RustDeskClientDistributionArchitecture;
}[];

export interface RustDeskClientArtifactSource {
  state: 'configured';
  url: string;
  filename: string;
  sha256: string;
}

export interface RustDeskClientDistributionProfile {
  platform: RustDeskClientDistributionPlatform;
  architecture: RustDeskClientDistributionArchitecture;
  client_version: {
    exact: typeof RUSTDESK_CLIENT_VERSION;
    allowed: [typeof RUSTDESK_CLIENT_VERSION];
  };
  server_version: typeof RUSTDESK_SERVER_VERSION;
  issued_at: string;
  expires_at: string;
  manual_fields: {
    id_server: string;
    relay_server: string;
    api_server: string;
    key: string;
  };
  server_key_fingerprint: string;
  protocol_handler: {
    supported: true;
    user_initiated_only: true;
  };
  install_source: RustDeskClientArtifactSource | { state: 'not_configured' };
  unattended_policy: {
    mode: 'attended_only';
    state: 'not_configured';
  };
}

export interface RustDeskClientDistributionProfileInput {
  platform: unknown;
  architecture: unknown;
  client_version: unknown;
  expected_server_version: unknown;
  expected_server_key_fingerprint: unknown;
}

export interface RustDeskClientDistributionProfileOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

type ArtifactManifest = {
  client_version: typeof RUSTDESK_CLIENT_VERSION;
  server_version: typeof RUSTDESK_SERVER_VERSION;
  artifacts: RustDeskClientArtifactSourceWithTarget[];
};

type RustDeskClientArtifactSourceWithTarget = RustDeskClientArtifactSource & {
  platform: RustDeskClientDistributionPlatform;
  architecture: RustDeskClientDistributionArchitecture;
};

export function createRustDeskClientDistributionProfile(
  input: RustDeskClientDistributionProfileInput,
  options: RustDeskClientDistributionProfileOptions = {}
): RustDeskClientDistributionProfile {
  const env = options.env || process.env;
  const expectedServerVersion = requiredExpectedPin(
    input.expected_server_version,
    'expected_server_version'
  );
  const expectedFingerprint = requiredExpectedPin(
    input.expected_server_key_fingerprint,
    'expected_server_key_fingerprint'
  );
  if (expectedServerVersion !== RUSTDESK_SERVER_VERSION) {
    throw profileError('RustDesk server version drift', 409);
  }
  if (!/^sha256:[a-f0-9]{16}$/.test(expectedFingerprint)) {
    throw profileError('expected_server_key_fingerprint is invalid', 400);
  }
  const platform = distributionPlatform(input.platform);
  const architecture = distributionArchitecture(input.architecture);
  assertSupportedTarget(platform, architecture);
  if (input.client_version !== RUSTDESK_CLIENT_VERSION) {
    throw profileError(`client_version must equal ${RUSTDESK_CLIENT_VERSION}`, 400);
  }

  const serverVersion = String(env.RUSTDESK_SERVER_IMAGE_TAG || '').trim();
  if (!serverVersion) {
    throw profileError('RUSTDESK_SERVER_IMAGE_TAG is required', 500);
  }
  if (serverVersion !== RUSTDESK_SERVER_VERSION) {
    throw profileError(`RustDesk server version must equal ${RUSTDESK_SERVER_VERSION}`, 409);
  }
  const configuredClientVersion = String(env.OPC_RUSTDESK_CLIENT_VERSION || RUSTDESK_CLIENT_VERSION).trim();
  if (configuredClientVersion !== RUSTDESK_CLIENT_VERSION) {
    throw profileError(`OPC_RUSTDESK_CLIENT_VERSION must equal ${RUSTDESK_CLIENT_VERSION}`, 500);
  }

  const config = rustDeskClientConfig(env);
  if (config.public_key_error) throw profileError(config.public_key_error, 500);
  if (config.api_server_error) throw profileError(config.api_server_error, 500);
  assertSafeApiServer(config.api_server);
  if (!config.id_server) throw profileError('RustDesk client profile id_server is not configured', 500);
  if (!config.public_key || !config.server_key_fingerprint) {
    throw profileError('RustDesk client profile public key is not configured', 500);
  }
  if (expectedFingerprint !== config.server_key_fingerprint) {
    throw profileError('RustDesk server key fingerprint drift', 409);
  }

  const manifest = parseArtifactManifest(env.OPC_RUSTDESK_CLIENT_ARTIFACTS_JSON);
  const artifact = manifest?.artifacts.find(
    (candidate) => candidate.platform === platform && candidate.architecture === architecture
  );
  const issuedAt = (options.now || (() => new Date()))();
  if (Number.isNaN(issuedAt.getTime())) throw profileError('RustDesk client profile clock is invalid', 500);
  const expiresAt = new Date(issuedAt.getTime() + profileTtlMs(env));

  return {
    platform,
    architecture,
    client_version: { exact: RUSTDESK_CLIENT_VERSION, allowed: [RUSTDESK_CLIENT_VERSION] },
    server_version: RUSTDESK_SERVER_VERSION,
    issued_at: issuedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    manual_fields: {
      id_server: config.manual_fields.id_server,
      relay_server: config.manual_fields.relay_server,
      api_server: config.manual_fields.api_server || '',
      key: config.manual_fields.key
    },
    server_key_fingerprint: config.server_key_fingerprint,
    protocol_handler: { supported: true, user_initiated_only: true },
    install_source: artifact
      ? { state: 'configured', url: artifact.url, filename: artifact.filename, sha256: artifact.sha256 }
      : { state: 'not_configured' },
    unattended_policy: { mode: 'attended_only', state: 'not_configured' }
  };
}

function parseArtifactManifest(raw: string | undefined): ArtifactManifest | null {
  const value = String(raw || '').trim();
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw profileError('RustDesk client artifact manifest must be valid JSON', 500);
  }
  const record = objectValue(parsed, 'RustDesk client artifact manifest');
  if (record.client_version !== RUSTDESK_CLIENT_VERSION) {
    throw profileError(`RustDesk client artifact manifest client_version must equal ${RUSTDESK_CLIENT_VERSION}`, 500);
  }
  if (record.server_version !== RUSTDESK_SERVER_VERSION) {
    throw profileError(`RustDesk client artifact manifest server_version must equal ${RUSTDESK_SERVER_VERSION}`, 500);
  }
  if (!Array.isArray(record.artifacts)) {
    throw profileError('RustDesk client artifact manifest artifacts must be an array', 500);
  }

  const seen = new Set<string>();
  const artifacts = record.artifacts.map((value, index) => {
    const artifact = objectValue(value, `RustDesk client artifact ${index}`);
    const platform = distributionPlatform(artifact.platform, true);
    const architecture = distributionArchitecture(artifact.architecture, true);
    assertSupportedTarget(platform, architecture, true);
    const target = `${platform}/${architecture}`;
    if (seen.has(target)) throw profileError(`RustDesk client artifact manifest duplicate target: ${target}`, 500);
    seen.add(target);

    const url = artifactUrl(artifact.url);
    const filename = artifactFilename(artifact.filename);
    assertCanonicalArtifactUrlFilename(url, filename);
    const pathSegments = artifactPathSegments(url);
    const urlFilename = pathSegments.at(-1) || '';
    if (urlFilename !== filename) {
      throw profileError('RustDesk client artifact filename must match URL', 500);
    }
    assertArtifactReleasePath(url, pathSegments);
    assertArtifactIdentity(pathSegments.join('/'), filename, platform, architecture);
    const sha256 = String(artifact.sha256 || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw profileError('RustDesk client artifact sha256 must be 64 hexadecimal characters', 500);
    }
    return { platform, architecture, state: 'configured' as const, url: url.toString(), filename, sha256 };
  });
  return { client_version: RUSTDESK_CLIENT_VERSION, server_version: RUSTDESK_SERVER_VERSION, artifacts };
}

function distributionPlatform(value: unknown, manifest = false): RustDeskClientDistributionPlatform {
  const platform = String(value || '').trim();
  if (platform === 'windows' || platform === 'macos' || platform === 'linux') return platform;
  throw profileError(`${manifest ? 'RustDesk client artifact' : 'unsupported RustDesk client'} platform`, manifest ? 500 : 400);
}

function distributionArchitecture(value: unknown, manifest = false): RustDeskClientDistributionArchitecture {
  const architecture = String(value || '').trim();
  if (architecture === 'x86_64' || architecture === 'aarch64') return architecture;
  throw profileError(`${manifest ? 'RustDesk client artifact' : 'unsupported RustDesk client'} architecture`, manifest ? 500 : 400);
}

function assertSupportedTarget(
  platform: RustDeskClientDistributionPlatform,
  architecture: RustDeskClientDistributionArchitecture,
  manifest = false
): void {
  const supported = SUPPORTED_RUSTDESK_CLIENT_TARGETS.some(
    (target) => target.platform === platform && target.architecture === architecture
  );
  if (!supported) {
    throw profileError(
      `${manifest ? 'RustDesk client artifact' : 'unsupported RustDesk client'} target: ${platform}/${architecture}`,
      manifest ? 500 : 400
    );
  }
}

function artifactUrl(value: unknown): URL {
  if (typeof value !== 'string' || !value || /[\u0000-\u0020\u007f-\u009f]/.test(value)) {
    throw profileError('RustDesk client artifact URL is invalid', 500);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw profileError('RustDesk client artifact URL is invalid', 500);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw profileError('RustDesk client artifact URL must be HTTPS without userinfo, query, or fragment', 500);
  }
  return url;
}

function assertSafeApiServer(value: string): void {
  if (!value) return;
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw profileError('RustDesk API server must not include credentials, query, or fragment', 500);
  }
}

function artifactFilename(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value === '.' ||
    value === '..' ||
    !/^[A-Za-z0-9._+-]{1,255}$/.test(value)
  ) {
    throw profileError('RustDesk client artifact filename is invalid', 500);
  }
  return value;
}

function assertCanonicalArtifactUrlFilename(url: URL, filename: string): void {
  const rawFilename = url.pathname.split('/').filter(Boolean).at(-1) || '';
  if (rawFilename !== filename) {
    throw profileError('RustDesk client artifact URL filename must be canonical ASCII', 500);
  }
}

function artifactPathSegments(url: URL): string[] {
  try {
    return url.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
  } catch {
    throw profileError('RustDesk client artifact URL path is malformed', 500);
  }
}

function assertArtifactReleasePath(url: URL, pathSegments: readonly string[]): void {
  const releaseDirectory = url.hostname.toLowerCase() === 'github.com' ? 'download' : 'releases';
  if (
    pathSegments.length < 3 ||
    pathSegments.at(-3) !== releaseDirectory ||
    pathSegments.at(-2) !== RUSTDESK_CLIENT_VERSION
  ) {
    throw profileError(`RustDesk client artifact URL must end with /${releaseDirectory}/${RUSTDESK_CLIENT_VERSION}/<filename>`, 500);
  }
}

const artifactExtensions: Record<string, readonly string[]> = {
  'windows/x86_64': ['.exe', '.msi'],
  'macos/x86_64': ['.dmg'],
  'macos/aarch64': ['.dmg'],
  'linux/x86_64': ['.deb'],
  'linux/aarch64': ['.deb']
};

const artifactArchitectureTokens: Record<RustDeskClientDistributionArchitecture, readonly string[]> = {
  x86_64: ['x86_64', 'amd64'],
  aarch64: ['aarch64', 'arm64']
};

function assertArtifactIdentity(
  pathIdentity: string,
  filename: string,
  platform: RustDeskClientDistributionPlatform,
  architecture: RustDeskClientDistributionArchitecture
): void {
  const lower = filename.toLowerCase();
  const lowerIdentity = pathIdentity.toLowerCase();
  if (!hasArtifactToken(lower, RUSTDESK_CLIENT_VERSION)) {
    throw profileError(`RustDesk client artifact filename must identify version ${RUSTDESK_CLIENT_VERSION}`, 500);
  }
  for (const version of semanticVersionTokens(lowerIdentity)) {
    if (version !== RUSTDESK_CLIENT_VERSION) {
      throw profileError(`RustDesk client artifact identity contains conflicting version ${version}`, 500);
    }
  }
  for (const candidate of ['windows', 'macos', 'linux'] as const) {
    if (candidate !== platform && hasArtifactToken(lowerIdentity, candidate)) {
      throw profileError(`RustDesk client artifact identity contains conflicting platform ${candidate}`, 500);
    }
  }
  for (const candidate of ['x86_64', 'aarch64'] as const) {
    if (
      candidate !== architecture &&
      artifactArchitectureTokens[candidate].some((token) => hasArtifactToken(lowerIdentity, token))
    ) {
      throw profileError(`RustDesk client artifact identity contains conflicting architecture ${candidate}`, 500);
    }
  }
  const extensions = artifactExtensions[`${platform}/${architecture}`] || [];
  const extension = extensions.find((candidate) => lower.endsWith(candidate));
  if (!extension) {
    throw profileError(`RustDesk client artifact filename extension is invalid for ${platform}`, 500);
  }
  const expectedFilename = `rustdesk-${RUSTDESK_CLIENT_VERSION}-${architecture}${extension}`;
  if (filename !== expectedFilename) {
    throw profileError(`RustDesk client artifact filename must equal ${expectedFilename}`, 500);
  }
}

function semanticVersionTokens(value: string): string[] {
  return Array.from(
    value.matchAll(/(?:^|[^0-9])(\d+\.\d+\.\d+)(?=$|[^0-9])/g),
    (match) => match[1]
  );
}

function hasArtifactToken(filename: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(filename);
}

function profileTtlMs(env: NodeJS.ProcessEnv): number {
  if (env.OPC_RUSTDESK_CLIENT_PROFILE_TTL_SECONDS !== undefined) {
    const seconds = Number(env.OPC_RUSTDESK_CLIENT_PROFILE_TTL_SECONDS);
    if (!Number.isInteger(seconds) || seconds < 60 || seconds > 3_600) {
      throw profileError('OPC_RUSTDESK_CLIENT_PROFILE_TTL_SECONDS must be an integer from 60 to 3600', 500);
    }
    return seconds * 1_000;
  }
  const value = Number(env.OPC_RUSTDESK_CLIENT_PROFILE_TTL_MS || 900_000);
  if (!Number.isInteger(value) || value < 60_000 || value > 3_600_000) {
    throw profileError('OPC_RUSTDESK_CLIENT_PROFILE_TTL_MS must be an integer from 60000 to 3600000', 500);
  }
  return value;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw profileError(`${label} must be an object`, 500);
  }
  return value as Record<string, unknown>;
}

function requiredExpectedPin(value: unknown, field: string): string {
  const pin = typeof value === 'string' ? value.trim() : '';
  if (!pin) throw profileError(`${field} is required`, 400);
  return pin;
}

function profileError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}
