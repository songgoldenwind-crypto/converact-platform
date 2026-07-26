import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildRtpengineSupplyChainEvidence,
  collectRtpengineSupplyChainEvidence,
  type RtpengineSupplyChainInput
} from '../scripts/ivekit-rtpengine-supply-chain.js';

const SOURCE_COMMIT = 'a'.repeat(40);
const DIGEST_A = `sha256:${'b'.repeat(64)}`;
const DIGEST_B = `sha256:${'c'.repeat(64)}`;
const DIGEST_C = `sha256:${'d'.repeat(64)}`;
const SHA_A = 'e'.repeat(64);
const SHA_B = 'f'.repeat(64);

describe('iveKit RTPengine supply-chain evidence', () => {
  it('binds both SBOM formats and scanner results into provenance', () => {
    const evidence = buildRtpengineSupplyChainEvidence(validInput());

    assert.equal(evidence.status, 'passed');
    assert.equal(evidence.capacity_claim, 'none');
    assert.equal(evidence.identity.image_digest, DIGEST_A);
    assert.equal(evidence.artifacts.cyclonedx.format, 'CycloneDX-1.6');
    assert.equal(evidence.artifacts.spdx.format, 'SPDX-2.3');
    assert.equal(evidence.policy.critical_vulnerability_count, 0);
    assert.equal(evidence.policy.secret_finding_count, 0);
    assert.equal(evidence.signature.status, 'not_run');
    assert.equal(
      evidence.provenance.predicateType,
      'https://slsa.dev/provenance/v1'
    );
    assert.deepEqual(evidence.provenance.subject, [{
      name: 'ivekit/rtpengine',
      digest: { sha256: DIGEST_A.slice('sha256:'.length) }
    }]);
    assert.deepEqual(
      evidence.provenance.predicate.buildDefinition.resolvedDependencies,
      [
        {
          uri: `git+https://github.com/songgoldenwind-crypto/opc-platform@${SOURCE_COMMIT}`,
          digest: { gitCommit: SOURCE_COMMIT }
        },
        {
          uri: 'ivekit:rtpengine-upstream-archive',
          digest: { sha256: SHA_A }
        },
        {
          uri: 'ivekit:rtpengine-patch-set',
          digest: { sha256: SHA_B }
        },
        {
          uri: 'docker:toolchain',
          digest: { sha256: DIGEST_B.slice('sha256:'.length) }
        }
      ]
    );
  });

  it('hashes input files and writes exclusive mode-0600 evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ivekit-supply-chain-'));
    const input = validInput();
    const paths = {
      identity: join(directory, 'identity.json'),
      cyclonedx: join(directory, 'cyclonedx.json'),
      spdx: join(directory, 'spdx.json'),
      trivy: join(directory, 'trivy.json'),
      secrets: join(directory, 'secrets.json'),
      evidence: join(directory, 'evidence.json'),
      provenance: join(directory, 'provenance.json')
    };
    try {
      await Promise.all([
        writeJson(paths.identity, input.identity),
        writeJson(paths.cyclonedx, input.cyclonedx.document),
        writeJson(paths.spdx, input.spdx.document),
        writeJson(paths.trivy, input.trivy.document),
        writeJson(paths.secrets, input.secret_scan.document)
      ]);

      const evidence = await collectRtpengineSupplyChainEvidence({
        IVEKIT_RTPENGINE_SUPPLY_CHAIN_IDENTITY: paths.identity,
        IVEKIT_RTPENGINE_SUPPLY_CHAIN_CYCLONEDX: paths.cyclonedx,
        IVEKIT_RTPENGINE_SUPPLY_CHAIN_SPDX: paths.spdx,
        IVEKIT_RTPENGINE_SUPPLY_CHAIN_TRIVY: paths.trivy,
        IVEKIT_RTPENGINE_SUPPLY_CHAIN_SECRET_SCAN: paths.secrets,
        IVEKIT_RTPENGINE_SUPPLY_CHAIN_TRIVY_VERSION:
          input.trivy.tool_version,
        IVEKIT_RTPENGINE_SUPPLY_CHAIN_TRIVY_DB_UPDATED_AT:
          input.trivy.database_updated_at,
        IVEKIT_RTPENGINE_SUPPLY_CHAIN_SECRET_SCANNER_VERSION:
          input.secret_scan.tool_version,
        IVEKIT_RTPENGINE_SUPPLY_CHAIN_SIGNATURE_NOT_RUN_REASON:
          'No keyless CI identity or cosign key is available',
        IVEKIT_RTPENGINE_SUPPLY_CHAIN_GENERATED_AT: input.generated_at,
        IVEKIT_RTPENGINE_SUPPLY_CHAIN_EVIDENCE_OUTPUT: paths.evidence,
        IVEKIT_RTPENGINE_SUPPLY_CHAIN_PROVENANCE_OUTPUT: paths.provenance
      });

      assert.equal(evidence.status, 'passed');
      assert.equal((await stat(paths.evidence)).mode & 0o777, 0o600);
      assert.equal((await stat(paths.provenance)).mode & 0o777, 0o600);
      assert.deepEqual(
        JSON.parse(await readFile(paths.provenance, 'utf8')),
        evidence.provenance
      );
      await assert.rejects(
        collectRtpengineSupplyChainEvidence({
          IVEKIT_RTPENGINE_SUPPLY_CHAIN_IDENTITY: paths.identity,
          IVEKIT_RTPENGINE_SUPPLY_CHAIN_CYCLONEDX: paths.cyclonedx,
          IVEKIT_RTPENGINE_SUPPLY_CHAIN_SPDX: paths.spdx,
          IVEKIT_RTPENGINE_SUPPLY_CHAIN_TRIVY: paths.trivy,
          IVEKIT_RTPENGINE_SUPPLY_CHAIN_SECRET_SCAN: paths.secrets,
          IVEKIT_RTPENGINE_SUPPLY_CHAIN_TRIVY_VERSION:
            input.trivy.tool_version,
          IVEKIT_RTPENGINE_SUPPLY_CHAIN_TRIVY_DB_UPDATED_AT:
            input.trivy.database_updated_at,
          IVEKIT_RTPENGINE_SUPPLY_CHAIN_SECRET_SCANNER_VERSION:
            input.secret_scan.tool_version,
          IVEKIT_RTPENGINE_SUPPLY_CHAIN_SIGNATURE_NOT_RUN_REASON:
            'No keyless CI identity or cosign key is available',
          IVEKIT_RTPENGINE_SUPPLY_CHAIN_GENERATED_AT: input.generated_at,
          IVEKIT_RTPENGINE_SUPPLY_CHAIN_EVIDENCE_OUTPUT: paths.evidence,
          IVEKIT_RTPENGINE_SUPPLY_CHAIN_PROVENANCE_OUTPUT: paths.provenance
        }),
        /EEXIST/
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects critical vulnerabilities without an unexpired exception', () => {
    const input = validInput();
    input.trivy.document.Results[0]!.Vulnerabilities = [{
      VulnerabilityID: 'CVE-2099-0001',
      PkgName: 'libexample',
      InstalledVersion: '1.0.0',
      Severity: 'CRITICAL'
    }];

    assert.throws(
      () => buildRtpengineSupplyChainEvidence(input),
      /unexcepted critical vulnerabilities: CVE-2099-0001/
    );
  });

  it('accepts only an explicit unexpired critical-vulnerability exception', () => {
    const input = validInput();
    input.trivy.document.Results[0]!.Vulnerabilities = [{
      VulnerabilityID: 'CVE-2099-0001',
      PkgName: 'libexample',
      InstalledVersion: '1.0.0',
      Severity: 'CRITICAL'
    }];
    input.vulnerability_exceptions = [{
      vulnerability_id: 'CVE-2099-0001',
      reason: 'No fixed package exists in the pinned Debian snapshot',
      expires_at: '2099-02-01T00:00:00.000Z'
    }];

    const evidence = buildRtpengineSupplyChainEvidence(input);

    assert.equal(evidence.policy.critical_vulnerability_count, 1);
    assert.equal(evidence.policy.excepted_critical_vulnerability_count, 1);
  });

  it('rejects expired vulnerability exceptions', () => {
    const input = validInput();
    input.trivy.document.Results[0]!.Vulnerabilities = [{
      VulnerabilityID: 'CVE-2099-0001',
      PkgName: 'libexample',
      InstalledVersion: '1.0.0',
      Severity: 'CRITICAL'
    }];
    input.vulnerability_exceptions = [{
      vulnerability_id: 'CVE-2099-0001',
      reason: 'Temporary exception',
      expires_at: '2026-07-26T03:59:59.000Z'
    }];

    assert.throws(
      () => buildRtpengineSupplyChainEvidence(input),
      /vulnerability exception is expired/
    );
  });

  it('rejects secrets found in the runtime image', () => {
    const input = validInput();
    input.secret_scan.document.Results = [{
      Target: 'ivekit/rtpengine',
      Secrets: [{
        RuleID: 'private-key',
        Category: 'AsymmetricPrivateKey',
        Severity: 'HIGH',
        Title: 'Private key'
      }]
    }];

    assert.throws(
      () => buildRtpengineSupplyChainEvidence(input),
      /runtime image secret findings: private-key/
    );
  });

  it('never represents an absent signature as passed', () => {
    const input = validInput();
    input.signature = {
      status: 'passed',
      reference: ''
    };

    assert.throws(
      () => buildRtpengineSupplyChainEvidence(input),
      /signature reference is required/
    );
  });

  it('rejects mutable image and malformed SBOM identities', () => {
    assert.throws(
      () => buildRtpengineSupplyChainEvidence({
        ...validInput(),
        identity: {
          ...validInput().identity,
          image_digest: 'ivekit/rtpengine:latest'
        }
      }),
      /immutable RTPengine image digest/
    );
    assert.throws(
      () => buildRtpengineSupplyChainEvidence({
        ...validInput(),
        cyclonedx: {
          ...validInput().cyclonedx,
          document: {
            ...validInput().cyclonedx.document,
            bomFormat: 'NotCycloneDX'
          }
        }
      }),
      /CycloneDX SBOM is invalid/
    );
  });
});

