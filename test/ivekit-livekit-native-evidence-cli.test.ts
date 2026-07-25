import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('LiveKit native evidence CLI is packaged for repeatable capacity campaigns', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as { scripts: Record<string, string> };
  assert.equal(
    packageJson.scripts['ivekit:capacity:livekit-native-evidence'],
    'tsx scripts/ivekit-livekit-native-evidence.ts'
  );
  assert.equal(
    existsSync(new URL('../scripts/ivekit-livekit-native-evidence.ts', import.meta.url)),
    true
  );
});

test('LiveKit native evidence CLI parses a fenced file-based evaluation', async () => {
  const module = await import('../scripts/ivekit-livekit-native-evidence.js');
  assert.deepEqual(module.parseLiveKitNativeEvidenceArgs([
    '--run-id', 'livekit-native-v3-a3-s15',
    '--expected-tracks', '90',
    '--maximum-packet-loss-ratio', '0.001',
    '--summary', '/tmp/load-test.log',
    '--generator', '/tmp/generator.json',
    '--sut', '/tmp/sut.json',
    '--result', '/tmp/evaluated.json'
  ]), {
    run_id: 'livekit-native-v3-a3-s15',
    expected_tracks: 90,
    maximum_packet_loss_ratio: 0.001,
    summary_path: '/tmp/load-test.log',
    generator_path: '/tmp/generator.json',
    sut_path: '/tmp/sut.json',
    result_path: '/tmp/evaluated.json',
    require_distinct_hosts: false,
    require_workload_binding: false
  });
  assert.deepEqual(module.parseLiveKitNativeEvidenceArgs([
    '--run-id', 'livekit-native-v3-a3-s15',
    '--expected-tracks', '90',
    '--maximum-packet-loss-ratio', '0.001',
    '--summary', '/tmp/load-test.log',
    '--generator', '/tmp/generator.json',
    '--sut', '/tmp/sut.json',
    '--result', '/tmp/evaluated.json',
    '--require-distinct-hosts', 'true'
  ]), {
    run_id: 'livekit-native-v3-a3-s15',
    expected_tracks: 90,
    maximum_packet_loss_ratio: 0.001,
    summary_path: '/tmp/load-test.log',
    generator_path: '/tmp/generator.json',
    sut_path: '/tmp/sut.json',
    result_path: '/tmp/evaluated.json',
    require_distinct_hosts: true,
    require_workload_binding: false
  });
  assert.deepEqual(module.parseLiveKitNativeEvidenceArgs([
    '--run-id', 'livekit-native-v3-a3-s15',
    '--expected-tracks', '90',
    '--maximum-packet-loss-ratio', '0.001',
    '--summary', '/tmp/load-test.log',
    '--generator', '/tmp/generator.json',
    '--sut', '/tmp/sut.json',
    '--result', '/tmp/evaluated.json',
    '--workload', '/tmp/workload.json',
    '--require-workload-binding', 'true'
  ]), {
    run_id: 'livekit-native-v3-a3-s15',
    expected_tracks: 90,
    maximum_packet_loss_ratio: 0.001,
    summary_path: '/tmp/load-test.log',
    generator_path: '/tmp/generator.json',
    sut_path: '/tmp/sut.json',
    result_path: '/tmp/evaluated.json',
    workload_path: '/tmp/workload.json',
    require_distinct_hosts: false,
    require_workload_binding: true
  });
  assert.throws(
    () => module.parseLiveKitNativeEvidenceArgs([
      '--run-id', 'livekit-native-v3-a3-s15',
      '--expected-tracks', '90',
      '--maximum-packet-loss-ratio', '0.001',
      '--summary', 'relative.log',
      '--generator', '/tmp/generator.json',
      '--sut', '/tmp/sut.json',
      '--result', '/tmp/evaluated.json'
    ]),
    /absolute path/i
  );
});

test('LiveKit native evidence CLI writes private non-overwriting evaluated evidence', async () => {
  const module = await import('../scripts/ivekit-livekit-native-evidence.js');
  const directory = mkdtempSync(join(tmpdir(), 'ivekit-livekit-native-evidence-'));
  const summaryPath = join(directory, 'load-test.log');
  const generatorPath = join(directory, 'generator.json');
  const sutPath = join(directory, 'sut.json');
  const resultPath = join(directory, 'evaluated.json');
  writeFileSync(
    summaryPath,
    '│ Total │ 90/90 │ 25.7mbps (1.7mbps avg) │ 0 (0%) │ 0 │\n'
  );
  writeFileSync(generatorPath, JSON.stringify(observation('run', {
    observed_pid: 100,
    executable: '/opt/ivekit/lk',
    exit_code: 0,
    signal: null,
    generator_cpu_p95_ratio: 0.3,
    host_witness_source: 'linux_boot_id_sha256',
    host_boot_id_sha256: 'a'.repeat(64)
  })));
  writeFileSync(sutPath, JSON.stringify(observation('pid', {
    observed_pid: 200,
    duration_seconds: 70,
    generator_cpu_p95_ratio: 0.2,
    host_witness_source: 'linux_boot_id_sha256',
    host_boot_id_sha256: 'b'.repeat(64)
  })));
  try {
    const evidence = await module.runLiveKitNativeEvidence({
      run_id: 'livekit-native-v3-a3-s15',
      expected_tracks: 90,
      maximum_packet_loss_ratio: 0.001,
      summary_path: summaryPath,
      generator_path: generatorPath,
      sut_path: sutPath,
      result_path: resultPath,
      require_distinct_hosts: true
    });

    assert.equal(evidence.status, 'controlled_pass');
    assert.equal(evidence.host_scope, 'distinct_boot_domain');
    assert.equal(JSON.parse(readFileSync(resultPath, 'utf8')).status, 'controlled_pass');
    assert.equal((await stat(resultPath)).mode & 0o777, 0o600);
    await assert.rejects(
      module.runLiveKitNativeEvidence({
        run_id: 'livekit-native-v3-a3-s15',
        expected_tracks: 90,
        maximum_packet_loss_ratio: 0.001,
        summary_path: summaryPath,
        generator_path: generatorPath,
        sut_path: sutPath,
        result_path: resultPath,
        require_distinct_hosts: true
      }),
      /already exists/i
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function observation(mode: 'run' | 'pid', overrides: Record<string, unknown>) {
  return {
    schema_version: '1.0.0',
    mode,
    generator_observation_source: 'linux_proc_tree',
    generator_observation_sample_count: 60,
    generator_network_interface: 'lo',
    generator_nic_capacity_bps: 1_000_000_000,
    generator_cpu_p95_ratio: 0.3,
    host_cpu_p95_ratio: 0.6,
    generator_nic_p95_ratio: 0.06,
    host_packet_drop_count: 0,
    ...overrides
  };
}
