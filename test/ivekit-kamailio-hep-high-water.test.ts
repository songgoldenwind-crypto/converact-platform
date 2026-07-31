import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HttpHomerMetricsClient,
  HomerHepMetricsSampler,
  KamailioHepHighWaterController,
  KamailioHepHighWaterStateMachine,
  type KamailioHepHighWaterPolicy
} from '../src/agent-runtime/ivekit/voice/kamailio-hep-high-water.js';

const POLICY: KamailioHepHighWaterPolicy = {
  sample_percent: 10,
  queue_sample_ratio: 0.5,
  queue_off_ratio: 0.8,
  queue_recover_ratio: 0.2,
  cpu_sample_cores: 0.7,
  cpu_off_cores: 1.5,
  cpu_recover_cores: 0.3,
  packets_sample_per_second: 5_000,
  packets_off_per_second: 10_000,
  packets_recover_per_second: 2_000,
  processing_gap_sample_per_second: 250,
  processing_gap_off_per_second: 1_000,
  processing_gap_recover_per_second: 25,
  failure_samples_to_off: 3,
  recovery_samples: 2
};

test('HEP high-water state machine degrades immediately and recovers with hysteresis', () => {
  const machine = new KamailioHepHighWaterStateMachine(POLICY);

  assert.equal(machine.status().mode, 'full');
  assert.deepEqual(machine.observe(observation({ queue_ratio: 0.55 })), {
    previous_mode: 'full',
    mode: 'sampled',
    changed: true,
    reason: 'collector_queue_high',
    sample_buckets: 102
  });
  assert.equal(machine.observe(observation({ queue_ratio: 0.1 })).mode, 'sampled');
  assert.equal(machine.observe(observation({ queue_ratio: 0.1 })).mode, 'full');

  assert.equal(machine.observe(observation({ queue_ratio: 0.9 })).mode, 'off');
  assert.equal(machine.observe(observation({ queue_ratio: 0.1 })).mode, 'off');
  assert.equal(machine.observe(observation({ queue_ratio: 0.1 })).mode, 'sampled');
  assert.equal(machine.observe(observation({ queue_ratio: 0.1 })).mode, 'sampled');
  assert.equal(machine.observe(observation({ queue_ratio: 0.1 })).mode, 'full');
});

test('HEP high-water state machine turns off after bounded collector failures', () => {
  const machine = new KamailioHepHighWaterStateMachine(POLICY);

  assert.equal(machine.observe(observation({ collector_up: false })).mode, 'sampled');
  assert.equal(machine.observe(observation({ collector_up: false })).mode, 'sampled');
  const third = machine.observe(observation({ collector_up: false }));
  assert.equal(third.mode, 'off');
  assert.equal(third.reason, 'collector_unavailable');

  assert.equal(machine.observe(observation()).mode, 'off');
  assert.equal(machine.observe(observation()).mode, 'sampled');
});

test('HEP high-water state machine protects against a growing receive-processing gap', () => {
  const machine = new KamailioHepHighWaterStateMachine(POLICY);

  const sampled = machine.observe(observation({ processing_gap_per_second: 250 }));
  assert.equal(sampled.mode, 'sampled');
  assert.equal(sampled.reason, 'collector_processing_gap_high');

  const off = machine.observe(observation({ processing_gap_per_second: 1_000 }));
  assert.equal(off.mode, 'off');
  assert.equal(off.reason, 'collector_processing_gap_critical');
});

test('HEP high-water state machine does not recover while rate observations are warming up', () => {
  const machine = new KamailioHepHighWaterStateMachine(POLICY);
  assert.equal(machine.observe(observation({ queue_ratio: 0.55 })).mode, 'sampled');

  const warming = {
    collector_up: true,
    queue_ratio: 0.1,
    cpu_cores: null,
    packets_per_second: null,
    processing_gap_per_second: null
  };
  assert.equal(machine.observe(warming).mode, 'sampled');
  assert.equal(machine.observe(warming).mode, 'sampled');
  assert.equal(machine.observe(observation()).mode, 'sampled');
  assert.equal(machine.observe(observation()).mode, 'full');
});

