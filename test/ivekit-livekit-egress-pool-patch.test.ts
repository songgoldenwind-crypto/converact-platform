import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  LIVEKIT_EGRESS_UPSTREAM_COMMIT,
  LIVEKIT_EGRESS_UPSTREAM_TAG,
  patchLiveKitEgressDockerfile,
  patchLiveKitEgressGoMod,
  patchLiveKitEgressMonitor
} from '../infra/converact/livekit-egress/apply-overlay.mjs';

test('LiveKit Egress pool overlay is exact-release bound and rejects cross-pool request types first', () => {
  assert.equal(LIVEKIT_EGRESS_UPSTREAM_TAG, 'v1.13.0');
  assert.equal(
    LIVEKIT_EGRESS_UPSTREAM_COMMIT,
    '7d3572a0bf1959cbbc452f5ba390b6a90b7dc249'
  );
  const patched = patchLiveKitEgressMonitor(monitorFixture());

  assert.match(patched, /ivekitegresspool "ivekit\.local\/egresspool"/);
  assert.match(patched, /ivekitPool \*ivekitegresspool\.Policy/);
  assert.match(patched, /ivekitPool, err := ivekitegresspool\.PolicyFromEnv\(\)/);
  assert.match(patched, /ivekitPool: ivekitPool/);
  assert.match(
    patched,
    /requestType := requestTypeFromReq\(req\)[\s\S]*m\.ivekitPool\.Allows\(requestType\)/
  );
  assert.match(patched, /m\.ivekitPool\.Draining\(\)/);
  assert.match(patched, /m\.ivekitPool\.AllowsConcurrent\(m\.requests\.Load\(\)\)/);
  assert.match(patched, /m\.initIveKitPrometheus\(\)/);
  assert.match(patched, /m\.ivekitPool\.ObserveRejection\("draining"\)/);
  assert.match(patched, /m\.ivekitPool\.ObserveRejection\("request_type"\)/);
  assert.match(patched, /m\.ivekitPool\.ObserveRejection\("slots"\)/);
  assert.ok(
    patched.indexOf('m.ivekitPool.Allows(requestType)') <
      patched.indexOf('m.checkMemoryAdmissionLocked()')
  );
  assert.equal(patchLiveKitEgressMonitor(patched), patched);
});

test('LiveKit Egress monitor patch accepts the exact gofmt-aligned v1.13.0 constructor', () => {
  const source = monitorFixture().replace(
    '\t\tcpuCostConfig: conf.CPUCostConfig,',
    '\t\tcpuCostConfig:  conf.CPUCostConfig,'
  );

  const patched = patchLiveKitEgressMonitor(source);

  assert.match(patched, /cpuCostConfig:\s+conf\.CPUCostConfig,/);
  assert.match(patched, /ivekitPool:\s+ivekitPool,/);
});

test('LiveKit Egress overlay adds only the local pool policy module', () => {
  const patched = patchLiveKitEgressGoMod(
    'module github.com/livekit/egress\n\ngo 1.24.0\n'
  );
  assert.match(patched, /require ivekit\.local\/egresspool v0\.0\.0/);
  assert.match(patched, /replace ivekit\.local\/egresspool => \.\/ivekit\/egress-pool/);
  assert.equal(patchLiveKitEgressGoMod(patched), patched);
});

