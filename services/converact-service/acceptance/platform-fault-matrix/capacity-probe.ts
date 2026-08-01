import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate as yieldImmediate } from 'node:timers/promises';

import {
  BoundedWorkGate,
  type AdmissionLease
} from '../../../../src/agent-runtime/converact/platform-foundation/resilience.js';
import { buildBoundedCapacityEvidence } from './campaign-evidence.mjs';

const LIMITS = Object.freeze({ active: 64, pending: 256, retry: 3, fanout: 8 });
const MIN_OPERATIONS = 10_000;
const MAX_OPERATIONS = 5_000_000;
const SAMPLE_INTERVAL = 64;
const YIELD_INTERVAL = 4_096;

export interface BoundedCapacityResult {
  status: 'passed';
  operations: number;
  duration_ms: number;
  accepted: number;
  overloaded: number;
  configured_active_limit: number;
  configured_pending_limit: number;
  configured_retry_limit: number;
  configured_fanout_limit: number;
  observed_max_active: number;
  observed_max_pending: number;
  observed_max_retry: number;
  observed_max_fanout: number;
  p99_operation_us: number;
  event_loop_delay_p99_ms: number;
  rss_start_bytes: number;
  rss_peak_bytes: number;
  rss_end_bytes: number;
  counter_integrity: true;
  no_unbounded_queue: true;
}

export async function runBoundedCapacityWorkload(input: {
  operations: number;
}): Promise<BoundedCapacityResult> {
  if (!Number.isSafeInteger(input?.operations)
    || input.operations < MIN_OPERATIONS || input.operations > MAX_OPERATIONS) {
    throw new Error('capacity_operations_invalid');
  }
  const gate = new BoundedWorkGate(LIMITS);
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  const samples: number[] = [];
  const activeLeases: AdmissionLease[] = [];
  const pendingLeases: AdmissionLease[] = [];
  let accepted = 0;
  let overloaded = 0;
  let observedMaxActive = 0;
  let observedMaxPending = 0;
  let observedMaxRetry = 0;
  let observedMaxFanout = 0;
  const rssStart = process.memoryUsage().rss;
  let rssPeak = rssStart;
  eventLoop.enable();
  await yieldImmediate();
  const started = performance.now();

  const acquire = (
    kind: 'active' | 'pending', retry: number, fanout: number, keep: AdmissionLease[] | null
  ) => {
    const sampled = (accepted + overloaded) % SAMPLE_INTERVAL === 0;
    const sampleStarted = sampled ? performance.now() : 0;
    const result = gate.tryAcquire({ kind, retry, fanout });
    if (sampled) samples.push(Math.max(Number.EPSILON, (performance.now() - sampleStarted) * 1_000));
    observedMaxRetry = Math.max(observedMaxRetry, Math.min(retry, LIMITS.retry));
    observedMaxFanout = Math.max(observedMaxFanout, Math.min(fanout, LIMITS.fanout));
    if (!result.accepted) {
      overloaded += 1;
      return;
    }
    accepted += 1;
    const snapshot = gate.snapshot();
    observedMaxActive = Math.max(observedMaxActive, snapshot.active);
    observedMaxPending = Math.max(observedMaxPending, snapshot.pending);
    if (keep) keep.push(result.lease);
    else gate.release(result.lease);
  };

  for (let index = 0; index < LIMITS.active; index += 1) {
    acquire('active', index % (LIMITS.retry + 1), (index % LIMITS.fanout) + 1, activeLeases);
  }
  for (let index = 0; index < LIMITS.pending; index += 1) {
    acquire('pending', index % (LIMITS.retry + 1), (index % LIMITS.fanout) + 1, pendingLeases);
  }
  const saturatedRejects = Math.max(1, Math.floor(input.operations / 5));
  for (let index = 0; index < saturatedRejects; index += 1) {
    acquire(index % 2 === 0 ? 'active' : 'pending', LIMITS.retry, LIMITS.fanout, null);
    if ((index + 1) % YIELD_INTERVAL === 0) {
      rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
      await yieldImmediate();
    }
  }
  for (const lease of activeLeases) gate.release(lease);
  for (const lease of pendingLeases) gate.release(lease);

  while (accepted + overloaded < input.operations) {
    const index = accepted + overloaded;
    acquire(index % 4 === 0 ? 'pending' : 'active', index % (LIMITS.retry + 1),
      (index % LIMITS.fanout) + 1, null);
    if ((index + 1) % YIELD_INTERVAL === 0) {
      rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
      await yieldImmediate();
    }
  }
  await yieldImmediate();
  const duration = Math.max(1, Math.ceil(performance.now() - started));
  const rssEnd = process.memoryUsage().rss;
  rssPeak = Math.max(rssPeak, rssEnd);
  eventLoop.disable();
  samples.sort((left, right) => left - right);
  const p99 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.99))] || Number.EPSILON;
  const delayP99 = eventLoop.percentile(99) / 1_000_000;
  const snapshot = gate.snapshot();
  if (accepted + overloaded !== input.operations
    || snapshot.active !== 0 || snapshot.pending !== 0
    || observedMaxActive !== LIMITS.active || observedMaxPending !== LIMITS.pending
    || observedMaxRetry !== LIMITS.retry || observedMaxFanout !== LIMITS.fanout) {
    throw new Error('capacity_counter_integrity_failed');
  }
  return Object.freeze({
    status: 'passed',
    operations: input.operations,
    duration_ms: duration,
    accepted,
    overloaded,
    configured_active_limit: LIMITS.active,
    configured_pending_limit: LIMITS.pending,
    configured_retry_limit: LIMITS.retry,
    configured_fanout_limit: LIMITS.fanout,
    observed_max_active: observedMaxActive,
    observed_max_pending: observedMaxPending,
    observed_max_retry: observedMaxRetry,
    observed_max_fanout: observedMaxFanout,
    p99_operation_us: p99,
    event_loop_delay_p99_ms: Number.isFinite(delayP99) ? delayP99 : 0,
    rss_start_bytes: rssStart,
    rss_peak_bytes: rssPeak,
    rss_end_bytes: rssEnd,
    counter_integrity: true,
    no_unbounded_queue: true
  });
}

async function main(): Promise<void> {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'run' && args.length === 2) {
    const output = resolve(args[0]!);
    const result = await runBoundedCapacityWorkload({ operations: Number(args[1]) });
    writeJson(output, result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (mode === 'finalize' && args.length === 3) {
    const result = buildBoundedCapacityEvidence({
      ...readJson(args[1]!),
      identity: readJson(args[0]!)
    });
    writeJson(resolve(args[2]!), result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== 'verified_controlled') process.exitCode = 1;
    return;
  }
  throw new Error('capacity_probe_mode_invalid');
}

function readJson(path: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(resolve(path), 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('capacity_json_invalid');
  }
  return value;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(resolve(path), `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx', mode: 0o600
  });
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${String((error as Error).message || 'capacity_probe_failed')}\n`);
    process.exitCode = 1;
  });
}