test('HOMER sampler derives bounded queue, CPU and packet-rate observations', () => {
  const sampler = new HomerHepMetricsSampler();
  const first = sampler.observe(homerMetrics({
    queueDepth: 20,
    queueCapacity: 80,
    cpuSeconds: 10,
    received: 1_000,
    processed: 990
  }), new Date('2026-07-25T00:00:00.000Z'));

  assert.equal(first.queue_ratio, 0.25);
  assert.equal(first.cpu_cores, null);
  assert.equal(first.packets_per_second, null);

  const second = sampler.observe(homerMetrics({
    queueDepth: 40,
    queueCapacity: 80,
    cpuSeconds: 15,
    received: 2_000,
    processed: 1_940
  }), new Date('2026-07-25T00:00:10.000Z'));
  assert.equal(second.queue_ratio, 0.5);
  assert.equal(second.cpu_cores, 0.5);
  assert.equal(second.packets_per_second, 100);
  assert.equal(second.processing_gap_per_second, 5);

  assert.throws(
    () => sampler.observe('homer_worker_queue_depth NaN\n', new Date()),
    /required HOMER metric/i
  );
});

test('HOMER metrics client requires a credential-free metrics endpoint and bounds the body', async () => {
  assert.throws(
    () => new HttpHomerMetricsClient({ endpoint: 'http://user:secret@homer:9090/metrics' }),
    /endpoint/i
  );
  assert.throws(
    () => new HttpHomerMetricsClient({ endpoint: 'http://homer:9090/other' }),
    /metrics/i
  );

  const client = new HttpHomerMetricsClient({
    endpoint: 'http://homer:9090/metrics',
    fetch: async () => new Response('x'.repeat(1_048_577), { status: 200 })
  });
  await assert.rejects(() => client.read(), /too large/i);
});

test('HEP controller retries failed control application without affecting observation state', async () => {
  const applied: Array<{ mode: string; sample_buckets: number; revision: number }> = [];
  let failFirstApply = true;
  const controller = new KamailioHepHighWaterController({
    policy: POLICY,
    read_metrics: async () => homerMetrics({
      queueDepth: 60,
      queueCapacity: 80,
      cpuSeconds: 10,
      received: 1_000,
      processed: 1_000
    }),
    control: {
      async read_revision() {
        return 0;
      },
      async apply(input) {
        if (failFirstApply) {
          failFirstApply = false;
          throw new Error('Kamailio RPC unavailable');
        }
        applied.push(input);
      }
    }
  });

  await assert.rejects(
    () => controller.runOnce(new Date('2026-07-25T00:00:00.000Z')),
    /RPC unavailable/
  );
  const failedMetrics = controller.prometheusMetrics();
  assert.match(failedMetrics, /ivekit_kamailio_hep_mode\{mode="sampled"\} 0/);
  assert.match(failedMetrics, /ivekit_kamailio_hep_desired_mode\{mode="off"\} 1/);
  assert.match(failedMetrics, /ivekit_kamailio_hep_control_pending 1/);
  const result = await controller.runOnce(new Date('2026-07-25T00:00:01.000Z'));
  assert.equal(result.mode, 'off');
  assert.deepEqual(applied, [{ mode: 'off', sample_buckets: 102, revision: 1 }]);
  assert.match(controller.prometheusMetrics(), /ivekit_kamailio_hep_control_apply_failures_total 1/);
  assert.match(controller.prometheusMetrics(), /ivekit_kamailio_hep_mode\{mode="off"\} 1/);
  assert.match(controller.prometheusMetrics(), /ivekit_kamailio_hep_control_pending 0/);
  assert.doesNotMatch(controller.prometheusMetrics(), /tenant|call_id|collector_host/);
});

