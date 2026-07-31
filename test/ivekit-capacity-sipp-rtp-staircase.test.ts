import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeSippRtpStaircasePoints,
  summarizeSippRtpResourceSamples,
  type SippRtpResourceSample
} from '../scripts/capacity/sipp-rtp-staircase.js';

const stats = (cpu: number, memory: number, network: number) => ({
  cpu_percent: cpu,
  memory_bytes: memory,
  pids: 4,
  network_rx_bytes: network,
  network_tx_bytes: network * 2,
  block_read_bytes: 0,
  block_write_bytes: 0
});

test('SIPp RTP staircase points are sorted, unique, and bounded', () => {
  assert.deepEqual(
    normalizeSippRtpStaircasePoints('25,1,10,10,5'),
    [1, 5, 10, 25]
  );
  assert.throws(
    () => normalizeSippRtpStaircasePoints('1,0,5'),
    /point/
  );
  assert.throws(
    () => normalizeSippRtpStaircasePoints('1,20001'),
    /point/
  );
});

test('SIPp RTP staircase resource summary preserves maxima and deltas', () => {
  const samples: SippRtpResourceSample[] = [
    {
      elapsed_ms: 0,
      containers: {
        rustpbx: stats(25, 100, 1_000),
        kamailio: stats(5, 50, 500),
        uac: stats(10, 25, 100),
        uas: stats(11, 26, 110)
      },
      errors: []
    },
    {
      elapsed_ms: 1_000,
      containers: {
        rustpbx: stats(80, 140, 1_800),
        kamailio: stats(15, 60, 800),
        uac: stats(30, 30, 500),
        uas: stats(31, 31, 510)
      },
      errors: []
    }
  ];

  const summary = summarizeSippRtpResourceSamples(samples, [
    'rustpbx',
    'kamailio',
    'uac',
    'uas'
  ]);

  assert.deepEqual(summary.missing_roles, []);
  assert.equal(summary.containers.rustpbx?.sample_count, 2);
  assert.equal(summary.containers.rustpbx?.cpu_max_percent, 80);
  assert.equal(summary.containers.rustpbx?.cpu_average_percent, 52.5);
  assert.equal(summary.containers.rustpbx?.memory_max_bytes, 140);
  assert.equal(summary.containers.rustpbx?.network_rx_delta_bytes, 800);
  assert.equal(summary.containers.rustpbx?.network_tx_delta_bytes, 1_600);
});

test('SIPp RTP staircase resource summary fails closed on missing roles', () => {
  const summary = summarizeSippRtpResourceSamples([
    {
      elapsed_ms: 0,
      containers: { rustpbx: stats(1, 1, 1) },
      errors: ['kamailio: unavailable']
    }
  ], ['rustpbx', 'kamailio']);

  assert.deepEqual(summary.missing_roles, ['kamailio']);
  assert.equal(summary.sampling_error_count, 1);
});
