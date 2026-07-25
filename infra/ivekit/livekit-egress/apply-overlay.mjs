#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LIVEKIT_EGRESS_UPSTREAM_TAG = 'v1.13.0';
export const LIVEKIT_EGRESS_UPSTREAM_COMMIT =
  '7d3572a0bf1959cbbc452f5ba390b6a90b7dc249';

export function patchLiveKitEgressGoMod(source) {
  if (!source.startsWith('module github.com/livekit/egress\n')) {
    throw new Error('LiveKit Egress go.mod module identity mismatch');
  }
  if (source.includes('ivekit.local/egresspool')) return source;
  return `${source.trimEnd()}

require ivekit.local/egresspool v0.0.0

replace ivekit.local/egresspool => ./ivekit/egress-pool
`;
}

export function patchLiveKitEgressDockerfile(source) {
  let next = source;
  const immutableBase = [
    'ARG IVEKIT_EGRESS_TEMPLATE_IMAGE',
    'ARG IVEKIT_EGRESS_BUILDER_IMAGE',
    'ARG IVEKIT_EGRESS_RUNTIME_IMAGE',
    'FROM ${IVEKIT_EGRESS_TEMPLATE_IMAGE} AS template',
    'FROM ${IVEKIT_EGRESS_BUILDER_IMAGE} AS ivekit-builder',
    'FROM ${IVEKIT_EGRESS_RUNTIME_IMAGE}'
  ];
  if (!immutableBase.every((line) => next.includes(line))) {
    next = replaceOnce(
      next,
      'ARG TEMPLATE_TAG=latest\n\n' +
        'FROM livekit/egress-templates:$TEMPLATE_TAG AS template\n\n' +
        'FROM livekit/gstreamer:1.24.12-dev',
      'ARG IVEKIT_EGRESS_TEMPLATE_IMAGE\n' +
        'ARG IVEKIT_EGRESS_BUILDER_IMAGE\n' +
        'ARG IVEKIT_EGRESS_RUNTIME_IMAGE\n\n' +
        'FROM ${IVEKIT_EGRESS_TEMPLATE_IMAGE} AS template\n\n' +
        'FROM ${IVEKIT_EGRESS_BUILDER_IMAGE} AS ivekit-builder',
      'Dockerfile immutable build stages'
    );
    next = replaceOnce(
      next,
      'FROM livekit/gstreamer:1.24.12-prod',
      'FROM ${IVEKIT_EGRESS_RUNTIME_IMAGE}',
      'Dockerfile immutable runtime stage'
    );
  }
  const toolchainInstall = [
    '# install checksum-verified Go toolchain materialized by build.sh',
    'COPY ivekit/toolchain/go/ /usr/local/go/',
    'RUN test "$(head -n 1 /usr/local/go/VERSION)" = "go1.26.2"',
  ].join('\n');
  if (!next.includes(toolchainInstall)) {
    next = replaceOnce(
      next,
      [
        '# install go',
        'RUN wget https://go.dev/dl/go1.26.2.linux-${TARGETARCH}.tar.gz && \\',
        '    rm -rf /usr/local/go && \\',
        '    tar -C /usr/local -xzf go1.26.2.linux-${TARGETARCH}.tar.gz',
      ].join('\n'),
      toolchainInstall,
      'Dockerfile Go toolchain installation'
    );
  }
  if (!/^COPY ivekit\/egress-pool\/ ivekit\/egress-pool\/$/m.test(next)) {
    next = replaceOnce(
      next,
      'COPY go.sum .\nRUN go mod download',
      'COPY go.sum .\n' +
        'COPY ivekit/egress-pool/ ivekit/egress-pool/\n' +
        'COPY vendor/ vendor/\n' +
        'ENV GOFLAGS=-mod=vendor',
      'Dockerfile vendored policy module'
    );
  }
  if (!next.includes('GOCACHE=/tmp/ivekit-egress-go-cache')) {
    next = next.replace('RUN go test ./pkg/stats\n', '');
    const buildPattern = /^RUN .*go build -a -o egress \.\/cmd\/server$/m;
    const matches = [...next.matchAll(new RegExp(buildPattern.source, 'gm'))];
    if (matches.length !== 1 || matches[0].index == null) {
      throw new Error('LiveKit Egress Dockerfile build anchor mismatch');
    }
    const build = matches[0][0];
    next = next.slice(0, matches[0].index) +
      'RUN GOCACHE=/tmp/ivekit-egress-go-cache go test ./pkg/stats && \\\n' +
      `    GOCACHE=/tmp/ivekit-egress-go-cache ${build.slice(4)} && \\\n` +
      '    rm -rf /tmp/ivekit-egress-go-cache' +
      next.slice(matches[0].index + build.length);
  }
  const installStart = next.indexOf('# install deps\n');
  const copyFilesStart = next.indexOf('# copy files\n');
  if (installStart >= 0) {
    if (copyFilesStart < 0 || copyFilesStart <= installStart) {
      throw new Error('LiveKit Egress Dockerfile runtime dependency anchor mismatch');
    }
    next = next.slice(0, installStart) +
      '# runtime dependencies, Chrome and Tini are supplied by the immutable v1.13.0 runtime image\n\n' +
      next.slice(copyFilesStart);
  }
  next = next.replaceAll('COPY --from=1 /workspace/egress /bin/', 'COPY --from=ivekit-builder /workspace/egress /bin/');
  next = next.replaceAll('COPY --from=1 /tini /tini\n', '');
  const tiniStart = next.indexOf('# install tini\n');
  if (tiniStart >= 0) {
    const runtimeStart = next.indexOf('FROM ${IVEKIT_EGRESS_RUNTIME_IMAGE}', tiniStart);
    if (runtimeStart < 0) {
      throw new Error('LiveKit Egress Dockerfile Tini anchor mismatch');
    }
    next = next.slice(0, tiniStart) + next.slice(runtimeStart);
  }
  return next;
}

