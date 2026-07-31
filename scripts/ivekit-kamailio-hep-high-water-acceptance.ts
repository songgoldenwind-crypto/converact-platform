import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isAbsolute } from 'node:path';

import {
  HttpHomerMetricsClient,
  KamailioHepHighWaterController,
  type KamailioHepMode
} from '../src/agent-runtime/ivekit/voice/kamailio-hep-high-water.js';
import {
  HttpKamailioJsonRpcClient
} from '../src/agent-runtime/ivekit/voice/kamailio-route-agent.js';

const MODE_VALUE: Record<KamailioHepMode, number> = {
  full: 2,
  sampled: 1,
  off: 0
};

const STEPS: Array<{
  name: string;
  queue_depth: number;
  expected_mode: KamailioHepMode;
}> = [
  { name: 'bootstrap-warmup-off', queue_depth: 10, expected_mode: 'off' },
  { name: 'bootstrap-recovery-hold', queue_depth: 10, expected_mode: 'off' },
  { name: 'bootstrap-to-sampled', queue_depth: 10, expected_mode: 'sampled' },
  { name: 'bootstrap-sampled-hold', queue_depth: 10, expected_mode: 'sampled' },
  { name: 'bootstrap-to-full', queue_depth: 10, expected_mode: 'full' },
  { name: 'queue-high-sampled', queue_depth: 60, expected_mode: 'sampled' },
  { name: 'queue-critical-off', queue_depth: 90, expected_mode: 'off' },
  { name: 'recovery-off-hold', queue_depth: 10, expected_mode: 'off' },
  { name: 'recovery-to-sampled', queue_depth: 10, expected_mode: 'sampled' },
  { name: 'recovery-sampled-hold', queue_depth: 10, expected_mode: 'sampled' },
  { name: 'recovery-to-full', queue_depth: 10, expected_mode: 'full' }
];

async function main(): Promise<void> {
  const endpoint = requiredEnv('OPC_IVEKIT_KAMAILIO_RPC_ENDPOINT');
  const tokenFile = requiredAbsoluteEnv('OPC_IVEKIT_KAMAILIO_RPC_TOKEN_FILE');
  const token = checkedToken((await readFile(tokenFile, 'utf8')).trim());
  if (process.argv[2] === '--set-mode') {
    await setMode(endpoint, token, process.argv[3], process.argv[4]);
    return;
  }
  if (process.argv.length > 2) {
    throw new Error('supported arguments are --set-mode <full|sampled|off> <revision>');
  }
  const fixture = metricsFixture();
  const fixtureEndpoint = await fixture.listen();
  const rpc = new HttpKamailioJsonRpcClient({
    endpoint,
    bearer_token: token,
    max_attempts: 1,
    timeout_ms: 1_000
  });
  const initialRemoteRevision = await rpc.readHepControlRevision();
  const metrics = new HttpHomerMetricsClient({
    endpoint: fixtureEndpoint,
    timeout_ms: 1_000
  });
  const controller = new KamailioHepHighWaterController({
    policy: {
      sample_percent: 10,
      queue_recover_ratio: 0.2,
      queue_sample_ratio: 0.5,
      queue_off_ratio: 0.8,
      cpu_recover_cores: 0.3,
      cpu_sample_cores: 0.7,
      cpu_off_cores: 1.5,
      packets_recover_per_second: 2_000,
      packets_sample_per_second: 5_000,
      packets_off_per_second: 10_000,
      processing_gap_recover_per_second: 25,
      processing_gap_sample_per_second: 250,
      processing_gap_off_per_second: 1_000,
      failure_samples_to_off: 3,
      recovery_samples: 2
    },
    read_metrics: () => metrics.read(),
    control: {
      read_revision: () => rpc.readHepControlRevision(),
      apply: (input) => rpc.applyHepControl(input)
    }
  });
  const results = [];
  try {
    for (const [index, step] of STEPS.entries()) {
      fixture.setQueueDepth(step.queue_depth);
      const decision = await controller.runOnce(
        new Date(Date.UTC(2026, 6, 25, 0, 0, index))
      );
      const appliedMode = await readHtableInteger(endpoint, token, 'mode', index + 100);
      const appliedRevision = await readHtableInteger(
        endpoint,
        token,
        'revision',
        index + 200
      );
      if (decision.mode !== step.expected_mode ||
          appliedMode !== MODE_VALUE[step.expected_mode] ||
          appliedRevision !== decision.revision) {
        throw new Error(`HEP control mismatch at ${step.name}`);
      }
      results.push({
        name: step.name,
        queue_ratio: step.queue_depth / 100,
        expected_mode: step.expected_mode,
        decision_mode: decision.mode,
        reason: decision.reason,
        changed: decision.changed,
        revision: decision.revision,
        applied_mode_value: appliedMode,
        applied_revision: appliedRevision
      });
    }
    await writeHtableInteger(endpoint, token, 'mode', 0, 500);
    await writeHtableInteger(endpoint, token, 'revision', 0, 501);
    fixture.setQueueDepth(10);
    const replay = await controller.runOnce(
      new Date(Date.UTC(2026, 6, 25, 0, 0, STEPS.length))
    );
    const replayMode = await readHtableInteger(endpoint, token, 'mode', 502);
    const replayRevision = await readHtableInteger(endpoint, token, 'revision', 503);
    if (replay.mode !== 'full' || replayMode !== MODE_VALUE.full ||
        replayRevision !== replay.revision ||
        replayRevision !== initialRemoteRevision + 8) {
      throw new Error('HEP control did not replay after remote revision reset');
    }
    results.push({
      name: 'remote-revision-reset-replay',
      queue_ratio: 0.1,
      expected_mode: 'full',
      decision_mode: replay.mode,
      reason: replay.reason,
      changed: replay.changed,
      revision: replay.revision,
      applied_mode_value: replayMode,
      applied_revision: replayRevision
    });
  } finally {
    await fixture.close();
  }
  process.stdout.write(`${JSON.stringify({
    schema_version: '1.0.0',
    suite: 'iveKit Kamailio HEP high-water controller sequence',
    passed: true,
    sample_percent: 10,
    restart_required: false,
    initial_remote_revision: initialRemoteRevision,
    steps: results,
    prometheus_metrics: controller.prometheusMetrics()
  }, null, 2)}\n`);
}

