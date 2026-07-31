export interface IveKitReleaseOperationsInput {
  sourceCommit: string;
  generatedAt: string;
  imageReference: string;
  imageDigest: string;
  imageMetadataSha256: string;
  migrationManifestSha256: string;
  stage2EvidenceSha256: string;
  stage2ReleaseFingerprint: string;
}

export interface IveKitReleaseContract {
  schema_version: 2;
  product: 'iveKit standalone service';
  source_commit: string;
  generated_at: string;
  execution_status: 'ready' | 'blocked_build_required';
  image: {
    reference: string;
    digest: string;
    immutable_reference: string;
    metadata_path: 'service/image-metadata.json';
    metadata_sha256: string;
  };
  migrations: {
    policy: 'forward_only_expand_contract';
    manifest_path: 'service/migration-manifest.json';
    manifest_sha256: string;
    runner: 'node dist/converact-migrate.js';
    advisory_lock: 'ivekit_schema_migrations';
    required: [
      '061_ivekit_file_security.sql',
      '062_tinode_file_delivery_operations.sql',
      '063_livekit_media_quality.sql'
    ];
  };
  configuration: {
    stage2_evidence_path: 'operations/stage2-deployment-evidence.json';
    stage2_evidence_sha256: string;
    release_fingerprint_sha256: string;
    runtime_deployment_fingerprint_required: true;
    secret_values_embedded: false;
  };
  compose: {
    file: 'deploy/application/docker-compose.yml';
    voice_file: 'deploy/application/docker-compose.voice.yml';
    service: 'ivekit';
    migration_service: 'migrate';
    image_variable: 'IVEKIT_SERVICE_IMAGE';
  };
  helm: {
    chart: 'deploy/kubernetes/ivekit';
    image_repository_value: 'image.repository';
    image_digest_value: 'image.digest';
    migration_hook: 'pre-install,pre-upgrade';
  };
  database: {
    backup: 'verified_pre_upgrade_backup_required';
    rollback: 'restore_verified_pre_upgrade_backup_only';
    automatic_down_migrations: false;
  };
  acceptance: {
    status_path: 'acceptance/status.json';
    real_environment_results_may_not_be_inferred: true;
  };
}

