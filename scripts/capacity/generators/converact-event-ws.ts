import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';

import { canonicalSha256 } from '../canonical-json.js';

export interface ConveractFabricEventWsShardInput {
  endpoint: string;
  run_id: string;
  shard_id: string;
  ordinal_start: number;
  ordinal_end_exclusive: number;
  worker_id: string;
  lease_epoch: string;
  token_for_ordinal(ordinal: number): string | Promise<string>;
  expected_durable_events_per_client: number;
  maximum_reconnects: number;
  reconnect_delay_ms: number;
  connection_timeout_ms: number;
  concurrency: number;
  message_processing_delay_ms?: number;
}

export interface ConveractFabricEventWsShardResult {
  protocol: 'ivekit_event_websocket';
  evidence_level: 'controlled';
  status: 'controlled_pass' | 'controlled_failed';
  run_id: string;
  shard_id: string;
  worker_id: string;
  lease_epoch: string;
  attempted_count: number;
  accepted_count: number;
  active_peak_count: number;
  closed_count: number;
  socket_attempt_count: number;
  reconnect_count: number;
  connected_envelope_count: number;
  durable_event_count: number;
  duplicate_event_count: number;
  out_of_order_event_count: number;
  snapshot_required_count: number;
  error_count: number;
  errors: string[];
  elapsed_ms: number;
  scheduler_lag_p99_ms: number;
  cpu_time_ms: number;
  rss_peak_bytes: number;
  journal_sha256: string;
}

interface JournalEntry {
  ordinal: number;
  sequence: number;
  event_id: string;
  cursor: string;
  type: string;
}

interface ClientResult {
  accepted: boolean;
  socketAttempts: number;
  reconnects: number;
  connectedEnvelopes: number;
  durableEvents: number;
  duplicates: number;
  outOfOrder: number;
  snapshotRequired: number;
  errors: string[];
  journal: JournalEntry[];
}

export async function runConveractFabricEventWsShard(
  input: ConveractFabricEventWsShardInput
): Promise<ConveractFabricEventWsShardResult> {
  validateInput(input);
  const startedAt = performance.now();
  const cpuStarted = process.cpuUsage();
  let rssPeak = process.memoryUsage().rss;
  let active = 0;
  let activePeak = 0;
  const lagSamples: number[] = [];
  let expectedTick = performance.now() + 10;
  const sampler = setInterval(() => {
    const now = performance.now();
    lagSamples.push(Math.max(0, now - expectedTick));
    expectedTick = now + 10;
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  }, 10);
  sampler.unref?.();

  const ordinals = Array.from(
    { length: input.ordinal_end_exclusive - input.ordinal_start },
    (_, index) => input.ordinal_start + index
  );
  try {
    const results = await mapConcurrent(ordinals, input.concurrency, async (ordinal) => {
      return runLogicalClient(input, ordinal, {
        becameActive() {
          active += 1;
          activePeak = Math.max(activePeak, active);
        },
        becameInactive() {
          active = Math.max(0, active - 1);
        }
      });
    });
    const allErrors = results.flatMap((result) => result.errors);
    const errors = allErrors.slice(0, 1_000);
    const journal = results.flatMap((result) => result.journal)
      .sort((left, right) => left.ordinal - right.ordinal || left.sequence - right.sequence);
    const acceptedCount = results.filter((result) => result.accepted).length;
    const durableEventCount = sum(results, (result) => result.durableEvents);
    const duplicateEventCount = sum(results, (result) => result.duplicates);
    const outOfOrderEventCount = sum(results, (result) => result.outOfOrder);
    const snapshotRequiredCount = sum(results, (result) => result.snapshotRequired);
    const expectedEvents = ordinals.length * input.expected_durable_events_per_client;
    const passed = acceptedCount === ordinals.length &&
      durableEventCount === expectedEvents && duplicateEventCount === 0 &&
      outOfOrderEventCount === 0 && snapshotRequiredCount === 0 && allErrors.length === 0;
    const cpu = process.cpuUsage(cpuStarted);
    return {
      protocol: 'ivekit_event_websocket',
      evidence_level: 'controlled',
      status: passed ? 'controlled_pass' : 'controlled_failed',
      run_id: input.run_id,
      shard_id: input.shard_id,
      worker_id: input.worker_id,
      lease_epoch: input.lease_epoch,
      attempted_count: ordinals.length,
      accepted_count: acceptedCount,
      active_peak_count: activePeak,
      closed_count: results.length,
      socket_attempt_count: sum(results, (result) => result.socketAttempts),
      reconnect_count: sum(results, (result) => result.reconnects),
      connected_envelope_count: sum(results, (result) => result.connectedEnvelopes),
      durable_event_count: durableEventCount,
      duplicate_event_count: duplicateEventCount,
      out_of_order_event_count: outOfOrderEventCount,
      snapshot_required_count: snapshotRequiredCount,
      error_count: allErrors.length,
      errors,
      elapsed_ms: Math.round((performance.now() - startedAt) * 1_000) / 1_000,
      scheduler_lag_p99_ms: percentile(lagSamples, 0.99),
      cpu_time_ms: Math.round((cpu.user + cpu.system) / 1_000),
      rss_peak_bytes: rssPeak,
      journal_sha256: canonicalSha256(journal)
    };
  } finally {
    clearInterval(sampler);
  }
}

