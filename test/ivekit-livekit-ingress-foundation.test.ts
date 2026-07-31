import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import {
  patchLiveKitIngressDockerfile
} from '../infra/converact/livekit-ingress/apply-overlay.mjs';

function source(path: string): string {
  assert.ok(existsSync(path), `${path} is missing`);
  return readFileSync(path, 'utf8');
}

test('LiveKit Ingress exact source image is offline, immutable and release gated', () => {
  const overlay = source('infra/converact/livekit-ingress/apply-overlay.mjs');
  const build = source('infra/converact/livekit-ingress/build.sh');
  const workflow = source('.github/workflows/ivekit-livekit-ingress-image.yml');
  const dockerfile = patchLiveKitIngressDockerfile(ingressDockerfileFixture());

  assert.match(overlay, /LIVEKIT_INGRESS_UPSTREAM_TAG = 'v1\.5\.0'/);
  assert.match(
    overlay,
    /LIVEKIT_INGRESS_UPSTREAM_COMMIT =\s*\n\s*'363f6090d572db8eef5b60c273c0970826fb7ca6'/
  );
  assert.match(dockerfile, /ARG IVEKIT_INGRESS_BUILDER_IMAGE/);
  assert.match(dockerfile, /ARG IVEKIT_INGRESS_RUNTIME_IMAGE/);
  assert.match(dockerfile, /FROM \$\{IVEKIT_INGRESS_BUILDER_IMAGE\} AS ivekit-builder/);
  assert.match(dockerfile, /FROM \$\{IVEKIT_INGRESS_RUNTIME_IMAGE\}/);
  assert.match(dockerfile, /COPY vendor\/ vendor\//);
  assert.match(dockerfile, /GOFLAGS=-mod=vendor/);
  assert.match(dockerfile, /COPY ivekit\/toolchain\/go\/ \/usr\/local\/go\//);
  assert.match(dockerfile, /GOCACHE=\/tmp\/ivekit-ingress-go-cache/);
  assert.match(dockerfile, /rm -rf \/tmp\/ivekit-ingress-go-cache/);
  assert.match(dockerfile, /USER 10001:10001/);
  assert.doesNotMatch(dockerfile, /go mod download|apt-get|curl -L|wget|go\.dev/);
  assert.equal(patchLiveKitIngressDockerfile(dockerfile), dockerfile);

  assert.match(build, /LIVEKIT_INGRESS_UPSTREAM_COMMIT/);
  assert.match(build, /IVEKIT_LIVEKIT_INGRESS_BUILDER_IMAGE/);
  assert.match(build, /IVEKIT_LIVEKIT_INGRESS_RUNTIME_IMAGE/);
  assert.match(build, /@sha256:\[a-f0-9\]/);
  assert.match(build, /go -C "\$\{LIVEKIT_INGRESS_SOURCE_DIR\}" mod vendor/);
  assert.match(build, /--network=none/);
  assert.match(build, /--platform "linux\/\$\{target_arch\}"/);
  assert.match(build, /io\.ivekit\.component=livekit-ingress/);
  assert.match(build, /docker image inspect.*org\.opencontainers\.image\.revision/);
  assert.match(build, /image user.*10001:10001/);
  assert.match(build, /docker run --rm --entrypoint \/bin\/ingress.*--version/);

  assert.match(workflow, /repository: livekit\/ingress/);
  assert.match(workflow, /ref: 363f6090d572db8eef5b60c273c0970826fb7ca6/);
  assert.match(workflow, /LIVEKIT_INGRESS_TAG: v1\.5\.0/);
  assert.match(
    workflow,
    /IVEKIT_LIVEKIT_INGRESS_BUILDER_IMAGE: \$\{\{ vars\.IVEKIT_LIVEKIT_INGRESS_BUILDER_IMAGE \}\}/
  );
  assert.match(
    workflow,
    /IVEKIT_LIVEKIT_INGRESS_RUNTIME_IMAGE: \$\{\{ vars\.IVEKIT_LIVEKIT_INGRESS_RUNTIME_IMAGE \}\}/
  );
  assert.match(workflow, /for arch in amd64 arm64/);
  assert.match(workflow, /ghcr\.io\/songgoldenwind-crypto\/opc-ivekit-livekit-ingress/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/ivekit-oci-release-gate\.yml/);
  assert.match(workflow, /digest: \$\{\{ needs\.publish\.outputs\.digest \}\}/);

  for (const [, action, revision] of workflow.matchAll(/uses:\s+([^@\s]+)@([^\s]+)/g)) {
    if (action.startsWith('./')) continue;
    assert.match(revision, /^[a-f0-9]{40}$/, `${action} is not commit-pinned`);
  }
});

test('LiveKit Ingress Helm pool isolates public media and admission capacity', () => {
  const deployment = source('infra/k8s/templates/livekit-ingress-deployment.yaml');
  const values = source('infra/k8s/values.yaml');

  assert.match(deployment, /required "media\.ingress\.image\.digest is required/);
  assert.match(deployment, /image: "\{\{ \$ingressImageRepository \}\}@\{\{ \$ingressImageDigest \}\}"/);
  assert.match(deployment, /kind: Deployment/);
  assert.match(deployment, /maxSurge: 0/);
  assert.match(deployment, /maxUnavailable: 1/);
  assert.match(deployment, /hostNetwork: \{\{ \.Values\.media\.ingress\.hostNetwork \}\}/);
  assert.match(deployment, /ClusterFirstWithHostNet/);
  assert.match(deployment, /containerPort: \{\{ \.Values\.media\.ingress\.rtmpPort \}\}/);
  assert.match(deployment, /containerPort: \{\{ \.Values\.media\.ingress\.whipPort \}\}/);
  assert.match(
    deployment,
    /containerPort: \{\{ \.Values\.media\.ingress\.rtcUdpPort \}\}[\s\S]*protocol: UDP/
  );
  assert.match(deployment, /path: \/availability/);
  assert.match(deployment, /path: \/metrics/);
  assert.match(deployment, /kind: PodDisruptionBudget/);
  assert.match(deployment, /podAntiAffinity/);
  assert.match(deployment, /topologySpreadConstraints/);
  assert.match(deployment, /app\.kubernetes\.io\/instance: \{\{ \.Release\.Name \}\}/);
  assert.match(deployment, /kind: NetworkPolicy/);
  assert.match(deployment, /LIVEKIT_API_KEY/);
  assert.match(deployment, /LIVEKIT_API_SECRET/);
  assert.match(deployment, /LIVEKIT_WS_URL/);
  assert.match(deployment, /redis:[\s\S]*include "opc\.livekitRedisConfig"/);
  assert.match(deployment, /cpu_cost:[\s\S]*rtmp_cpu_cost:[\s\S]*whip_cpu_cost:/);
  assert.match(deployment, /preStop:[\s\S]*SIGTERM/);

  assert.match(values, /ingress:[\s\S]*enabled: false/);
  assert.match(values, /repository: ivekit\/livekit-ingress/);
  assert.match(values, /digest: ""/);
  assert.match(values, /replicaCount: 3/);
  assert.match(values, /hostNetwork: true/);
  assert.match(values, /rtmpPort: 1935/);
  assert.match(values, /whipPort: 8080/);
  assert.match(values, /rtcUdpPort: 7885/);
  assert.match(values, /healthPort: 8090/);
  assert.match(values, /prometheusPort: 9091/);
  assert.match(values, /minAvailable: 2/);
});

function ingressDockerfileFixture(): string {
  return [
    'ARG GSTVERSION=1.26.7',
    'FROM livekit/gstreamer:$GSTVERSION-dev',
    'ARG TARGETPLATFORM',
    'ARG GOVERSION',
    'WORKDIR /workspace',
    'RUN apt-get update && apt-get install -y curl',
    'RUN if [ "$TARGETPLATFORM" = "linux/arm64" ]; then GOARCH=arm64; else GOARCH=amd64; fi && \\',
    '    curl -L -o /tmp/go.tar.gz "https://go.dev/dl/go$GOVERSION.linux-$GOARCH.tar.gz"',
    'RUN tar -C /usr/local -xzf /tmp/go.tar.gz',
    'COPY go.mod .',
    'COPY go.sum .',
    'RUN go mod download',
    'COPY cmd/ cmd/',
    'COPY pkg/ pkg/',
    'COPY version/ version/',
    'RUN if [ "$TARGETPLATFORM" = "linux/arm64" ]; then GOARCH=arm64; else GOARCH=amd64; fi && \\',
    '    CGO_ENABLED=1 GOOS=linux GOARCH=${GOARCH} GO111MODULE=on go build -a -o ingress ./cmd/server',
    'ARG GSTVERSION',
    'FROM livekit/gstreamer:$GSTVERSION-prod',
    'RUN apt-get update && apt-get install -y wget',
    'COPY --from=0 /workspace/ingress /bin/',
    'ENTRYPOINT ["ingress"]',
    ''
  ].join('\n');
}
