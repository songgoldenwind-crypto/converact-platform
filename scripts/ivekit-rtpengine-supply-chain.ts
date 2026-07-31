const SHA256 = /^[a-f0-9]{64}$/;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SOURCE_COMMIT = /^[a-f0-9]{40}$/;

interface CycloneDxDocument {
  bomFormat: string;
  specVersion: string;
  serialNumber: string;
  version: number;
  components: Array<Record<string, unknown>>;
}

interface SpdxDocument {
  spdxVersion: string;
  SPDXID: string;
  name: string;
  documentNamespace: string;
  packages: Array<Record<string, unknown>>;
}

interface TrivyVulnerability {
  VulnerabilityID: string;
  PkgName?: string;
  InstalledVersion?: string;
  Severity: string;
}

interface TrivySecret {
  RuleID: string;
  Category?: string;
  Severity?: string;
  Title?: string;
}

interface TrivyResult {
  Target?: string;
  Vulnerabilities?: TrivyVulnerability[];
  Secrets?: TrivySecret[];
}

interface TrivyDocument {
  SchemaVersion: number;
  ArtifactName?: string;
  ArtifactType?: string;
  Metadata?: Record<string, unknown>;
  Results: TrivyResult[];
}

export interface RtpengineSupplyChainInput {
  generated_at: string;
  identity: {
    source_commit: string;
    image_reference: string;
    image_digest: string;
    rtpengine_source_commit: string;
    archive_sha256: string;
    patch_set_sha256: string;
    toolchain_image_digest: string;
    builder_image_digest: string;
    architecture: 'amd64' | 'arm64';
    build_arguments: Record<string, string>;
  };
  cyclonedx: {
    sha256: string;
    document: CycloneDxDocument;
  };
  spdx: {
    sha256: string;
    document: SpdxDocument;
  };
  trivy: {
    sha256: string;
    tool_version: string;
    scanner_image_digest: string;
    database_updated_at: string;
    document: TrivyDocument;
  };
  secret_scan: {
    sha256: string;
    tool_version: string;
    scanner_image_digest: string;
    document: TrivyDocument;
  };
  signature:
    | { status: 'passed'; reference: string; bundle_sha256?: string }
    | { status: 'not_run'; reason: string };
  vulnerability_exceptions: Array<{
    vulnerability_id: string;
    reason: string;
    expires_at: string;
  }>;
}

export interface RtpengineSupplyChainEvidence {
  schema_version: 1;
  goal: 'voice-media-control-goal2-task10';
  status: 'passed';
  capacity_claim: 'none';
  generated_at: string;
  identity: RtpengineSupplyChainInput['identity'];
  artifacts: {
    cyclonedx: {
      format: 'CycloneDX-1.6' | 'CycloneDX-1.7';
      sha256: string;
      component_count: number;
    };
    spdx: {
      format: 'SPDX-2.3';
      sha256: string;
      package_count: number;
    };
    vulnerability_scan: {
      format: 'Trivy-JSON-2';
      sha256: string;
      tool_version: string;
      scanner_image_digest: string;
      database_updated_at: string;
    };
    secret_scan: {
      format: 'Trivy-JSON-2';
      sha256: string;
      tool_version: string;
      scanner_image_digest: string;
    };
  };
  policy: {
    critical_vulnerability_count: number;
    excepted_critical_vulnerability_count: number;
    secret_finding_count: number;
    exceptions: RtpengineSupplyChainInput['vulnerability_exceptions'];
  };
  signature: RtpengineSupplyChainInput['signature'];
  provenance: {
    _type: 'https://in-toto.io/Statement/v1';
    subject: Array<{
      name: string;
      digest: { sha256: string };
    }>;
    predicateType: 'https://slsa.dev/provenance/v1';
    predicate: {
      buildDefinition: {
        buildType: 'https://ivekit.dev/buildtypes/rtpengine-container/v1';
        externalParameters: {
          architecture: 'amd64' | 'arm64';
          build_arguments: Record<string, string>;
        };
        internalParameters: Record<string, never>;
        resolvedDependencies: Array<{
          uri: string;
          digest: Record<string, string>;
        }>;
      };
      runDetails: {
        builder: { id: string };
        metadata: {
          invocationId: string;
          startedOn: string;
          finishedOn: string;
        };
      };
    };
  };
}

