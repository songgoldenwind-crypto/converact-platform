import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  compileCapacityManifestFiles,
  validateCapacityManifestBundleFile
} from '../scripts/ivekit-capacity.js';

test('capacity CLI functions compile and validate an immutable Cell-10K bundle', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ivekit-capacity-cli-'));
  const runConfigPath = join(directory, 'run-config.json');
  const outputPath = join(directory, 'manifest.json');
  writeFileSync(runConfigPath, JSON.stringify({
    run: {
      runId: 'cell-10k-controlled-20260716-cli',
      seed: 'capacity-cli-seed',
      runEpoch: '2026-07-16T06:00:00.000Z',
      sutReleaseId: 'ivekit@0123456789abcdef0123456789abcdef01234567',
      generatorReleaseId: 'loadgen@fedcba9876543210fedcba9876543210fedcba98',
      startNotBefore: '2026-07-16T06:30:00.000Z',
      evidencePrefix: 'capacity/cell-10k-controlled-20260716-cli'
    },
    topology: {
      fleets: [
        { fleet_id: 'tinode', worker_count: 5, protocols: ['tinode_websocket'] },
        { fleet_id: 'ivekit_event_ws', worker_count: 5, protocols: ['ivekit_event_websocket'] },
        { fleet_id: 'sip', worker_count: 5, protocols: ['sip', 'rtp', 'sip_websocket'] },
        { fleet_id: 'livekit', worker_count: 5, protocols: ['livekit_webrtc'] },
        { fleet_id: 'rustdesk', worker_count: 5, protocols: ['rustdesk_native'] }
      ]
    },
    shardSizeByWorkloadId: {
      tinode_im: 1200,
      sip_voice: 500,
      livekit_av: 200,
      livekit_screen: 60,
      rustdesk_remote: 40,
      tinode_websocket: 1800,
      ivekit_event_websocket: 1000,
      sip_registration: 500,
      sip_websocket: 200,
      livekit_participant: 520,
      rustdesk_endpoint: 80
    }
  }, null, 2));

  const compiled = compileCapacityManifestFiles({
    profile_path: 'docs/capacity/profiles/cell-10k-v1.json',
    fork_manifest_path: 'docs/capacity/forks/ivekit-forks-v1.json',
    run_config_path: runConfigPath,
    output_path: outputPath
  });
  const validated = validateCapacityManifestBundleFile({
    profile_path: 'docs/capacity/profiles/cell-10k-v1.json',
    fork_manifest_path: 'docs/capacity/forks/ivekit-forks-v1.json',
    bundle_path: outputPath
  });

  assert.equal(validated.manifest_sha256, compiled.manifest_sha256);
  assert.equal(validated.manifest.expected_totals.interactions, 10_000);
  assert.equal(validated.manifest.shards.length, 50);
  assert.match(readFileSync(outputPath, 'utf8'), /"manifest_sha256": "[a-f0-9]{64}"/);
});

test('capacity bundle validation rejects post-compile mutation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ivekit-capacity-cli-tamper-'));
  const bundlePath = join(directory, 'manifest.json');
  const profile = JSON.parse(readFileSync('docs/capacity/profiles/cell-10k-v1.json', 'utf8'));
  const forkManifest = JSON.parse(readFileSync('docs/capacity/forks/ivekit-forks-v1.json', 'utf8'));
  const runConfigPath = join(directory, 'run-config.json');
  writeFileSync(runConfigPath, JSON.stringify({
    run: {
      runId: 'cell-10k-controlled-20260716-tamper',
      seed: 'capacity-cli-tamper',
      runEpoch: '2026-07-16T06:00:00.000Z',
      sutReleaseId: 'ivekit@0123456789abcdef0123456789abcdef01234567',
      generatorReleaseId: 'loadgen@fedcba9876543210fedcba9876543210fedcba98',
      startNotBefore: '2026-07-16T06:30:00.000Z',
      evidencePrefix: 'capacity/cell-10k-controlled-20260716-tamper'
    },
    topology: { fleets: [
      { fleet_id: 'tinode', worker_count: 5, protocols: ['tinode_websocket'] },
      { fleet_id: 'ivekit_event_ws', worker_count: 5, protocols: ['ivekit_event_websocket'] },
      { fleet_id: 'sip', worker_count: 5, protocols: ['sip', 'rtp', 'sip_websocket'] },
      { fleet_id: 'livekit', worker_count: 5, protocols: ['livekit_webrtc'] },
      { fleet_id: 'rustdesk', worker_count: 5, protocols: ['rustdesk_native'] }
    ] }
  }));
  compileCapacityManifestFiles({
    profile_path: 'docs/capacity/profiles/cell-10k-v1.json',
    fork_manifest_path: 'docs/capacity/forks/ivekit-forks-v1.json',
    run_config_path: runConfigPath,
    output_path: bundlePath
  });
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  bundle.manifest.expected_totals.interactions += 1;
  writeFileSync(bundlePath, JSON.stringify(bundle));

  assert.throws(() => validateCapacityManifestBundleFile({
    profile_path: writeJson(join(directory, 'profile.json'), profile),
    fork_manifest_path: writeJson(join(directory, 'fork.json'), forkManifest),
    bundle_path: bundlePath
  }), /hash mismatch/i);
});

test('phase 1 status cannot be mistaken for a capacity pass', () => {
  const status = JSON.parse(readFileSync('docs/capacity/phase1-controlled-status.json', 'utf8'));
  assert.equal(status.status, 'controlled_implementation_pass');
  assert.equal(status.capacity_claim, 'none');
  assert.equal(status.source.working_tree_dirty, true);
  assert.equal(status.not_run.includes('mix_100k_physical_run'), true);
  assert.equal(status.truth_constraints.some((value: string) => /No C_hard/.test(value)), true);
});

function writeJson(path: string, value: unknown): string {
  writeFileSync(path, JSON.stringify(value));
  return path;
}