async function setMode(
  endpoint: string,
  token: string,
  rawMode: string | undefined,
  rawRevision: string | undefined
): Promise<void> {
  if (rawMode !== 'full' && rawMode !== 'sampled' && rawMode !== 'off') {
    throw new Error('HEP mode must be full, sampled, or off');
  }
  const revision = Number(rawRevision);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error('HEP revision must be a positive integer');
  }
  const rpc = new HttpKamailioJsonRpcClient({
    endpoint,
    bearer_token: token,
    max_attempts: 1,
    timeout_ms: 1_000
  });
  await rpc.applyHepControl({
    mode: rawMode,
    sample_buckets: 102,
    revision
  });
  const appliedMode = await readHtableInteger(endpoint, token, 'mode', revision + 10_000);
  const appliedRevision = await readHtableInteger(
    endpoint,
    token,
    'revision',
    revision + 20_000
  );
  if (appliedMode !== MODE_VALUE[rawMode] || appliedRevision !== revision) {
    throw new Error('Kamailio did not apply the requested HEP mode');
  }
  process.stdout.write(`${JSON.stringify({
    mode: rawMode,
    mode_value: appliedMode,
    sample_buckets: 102,
    revision: appliedRevision
  })}\n`);
}

function metricsFixture(): {
  listen(): Promise<string>;
  setQueueDepth(value: number): void;
  close(): Promise<void>;
} {
  let queueDepth = 0;
  let scrape = 0;
  const server = createServer((_request, response) => {
    scrape += 1;
    response.writeHead(200, {
      'content-type': 'text/plain; version=0.0.4',
      'cache-control': 'no-store'
    });
    response.end([
      `homer_worker_queue_depth ${queueDepth}`,
      'homer_worker_queue_capacity 100',
      `process_cpu_seconds_total ${10 + scrape * 0.1}`,
      'process_start_time_seconds 1784900000',
      `homer_hep_packets_received_total{protocol="udp"} ${1_000 + scrape * 100}`,
      `homer_hep_packets_processed_total{protocol="udp"} ${1_000 + scrape * 100}`,
      ''
    ].join('\n'));
  });
  return {
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('controlled metrics fixture did not bind'));
          return;
        }
        resolve(`http://127.0.0.1:${address.port}/metrics`);
      });
    }),
    setQueueDepth(value: number) {
      if (!Number.isInteger(value) || value < 0 || value > 100) {
        throw new Error('controlled queue depth is invalid');
      }
      queueDepth = value;
    },
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

async function readHtableInteger(
  endpoint: string,
  token: string,
  key: string,
  id: number
): Promise<number> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'htable.get',
      params: ['ivekit_hep_control', key],
      id
    })
  });
  if (!response.ok) throw new Error(`Kamailio htable.get returned HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 65_536) throw new Error('Kamailio htable.get response is too large');
  const payload = JSON.parse(text) as {
    jsonrpc?: unknown;
    id?: unknown;
    result?: { item?: { value?: unknown } };
    error?: unknown;
  };
  const value = payload.result?.item?.value;
  if (payload.jsonrpc !== '2.0' || payload.id !== id || payload.error ||
      !Number.isSafeInteger(value)) {
    throw new Error('Kamailio htable.get response is invalid');
  }
  return value as number;
}

async function writeHtableInteger(
  endpoint: string,
  token: string,
  key: string,
  value: number,
  id: number
): Promise<void> {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Kamailio htable test value is invalid');
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'htable.seti',
      params: ['ivekit_hep_control', key, value],
      id
    })
  });
  if (!response.ok) throw new Error(`Kamailio htable.seti returned HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 65_536) throw new Error('Kamailio htable.seti response is too large');
  const payload = JSON.parse(text) as {
    jsonrpc?: unknown;
    id?: unknown;
    result?: unknown;
    error?: unknown;
  };
  if (payload.jsonrpc !== '2.0' || payload.id !== id || payload.error ||
      !Object.prototype.hasOwnProperty.call(payload, 'result')) {
    throw new Error('Kamailio htable.seti response is invalid');
  }
}

function requiredEnv(name: string): string {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredAbsoluteEnv(name: string): string {
  const value = requiredEnv(name);
  if (!isAbsolute(value) || /[\0\r\n]/.test(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return value;
}

function checkedToken(value: string): string {
  if (value.length < 24 || value.length > 512 || /[\0\r\n]/.test(value)) {
    throw new Error('Kamailio RPC token is invalid');
  }
  return value;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Kamailio HEP high-water acceptance failed: ${message}\n`);
  process.exitCode = 1;
});