export function buildRtpengineSupplyChainEvidence(
  input: RtpengineSupplyChainInput
): RtpengineSupplyChainEvidence {
  const generatedAt = canonicalDate(input.generated_at, 'generated_at');
  const identity = checkedIdentity(input.identity);
  const cycloneDx = checkedCycloneDx(input.cyclonedx);
  const spdx = checkedSpdx(input.spdx);
  const trivy = checkedTrivy(input.trivy, identity.image_digest);
  const secretScan = checkedSecretScan(input.secret_scan);
  const exceptions = checkedExceptions(
    input.vulnerability_exceptions,
    generatedAt
  );
  const critical = criticalVulnerabilities(trivy.document);
  const exceptionById = new Map(
    exceptions.map((entry) => [entry.vulnerability_id, entry])
  );
  const unexcepted = critical.filter(
    (vulnerability) => !exceptionById.has(vulnerability.VulnerabilityID)
  );
  if (unexcepted.length > 0) {
    throw new Error(
      `unexcepted critical vulnerabilities: ${
        unexcepted.map((entry) => entry.VulnerabilityID).join(', ')
      }`
    );
  }
  const secrets = secretFindings(secretScan.document);
  if (secrets.length > 0) {
    throw new Error(
      `runtime image secret findings: ${
        secrets.map((entry) => entry.RuleID).join(', ')
      }`
    );
  }
  const signature = checkedSignature(input.signature);
  const invocationId = [
    identity.source_commit,
    identity.image_digest.slice('sha256:'.length),
    cycloneDx.sha256,
    spdx.sha256,
    trivy.sha256,
    secretScan.sha256
  ].join(':');

  return {
    schema_version: 1,
    goal: 'voice-media-control-goal2-task10',
    status: 'passed',
    capacity_claim: 'none',
    generated_at: generatedAt,
    identity,
    artifacts: {
      cyclonedx: {
        format: `CycloneDX-${cycloneDx.document.specVersion}` as
          'CycloneDX-1.6' | 'CycloneDX-1.7',
        sha256: cycloneDx.sha256,
        component_count: cycloneDx.document.components.length
      },
      spdx: {
        format: 'SPDX-2.3',
        sha256: spdx.sha256,
        package_count: spdx.document.packages.length
      },
      vulnerability_scan: {
        format: 'Trivy-JSON-2',
        sha256: trivy.sha256,
        tool_version: trivy.tool_version,
        scanner_image_digest: trivy.scanner_image_digest,
        database_updated_at: trivy.database_updated_at
      },
      secret_scan: {
        format: 'Trivy-JSON-2',
        sha256: secretScan.sha256,
        tool_version: secretScan.tool_version,
        scanner_image_digest: secretScan.scanner_image_digest
      }
    },
    policy: {
      critical_vulnerability_count: critical.length,
      excepted_critical_vulnerability_count: critical.length,
      secret_finding_count: secrets.length,
      exceptions
    },
    signature,
    provenance: {
      _type: 'https://in-toto.io/Statement/v1',
      subject: [{
        name: identity.image_reference,
        digest: { sha256: identity.image_digest.slice('sha256:'.length) }
      }],
      predicateType: 'https://slsa.dev/provenance/v1',
      predicate: {
        buildDefinition: {
          buildType: 'https://ivekit.dev/buildtypes/rtpengine-container/v1',
          externalParameters: {
            architecture: identity.architecture,
            build_arguments: structuredClone(identity.build_arguments)
          },
          internalParameters: {},
          resolvedDependencies: [
            {
              uri: `git+https://github.com/songgoldenwind-crypto/opc-platform@${
                identity.source_commit
              }`,
              digest: { gitCommit: identity.source_commit }
            },
            {
              uri: 'ivekit:rtpengine-upstream-archive',
              digest: { sha256: identity.archive_sha256 }
            },
            {
              uri: 'ivekit:rtpengine-patch-set',
              digest: { sha256: identity.patch_set_sha256 }
            },
            {
              uri: 'docker:toolchain',
              digest: {
                sha256: identity.toolchain_image_digest.slice('sha256:'.length)
              }
            }
          ]
        },
        runDetails: {
          builder: { id: identity.builder_image_digest },
          metadata: {
            invocationId,
            startedOn: generatedAt,
            finishedOn: generatedAt
          }
        }
      }
    }
  };
}

