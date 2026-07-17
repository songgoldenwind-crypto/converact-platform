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

export function patchLiveKitEgressMonitor(source) {
  let next = source;
  next = replaceOnce(
    next,
    '\t"fmt"\n',
    '\t"fmt"\n\n\tivekitegresspool "ivekit.local/egresspool"\n',
    'pool policy import'
  );
  next = replaceOnce(
    next,
    '\tcpuCostConfig *config.CPUCostConfig\n',
    '\tcpuCostConfig *config.CPUCostConfig\n\tivekitPool *ivekitegresspool.Policy\n',
    'pool policy field'
  );
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
  next = replaceOnce(
    next,
    '\t\tcpuCostConfig: conf.CPUCostConfig,\n',
    '\t\tcpuCostConfig: conf.CPUCostConfig,\n\t\tivekitPool: ivekitPool,\n',
    'pool policy assignment'
  );
  next = replaceOnce(
    next,
    '\tm.initPrometheus()\n',
    '\tm.initPrometheus()\n\tm.initIveKitPrometheus()\n',
    'iveKit prometheus initialization'
  );
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
  await writeFile(goModPath, patchLiveKitEgressGoMod(await readFile(goModPath, 'utf8')), 'utf8');
  await writeFile(monitorPath, patchLiveKitEgressMonitor(await readFile(monitorPath, 'utf8')), 'utf8');
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