test('HEP controller stays fail-closed while rate observations warm after restart', async () => {
  const applied: Array<{ mode: string; sample_buckets: number; revision: number }> = [];
  const controller = new KamailioHepHighWaterController({
    policy: POLICY,
    read_metrics: async () => homerMetrics({
      queueDepth: 8,
      queueCapacity: 80,
      cpuSeconds: 10,
      received: 1_000,
      processed: 1_000
    }),
    control: {
      async read_revision() {
        return 9;
      },
      async apply(input) {
        applied.push(input);
      }
    }
  });

  const result = await controller.runOnce(new Date('2026-07-25T00:00:00.000Z'));

  assert.deepEqual(result, {
    previous_mode: 'off',
    mode: 'off',
    changed: false,
    reason: 'healthy',
    sample_buckets: 102,
    revision: 10
  });
  assert.deepEqual(applied, [
    { mode: 'off', sample_buckets: 102, revision: 10 }
  ]);
  assert.match(controller.prometheusMetrics(), /ivekit_kamailio_hep_observation_valid 0/);
  assert.match(controller.prometheusMetrics(), /ivekit_kamailio_hep_mode\{mode="off"\} 1/);
});

test('HEP controller advances past a remotely committed revision whose response was lost', async () => {
  let remoteRevision = 0;
  let loseFirstResponse = true;
  const applied: Array<{ mode: string; sample_buckets: number; revision: number }> = [];
  const controller = new KamailioHepHighWaterController({
    policy: POLICY,
    read_metrics: async () => homerMetrics({
      queueDepth: 8,
      queueCapacity: 80,
      cpuSeconds: 10,
      received: 1_000,
      processed: 1_000
    }),
    control: {
      async read_revision() {
        return remoteRevision;
      },
      async apply(input) {
        remoteRevision = input.revision;
        if (loseFirstResponse) {
          loseFirstResponse = false;
          throw new Error('commit response lost');
        }
        applied.push(input);
      }
    }
  });

  await assert.rejects(
    () => controller.runOnce(new Date('2026-07-25T00:00:00.000Z')),
    /response lost/
  );
  const result = await controller.runOnce(new Date('2026-07-25T00:00:01.000Z'));

  assert.equal(result.revision, 2);
  assert.deepEqual(applied, [
    { mode: 'off', sample_buckets: 102, revision: 2 }
  ]);
});

test('HEP controller retries a failed mode transition with the same next revision', async () => {
  const queueDepths = [8, 8, 8, 8];
  const applied: Array<{ mode: string; sample_buckets: number; revision: number }> = [];
  let attempts = 0;
  let metricReads = 0;
  const controller = new KamailioHepHighWaterController({
    policy: POLICY,
    read_metrics: async () => homerMetrics({
      queueDepth: queueDepths.shift() ?? 48,
      queueCapacity: 80,
      cpuSeconds: 10 + metricReads++ * 0.1,
      received: 1_000 + metricReads * 100,
      processed: 1_000 + metricReads * 100
    }),
    control: {
      async read_revision() {
        return applied.at(-1)?.revision || 0;
      },
      async apply(input) {
        attempts += 1;
        if (input.mode === 'sampled' && attempts === 2) {
          throw new Error('transition RPC failed');
        }
        applied.push(input);
      }
    }
  });

  await controller.runOnce(new Date('2026-07-25T00:00:00.000Z'));
  await controller.runOnce(new Date('2026-07-25T00:00:01.000Z'));
  await assert.rejects(
    () => controller.runOnce(new Date('2026-07-25T00:00:02.000Z')),
    /transition RPC failed/
  );
  const retried = await controller.runOnce(new Date('2026-07-25T00:00:03.000Z'));

  assert.equal(retried.mode, 'sampled');
  assert.equal(retried.revision, 2);
  assert.deepEqual(applied, [
    { mode: 'off', sample_buckets: 102, revision: 1 },
    { mode: 'sampled', sample_buckets: 102, revision: 2 }
  ]);
  assert.match(
    controller.prometheusMetrics(),
    /ivekit_kamailio_hep_collector_processing_gap_per_second 0/
  );
  assert.match(controller.prometheusMetrics(), /ivekit_kamailio_hep_transitions_total 1/);
});