function checkedIdentity(
  input: RtpengineSupplyChainInput['identity']
): RtpengineSupplyChainInput['identity'] {
  if (!input || !SOURCE_COMMIT.test(input.source_commit)) {
    throw new Error('full OPC source commit is required');
  }
  if (!SOURCE_COMMIT.test(input.rtpengine_source_commit)) {
    throw new Error('full RTPengine source commit is required');
  }
  if (!SHA256_DIGEST.test(input.image_digest)) {
    throw new Error('immutable RTPengine image digest is required');
  }
  for (const [name, value] of [
    ['archive SHA-256', input.archive_sha256],
    ['patch-set SHA-256', input.patch_set_sha256]
  ]) {
    if (!SHA256.test(value)) throw new Error(`${name} is required`);
  }
  for (const [name, value] of [
    ['toolchain image digest', input.toolchain_image_digest],
    ['builder image digest', input.builder_image_digest]
  ]) {
    if (!SHA256_DIGEST.test(value)) throw new Error(`${name} is required`);
  }
  if (!/^[a-z0-9][a-z0-9._/-]{2,255}$/.test(input.image_reference) ||
      input.image_reference.includes('..')) {
    throw new Error('RTPengine image reference is invalid');
  }
  if (input.architecture !== 'amd64' && input.architecture !== 'arm64') {
    throw new Error('RTPengine architecture is invalid');
  }
  const buildArguments = checkedBuildArguments(input.build_arguments);
  return structuredClone({ ...input, build_arguments: buildArguments });
}

function checkedBuildArguments(
  input: Record<string, string>
): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('RTPengine build arguments are invalid');
  }
  const entries = Object.entries(input);
  if (entries.length < 1 || entries.length > 64) {
    throw new Error('RTPengine build arguments are invalid');
  }
  for (const [key, value] of entries) {
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(key) ||
        typeof value !== 'string' ||
        value.length > 512 ||
        /[\0\r\n]/.test(value)) {
      throw new Error('RTPengine build arguments are invalid');
    }
  }
  return Object.fromEntries(entries.sort(([left], [right]) =>
    left.localeCompare(right)
  ));
}

function checkedCycloneDx(
  input: RtpengineSupplyChainInput['cyclonedx']
): RtpengineSupplyChainInput['cyclonedx'] {
  if (!input ||
      !SHA256.test(input.sha256) ||
      input.document?.bomFormat !== 'CycloneDX' ||
      !['1.6', '1.7'].includes(input.document.specVersion) ||
      !/^urn:uuid:[0-9a-f-]{36}$/i.test(input.document.serialNumber) ||
      !Number.isSafeInteger(input.document.version) ||
      input.document.version < 1 ||
      !Array.isArray(input.document.components) ||
      input.document.components.length > 1_000_000) {
    throw new Error('CycloneDX SBOM is invalid');
  }
  const packageComponents = input.document.components.filter(
    (component) => component.type !== 'container'
  );
  if (packageComponents.length === 0) {
    throw new Error('runtime package coverage is missing from CycloneDX SBOM');
  }
  return structuredClone(input);
}

function checkedSpdx(
  input: RtpengineSupplyChainInput['spdx']
): RtpengineSupplyChainInput['spdx'] {
  if (!input ||
      !SHA256.test(input.sha256) ||
      input.document?.spdxVersion !== 'SPDX-2.3' ||
      input.document.SPDXID !== 'SPDXRef-DOCUMENT' ||
      !singleLine(input.document.name, 512) ||
      !singleLine(input.document.documentNamespace, 2_048) ||
      !Array.isArray(input.document.packages) ||
      input.document.packages.length > 1_000_000) {
    throw new Error('SPDX SBOM is invalid');
  }
  return structuredClone(input);
}