async function runLogicalClient(
  input: ConveractFabricEventWsShardInput,
  ordinal: number,
  activity: { becameActive(): void; becameInactive(): void }
): Promise<ClientResult> {
  const token = await input.token_for_ordinal(ordinal);
  if (!token || /[\s,]/.test(token)) throw new Error(`token for ordinal ${ordinal} is not WebSocket-protocol safe`);
  return new Promise((resolve) => {
    const result: ClientResult = {
      accepted: false,
      socketAttempts: 0,
      reconnects: 0,
      connectedEnvelopes: 0,
      durableEvents: 0,
      duplicates: 0,
      outOfOrder: 0,
      snapshotRequired: 0,
      errors: [],
      journal: []
    };
    const seenEventIds = new Set<string>();
    let cursor = '';
    let lastEventId: bigint | null = null;
    let active = false;
    let complete = false;
    let settled = false;
    let currentSocket: WebSocket | null = null;

    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      if (error) result.errors.push(`ordinal ${ordinal}: ${error}`);
      if (active) {
        active = false;
        activity.becameInactive();
      }
      currentSocket?.removeAllListeners();
      if (currentSocket?.readyState === WebSocket.OPEN || currentSocket?.readyState === WebSocket.CONNECTING) {
        currentSocket.terminate();
      }
      resolve(result);
    };

    const connect = () => {
      if (settled) return;
      result.socketAttempts += 1;
      let socketFailure = '';
      let messageQueue = Promise.resolve();
      const endpoint = new URL(input.endpoint);
      if (cursor) endpoint.searchParams.set('cursor', cursor);
      const socket = new WebSocket(endpoint, ['ivekit.v1', `ivekit.jwt.${token}`]);
      currentSocket = socket;
      const timeout = setTimeout(() => {
        socketFailure = 'connection or event timeout';
        socket.terminate();
      }, input.connection_timeout_ms);

      socket.on('message', (raw) => {
        const processMessage = () => {
          if (settled) return;
          let envelope: Record<string, any>;
          try {
            envelope = JSON.parse(String(raw));
          } catch {
            socketFailure = 'invalid JSON envelope';
            socket.close(1002, 'invalid JSON');
            return;
          }
          if (envelope.type === 'connected') {
            result.connectedEnvelopes += 1;
            if (envelope.data?.snapshot_required === true) {
              result.snapshotRequired += 1;
              socketFailure = `snapshot required${envelope.data?.reason ? `: ${envelope.data.reason}` : ''}`;
              socket.close(1000, 'snapshot required');
              return;
            }
            if (!result.accepted) result.accepted = true;
            if (!active) {
              active = true;
              activity.becameActive();
            }
            if (input.expected_durable_events_per_client === 0) {
              complete = true;
              socket.close(1000, 'complete');
            }
            return;
          }
          if (!envelope.event_id || !envelope.cursor) return;
          const eventId = String(envelope.event_id);
          if (!/^\d+$/.test(eventId)) {
            socketFailure = 'durable event ID is not numeric';
            socket.close(1002, 'invalid event ID');
            return;
          }
          if (seenEventIds.has(eventId)) {
            result.duplicates += 1;
            return;
          }
          const numericEventId = BigInt(eventId);
          if (lastEventId !== null && numericEventId <= lastEventId) result.outOfOrder += 1;
          seenEventIds.add(eventId);
          lastEventId = numericEventId;
          cursor = String(envelope.cursor);
          result.durableEvents += 1;
          result.journal.push({
            ordinal,
            sequence: result.durableEvents,
            event_id: eventId,
            cursor,
            type: String(envelope.type || '')
          });
          if (result.durableEvents >= input.expected_durable_events_per_client) {
            complete = true;
            socket.close(1000, 'complete');
          }
        };
        messageQueue = messageQueue.then(async () => {
          if ((input.message_processing_delay_ms ?? 0) > 0) {
            await new Promise<void>((resolveDelay) =>
              setTimeout(resolveDelay, input.message_processing_delay_ms)
            );
          }
          processMessage();
        }).catch((error) => {
          socketFailure ||= error instanceof Error ? error.message : String(error);
          if (socket.readyState === WebSocket.OPEN) socket.close(1011, 'message processing failed');
        });
      });
      socket.on('error', (error) => {
        socketFailure ||= error.message || 'WebSocket error';
      });
      socket.on('close', (code, reason) => {
        void messageQueue.then(() => {
          clearTimeout(timeout);
          if (active) {
            active = false;
            activity.becameInactive();
          }
          if (complete) {
            finish();
            return;
          }
          if (result.reconnects < input.maximum_reconnects) {
            result.reconnects += 1;
            setTimeout(connect, input.reconnect_delay_ms);
            return;
          }
          const detail = socketFailure || `closed before completion (${code}${reason.length ? `: ${String(reason)}` : ''})`;
          finish(detail);
        });
      });
    };

    connect();
  });
}

