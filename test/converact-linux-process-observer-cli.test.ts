import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('Linux process observer CLI is packaged for repeatable capacity campaigns', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as { scripts: Record<string, string> };
  assert.equal(
    packageJson.scripts['converact:observe:linux'],
    'tsx scripts/converact-linux-process-observer.ts'
  );
  assert.equal(
    existsSync(new URL('../scripts/converact-linux-process-observer.ts', import.meta.url)),
    true
  );
});

test('Linux process observer CLI parses fenced PID and command modes', async () => {
  const module = await import('../scripts/converact-linux-process-observer.js');

  assert.deepEqual(module.parseLinuxProcessObserverArgs([
    'pid',
    '--pid', '4242',
    '--duration-seconds', '60',
    '--interface', 'eth0',
    '--nic-bps', '25000000000',
    '--sample-ms', '1000',
    '--result', '/tmp/pid-observation.json'
  ]), {
    mode: 'pid',
    pid: 4242,
    duration_seconds: 60,
    interface_name: 'eth0',
    nic_capacity_bps: 25_000_000_000,
    sample_interval_ms: 1_000,
    result_path: '/tmp/pid-observation.json'
  });

  assert.deepEqual(module.parseLinuxProcessObserverArgs([
    'run',
    '--interface', 'lo',
    '--nic-bps', '1000000000',
    '--sample-ms', '250',
    '--result', '/tmp/command-observation.json',
    '--',
    '/usr/bin/true', '--flag'
  ]), {
    mode: 'run',
    executable: '/usr/bin/true',
    args: ['--flag'],
    interface_name: 'lo',
    nic_capacity_bps: 1_000_000_000,
    sample_interval_ms: 250,
    result_path: '/tmp/command-observation.json'
  });

  assert.throws(
    () => module.parseLinuxProcessObserverArgs([
      'run',
      '--interface', 'lo',
      '--nic-bps', '1000000000',
      '--sample-ms', '250',
      '--result', '/tmp/command-observation.json',
      '--',
      'relative-command'
    ]),
    /absolute executable/i
  );
});

test('Linux process observer brackets a real child and writes private non-overwriting evidence', {
  skip: process.platform !== 'linux'
}, async () => {
  const module = await import('../scripts/converact-linux-process-observer.js');
  const directory = mkdtempSync(join(tmpdir(), 'converact-linux-process-observer-'));
  const resultPath = join(directory, 'result.json');
  try {
    const evidence = await module.runObservedLinuxCommand({
      executable: process.execPath,
      args: ['-e', 'const end=Date.now()+500; while(Date.now()<end) Math.sqrt(Math.random())'],
      interface_name: 'lo',
      nic_capacity_bps: 10_000_000_000,
      sample_interval_ms: 100,
      result_path: resultPath
    });

    assert.equal(evidence.mode, 'run');
    assert.equal(evidence.exit_code, 0);
    assert.equal(evidence.generator_observation_source, 'linux_proc_tree');
    assert.equal(evidence.generator_observation_sample_count > 0, true);
    assert.equal(evidence.generator_cpu_p95_ratio > 0, true);
    assert.equal(evidence.host_witness_source, 'linux_boot_id_sha256');
    assert.match(evidence.host_boot_id_sha256 || '', /^[0-9a-f]{64}$/);
    assert.equal(evidence.schema_version, '1.1.0');
    assert.equal(evidence.command_arg_count, 2);
    assert.equal(
      evidence.command_args_sha256,
      createHash('sha256').update(JSON.stringify([
        '-e',
        'const end=Date.now()+500; while(Date.now()<end) Math.sqrt(Math.random())'
      ])).digest('hex')
    );
    assert.match(evidence.executable_sha256, /^[0-9a-f]{64}$/);
    assert.equal('args' in evidence, false);
    assert.equal((await stat(resultPath)).mode & 0o777, 0o600);
    await assert.rejects(
      module.runObservedLinuxCommand({
        executable: process.execPath,
        args: ['-e', 'process.exit(0)'],
        interface_name: 'lo',
        nic_capacity_bps: 10_000_000_000,
        sample_interval_ms: 100,
        result_path: resultPath
      }),
      /already exists/i
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