function checkedTrivy(
  input: RtpengineSupplyChainInput['trivy'],
  imageDigest: string
): RtpengineSupplyChainInput['trivy'] {
  if (!input ||
      !SHA256.test(input.sha256) ||
      !singleLine(input.tool_version, 128) ||
      !SHA256_DIGEST.test(input.scanner_image_digest) ||
      input.document?.SchemaVersion !== 2 ||
      input.document.ArtifactType !== 'container_image' ||
      !Array.isArray(input.document.Results) ||
      input.document.Results.length > 1_000_000 ||
      input.document.Metadata?.ImageID !== imageDigest) {
    throw new Error('Trivy vulnerability scan is invalid');
  }
  const databaseUpdatedAt = canonicalDate(
    input.database_updated_at,
    'Trivy database timestamp'
  );
  return structuredClone({
    ...input,
    database_updated_at: databaseUpdatedAt
  });
}

function checkedSecretScan(
  input: RtpengineSupplyChainInput['secret_scan']
): RtpengineSupplyChainInput['secret_scan'] {
  if (!input ||
      !SHA256.test(input.sha256) ||
      !singleLine(input.tool_version, 128) ||
      !SHA256_DIGEST.test(input.scanner_image_digest) ||
      input.document?.SchemaVersion !== 2 ||
      !Array.isArray(input.document.Results) ||
      input.document.Results.length > 1_000_000) {
    throw new Error('Trivy secret scan is invalid');
  }
  return structuredClone(input);
}

function criticalVulnerabilities(
  document: TrivyDocument
): TrivyVulnerability[] {
  const byId = new Map<string, TrivyVulnerability>();
  for (const result of document.Results) {
    for (const vulnerability of result.Vulnerabilities || []) {
      if (vulnerability.Severity !== 'CRITICAL') continue;
      if (!/^CVE-[0-9]{4}-[0-9]{4,}$/.test(vulnerability.VulnerabilityID)) {
        throw new Error('critical vulnerability identity is invalid');
      }
      byId.set(vulnerability.VulnerabilityID, structuredClone(vulnerability));
    }
  }
  return [...byId.values()].sort((left, right) =>
    left.VulnerabilityID.localeCompare(right.VulnerabilityID)
  );
}

function secretFindings(document: TrivyDocument): TrivySecret[] {
  const byId = new Map<string, TrivySecret>();
  for (const result of document.Results) {
    for (const secret of result.Secrets || []) {
      if (!singleLine(secret.RuleID, 256)) {
        throw new Error('secret finding identity is invalid');
      }
      byId.set(secret.RuleID, structuredClone(secret));
    }
  }
  return [...byId.values()].sort((left, right) =>
    left.RuleID.localeCompare(right.RuleID)
  );
}

function checkedExceptions(
  input: RtpengineSupplyChainInput['vulnerability_exceptions'],
  generatedAt: string
): RtpengineSupplyChainInput['vulnerability_exceptions'] {
  if (!Array.isArray(input) || input.length > 10_000) {
    throw new Error('vulnerability exceptions are invalid');
  }
  const seen = new Set<string>();
  return input.map((entry) => {
    if (!entry ||
        !/^CVE-[0-9]{4}-[0-9]{4,}$/.test(entry.vulnerability_id) ||
        seen.has(entry.vulnerability_id) ||
        !singleLine(entry.reason, 2_048)) {
      throw new Error('vulnerability exception is invalid');
    }
    const expiresAt = canonicalDate(
      entry.expires_at,
      'vulnerability exception expiry'
    );
    if (Date.parse(expiresAt) <= Date.parse(generatedAt)) {
      throw new Error(
        `vulnerability exception is expired: ${entry.vulnerability_id}`
      );
    }
    seen.add(entry.vulnerability_id);
    return { ...structuredClone(entry), expires_at: expiresAt };
  }).sort((left, right) =>
    left.vulnerability_id.localeCompare(right.vulnerability_id)
  );
}