function validInput(): RtpengineSupplyChainInput {
  return {
    generated_at: '2026-07-26T04:00:00.000Z',
    identity: {
      source_commit: SOURCE_COMMIT,
      image_reference: 'ivekit/rtpengine',
      image_digest: DIGEST_A,
      rtpengine_source_commit: '1'.repeat(40),
      archive_sha256: SHA_A,
      patch_set_sha256: SHA_B,
      toolchain_image_digest: DIGEST_B,
      builder_image_digest: DIGEST_C,
      architecture: 'amd64',
      build_arguments: {
        TARGETARCH: 'amd64',
        IVEKIT_BUILD_JOBS: '8'
      }
    },
    cyclonedx: {
      sha256: '2'.repeat(64),
      document: {
        bomFormat: 'CycloneDX',
        specVersion: '1.6',
        serialNumber: 'urn:uuid:00000000-0000-4000-8000-000000000001',
        version: 1,
        components: [{
          type: 'container',
          name: 'ivekit/rtpengine',
          version: DIGEST_A
        }]
      }
    },
    spdx: {
      sha256: '3'.repeat(64),
      document: {
        spdxVersion: 'SPDX-2.3',
        SPDXID: 'SPDXRef-DOCUMENT',
        name: 'ivekit-rtpengine',
        documentNamespace: 'https://ivekit.invalid/spdx/task10',
        packages: [{
          SPDXID: 'SPDXRef-Package-rtpengine',
          name: 'rtpengine',
          versionInfo: DIGEST_A
        }]
      }
    },
    trivy: {
      sha256: '4'.repeat(64),
      tool_version: '0.65.0',
      database_updated_at: '2026-07-26T03:00:00.000Z',
      document: {
        SchemaVersion: 2,
        ArtifactName: 'ivekit/rtpengine',
        ArtifactType: 'container_image',
        Metadata: { ImageID: DIGEST_A },
        Results: [{
          Target: 'ivekit/rtpengine',
          Vulnerabilities: []
        }]
      }
    },
    secret_scan: {
      sha256: '5'.repeat(64),
      tool_version: '0.65.0',
      document: {
        SchemaVersion: 2,
        ArtifactName: 'ivekit/rtpengine',
        Results: []
      }
    },
    signature: {
      status: 'not_run',
      reason: 'No keyless CI identity or cosign key is available'
    },
    vulnerability_exceptions: []
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
