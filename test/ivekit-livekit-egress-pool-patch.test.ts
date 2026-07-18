import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import * as liveKitEgressOverlay from '../infra/ivekit/livekit-egress/apply-overlay.mjs';

import {
  LIVEKIT_EGRESS_UPSTREAM_COMMIT,
  LIVEKIT_EGRESS_UPSTREAM_TAG,
  patchLiveKitEgressGoMod,
  patchLiveKitEgressMonitor
} from '../infra/ivekit/livekit-egress/apply-overlay.mjs';

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
  const patchDockerfile = (liveKitEgressOverlay as Record<string, unknown>)
    .patchLiveKitEgressDockerfile;
  assert.equal(typeof patchDockerfile, 'function');
  const patched = (patchDockerfile as (source: string) => string)(egressDockerfileFixture());

  assert.match(patched, /COPY ivekit\/ ivekit\//);
  assert.ok(patched.indexOf('COPY ivekit/ ivekit/') < patched.indexOf('RUN go mod download'));
  assert.match(patched, /go test \.\/pkg\/stats/);
  assert.ok(patched.indexOf('go test ./pkg/stats') < patched.indexOf('go build -a'));
  assert.equal((patchDockerfile as (source: string) => string)(patched), patched);
});

test('LiveKit Egress build and Kubernetes pools enforce the source-level policy boundary', () => {
  const build = readFileSync('infra/ivekit/livekit-egress/build.sh', 'utf8');
  const deployment = readFileSync('infra/k8s/templates/livekit-egress-deployment.yaml', 'utf8');
  const values = readFileSync('infra/k8s/values.yaml', 'utf8');
  const metrics = readFileSync('infra/ivekit/livekit-egress/ivekit_metrics.go', 'utf8');

  assert.match(build, /LIVEKIT_EGRESS_UPSTREAM_COMMIT/);
  assert.match(build, /git -C "\$\{LIVEKIT_EGRESS_SOURCE_DIR\}" rev-parse HEAD/);
  assert.match(build, /go test -C "\$\{LIVEKIT_EGRESS_SOURCE_DIR\}\/ivekit\/egress-pool" \.\/\.\.\./);
  assert.doesNotMatch(build, /go test -C "\$\{LIVEKIT_EGRESS_SOURCE_DIR\}" \.\/pkg\/stats/);
  assert.match(build, /--file "\$\{LIVEKIT_EGRESS_SOURCE_DIR\}\/build\/egress\/Dockerfile"/);
  assert.match(build, /io\.ivekit\.egress-pool-contract=ivekit-egress-pool-v1/);
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
    'WORKDIR /workspace',
    'COPY go.mod .',
    'COPY go.sum .',
    'RUN go mod download',
    'COPY cmd/ cmd/',
    'COPY pkg/ pkg/',
    'COPY version/ version/',
    'RUN CGO_ENABLED=1 GOOS=linux GOARCH=${TARGETARCH} GO111MODULE=on GODEBUG=disablethp=1 go build -a -o egress ./cmd/server',
    ''
  ].join('\n');
}
