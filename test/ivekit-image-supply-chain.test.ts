import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync('.github/workflows/ivekit-oci-release-gate.yml', 'utf8');

test('shared OCI release gate is reusable and grants only required publishing permissions', () => {
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /image:[\s\S]*required: true[\s\S]*type: string/);
  assert.match(workflow, /digest:[\s\S]*required: true[\s\S]*type: string/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /packages: write/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /attestations: write/);
  assert.match(workflow, /artifact-metadata: write/);
  assert.doesNotMatch(workflow, /actions: write|administration: write|contents: write/);
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(workflow, /secrets\.GITHUB_TOKEN/);
});

test('shared OCI release gate fails closed on mutable subjects and severe vulnerabilities', () => {
  assert.match(workflow, /\^ghcr\\\.io\/\[a-z0-9/);
  assert.match(workflow, /\^sha256:\[a-f0-9\]\{64\}\$/);
  assert.match(workflow, /image-ref: \$\{\{ inputs\.image \}\}@\$\{\{ inputs\.digest \}\}/);
  assert.match(workflow, /format: spdx-json/);
  assert.match(workflow, /output: image\.sbom\.spdx\.json/);
  assert.match(workflow, /severity: HIGH,CRITICAL/);
  assert.match(workflow, /exit-code: '1'/);
  assert.match(workflow, /ignore-unfixed: 'false'/);
  assert.match(workflow, /version: v0\.70\.0/);
});

test('shared OCI release gate signs and attests the immutable image subject', () => {
  assert.match(workflow, /cosign sign --yes "\$\{IMAGE\}@\$\{DIGEST\}"/);
  assert.match(workflow, /cosign verify "\$\{IMAGE\}@\$\{DIGEST\}"/);
  assert.match(workflow, /subject-name: \$\{\{ inputs\.image \}\}/);
  assert.match(workflow, /subject-digest: \$\{\{ inputs\.digest \}\}/);
  assert.match(workflow, /sbom-path: image\.sbom\.spdx\.json/);
  assert.ok((workflow.match(/push-to-registry: true/g) || []).length >= 2);
  assert.match(workflow, /gh attestation verify "oci:\/\/\$\{IMAGE\}@\$\{DIGEST\}"/);
});

test('shared OCI release gate pins every third-party action to a full commit', () => {
  const actions = [...workflow.matchAll(/uses:\s+([^@\s]+)@([^\s]+)/g)];
  assert.ok(actions.length >= 5);
  for (const [, action, revision] of actions) {
    assert.match(revision, /^[a-f0-9]{40}$/, `${action} is not commit-pinned`);
  }
  assert.match(workflow, /aquasecurity\/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25/);
  assert.match(workflow, /sigstore\/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6/);
  assert.ok(
    (workflow.match(/actions\/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6/g) || []).length >= 2
  );
});

test('every repository Dockerfile pins external base images by digest', () => {
  const dockerfiles = [
    'Dockerfile',
    'frontend/Dockerfile',
    'infra/capacity/Dockerfile',
    'infra/ivekit/kamailio/Dockerfile',
    'infra/ivekit/rustdesk-server/Dockerfile',
    'infra/ivekit/rustpbx/Dockerfile.runtime',
    'services/ai-agent-py/Dockerfile',
    'services/ivekit-service/Dockerfile'
  ];
  for (const dockerfile of dockerfiles) {
    const stages = new Set<string>();
    for (const line of readFileSync(dockerfile, 'utf8').split('\n')) {
      const from = /^FROM\s+([^\s]+)(?:\s+AS\s+([^\s]+))?/i.exec(line.trim());
      if (!from) continue;
      const [, image, stage] = from;
      if (!stages.has(image)) {
        assert.match(image, /@sha256:[a-f0-9]{64}$/, `${dockerfile}: ${line}`);
      }
      if (stage) stages.add(stage);
    }
  }

  const livekitSip = readFileSync('infra/ivekit/livekit-sip/Dockerfile', 'utf8');
  const livekitBuild = readFileSync('infra/ivekit/livekit-sip/build.sh', 'utf8');
  assert.match(livekitSip, /FROM \$\{LIVEKIT_SIP_BUILDER_IMAGE\}/);
  assert.match(livekitSip, /FROM \$\{LIVEKIT_SIP_RUNTIME_IMAGE\}/);
  assert.match(livekitBuild, /@sha256:\[a-f0-9\]/);
});

test('core source images share one digest-only build and release workflow', () => {
  const reusable = readFileSync(
    '.github/workflows/ivekit-source-image-release.yml',
    'utf8'
  );
  const caller = readFileSync('.github/workflows/ivekit-core-images.yml', 'utf8');

  assert.match(reusable, /workflow_call:/);
  for (const input of ['image', 'context', 'dockerfile', 'platforms', 'prepare']) {
    assert.match(reusable, new RegExp(`${input}:[\\s\\S]*type: string`));
  }
  assert.match(reusable, /push: true/);
  assert.match(reusable, /outputs:[\s\S]*digest:/);
  assert.match(reusable, /uses: \.\/\.github\/workflows\/ivekit-oci-release-gate\.yml/);
  assert.match(reusable, /digest: \$\{\{ needs\.publish\.outputs\.digest \}\}/);

  const actions = [...reusable.matchAll(/uses:\s+([^@\s]+)@([^\s]+)/g)];
  assert.ok(actions.length >= 5);
  for (const [, action, revision] of actions) {
    if (action.startsWith('./')) continue;
    assert.match(revision, /^[a-f0-9]{40}$/, `${action} is not commit-pinned`);
  }

  for (const image of [
    'opc-platform',
    'opc-frontend',
    'opc-ivekit-service',
    'opc-ivekit-capacity-tools',
    'opc-ivekit-kamailio',
    'opc-ai-agent'
  ]) {
    assert.match(caller, new RegExp(`ghcr\\.io/songgoldenwind-crypto/${image}`));
  }
  assert.match(caller, /uses: \.\/\.github\/workflows\/ivekit-source-image-release\.yml/);
  assert.match(caller, /strategy:[\s\S]*matrix:[\s\S]*include:/);
});

test('iveKit service image is built from its generated standalone source context', () => {
  const reusable = readFileSync(
    '.github/workflows/ivekit-source-image-release.yml',
    'utf8'
  );
  const caller = readFileSync('.github/workflows/ivekit-core-images.yml', 'utf8');

  assert.match(reusable, /PREPARE: \$\{\{ inputs\.prepare \}\}/);
  assert.match(reusable, /none\|ivekit-standalone/);
  assert.match(reusable, /scripts\/ivekit-standalone-build-context\.ts/);
  assert.match(reusable, /OPC_IVEKIT_STANDALONE_CONTEXT_DIR="\$\{CONTEXT\}"/);
  assert.match(reusable, /OPC_IVEKIT_SOURCE_COMMIT="\$\{GITHUB_SHA\}"/);
  assert.doesNotMatch(reusable, /eval\s+"?\$\{?PREPARE/);

  const serviceEntry = caller.match(/- id: ivekit-service[\s\S]*?(?=\n          - id:)/)?.[0] || '';
  assert.match(serviceEntry, /context: \.tmp\/ivekit-standalone-context/);
  assert.match(serviceEntry, /dockerfile: \.tmp\/ivekit-standalone-context\/Dockerfile/);
  assert.match(serviceEntry, /prepare: ivekit-standalone/);
  assert.match(caller, /prepare: \$\{\{ matrix\.prepare \}\}/);
});

test('LiveKit Server release rebuilds and gates the exact maintained fork', () => {
  const release = readFileSync(
    '.github/workflows/ivekit-livekit-server-image.yml',
    'utf8'
  );

  assert.match(release, /repository: livekit\/livekit/);
  assert.match(release, /ref: 0b3fd288e3ef3263ec475ba0d78cf3ad77459981/);
  assert.match(release, /LIVEKIT_TAG: v1\.13\.4/);
  assert.ok((release.match(/apply-overlay\.mjs upstream/g) || []).length >= 2);
  assert.match(release, /go test -C upstream \.\/cmd\/server \.\/pkg\/sfu \.\/pkg\/sfu\/utils/);
  assert.match(release, /go -C upstream mod vendor/);
  assert.match(release, /platforms: linux\/amd64,linux\/arm64/);
  assert.match(release, /ghcr\.io\/songgoldenwind-crypto\/opc-ivekit-livekit-server/);
  assert.match(release, /uses: \.\/\.github\/workflows\/ivekit-oci-release-gate\.yml/);
  assert.match(release, /digest: \$\{\{ needs\.publish\.outputs\.digest \}\}/);

  for (const [, action, revision] of release.matchAll(/uses:\s+([^@\s]+)@([^\s]+)/g)) {
    if (action.startsWith('./')) continue;
    assert.match(revision, /^[a-f0-9]{40}$/, `${action} is not commit-pinned`);
  }
});

test('Tinode release builds an exact multi-architecture non-root fork and gates its digest', () => {
  const release = readFileSync(
    '.github/workflows/ivekit-tinode-server-image.yml',
    'utf8'
  );

  assert.match(release, /repository: tinode\/chat/);
  assert.match(release, /ref: 22a7c18e9cd695e9a061bf1b8c84175196ef5a15/);
  assert.match(release, /TINODE_TAG: v0\.25\.3/);
  assert.match(release, /VERSION: v0\.25\.3-ivekit\.3-22a7c18e/);
  assert.match(release, /IVEKIT_TINODE_BUILDER_IMAGE: \$\{\{ vars\.IVEKIT_TINODE_BUILDER_IMAGE \}\}/);
  assert.match(release, /IVEKIT_TINODE_RUNTIME_IMAGE: \$\{\{ vars\.IVEKIT_TINODE_RUNTIME_IMAGE \}\}/);
  assert.match(release, /for arch in amd64 arm64/);
  assert.match(release, /ghcr\.io\/songgoldenwind-crypto\/opc-ivekit-tinode-server/);
  assert.match(release, /uses: \.\/\.github\/workflows\/ivekit-oci-release-gate\.yml/);
  assert.match(release, /digest: \$\{\{ needs\.publish\.outputs\.digest \}\}/);

  for (const [, action, revision] of release.matchAll(/uses:\s+([^@\s]+)@([^\s]+)/g)) {
    if (action.startsWith('./')) continue;
    assert.match(revision, /^[a-f0-9]{40}$/, `${action} is not commit-pinned`);
  }
});

test('LiveKit Egress release removes mutable build inputs and gates a multi-architecture digest', () => {
  const release = readFileSync(
    '.github/workflows/ivekit-livekit-egress-image.yml',
    'utf8'
  );

  assert.match(release, /repository: livekit\/egress/);
  assert.match(release, /ref: 7d3572a0bf1959cbbc452f5ba390b6a90b7dc249/);
  assert.match(release, /LIVEKIT_EGRESS_TAG: v1\.13\.0/);
  for (const input of [
    'TEMPLATE',
    'BUILDER',
    'RUNTIME'
  ]) {
    assert.match(
      release,
      new RegExp(`IVEKIT_LIVEKIT_EGRESS_${input}_IMAGE: \\$\\{\\{ vars\\.IVEKIT_LIVEKIT_EGRESS_${input}_IMAGE \\}\\}`)
    );
  }
  assert.match(release, /for arch in amd64 arm64/);
  assert.match(release, /ghcr\.io\/songgoldenwind-crypto\/opc-ivekit-livekit-egress/);
  assert.match(release, /uses: \.\/\.github\/workflows\/ivekit-oci-release-gate\.yml/);
  assert.match(release, /digest: \$\{\{ needs\.publish\.outputs\.digest \}\}/);

  for (const [, action, revision] of release.matchAll(/uses:\s+([^@\s]+)@([^\s]+)/g)) {
    if (action.startsWith('./')) continue;
    assert.match(revision, /^[a-f0-9]{40}$/, `${action} is not commit-pinned`);
  }
});

test('LiveKit Ingress release uses exact source, immutable inputs and the shared digest gate', () => {
  const release = readFileSync(
    '.github/workflows/ivekit-livekit-ingress-image.yml',
    'utf8'
  );

  assert.match(release, /repository: livekit\/ingress/);
  assert.match(release, /ref: 363f6090d572db8eef5b60c273c0970826fb7ca6/);
  assert.match(release, /LIVEKIT_INGRESS_TAG: v1\.5\.0/);
  for (const input of ['BUILDER', 'RUNTIME']) {
    assert.match(
      release,
      new RegExp(`IVEKIT_LIVEKIT_INGRESS_${input}_IMAGE: \\$\\{\\{ vars\\.IVEKIT_LIVEKIT_INGRESS_${input}_IMAGE \\}\\}`)
    );
  }
  assert.match(release, /for arch in amd64 arm64/);
  assert.match(release, /ghcr\.io\/songgoldenwind-crypto\/opc-ivekit-livekit-ingress/);
  assert.match(release, /uses: \.\/\.github\/workflows\/ivekit-oci-release-gate\.yml/);
  assert.match(release, /digest: \$\{\{ needs\.publish\.outputs\.digest \}\}/);

  for (const [, action, revision] of release.matchAll(/uses:\s+([^@\s]+)@([^\s]+)/g)) {
    if (action.startsWith('./')) continue;
    assert.match(revision, /^[a-f0-9]{40}$/, `${action} is not commit-pinned`);
  }
});