function checkedSignature(
  input: RtpengineSupplyChainInput['signature']
): RtpengineSupplyChainInput['signature'] {
  if (!input || (input.status !== 'passed' && input.status !== 'not_run')) {
    throw new Error('signature status is invalid');
  }
  if (input.status === 'not_run') {
    if (!singleLine(input.reason, 1_024)) {
      throw new Error('signature not-run reason is required');
    }
    return structuredClone(input);
  }
  if (!singleLine(input.reference, 2_048)) {
    throw new Error('signature reference is required');
  }
  if (input.bundle_sha256 !== undefined &&
      !SHA256.test(input.bundle_sha256)) {
    throw new Error('signature bundle SHA-256 is invalid');
  }
  return structuredClone(input);
}

function canonicalDate(value: string, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is invalid`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function singleLine(value: unknown, maximum: number): boolean {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\0\r\n]/.test(value);
}

export async function collectRtpengineSupplyChainEvidence(
  env: Record<string, string | undefined>
): Promise<RtpengineSupplyChainEvidence> {
  const identity = await jsonFile<RtpengineSupplyChainInput['identity']>(
    requiredPath(env, 'IVEKIT_RTPENGINE_SUPPLY_CHAIN_IDENTITY')
  );
  const cycloneDxPath = requiredPath(
    env,
    'IVEKIT_RTPENGINE_SUPPLY_CHAIN_CYCLONEDX'
  );
  const spdxPath = requiredPath(env, 'IVEKIT_RTPENGINE_SUPPLY_CHAIN_SPDX');
  const trivyPath = requiredPath(env, 'IVEKIT_RTPENGINE_SUPPLY_CHAIN_TRIVY');
  const secretPath = requiredPath(
    env,
    'IVEKIT_RTPENGINE_SUPPLY_CHAIN_SECRET_SCAN'
  );
  const [cycloneDx, spdx, trivy, secretScan] = await Promise.all([
    artifactJson<CycloneDxDocument>(cycloneDxPath),
    artifactJson<SpdxDocument>(spdxPath),
    artifactJson<TrivyDocument>(trivyPath),
    artifactJson<TrivyDocument>(secretPath)
  ]);
  const exceptionsPath = optionalPath(
    env,
    'IVEKIT_RTPENGINE_SUPPLY_CHAIN_EXCEPTIONS'
  );
  const vulnerabilityExceptions = exceptionsPath
    ? await jsonFile<RtpengineSupplyChainInput['vulnerability_exceptions']>(
        exceptionsPath
      )
    : [];
  const signatureReference =
    env.IVEKIT_RTPENGINE_SUPPLY_CHAIN_SIGNATURE_REFERENCE?.trim();
  const signatureBundlePath = optionalPath(
    env,
    'IVEKIT_RTPENGINE_SUPPLY_CHAIN_SIGNATURE_BUNDLE'
  );
  if (signatureBundlePath && !signatureReference) {
    throw new Error('signature bundle requires a signature reference');
  }
  const signature: RtpengineSupplyChainInput['signature'] = signatureReference
    ? {
        status: 'passed',
        reference: checkedLine(
          signatureReference,
          'signature reference',
          2_048
        ),
        ...(signatureBundlePath
          ? { bundle_sha256: await fileSha256(signatureBundlePath) }
          : {})
      }
    : {
        status: 'not_run',
        reason: checkedLine(
          required(
            env,
            'IVEKIT_RTPENGINE_SUPPLY_CHAIN_SIGNATURE_NOT_RUN_REASON'
          ),
          'signature not-run reason',
          1_024
        )
      };
  const evidence = buildRtpengineSupplyChainEvidence({
    generated_at: required(env, 'IVEKIT_RTPENGINE_SUPPLY_CHAIN_GENERATED_AT'),
    identity,
    cyclonedx: {
      sha256: cycloneDx.sha256,
      document: cycloneDx.document
    },
    spdx: {
      sha256: spdx.sha256,
      document: spdx.document
    },
    trivy: {
      sha256: trivy.sha256,
      tool_version: required(
        env,
        'IVEKIT_RTPENGINE_SUPPLY_CHAIN_TRIVY_VERSION'
      ),
      scanner_image_digest: required(
        env,
        'IVEKIT_RTPENGINE_SUPPLY_CHAIN_TRIVY_IMAGE_DIGEST'
      ),
      database_updated_at: required(
        env,
        'IVEKIT_RTPENGINE_SUPPLY_CHAIN_TRIVY_DB_UPDATED_AT'
      ),
      document: trivy.document
    },
    secret_scan: {
      sha256: secretScan.sha256,
      tool_version: required(
        env,
        'IVEKIT_RTPENGINE_SUPPLY_CHAIN_SECRET_SCANNER_VERSION'
      ),
      scanner_image_digest: required(
        env,
        'IVEKIT_RTPENGINE_SUPPLY_CHAIN_SECRET_SCANNER_IMAGE_DIGEST'
      ),
      document: secretScan.document
    },
    signature,
    vulnerability_exceptions: vulnerabilityExceptions
  });
  await writeNewJson(
    requiredPath(env, 'IVEKIT_RTPENGINE_SUPPLY_CHAIN_PROVENANCE_OUTPUT'),
    evidence.provenance
  );
  await writeNewJson(
    requiredPath(env, 'IVEKIT_RTPENGINE_SUPPLY_CHAIN_EVIDENCE_OUTPUT'),
    evidence
  );
  return evidence;
}

async function artifactJson<T>(
  path: string
): Promise<{ sha256: string; document: T }> {
  const bytes = await boundedFile(path);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    document: parseJson<T>(bytes, path)
  };
}

async function jsonFile<T>(path: string): Promise<T> {
  return parseJson<T>(await boundedFile(path), path);
}

async function boundedFile(path: string): Promise<Buffer> {
  const bytes = await readFile(path);
  if (bytes.length < 2 || bytes.length > 64 * 1024 * 1024) {
    throw new Error(`supply-chain artifact size is invalid: ${path}`);
  }
  return bytes;
}

function parseJson<T>(bytes: Buffer, path: string): T {
  try {
    return JSON.parse(bytes.toString('utf8')) as T;
  } catch {
    throw new Error(`supply-chain artifact JSON is invalid: ${path}`);
  }
}

async function fileSha256(path: string): Promise<string> {
  return createHash('sha256').update(await boundedFile(path)).digest('hex');
}

async function writeNewJson(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  if (!isAbsolute(parent)) throw new Error('supply-chain output is invalid');
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function requiredPath(
  env: Record<string, string | undefined>,
  name: string
): string {
  return checkedPath(required(env, name), name);
}

function optionalPath(
  env: Record<string, string | undefined>,
  name: string
): string | undefined {
  const value = env[name]?.trim();
  return value ? checkedPath(value, name) : undefined;
}

function checkedPath(value: string, name: string): string {
  if (!isAbsolute(value) ||
      value.split('/').includes('..') ||
      /[\0\r\n]/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function required(
  env: Record<string, string | undefined>,
  name: string
): string {
  const value = env[name]?.trim();
  if (!value || /[\0\r\n]/.test(value)) throw new Error(`${name} is required`);
  return value;
}

function checkedLine(value: string, name: string, maximum: number): string {
  if (!singleLine(value, maximum)) throw new Error(`${name} is invalid`);
  return value;
}

if (process.argv[1] &&
    resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const evidence = await collectRtpengineSupplyChainEvidence(process.env);
    process.stdout.write(`${JSON.stringify({
      status: evidence.status,
      image_digest: evidence.identity.image_digest,
      critical_vulnerabilities:
        evidence.policy.critical_vulnerability_count,
      secret_findings: evidence.policy.secret_finding_count,
      signature: evidence.signature.status
    })}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `iveKit RTPengine supply-chain evidence failed: ${
        message.replace(/[\0\r\n]+/g, ' ').slice(0, 512)
      }\n`
    );
    process.exitCode = 1;
  }
}
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