function validateInput(input: ConveractFabricEventWsShardInput): void {
  const endpoint = new URL(input.endpoint);
  if (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') throw new Error('event WS endpoint must use ws or wss');
  if (!input.run_id || !input.worker_id) throw new Error('run and worker IDs are required');
  if (!Number.isInteger(input.ordinal_start) || !Number.isInteger(input.ordinal_end_exclusive) ||
      input.ordinal_start < 0 || input.ordinal_end_exclusive <= input.ordinal_start) {
    throw new Error('event WS shard ordinal range is invalid');
  }
  const expectedShardId = `connection/ivekit_event_websocket/${input.ordinal_start}-${input.ordinal_end_exclusive}`;
  if (input.shard_id !== expectedShardId) throw new Error(`event WS shard ID must be ${expectedShardId}`);
  if (!/^[1-9][0-9]{0,18}$/.test(input.lease_epoch)) {
    throw new Error('invalid event WS lease_epoch');
  }
  for (const [field, value] of Object.entries({
    expected_durable_events_per_client: input.expected_durable_events_per_client,
    maximum_reconnects: input.maximum_reconnects,
    reconnect_delay_ms: input.reconnect_delay_ms,
    connection_timeout_ms: input.connection_timeout_ms,
    concurrency: input.concurrency,
    message_processing_delay_ms: input.message_processing_delay_ms ?? 0
  })) {
    if (!Number.isInteger(value) || value < (field === 'connection_timeout_ms' || field === 'concurrency' ? 1 : 0)) {
      throw new Error(`invalid event WS ${field}`);
    }
  }
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

function sum<T>(items: T[], select: (item: T) => number): number {
  return items.reduce((total, item) => total + select(item), 0);
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return Math.round(sorted[index] * 1_000) / 1_000;
}