test('LiveKit Egress overlay makes the upstream production Dockerfile build the local policy', () => {
  const patched = patchLiveKitEgressDockerfile(egressDockerfileFixture());

  for (const input of [
    'IVEKIT_EGRESS_TEMPLATE_IMAGE',
    'IVEKIT_EGRESS_BUILDER_IMAGE',
    'IVEKIT_EGRESS_RUNTIME_IMAGE'
  ]) {
    assert.match(patched, new RegExp(`ARG ${input}`));
    assert.match(patched, new RegExp(`FROM \\$\\{${input}\\}`));
  }
  assert.doesNotMatch(patched, /^FROM livekit\//m);
  assert.doesNotMatch(patched, /^ADD https:\/\//m);
  assert.doesNotMatch(patched, /apt-get/);
  assert.doesNotMatch(patched, /chrome-installer/);
  assert.match(patched, /COPY ivekit\/egress-pool\/ ivekit\/egress-pool\//);
  assert.match(patched, /COPY vendor\/ vendor\//);
  assert.match(patched, /GOFLAGS=-mod=vendor/);
  assert.doesNotMatch(patched, /go mod download/);
  assert.match(patched, /GOCACHE=\/tmp\/ivekit-egress-go-cache/);
  assert.match(patched, /rm -rf \/tmp\/ivekit-egress-go-cache/);
  assert.match(patched, /COPY ivekit\/toolchain\/go\/ \/usr\/local\/go\//);
  assert.match(patched, /test "\$\(head -n 1 \/usr\/local\/go\/VERSION\)" = "go1\.26\.2"/);
  assert.doesNotMatch(patched, /wget https:\/\/go\.dev\/dl\/go1\.26\.2/);
  assert.match(patched, /go test \.\/pkg\/stats/);
  assert.ok(patched.indexOf('go test ./pkg/stats') < patched.indexOf('go build -a'));
  assert.equal(patchLiveKitEgressDockerfile(patched), patched);
});

test('LiveKit Egress build and Kubernetes pools enforce the source-level policy boundary', () => {
  const build = readFileSync('infra/converact/livekit-egress/build.sh', 'utf8');
  const deployment = readFileSync('infra/k8s/templates/livekit-egress-deployment.yaml', 'utf8');
  const values = readFileSync('infra/k8s/values.yaml', 'utf8');
  const metrics = readFileSync('infra/converact/livekit-egress/ivekit_metrics.go', 'utf8');

  assert.match(build, /LIVEKIT_EGRESS_UPSTREAM_COMMIT/);
  assert.match(build, /golang\.org\/toolchain@v0\.0\.1-go1\.26\.2\.linux-\$\{target_arch\}/);
  assert.match(build, /h1:825B2ojAZW7usy4LtVvkxKs89EwlM1mqV0OvDbIA5Ak=/);
  assert.match(build, /h1:mCBp0gCL9gQVqXpC60jQ7R46JDxL73qeF8hv6SnV2ss=/);
  assert.match(build, /aarch64\|arm64/);
  assert.match(build, /x86_64\|amd64/);
  assert.match(build, /GOSUMDB="\$\{GOSUMDB:-sum\.golang\.org\}"/);
  assert.match(build, /chmod -R u\+w "\$\{toolchain_target\}"/);
  assert.match(build, /chmod 0555 "\$\{toolchain_target\}\/bin\/go"/);
  assert.match(build, /pkg\/tool\/linux_\$\{target_arch\}.*chmod 0555/);
  assert.match(build, /git -C "\$\{LIVEKIT_EGRESS_SOURCE_DIR\}" rev-parse HEAD/);
  assert.match(build, /go test -C "\$\{LIVEKIT_EGRESS_SOURCE_DIR\}\/ivekit\/egress-pool" \.\/\.\.\./);
  assert.doesNotMatch(build, /go test -C "\$\{LIVEKIT_EGRESS_SOURCE_DIR\}" \.\/pkg\/stats/);
  assert.match(build, /--file "\$\{LIVEKIT_EGRESS_SOURCE_DIR\}\/build\/egress\/Dockerfile"/);
  assert.match(build, /--platform "linux\/\$\{target_arch\}"/);
  for (const input of [
    'TEMPLATE',
    'BUILDER',
    'RUNTIME'
  ]) {
    assert.match(build, new RegExp(`IVEKIT_LIVEKIT_EGRESS_${input}_IMAGE`));
  }
  assert.match(build, /@sha256:\[a-f0-9\]/);
  assert.match(build, /go -C "\$\{LIVEKIT_EGRESS_SOURCE_DIR\}" mod vendor/);
  assert.ok(
    build.indexOf('rm -rf "${toolchain_target}"') <
      build.indexOf('go -C "${LIVEKIT_EGRESS_SOURCE_DIR}" mod vendor')
  );
  assert.match(build, /--network=none/);
  assert.match(build, /io\.ivekit\.egress-pool-contract=ivekit-egress-pool-v1/);
  assert.match(build, /docker image inspect.*org\.opencontainers\.image\.revision/);
  assert.match(build, /docker run --rm --entrypoint \/bin\/egress.*--version/);
  assert.match(build, /IVEKIT_EGRESS_POOL_NAME/);
  assert.match(build, /ivekit_livekit_egress_policy_rejections_total/);
  assert.match(deployment, /IVEKIT_EGRESS_POOL_NAME/);
  assert.match(deployment, /IVEKIT_EGRESS_ALLOWED_REQUEST_TYPES/);
  assert.match(deployment, /IVEKIT_EGRESS_MAX_CONCURRENT_REQUESTS/);
  assert.match(deployment, /IVEKIT_EGRESS_DRAIN_FILE/);
  assert.match(deployment, /IVEKIT_EGRESS_SPOOL_PATH/);
  assert.match(deployment, /required "media\.egress\.image\.digest is required/);
  assert.match(deployment, /lower \$egressImageRepository/);
  assert.match(deployment, /regexMatch "\(\^\|\/\)ivekit\/livekit-egress\$"/);
  assert.match(deployment, /must identify an iveKit custom image ending with ivekit\/livekit-egress/);
  assert.match(deployment, /media\.egress\.image\.allowedRegistries/);
  assert.match(deployment, /is not listed in media\.egress\.image\.allowedRegistries/);
  assert.match(deployment, /ivekit-egress-pool-v1/);
  assert.match(deployment, /image: "{{ \$egressImageRepository }}@{{ \$egressImageDigest }}"/);
  assert.doesNotMatch(deployment, /image: "{{ \$root\.Values\.media\.egress\.image\.repository }}:{{ \$root\.Values\.media\.egress\.image\.tag }}"/);
  assert.match(deployment, /preStop:[\s\S]*touch \/var\/run\/ivekit-egress\/draining/);
  assert.match(deployment, /kind: ScaledObject/);
  assert.match(deployment, /kind: HorizontalPodAutoscaler/);
  assert.match(deployment, /kind: PrometheusRule/);
  assert.match(deployment, /ivekit_livekit_egress_pending_jobs/);
  assert.match(deployment, /ivekit_livekit_egress_spool_used_bytes/);
  assert.match(deployment, /ivekit_livekit_egress_network_transmit_bytes_total/);
  assert.match(values, /allowedRequestTypes: \["track"\]/);
  assert.match(values, /allowedRequestTypes: \["room_composite", "track_composite"\]/);
  assert.match(values, /repository: ivekit\/livekit-egress/);
  assert.match(values, /allowedRegistries:\s*\n\s*- docker\.io/);
  assert.match(values, /contract: ivekit-egress-pool-v1/);
  assert.match(values, /digest: ""/);
  assert.match(metrics, /ivekit_livekit_egress_active_requests/);
  assert.match(metrics, /ivekit_livekit_egress_policy_rejections_total/);
  assert.match(metrics, /ivekit_livekit_egress_spool_capacity_bytes/);
});

test('Stage 2 Helm gate rejects upstream aliases and arbitrary Egress repositories', () => {
  const gate = readFileSync('scripts/verify-ivekit-stage2-deployment.sh', 'utf8');

  assert.match(gate, /livekit\/egress/);
  assert.match(gate, /docker\.io\/livekit\/egress/);
  assert.match(gate, /registry-1\.docker\.io\/livekit\/egress/);
  assert.match(gate, /registry\.example\.invalid\/arbitrary\/livekit-egress/);
  assert.match(gate, /untrusted\.example\.invalid\/ivekit\/livekit-egress/);
  assert.match(gate, /registry\.example\.invalid\/ivekit\/livekit-egress/);
  assert.match(gate, /media\.egress\.image\.allowedRegistries\[0\]=registry\.example\.invalid/);
  assert.match(gate, /unapproved Egress image repository unexpectedly rendered/);
});

function monitorFixture(): string {
  return [
    'package stats',
    '',
    'import (',
    '\t"fmt"',
    '\t"sort"',
    ')',
    '',
    'type Monitor struct {',
    '\tnodeID string',
    '\tclusterID string',
    '\tcpuCostConfig *config.CPUCostConfig',
    '}',
    '',
    'func NewMonitor(conf *config.ServiceConfig, svc Service) (*Monitor, error) {',
    '\tm := &Monitor{',
    '\t\tnodeID: conf.NodeID,',
    '\t\tclusterID: conf.ClusterID,',
    '\t\tcpuCostConfig: conf.CPUCostConfig,',
    '\t}',
    '\tm.initPrometheus()',
    '\treturn m, nil',
    '}',
    '',
    'func (m *Monitor) canAcceptRequestLocked(req *rpc.StartEgressRequest) ([]interface{}, bool) {',
    '\ttotal, available, pending, used := m.getCPUUsageLocked()',
    '\tfields := []interface{}{',
    '\t\t"total", total, "available", available, "pending", pending, "used", used,',
    '\t}',
    '\t// Memory admission check based on configured source',
    '\tif reject, reason := m.checkMemoryAdmissionLocked(); reject {',
    '\t\tfields = append(fields, "canAccept", false, "reason", reason)',
    '\t\treturn fields, false',
    '\t}',
    '\treturn fields, true',
    '}',
    ''
  ].join('\n');
}

function egressDockerfileFixture(): string {
  return [
    'ARG TEMPLATE_TAG=latest',
    '',
    'FROM livekit/egress-templates:$TEMPLATE_TAG AS template',
    '',
    'FROM livekit/gstreamer:1.24.12-dev',
    'ARG TARGETARCH',
    'WORKDIR /workspace',
    '# install go',
    'RUN wget https://go.dev/dl/go1.26.2.linux-${TARGETARCH}.tar.gz && \\',
    '    rm -rf /usr/local/go && \\',
    '    tar -C /usr/local -xzf go1.26.2.linux-${TARGETARCH}.tar.gz',
    'ENV PATH="/usr/local/go/bin:${PATH}"',
    'COPY go.mod .',
    'COPY go.sum .',
    'RUN go mod download',
    'COPY cmd/ cmd/',
    'COPY pkg/ pkg/',
    'COPY version/ version/',
    'RUN CGO_ENABLED=1 GOOS=linux GOARCH=${TARGETARCH} GO111MODULE=on GODEBUG=disablethp=1 go build -a -o egress ./cmd/server',
    '# install tini',
    'ENV TINI_VERSION v0.19.0',
    'ADD https://github.com/krallin/tini/releases/download/${TINI_VERSION}/tini-${TARGETARCH} /tini',
    'RUN chmod +x /tini',
    '',
    'FROM livekit/gstreamer:1.24.12-prod',
    'ARG TARGETPLATFORM',
    '# install deps',
    'RUN apt-get update && \\',
    '    apt-get install -y curl',
    'COPY --from=livekit/chrome-installer:146.0.7680.177-1 /chrome-installer /chrome-installer',
    '# copy files',
    'COPY --from=1 /workspace/egress /bin/',
    'COPY --from=1 /tini /tini',
    ''
  ].join('\n');
}
