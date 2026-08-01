import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateLinuxProcessTreeInterval,
  createLinuxHostWitness,
  LinuxProcessTreeObserver,
  parseLinuxHostCpuStat,
  parseLinuxHostCpuTicks,
  parseLinuxNetworkDeviceStats,
  parseLinuxProcessStat,
  readLinuxProcessRecords,
  summarizeLinuxProcessTreeIntervals
} from '../scripts/capacity/generators/linux-process-tree-observer.js';

const BOOT_ID = '12345678-1234-5678-9abc-123456789abc';
const BOOT_ID_SHA256 = '4f9c5d986da99823c4bf4302dbbb3f8b9527289da813098d1fcf0c43e21b1a6b';

test('Linux process observer hashes the boot domain without retaining its raw ID', () => {
  const witness = createLinuxHostWitness(`${BOOT_ID}\n`);

  assert.deepEqual(witness, {
    host_witness_source: 'linux_boot_id_sha256',
    host_boot_id_sha256: BOOT_ID_SHA256
  });
  assert.equal(JSON.stringify(witness).includes(BOOT_ID), false);
});

test('Linux process observer parses proc stat records with spaces and parentheses', () => {
  const record = parseLinuxProcessStat(
    '4242 (Chromium Helper (GPU)) S 4000 1 1 0 -1 0 0 0 0 0 123 77 0 0 20 0 12 0 9'
  );

  assert.deepEqual(record, {
    pid: 4242,
    ppid: 4000,
    cpu_ticks: 200
  });
});

test('Linux process observer parses aggregate host ticks and one named interface', () => {
  assert.equal(
    parseLinuxHostCpuTicks('cpu  100 2 30 400 5 6 7 8 900 901\ncpu0 1 2 3 4\n'),
    558
  );
  assert.deepEqual(
    parseLinuxHostCpuStat('cpu  100 2 30 400 5 6 7 8 900 901\ncpu0 1 2 3 4\n'),
    {
      total_ticks: 558,
      idle_ticks: 405
    }
  );
  assert.deepEqual(
    parseLinuxNetworkDeviceStats([
      'Inter-|   Receive                                                |  Transmit',
      ' face |bytes    packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed',
      '    lo: 1000 10 0 2 0 0 0 0 1500 11 0 3 0 0 0 0',
      '  eth0: 9000 20 0 0 0 0 0 0 8000 21 0 0 0 0 0 0'
    ].join('\n'), 'lo'),
    {
      rx_bytes: 1_000,
      tx_bytes: 1_500,
      drop_count: 5
    }
  );
});

test('Linux process observer ignores processes that exit during procfs enumeration', async () => {
  const records = await readLinuxProcessRecords(['100', '101', 'not-a-pid'], async (pid) => {
    if (pid === 101) {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    }
    return `${pid} (node) S 1 1 1 0 -1 0 0 0 0 0 10 20 0 0 20 0 1 0 1`;
  });

  assert.deepEqual(records, [{ pid: 100, ppid: 1, cpu_ticks: 30 }]);
});

test('Linux process observer measures only the root process tree and uses directional NIC load', () => {
  const previous = {
    captured_at_ms: 1_000,
    host_cpu_ticks: 10_000,
    host_idle_ticks: 7_000,
    processes: [
      { pid: 100, ppid: 1, cpu_ticks: 100 },
      { pid: 101, ppid: 100, cpu_ticks: 50 },
      { pid: 999, ppid: 1, cpu_ticks: 8_000 }
    ],
    network: { rx_bytes: 1_000, tx_bytes: 2_000, drop_count: 4 }
  };
  const current = {
    captured_at_ms: 2_000,
    host_cpu_ticks: 10_400,
    host_idle_ticks: 7_100,
    processes: [
      { pid: 100, ppid: 1, cpu_ticks: 180 },
      { pid: 101, ppid: 100, cpu_ticks: 90 },
      { pid: 102, ppid: 101, cpu_ticks: 20 },
      { pid: 999, ppid: 1, cpu_ticks: 8_300 }
    ],
    network: { rx_bytes: 26_000, tx_bytes: 52_000, drop_count: 5 }
  };

  assert.deepEqual(
    calculateLinuxProcessTreeInterval(previous, current, 100, 1_000_000),
    {
      cpu_ratio: 0.35,
      host_cpu_ratio: 0.75,
      nic_ratio: 0.4
    }
  );
});

test('Linux process observer emits auditable P95 resource evidence and drop delta', () => {
  const observation = summarizeLinuxProcessTreeIntervals({
    interface_name: 'lo',
    nic_capacity_bps: 10_000_000_000,
    initial_drop_count: 7,
    final_drop_count: 9,
    intervals: [
      { cpu_ratio: 0.1, host_cpu_ratio: 0.4, nic_ratio: 0.2 },
      { cpu_ratio: 0.5, host_cpu_ratio: 0.8, nic_ratio: 0.6 },
      { cpu_ratio: 0.3, host_cpu_ratio: 0.6, nic_ratio: 0.4 }
    ]
  });

  assert.deepEqual(observation, {
    generator_observation_source: 'linux_proc_tree',
    generator_observation_sample_count: 3,
    generator_network_interface: 'lo',
    generator_nic_capacity_bps: 10_000_000_000,
    generator_cpu_p95_ratio: 0.5,
    host_cpu_p95_ratio: 0.8,
    generator_nic_p95_ratio: 0.6,
    host_packet_drop_count: 2
  });
});

test('Linux process observer brackets a run with real start and stop snapshots', async () => {
  const snapshots = [
    {
      captured_at_ms: 1_000,
      host_cpu_ticks: 10_000,
      host_idle_ticks: 7_000,
      processes: [{ pid: 100, ppid: 1, cpu_ticks: 100 }],
      network: { rx_bytes: 1_000, tx_bytes: 2_000, drop_count: 4 }
    },
    {
      captured_at_ms: 2_000,
      host_cpu_ticks: 10_400,
      host_idle_ticks: 7_100,
      processes: [{ pid: 100, ppid: 1, cpu_ticks: 180 }],
      network: { rx_bytes: 11_000, tx_bytes: 22_000, drop_count: 5 }
    }
  ];
  const observer = new LinuxProcessTreeObserver({
    root_pid: 100,
    interface_name: 'lo',
    nic_capacity_bps: 1_000_000,
    sample_interval_ms: 10_000,
    async read_boot_id() {
      return `${BOOT_ID}\n`;
    },
    async capture() {
      const snapshot = snapshots.shift();
      if (!snapshot) throw new Error('unexpected extra snapshot');
      return snapshot;
    }
  });

  await observer.start();
  const observation = await observer.stop();

  assert.equal(observation.generator_observation_sample_count, 1);
  assert.equal(observation.generator_cpu_p95_ratio, 0.2);
  assert.equal(observation.host_cpu_p95_ratio, 0.75);
  assert.equal(observation.generator_nic_p95_ratio, 0.16);
  assert.equal(observation.host_packet_drop_count, 1);
  assert.equal(observation.host_witness_source, 'linux_boot_id_sha256');
  assert.equal(observation.host_boot_id_sha256, BOOT_ID_SHA256);
  assert.equal(JSON.stringify(observation).includes(BOOT_ID), false);
});