export function patchLiveKitEgressMonitor(source) {
  let next = source;
  if (!next.includes('ivekitegresspool "ivekit.local/egresspool"')) {
    next = replaceOnce(
      next,
      '\t"fmt"\n',
      '\t"fmt"\n\n\tivekitegresspool "ivekit.local/egresspool"\n',
      'pool policy import'
    );
  }
  if (!/^\tivekitPool\s+\*ivekitegresspool\.Policy$/m.test(next)) {
    next = replaceMatchOnce(
      next,
      /^\tcpuCostConfig\s+\*config\.CPUCostConfig$/m,
      '\tcpuCostConfig *config.CPUCostConfig\n\tivekitPool *ivekitegresspool.Policy',
      'pool policy field'
    );
  }
  if (!next.includes('ivekitPool, err := ivekitegresspool.PolicyFromEnv()')) {
    next = replaceOnce(
      next,
      'func NewMonitor(conf *config.ServiceConfig, svc Service) (*Monitor, error) {\n\tm := &Monitor{',
      'func NewMonitor(conf *config.ServiceConfig, svc Service) (*Monitor, error) {\n' +
        '\tivekitPool, err := ivekitegresspool.PolicyFromEnv()\n' +
        '\tif err != nil {\n' +
        '\t\treturn nil, err\n' +
        '\t}\n' +
        '\tm := &Monitor{',
      'pool policy construction'
    );
  }
  if (!/^\t\tivekitPool:\s+ivekitPool,$/m.test(next)) {
    next = replaceMatchOnce(
      next,
      /^\t\tcpuCostConfig:\s+conf\.CPUCostConfig,$/m,
      '\t\tcpuCostConfig: conf.CPUCostConfig,\n\t\tivekitPool: ivekitPool,',
      'pool policy assignment'
    );
  }
  if (!next.includes('m.initIveKitPrometheus()')) {
    next = replaceOnce(
      next,
      '\tm.initPrometheus()\n',
      '\tm.initPrometheus()\n\tm.initIveKitPrometheus()\n',
      'iveKit prometheus initialization'
    );
  }
  if (!next.includes('m.ivekitPool.Draining()')) {
    next = replaceOnce(
      next,
      '\t// Memory admission check based on configured source\n',
      '\trequestType := requestTypeFromReq(req)\n' +
      '\tif m.ivekitPool.Draining() {\n' +
      '\t\tm.ivekitPool.ObserveRejection("draining")\n' +
      '\t\tfields = append(fields, "canAccept", false, "reason", "ivekit_pool_draining", "ivekitPool", m.ivekitPool.PoolName())\n' +
      '\t\treturn fields, false\n' +
      '\t}\n' +
      '\tif !m.ivekitPool.Allows(requestType) {\n' +
      '\t\tm.ivekitPool.ObserveRejection("request_type")\n' +
      '\t\tfields = append(fields,\n' +
      '\t\t\t"canAccept", false,\n' +
      '\t\t\t"reason", "ivekit_pool_request_type",\n' +
      '\t\t\t"ivekitPool", m.ivekitPool.PoolName(),\n' +
      '\t\t\t"requestType", requestType,\n' +
      '\t\t)\n' +
      '\t\treturn fields, false\n' +
      '\t}\n' +
      '\tif !m.ivekitPool.AllowsConcurrent(m.requests.Load()) {\n' +
      '\t\tm.ivekitPool.ObserveRejection("slots")\n' +
      '\t\tfields = append(fields, "canAccept", false, "reason", "ivekit_pool_slots", "ivekitPool", m.ivekitPool.PoolName(), "requestType", requestType)\n' +
      '\t\treturn fields, false\n' +
      '\t}\n' +
        '\t// Memory admission check based on configured source\n',
      'hard pool admission'
    );
  }
  return next;
}

