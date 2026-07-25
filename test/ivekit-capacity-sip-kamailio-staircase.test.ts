import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildSipKamailioStaircaseConfig,
  canonicalSipEvidenceJson,
  parseSippVersionProbe,
  parseSipDockerStatsCsv,
  summarizeSipDockerResources
} from '../scripts/capacity/sip-kamailio-staircase.js';

test('SIP Kamailio staircase config requires ascending controlled points and immutable inputs', () => {
  const config = buildSipKamailioStaircaseConfig({
    output_file: '/tmp/sip-evidence.json',
    artifact_root: '/tmp/sip-artifacts',
    runtime_root: '/tmp/sip-runtime',
    points: [100, 250, 500, 750, 1000],
    duration_seconds: 20,
    sipp_binary: '/opt/ivekit-capacity-benchmark/bin/sipp-3.7.7',
    rustpbx_image: 'ivekit/rustpbx:0.4.11-ivekit.16-6c49ee76',
    kamailio_image: `ivekit/kamailio@sha256:${'a'.repeat(64)}`,
    postgres_image: `postgres@sha256:${'b'.repeat(64)}`,
    python_image: `python@sha256:${'c'.repeat(64)}`,
    capacity_tools_image: 'ivekit/capacity-tools:0.1.0-rustpbx-router-v1',
    node_command: '/opt/node/bin/node'
  });

  assert.deepEqual(config.points, [100, 250, 500, 750, 1000]);
  assert.equal(config.duration_seconds, 20);
  assert.equal(config.capacity_claim, 'none');
  assert.equal(config.kamailio_shm_memory_mb, 512);
  assert.equal(config.kamailio_pkg_memory_mb, 32);
  assert.equal(config.kamailio_shm_allocator, 'fm');
  assert.throws(
    () => buildSipKamailioStaircaseConfig({
      ...config,
      points: [100, 100]
    }),
    /strictly ascending/i
  );
  assert.throws(
    () => buildSipKamailioStaircaseConfig({
      ...config,
      kamailio_image: 'ivekit/kamailio:latest'
    }),
    /immutable/i
  );
  assert.throws(
    () => buildSipKamailioStaircaseConfig({
      ...config,
      kamailio_shm_memory_mb: 32
    }),
    /kamailio_shm_memory_mb/i
  );
  assert.throws(
    () => buildSipKamailioStaircaseConfig({
      ...config,
      kamailio_shm_allocator: 'system' as 'tlsf'
    }),
    /kamailio_shm_allocator/i
  );
});

test('SIP Kamailio resource parser preserves per-container maxima', () => {
  const samples = parseSipDockerStatsCsv([
    'timestamp,name,cpu,mem,net_io,block_io,pids',
    '2026-07-23T00:00:00Z,ivekit-rustpbx-baseline-kamailio-1,12.50%,20MiB / 8GiB,1kB / 2kB,0B / 0B,19',
    '2026-07-23T00:00:01Z,ivekit-rustpbx-baseline-kamailio-1,31.25%,24MiB / 8GiB,2kB / 3kB,0B / 0B,20',
    '2026-07-23T00:00:01Z,ivekit-rustpbx-baseline-rustpbx-1,44.50%,120MiB / 8GiB,5kB / 6kB,0B / 0B,15'
  ].join('\n'));
  const summary = summarizeSipDockerResources(samples);

  assert.equal(samples.length, 3);
  assert.deepEqual(summary['ivekit-rustpbx-baseline-kamailio-1'], {
    sample_count: 2,
    cpu_max_percent: 31.25,
    memory_max_bytes: 24 * 1024 * 1024,
    pids_max: 20
  });
  assert.equal(
    summary['ivekit-rustpbx-baseline-rustpbx-1']?.memory_max_bytes,
    120 * 1024 * 1024
  );
});

test('SIP Kamailio evidence canonicalization is recursive and key-order independent', () => {
  const left = {
    preserved: [{ name: 'led-api', state: { health: 'healthy', restarts: 0 } }],
    artifacts: { summary: 'a', stats: 'b' }
  };
  const right = {
    artifacts: { stats: 'b', summary: 'a' },
    preserved: [{ state: { restarts: 0, health: 'healthy' }, name: 'led-api' }]
  };

  assert.equal(canonicalSipEvidenceJson(left), canonicalSipEvidenceJson(right));
  assert.match(canonicalSipEvidenceJson(left), /"health":"healthy"/);
  assert.match(canonicalSipEvidenceJson(left), /"summary":"a"/);
});

test('SIPp version probe accepts its documented informational exit code only', () => {
  assert.equal(
    parseSippVersionProbe({
      exit_code: 99,
      stdout: '\n SIPp v3.7.7-PCAP.\n',
      stderr: ''
    }),
    'SIPp v3.7.7-PCAP.'
  );
  assert.throws(
    () => parseSippVersionProbe({
      exit_code: 2,
      stdout: 'SIPp v3.7.7-PCAP.',
      stderr: ''
    }),
    /exit code 2/i
  );
  assert.throws(
    () => parseSippVersionProbe({ exit_code: 99, stdout: '', stderr: 'invalid' }),
    /could not be identified/i
  );
});

test('SIP Kamailio staircase has CLI and capacity package entrypoints', async () => {
  const [cli, rootPackage, capacityPackage, tsconfig, dockerfile] = await Promise.all([
    readFile(new URL('../scripts/ivekit-capacity-sip-kamailio-staircase.ts', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../infra/capacity/package.json', import.meta.url), 'utf8'),
    readFile(new URL('../infra/capacity/tsconfig.json', import.meta.url), 'utf8'),
    readFile(new URL('../infra/capacity/Dockerfile', import.meta.url), 'utf8')
  ]);

  assert.match(cli, /runSipKamailioStaircase/);
  assert.match(rootPackage, /ivekit:capacity:sip-kamailio-staircase/);
  assert.match(capacityPackage, /sip-kamailio-staircase/);
  assert.match(tsconfig, /ivekit-capacity-sip-kamailio-staircase\.ts/);
  assert.match(dockerfile, /COPY --chmod=0755 scripts\/ivekit-capacity-sip-kamailio-staircase\.ts/);
});