export interface IveKitReleaseOperations {
  contract: IveKitReleaseContract;
  runbook: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SOURCE_COMMIT = /^[a-f0-9]{40}$/;
const SAFE_IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;
const DESTRUCTIVE_OPERATION = /(?:docker\s+compose\s+down\s+-v|\bDROP\s+(?:DATABASE|SCHEMA|TABLE)\b|\bTRUNCATE\b|\bDELETE\s+FROM\s+schema_migrations\b)/i;

export function createIveKitReleaseOperations(
  input: IveKitReleaseOperationsInput
): IveKitReleaseOperations {
  assertInput(input);
  const immutableReference = input.imageDigest
    ? `${input.imageReference}@${input.imageDigest}`
    : '';
  const contract: IveKitReleaseContract = {
    schema_version: 2,
    product: 'iveKit standalone service',
    source_commit: input.sourceCommit,
    generated_at: input.generatedAt,
    execution_status: immutableReference ? 'ready' : 'blocked_build_required',
    image: {
      reference: input.imageReference,
      digest: input.imageDigest,
      immutable_reference: immutableReference,
      metadata_path: 'service/image-metadata.json',
      metadata_sha256: input.imageMetadataSha256
    },
    migrations: {
      policy: 'forward_only_expand_contract',
      manifest_path: 'service/migration-manifest.json',
      manifest_sha256: input.migrationManifestSha256,
      runner: 'node dist/converact-migrate.js',
      advisory_lock: 'ivekit_schema_migrations',
      required: [
        '061_ivekit_file_security.sql',
        '062_tinode_file_delivery_operations.sql',
        '063_livekit_media_quality.sql'
      ]
    },
    configuration: {
      stage2_evidence_path: 'operations/stage2-deployment-evidence.json',
      stage2_evidence_sha256: input.stage2EvidenceSha256,
      release_fingerprint_sha256: input.stage2ReleaseFingerprint,
      runtime_deployment_fingerprint_required: true,
      secret_values_embedded: false
    },
    compose: {
      file: 'deploy/application/docker-compose.yml',
      voice_file: 'deploy/application/docker-compose.voice.yml',
      service: 'ivekit',
      migration_service: 'migrate',
      image_variable: 'IVEKIT_SERVICE_IMAGE'
    },
    helm: {
      chart: 'deploy/kubernetes/ivekit',
      image_repository_value: 'image.repository',
      image_digest_value: 'image.digest',
      migration_hook: 'pre-install,pre-upgrade'
    },
    database: {
      backup: 'verified_pre_upgrade_backup_required',
      rollback: 'restore_verified_pre_upgrade_backup_only',
      automatic_down_migrations: false
    },
    acceptance: {
      status_path: 'acceptance/status.json',
      real_environment_results_may_not_be_inferred: true
    }
  };
  const operations = { contract, runbook: renderRunbook(contract) };
  validateIveKitReleaseOperations(operations);
  return operations;
}

export function validateIveKitReleaseOperations(operations: IveKitReleaseOperations): void {
  const { contract, runbook } = operations;
  if (contract.schema_version !== 2 || contract.product !== 'iveKit standalone service') {
    throw new Error('invalid iveKit release contract');
  }
  if (!SOURCE_COMMIT.test(contract.source_commit)) throw new Error('invalid release source commit');
  if (!Number.isFinite(Date.parse(contract.generated_at))) throw new Error('invalid release timestamp');
  if (!SAFE_IMAGE_REFERENCE.test(contract.image.reference) ||
      floatingImageReference(contract.image.reference)) {
    throw new Error('release contract contains an unsafe image reference');
  }
  if (!SHA256.test(contract.image.metadata_sha256) ||
      !SHA256.test(contract.migrations.manifest_sha256) ||
      !SHA256.test(contract.configuration.stage2_evidence_sha256) ||
      !SHA256.test(contract.configuration.release_fingerprint_sha256)) {
    throw new Error('invalid release artifact checksum');
  }
  if (contract.image.digest) {
    const expected = `${contract.image.reference}@${contract.image.digest}`;
    if (!IMAGE_DIGEST.test(contract.image.digest) ||
        contract.image.immutable_reference !== expected ||
        contract.execution_status !== 'ready' ||
        floatingImageReference(contract.image.reference)) {
      throw new Error('release contract requires an immutable image');
    }
  } else if (contract.image.immutable_reference ||
      contract.execution_status !== 'blocked_build_required') {
    throw new Error('release without an image digest must remain blocked');
  }
  if (contract.migrations.policy !== 'forward_only_expand_contract' ||
      contract.database.rollback !== 'restore_verified_pre_upgrade_backup_only' ||
      contract.database.automatic_down_migrations !== false) {
    throw new Error('invalid database upgrade or rollback policy');
  }
  if (contract.image.metadata_path !== 'service/image-metadata.json' ||
      contract.migrations.manifest_path !== 'service/migration-manifest.json' ||
      JSON.stringify(contract.migrations.required) !== JSON.stringify([
        '061_ivekit_file_security.sql',
        '062_tinode_file_delivery_operations.sql',
        '063_livekit_media_quality.sql'
      ]) ||
      contract.configuration.stage2_evidence_path !== 'operations/stage2-deployment-evidence.json' ||
      contract.configuration.runtime_deployment_fingerprint_required !== true ||
      contract.configuration.secret_values_embedded !== false ||
      contract.compose.file !== 'deploy/application/docker-compose.yml' ||
      contract.compose.voice_file !== 'deploy/application/docker-compose.voice.yml' ||
      contract.compose.service !== 'ivekit' ||
      contract.compose.migration_service !== 'migrate' ||
      contract.compose.image_variable !== 'IVEKIT_SERVICE_IMAGE' ||
      contract.helm.chart !== 'deploy/kubernetes/ivekit' ||
      contract.helm.image_repository_value !== 'image.repository' ||
      contract.helm.image_digest_value !== 'image.digest' ||
      contract.helm.migration_hook !== 'pre-install,pre-upgrade' ||
      contract.database.backup !== 'verified_pre_upgrade_backup_required' ||
      contract.acceptance.status_path !== 'acceptance/status.json' ||
      contract.acceptance.real_environment_results_may_not_be_inferred !== true) {
    throw new Error('release contract contains an invalid deployment surface');
  }
  if (DESTRUCTIVE_OPERATION.test(runbook)) {
    throw new Error('destructive release operation is forbidden');
  }
  if (/:latest(?:\s|['"@]|$)/i.test(runbook)) {
    throw new Error('release runbook contains a mutable image');
  }
  for (const required of [
    contract.source_commit,
    contract.execution_status,
    contract.image.metadata_sha256,
    contract.migrations.manifest_sha256,
    contract.configuration.stage2_evidence_sha256,
    contract.configuration.release_fingerprint_sha256,
    'sha256sum --check SHA256SUMS',
    'restore-only'
  ]) {
    if (!runbook.includes(required)) throw new Error(`release runbook is missing ${required}`);
  }
  if (runbook !== renderRunbook(contract)) throw new Error('release runbook does not match its contract');
}

function assertInput(input: IveKitReleaseOperationsInput): void {
  if (!SOURCE_COMMIT.test(input.sourceCommit)) throw new Error('sourceCommit must be a full Git commit');
  if (!Number.isFinite(Date.parse(input.generatedAt))) throw new Error('generatedAt must be an ISO timestamp');
  if (!SAFE_IMAGE_REFERENCE.test(input.imageReference) || input.imageReference.includes('@') ||
      floatingImageReference(input.imageReference)) {
    throw new Error('imageReference must be a safe, non-floating OCI reference');
  }
  if (input.imageDigest && !IMAGE_DIGEST.test(input.imageDigest)) {
    throw new Error('imageDigest must be a sha256 digest');
  }
  if (!SHA256.test(input.imageMetadataSha256) || !SHA256.test(input.migrationManifestSha256) ||
      !SHA256.test(input.stage2EvidenceSha256) || !SHA256.test(input.stage2ReleaseFingerprint)) {
    throw new Error('release artifact checksums must be SHA-256 values');
  }
}

function floatingImageReference(reference: string): boolean {
  return /(?:^|[/:])latest$/i.test(reference) || !SAFE_IMAGE_REFERENCE.test(reference);
}

function imageRepository(reference: string): string {
  const slash = reference.lastIndexOf('/');
  const colon = reference.lastIndexOf(':');
  return colon > slash ? reference.slice(0, colon) : reference;
}

function renderRunbook(contract: IveKitReleaseContract): string {
  const immutableImage = contract.image.immutable_reference || '<digest-required-before-execution>';
  const repository = imageRepository(contract.image.reference);
  return [
    '# iveKit Standalone Upgrade And Rollback Runbook',
    '',
    `Release status: \`${contract.execution_status}\``,
    `Source commit: \`${contract.source_commit}\``,
    `Image metadata SHA-256: \`${contract.image.metadata_sha256}\``,
    `Migration manifest SHA-256: \`${contract.migrations.manifest_sha256}\``,
    `Stage 2 deployment evidence SHA-256: \`${contract.configuration.stage2_evidence_sha256}\``,
    `Stage 2 release fingerprint: \`${contract.configuration.release_fingerprint_sha256}\``,
    '',
    'Do not execute an upgrade while the status is `blocked_build_required`. Build and publish the image,',
    'record its registry digest in `service/image-metadata.json`, then regenerate and verify this bundle.',
    '',
    '## Release invariants',
    '',
    '- Verify `SHA256SUMS` before using any artifact.',
    '- Capture and restore-test a PostgreSQL backup before migration.',
    '- Migrations are forward-only and must follow expand/contract compatibility.',
    '- Migrations 061, 062, and 063 and the TURN, Egress, and file-security template fingerprints are release-bound.',
    '- Production acceptance must record the runtime deployment fingerprint; template fingerprints do not prove a live environment.',
    '- Application rollback never runs a schema downgrade.',
    '- Database rollback is restore-only from the verified pre-upgrade backup during an approved maintenance window.',
    '- Existing provider data, RustDesk identity keys, recordings, and object storage are not deleted by this procedure.',
    '',
    '## Integrity gate',
    '',
    '```bash',
    'sha256sum --check SHA256SUMS',
    `printf '%s  %s\\n' '${contract.image.metadata_sha256}' '${contract.image.metadata_path}' | sha256sum --check -`,
    `printf '%s  %s\\n' '${contract.migrations.manifest_sha256}' '${contract.migrations.manifest_path}' | sha256sum --check -`,
    `printf '%s  %s\\n' '${contract.configuration.stage2_evidence_sha256}' '${contract.configuration.stage2_evidence_path}' | sha256sum --check -`,
    '```',
    '',
    'Record the backup identifier, restore-test evidence, current immutable image, and health baseline in the change ticket.',
    'The commands below intentionally do not automate database backup because topology, encryption, and retention are operator-owned.',
    '',
    '## Compose upgrade',
    '',
    '```bash',
    `export IVEKIT_SERVICE_IMAGE='${immutableImage}'`,
    "export IVEKIT_ENV_FILE='/secure/ivekit/application.env'",
    'docker compose --project-name ivekit --env-file "$IVEKIT_ENV_FILE" -f deploy/application/docker-compose.yml config --quiet',
    'docker compose --project-name ivekit --env-file "$IVEKIT_ENV_FILE" -f deploy/application/docker-compose.yml run --rm runtime-role-init',
    'docker compose --project-name ivekit --env-file "$IVEKIT_ENV_FILE" -f deploy/application/docker-compose.yml run --rm migrate',
    'docker compose --project-name ivekit --env-file "$IVEKIT_ENV_FILE" -f deploy/application/docker-compose.yml up -d --no-deps ivekit',
    'docker compose --project-name ivekit --env-file "$IVEKIT_ENV_FILE" -f deploy/application/docker-compose.yml ps',
    'curl --fail --show-error http://127.0.0.1:8300/health',
    '```',
    '',
    'Add `-f deploy/application/docker-compose.voice.yml --profile voice` only after Voice preflight and provider secrets pass.',
    '',
    '## Helm upgrade',
    '',
    'The Chart migration hook initializes the runtime role and runs the advisory-locked migration before rollout.',
    '',
    '```bash',
    `export IVEKIT_IMAGE_REPOSITORY='${repository}'`,
    `export IVEKIT_IMAGE_DIGEST='${contract.image.digest || '<digest-required>'}'`,
    "export IVEKIT_NAMESPACE='ivekit'",
    "export IVEKIT_RELEASE='ivekit'",
    "export IVEKIT_VALUES_FILE='/secure/ivekit/values.yaml'",
    'helm upgrade --install "$IVEKIT_RELEASE" deploy/kubernetes/ivekit --namespace "$IVEKIT_NAMESPACE" --create-namespace --wait --atomic --values "$IVEKIT_VALUES_FILE" --set-string image.repository="$IVEKIT_IMAGE_REPOSITORY" --set-string image.digest="$IVEKIT_IMAGE_DIGEST"',
    'kubectl --namespace "$IVEKIT_NAMESPACE" rollout status deployment/"$IVEKIT_RELEASE"-ivekit --timeout=5m',
    'kubectl --namespace "$IVEKIT_NAMESPACE" get pods,jobs',
    '```',
    '',
    '## Application rollback',
    '',
    'Rollback is permitted only when the previous application is compatible with the already-expanded schema.',
    '',
    '### Compose',
    '',
    '```bash',
    "export PREVIOUS_IVEKIT_IMAGE='registry.example/ivekit/service@sha256:<previous-digest>'",
    'export IVEKIT_SERVICE_IMAGE="$PREVIOUS_IVEKIT_IMAGE"',
    'docker compose --project-name ivekit --env-file "$IVEKIT_ENV_FILE" -f deploy/application/docker-compose.yml up -d --no-deps ivekit',
    'curl --fail --show-error http://127.0.0.1:8300/health',
    '```',
    '',
    '### Helm',
    '',
    '```bash',
    'helm history "$IVEKIT_RELEASE" --namespace "$IVEKIT_NAMESPACE"',
    'helm rollback "$IVEKIT_RELEASE" <previous-revision> --namespace "$IVEKIT_NAMESPACE" --wait',
    'kubectl --namespace "$IVEKIT_NAMESPACE" rollout status deployment/"$IVEKIT_RELEASE"-ivekit --timeout=5m',
    '```',
    '',
    'If the old application is not compatible with the expanded schema, stop the rollout and use the approved restore-only',
    'database recovery procedure with the verified pre-upgrade backup. Never invent or run an automatic down migration.',
    '',
    '## Evidence boundary',
    '',
    '`acceptance/status.json` remains authoritative. A successful deployment does not change any real LiveKit, Tinode,',
    'RustDesk, RustPBX, OCR, ASR, quality, translation, PSTN, RTP, or physical-device result from `not_run` to `passed`.',
    ''
  ].join('\n');
}