export async function applyLiveKitEgressOverlay(input) {
  const sourceDir = resolve(input.sourceDir);
  const repoRoot = resolve(input.repoRoot || defaultRepoRoot());
  const commit = execFileSync('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (commit !== LIVEKIT_EGRESS_UPSTREAM_COMMIT) {
    throw new Error(`LiveKit Egress source commit mismatch: expected ${LIVEKIT_EGRESS_UPSTREAM_COMMIT}, got ${commit}`);
  }
  const exactTag = execFileSync(
    'git',
    ['-C', sourceDir, 'describe', '--tags', '--exact-match', 'HEAD'],
    { encoding: 'utf8' }
  ).trim();
  if (exactTag !== LIVEKIT_EGRESS_UPSTREAM_TAG) {
    throw new Error(`LiveKit Egress source tag mismatch: expected ${LIVEKIT_EGRESS_UPSTREAM_TAG}, got ${exactTag}`);
  }

  const policyTarget = join(sourceDir, 'ivekit/egress-pool');
  await mkdir(dirname(policyTarget), { recursive: true });
  await cp(
    join(repoRoot, 'integrations/livekit-egress-v1.13.0'),
    policyTarget,
    { recursive: true, force: true }
  );
  const goModPath = join(sourceDir, 'go.mod');
  const monitorPath = join(sourceDir, 'pkg/stats/monitor.go');
  const metricsPath = join(sourceDir, 'pkg/stats/ivekit_metrics.go');
  const dockerfilePath = join(sourceDir, 'build/egress/Dockerfile');
  await writeFile(goModPath, patchLiveKitEgressGoMod(await readFile(goModPath, 'utf8')), 'utf8');
  await writeFile(monitorPath, patchLiveKitEgressMonitor(await readFile(monitorPath, 'utf8')), 'utf8');
  await writeFile(
    dockerfilePath,
    patchLiveKitEgressDockerfile(await readFile(dockerfilePath, 'utf8')),
    'utf8'
  );
  await cp(join(repoRoot, 'infra/ivekit/livekit-egress/ivekit_metrics.go'), metricsPath, { force: true });
  execFileSync('gofmt', ['-w', monitorPath, metricsPath], { stdio: 'inherit' });
  return {
    upstream_tag: LIVEKIT_EGRESS_UPSTREAM_TAG,
    upstream_commit: LIVEKIT_EGRESS_UPSTREAM_COMMIT,
    source_dir: sourceDir
  };
}

function replaceOnce(source, anchor, replacement, label) {
  if (source.includes(replacement)) return source;
  const first = source.indexOf(anchor);
  const last = source.lastIndexOf(anchor);
  if (first < 0 || first !== last) {
    throw new Error(`LiveKit Egress ${label} anchor mismatch`);
  }
  return source.slice(0, first) + replacement + source.slice(first + anchor.length);
}

function replaceMatchOnce(source, pattern, replacement, label) {
  const flags = `${pattern.flags.replaceAll('g', '')}g`;
  const matches = [...source.matchAll(new RegExp(pattern.source, flags))];
  if (matches.length !== 1 || matches[0].index == null) {
    throw new Error(`LiveKit Egress ${label} anchor mismatch`);
  }
  const match = matches[0];
  return source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
}

function defaultRepoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const sourceDir = process.argv[2];
  if (!sourceDir) {
    console.error('usage: node apply-overlay.mjs <livekit-egress-source-dir>');
    process.exitCode = 2;
  } else {
    applyLiveKitEgressOverlay({ sourceDir }).then((result) => {
      console.log(JSON.stringify(result));
    }).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
