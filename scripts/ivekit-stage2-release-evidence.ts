import { createHash } from 'node:crypto';

export const IVEKIT_STAGE2_REQUIRED_MIGRATIONS = [
  '061_ivekit_file_security.sql',
  '062_tinode_file_delivery_operations.sql',
  '063_livekit_media_quality.sql'
] as const;

export const IVEKIT_STAGE2_CONFIGURATION_PROFILES = [
  'livekit_turn',
  'livekit_egress',
  'file_security'
] as const;

export type IveKitStage2ConfigurationProfile =
  typeof IVEKIT_STAGE2_CONFIGURATION_PROFILES[number];

export interface IveKitStage2ReleaseEvidenceInput {
  sourceCommit: string;
  generatedAt: string;
  imageDigest: string;
  migrations: Array<{ file: string; sha256: string }>;
  configurationArtifacts: Array<{
    profile: IveKitStage2ConfigurationProfile;
    path: string;
    sha256: string;
  }>;
}

export interface IveKitStage2ReleaseEvidence {
  schema_version: 1;
  source_commit: string;
  generated_at: string;
  execution_status: 'ready' | 'blocked_build_required';
  application_image_digest: string;
  required_migrations: Array<{ file: string; sha256: string }>;
  configuration_template_fingerprints: Record<IveKitStage2ConfigurationProfile, {
    fingerprint_sha256: string;
    artifacts: Array<{ path: string; sha256: string }>;
  }>;
  release_fingerprint_sha256: string;
  runtime_deployment_fingerprint_required: true;
  secret_values_embedded: false;
  real_environment_validation: 'not_run';
}

const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SOURCE_COMMIT = /^[a-f0-9]{40}$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;

export function createIveKitStage2ReleaseEvidence(
  input: IveKitStage2ReleaseEvidenceInput
): IveKitStage2ReleaseEvidence {
  assertInput(input);
  const requiredMigrations = IVEKIT_STAGE2_REQUIRED_MIGRATIONS.map((file) => {
    const found = input.migrations.find((entry) => entry.file === file);
    if (!found) throw new Error(`stage 2 release evidence requires ${file}`);
    return { file, sha256: found.sha256 };
  });
  const profiles = Object.fromEntries(IVEKIT_STAGE2_CONFIGURATION_PROFILES.map((profile) => {
    const artifacts = input.configurationArtifacts
      .filter((entry) => entry.profile === profile)
      .map(({ path, sha256 }) => ({ path, sha256 }))
      .sort((left, right) => left.path.localeCompare(right.path));
    if (!artifacts.length) throw new Error(`stage 2 release evidence requires ${profile} artifacts`);
    return [profile, {
      fingerprint_sha256: hashCanonical({ profile, artifacts }),
      artifacts
    }];
  })) as IveKitStage2ReleaseEvidence['configuration_template_fingerprints'];
  const executionStatus = input.imageDigest ? 'ready' : 'blocked_build_required';
  const releaseFingerprint = hashCanonical({
    source_commit: input.sourceCommit,
    application_image_digest: input.imageDigest,
    required_migrations: requiredMigrations,
    configuration_template_fingerprints: profiles
  });
  const evidence: IveKitStage2ReleaseEvidence = {
    schema_version: 1,
    source_commit: input.sourceCommit,
    generated_at: input.generatedAt,
    execution_status: executionStatus,
    application_image_digest: input.imageDigest,
    required_migrations: requiredMigrations,
    configuration_template_fingerprints: profiles,
    release_fingerprint_sha256: releaseFingerprint,
    runtime_deployment_fingerprint_required: true,
    secret_values_embedded: false,
    real_environment_validation: 'not_run'
  };
  validateIveKitStage2ReleaseEvidence(evidence);
  return evidence;
}

export function validateIveKitStage2ReleaseEvidence(
  evidence: IveKitStage2ReleaseEvidence
): void {
  if (evidence.schema_version !== 1 || !SOURCE_COMMIT.test(evidence.source_commit)) {
    throw new Error('invalid stage 2 release evidence identity');
  }
  if (!isIsoTimestamp(evidence.generated_at)) throw new Error('invalid stage 2 evidence timestamp');
  if (evidence.application_image_digest) {
    if (!IMAGE_DIGEST.test(evidence.application_image_digest) || evidence.execution_status !== 'ready') {
      throw new Error('invalid stage 2 application image digest');
    }
  } else if (evidence.execution_status !== 'blocked_build_required') {
    throw new Error('stage 2 evidence without an image digest must remain blocked');
  }
  if (JSON.stringify(evidence.required_migrations.map((entry) => entry.file)) !==
      JSON.stringify(IVEKIT_STAGE2_REQUIRED_MIGRATIONS)) {
    throw new Error('stage 2 evidence is missing required migrations');
  }
  for (const entry of evidence.required_migrations) {
    if (!SHA256.test(entry.sha256)) throw new Error(`invalid migration checksum for ${entry.file}`);
  }
  if (JSON.stringify(Object.keys(evidence.configuration_template_fingerprints)) !==
      JSON.stringify(IVEKIT_STAGE2_CONFIGURATION_PROFILES)) {
    throw new Error('stage 2 evidence has invalid configuration profiles');
  }
  for (const profile of IVEKIT_STAGE2_CONFIGURATION_PROFILES) {
    const entry = evidence.configuration_template_fingerprints[profile];
    if (!entry.artifacts.length) throw new Error(`stage 2 evidence has no ${profile} artifacts`);
    for (const artifact of entry.artifacts) {
      if (!SAFE_PATH.test(artifact.path) || !SHA256.test(artifact.sha256)) {
        throw new Error(`invalid ${profile} configuration artifact`);
      }
    }
    const expected = hashCanonical({ profile, artifacts: entry.artifacts });
    if (entry.fingerprint_sha256 !== expected) {
      throw new Error(`${profile} configuration fingerprint does not match its artifacts`);
    }
  }
  const expectedReleaseFingerprint = hashCanonical({
    source_commit: evidence.source_commit,
    application_image_digest: evidence.application_image_digest,
    required_migrations: evidence.required_migrations,
    configuration_template_fingerprints: evidence.configuration_template_fingerprints
  });
  if (evidence.release_fingerprint_sha256 !== expectedReleaseFingerprint) {
    throw new Error('stage 2 release fingerprint does not match its evidence');
  }
  if (evidence.runtime_deployment_fingerprint_required !== true ||
      evidence.secret_values_embedded !== false || evidence.real_environment_validation !== 'not_run') {
    throw new Error('invalid stage 2 evidence boundary');
  }
}

function assertInput(input: IveKitStage2ReleaseEvidenceInput): void {
  if (!SOURCE_COMMIT.test(input.sourceCommit)) throw new Error('sourceCommit must be a full Git commit');
  if (!isIsoTimestamp(input.generatedAt)) throw new Error('generatedAt must be an ISO timestamp');
  if (input.imageDigest && !IMAGE_DIGEST.test(input.imageDigest)) {
    throw new Error('imageDigest must be a sha256 digest');
  }
  for (const entry of input.migrations) {
    if (!SAFE_PATH.test(entry.file) || !SHA256.test(entry.sha256)) {
      throw new Error('stage 2 release input contains an invalid migration artifact');
    }
  }
  for (const entry of input.configurationArtifacts) {
    if (!IVEKIT_STAGE2_CONFIGURATION_PROFILES.includes(entry.profile) ||
        !SAFE_PATH.test(entry.path) || !SHA256.test(entry.sha256)) {
      throw new Error('stage 2 release input contains an invalid configuration artifact');
    }
  }
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

function isIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Boolean(value) && Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