test('HEP controller replays unchanged state after the remote revision resets', async () => {
  let remoteRevision = 0;
  const applied: Array<{ mode: string; sample_buckets: number; revision: number }> = [];
  const controller = new KamailioHepHighWaterController({
    policy: POLICY,
    read_metrics: async () => homerMetrics({
      queueDepth: 8,
      queueCapacity: 80,
      cpuSeconds: 10,
      received: 1_000,
      processed: 1_000
    }),
    control: {
      async read_revision() {
        return remoteRevision;
      },
      async apply(input) {
        applied.push(input);
        remoteRevision = input.revision;
      }
    } as unknown as ConstructorParameters<typeof KamailioHepHighWaterController>[0]['control']
  });

  for (let second = 0; second < 5; second += 1) {
    await controller.runOnce(new Date(`2026-07-25T00:00:0${second}.000Z`));
  }
  remoteRevision = 0;
  await controller.runOnce(new Date('2026-07-25T00:00:05.000Z'));

  assert.deepEqual(applied, [
    { mode: 'off', sample_buckets: 102, revision: 1 },
    { mode: 'sampled', sample_buckets: 102, revision: 2 },
    { mode: 'full', sample_buckets: 102, revision: 3 },
    { mode: 'full', sample_buckets: 102, revision: 4 }
  ]);
});

test('HEP controller coalesces concurrent polls into one metrics and RPC sequence', async () => {
  let releaseMetrics!: () => void;
  const gate = new Promise<void>((resolve) => { releaseMetrics = resolve; });
  let metricReads = 0;
  let remoteRevision = 0;
  const applied: Array<{ mode: string; sample_buckets: number; revision: number }> = [];
  const controller = new KamailioHepHighWaterController({
    policy: POLICY,
    read_metrics: async () => {
      metricReads += 1;
      await gate;
      return homerMetrics({
        queueDepth: 72,
        queueCapacity: 80,
        cpuSeconds: 10,
        received: 1_000,
        processed: 1_000
      });
    },
    control: {
      async read_revision() {
        return remoteRevision;
      },
      async apply(input) {
        applied.push(input);
        remoteRevision = input.revision;
      }
    } as unknown as ConstructorParameters<typeof KamailioHepHighWaterController>[0]['control']
  });

  const first = controller.runOnce(new Date('2026-07-25T00:00:00.000Z'));
  const second = controller.runOnce(new Date('2026-07-25T00:00:01.000Z'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(metricReads, 1);
  releaseMetrics();
  assert.deepEqual(await Promise.all([first, second]), [
    {
      previous_mode: 'off',
      mode: 'off',
      changed: false,
      reason: 'collector_queue_critical',
      sample_buckets: 102,
      revision: 1
    },
    {
      previous_mode: 'off',
      mode: 'off',
      changed: false,
      reason: 'collector_queue_critical',
      sample_buckets: 102,
      revision: 1
    }
  ]);
  assert.equal(applied.length, 1);
});

function observation(overrides: Partial<{
  collector_up: boolean;
  queue_ratio: number;
  cpu_cores: number;
  packets_per_second: number;
  processing_gap_per_second: number;
}> = {}) {
  return {
    collector_up: true,
    queue_ratio: 0.1,
    cpu_cores: 0.1,
    packets_per_second: 100,
    processing_gap_per_second: 0,
    ...overrides
  };
}

function homerMetrics(input: {
  queueDepth: number;
  queueCapacity: number;
  cpuSeconds: number;
  received: number;
  processed: number;
}): string {
  return [
    `homer_worker_queue_depth ${input.queueDepth}`,
    `homer_worker_queue_capacity ${input.queueCapacity}`,
    `process_cpu_seconds_total ${input.cpuSeconds}`,
    'process_start_time_seconds 1784900000',
    `homer_hep_packets_received_total{protocol="udp"} ${input.received}`,
    `homer_hep_packets_processed_total{protocol="udp"} ${input.processed}`,
    ''
  ].join('\n');
}
