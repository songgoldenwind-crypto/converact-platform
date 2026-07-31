import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import type { CapacityRequirement } from '../placement/types.js';
import { ComponentNodeAdmissionError } from '../placement/component-node-admission.js';
import { recordingSpoolAdmission } from './recording-manifest.js';

interface SpoolMetricsDocument {
  schema_version: 1;
  observed_at: string;
  capacity_bytes: number;
  available_bytes: number;
  used_bytes: number;
  utilization_ratio: number;
  non_core_admission: 'accept' | 'defer_non_core';
  must_record_admission: 'accept' | 'reject_must_record';
  backlog_segments: number;
  backlog_bytes: number;
  oldest_backlog_age_seconds: number;
  terminal_segments: number;
  finalization_backlog: number;
  finalization_terminal: number;
  oldest_finalization_age_seconds: number;
}

export interface RustPbxRecordingSpoolCapacitySnapshot {
  fresh: boolean;
  observed_at: string;
  capacity_bytes: number;
  safe_capacity_bytes: number;
  available_bytes: number;
  used_bytes: number;
  utilization_ratio: number;
  backlog_segments: number;
  backlog_bytes: number;
  oldest_backlog_age_seconds: number;
  terminal_segments: number;
  finalization_backlog: number;
  finalization_terminal: number;
  oldest_finalization_age_seconds: number;
  non_core_deferred: boolean;
  must_record_rejected: boolean;
  last_refresh_error: string;
}

const MAX_METRICS_BYTES = 64 * 1024;
const FUTURE_SKEW_MS = 30_000;
const MUST_RECORD_PERCENT = 90;

export class RustPbxRecordingSpoolCapacityGate {
  readonly #metricsFile: string;
  readonly #staleAfterMs: number;
  readonly #now: () => Date;
  #metrics: SpoolMetricsDocument | null = null;
  #lastRefreshError = '';

  constructor(input: {
    metrics_file: string;
    stale_after_ms: number;
    now?: () => Date;
  }) {
    if (!input.metrics_file.startsWith('/')) {
      throw new Error('recording spool metrics file must be absolute');
    }
    if (!Number.isInteger(input.stale_after_ms) ||
        input.stale_after_ms < 1_000 || input.stale_after_ms > 300_000) {
      throw new Error('recording spool metrics stale interval is invalid');
    }
    this.#metricsFile = input.metrics_file;
    this.#staleAfterMs = input.stale_after_ms;
    this.#now = input.now ?? (() => new Date());
  }

  async refresh(now = this.#now()): Promise<boolean> {
    try {
      const content = await readStableFile(this.#metricsFile, MAX_METRICS_BYTES);
      const value = parseMetrics(content, now);
      if (this.#metrics && Date.parse(value.observed_at) < Date.parse(this.#metrics.observed_at)) {
        throw new Error('recording spool metrics regressed');
      }
      this.#metrics = value;
      this.#lastRefreshError = '';
      return true;
    } catch (error) {
      this.#lastRefreshError = error instanceof Error ? error.message : 'recording spool metrics invalid';
      return false;
    }
  }

  assertCapacity(required: CapacityRequirement, now = this.#now()): void {
    const amount = required['data.local_spool_bytes'];
    if (amount === undefined) return;
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ComponentNodeAdmissionError(
        'component_reservation_capacity_invalid',
        400
      );
    }
    const snapshot = this.snapshot(now);
    if (!snapshot.fresh) {
      throw new ComponentNodeAdmissionError(
        'component_recording_spool_observation_stale',
        503,
        true
      );
    }
    if (snapshot.used_bytes + amount > snapshot.safe_capacity_bytes) {
      throw new ComponentNodeAdmissionError(
        'component_recording_spool_exhausted',
        503,
        true
      );
    }
  }

  assertReservation(required: CapacityRequirement, now = this.#now()): void {
    this.assertCapacity(required, now);
  }

  snapshot(now = this.#now()): RustPbxRecordingSpoolCapacitySnapshot {
    const metrics = this.#metrics;
    if (!metrics) {
      return {
        fresh: false,
        observed_at: '',
        capacity_bytes: 0,
        safe_capacity_bytes: 0,
        available_bytes: 0,
        used_bytes: 0,
        utilization_ratio: 0,
        backlog_segments: 0,
        backlog_bytes: 0,
        oldest_backlog_age_seconds: 0,
        terminal_segments: 0,
        finalization_backlog: 0,
        finalization_terminal: 0,
        oldest_finalization_age_seconds: 0,
        non_core_deferred: false,
        must_record_rejected: true,
        last_refresh_error: this.#lastRefreshError
      };
    }
    const observedAt = Date.parse(metrics.observed_at);
    const timestamp = checkedDate(now).getTime();
    return {
      fresh: observedAt <= timestamp + FUTURE_SKEW_MS &&
        timestamp - observedAt <= this.#staleAfterMs,
      observed_at: metrics.observed_at,
      capacity_bytes: metrics.capacity_bytes,
      safe_capacity_bytes: Math.floor(
        metrics.capacity_bytes * MUST_RECORD_PERCENT / 100
      ),
      available_bytes: metrics.available_bytes,
      used_bytes: metrics.used_bytes,
      utilization_ratio: metrics.utilization_ratio,
      backlog_segments: metrics.backlog_segments,
      backlog_bytes: metrics.backlog_bytes,
      oldest_backlog_age_seconds: metrics.oldest_backlog_age_seconds,
      terminal_segments: metrics.terminal_segments,
      finalization_backlog: metrics.finalization_backlog,
      finalization_terminal: metrics.finalization_terminal,
      oldest_finalization_age_seconds: metrics.oldest_finalization_age_seconds,
      non_core_deferred: metrics.non_core_admission === 'defer_non_core',
      must_record_rejected: metrics.must_record_admission === 'reject_must_record',
      last_refresh_error: this.#lastRefreshError
    };
  }

  renderPrometheus(now = this.#now()): string {
    const value = this.snapshot(now);
    return [
      '# TYPE ivekit_rustpbx_recording_spool_observation_fresh gauge',
      `ivekit_rustpbx_recording_spool_observation_fresh ${value.fresh ? 1 : 0}`,
      '# TYPE ivekit_rustpbx_recording_spool_capacity_bytes gauge',
      `ivekit_rustpbx_recording_spool_capacity_bytes ${value.capacity_bytes}`,
      '# TYPE ivekit_rustpbx_recording_spool_safe_capacity_bytes gauge',
      `ivekit_rustpbx_recording_spool_safe_capacity_bytes ${value.safe_capacity_bytes}`,
      '# TYPE ivekit_rustpbx_recording_spool_available_bytes gauge',
      `ivekit_rustpbx_recording_spool_available_bytes ${value.available_bytes}`,
      '# TYPE ivekit_rustpbx_recording_spool_used_bytes gauge',
      `ivekit_rustpbx_recording_spool_used_bytes ${value.used_bytes}`,
      '# TYPE ivekit_rustpbx_recording_spool_utilization_ratio gauge',
      `ivekit_rustpbx_recording_spool_utilization_ratio ${value.utilization_ratio}`,
      '# TYPE ivekit_rustpbx_recording_spool_backlog_segments gauge',
      `ivekit_rustpbx_recording_spool_backlog_segments ${value.backlog_segments}`,
      '# TYPE ivekit_rustpbx_recording_spool_backlog_bytes gauge',
      `ivekit_rustpbx_recording_spool_backlog_bytes ${value.backlog_bytes}`,
      '# TYPE ivekit_rustpbx_recording_spool_oldest_backlog_age_seconds gauge',
      `ivekit_rustpbx_recording_spool_oldest_backlog_age_seconds ${value.oldest_backlog_age_seconds}`,
      '# TYPE ivekit_rustpbx_recording_spool_terminal_segments gauge',
      `ivekit_rustpbx_recording_spool_terminal_segments ${value.terminal_segments}`,
      '# TYPE ivekit_rustpbx_recording_spool_finalization_backlog gauge',
      `ivekit_rustpbx_recording_spool_finalization_backlog ${value.finalization_backlog}`,
      '# TYPE ivekit_rustpbx_recording_spool_finalization_terminal gauge',
      `ivekit_rustpbx_recording_spool_finalization_terminal ${value.finalization_terminal}`,
      '# TYPE ivekit_rustpbx_recording_spool_oldest_finalization_age_seconds gauge',
      `ivekit_rustpbx_recording_spool_oldest_finalization_age_seconds ${value.oldest_finalization_age_seconds}`,
      '# TYPE ivekit_rustpbx_recording_spool_non_core_deferred gauge',
      `ivekit_rustpbx_recording_spool_non_core_deferred ${value.non_core_deferred ? 1 : 0}`,
      '# TYPE ivekit_rustpbx_recording_spool_must_record_rejected gauge',
      `ivekit_rustpbx_recording_spool_must_record_rejected ${value.must_record_rejected ? 1 : 0}`
    ].join('\n') + '\n';
  }

  prometheusMetrics(now = this.#now()): string {
    return this.renderPrometheus(now);
  }
}

async function readStableFile(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > maxBytes) {
      throw new Error('recording spool metrics file is invalid');
    }
    const content = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < content.length) {
      const read = await handle.read(content, offset, content.length - offset, offset);
      if (read.bytesRead === 0) throw new Error('recording spool metrics file changed');
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('recording spool metrics file changed');
    }
    return content;
  } finally {
    await handle.close();
  }
}

function parseMetrics(content: Buffer, now: Date): SpoolMetricsDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(content.toString('utf8'));
  } catch {
    throw new Error('recording spool metrics JSON is invalid');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('recording spool metrics document is invalid');
  }
  const value = raw as Record<string, unknown>;
  if (value.schema_version !== 1) throw new Error('recording spool metrics version is invalid');
  const observedAt = new Date(String(value.observed_at || ''));
  if (!Number.isFinite(observedAt.getTime()) ||
      observedAt.getTime() > checkedDate(now).getTime() + FUTURE_SKEW_MS) {
    throw new Error('recording spool metrics timestamp is invalid');
  }
  const capacity = positiveInteger(value.capacity_bytes, 'capacity');
  const available = nonNegativeInteger(value.available_bytes, 'available');
  const used = nonNegativeInteger(value.used_bytes, 'used');
  if (available > capacity || used > capacity || capacity - available !== used) {
    throw new Error('recording spool metrics capacity is inconsistent');
  }
  const ratio = Number(value.utilization_ratio);
  if (!Number.isFinite(ratio) || Math.abs(ratio - used / capacity) > 1e-9) {
    throw new Error('recording spool metrics utilization is inconsistent');
  }
  const computedNonCore = recordingSpoolAdmission({
    used_bytes: used,
    capacity_bytes: capacity,
    recording_class: 'non_core'
  });
  const computedMustRecord = recordingSpoolAdmission({
    used_bytes: used,
    capacity_bytes: capacity,
    recording_class: 'must_record'
  });
  if (computedNonCore === 'reject_must_record' || computedMustRecord === 'defer_non_core') {
    throw new Error('recording spool metrics admission is invalid');
  }
  const nonCore: 'accept' | 'defer_non_core' = computedNonCore;
  const mustRecord: 'accept' | 'reject_must_record' = computedMustRecord;
  if (value.non_core_admission !== nonCore || value.must_record_admission !== mustRecord) {
    throw new Error('recording spool metrics admission is inconsistent');
  }
  return {
    schema_version: 1,
    observed_at: observedAt.toISOString(),
    capacity_bytes: capacity,
    available_bytes: available,
    used_bytes: used,
    utilization_ratio: ratio,
    non_core_admission: nonCore,
    must_record_admission: mustRecord,
    backlog_segments: nonNegativeInteger(value.backlog_segments, 'backlog segments'),
    backlog_bytes: nonNegativeInteger(value.backlog_bytes, 'backlog bytes'),
    oldest_backlog_age_seconds: nonNegativeInteger(
      value.oldest_backlog_age_seconds,
      'oldest backlog age'
    ),
    terminal_segments: optionalNonNegativeInteger(value.terminal_segments, 'terminal segments'),
    finalization_backlog: optionalNonNegativeInteger(
      value.finalization_backlog,
      'finalization backlog'
    ),
    finalization_terminal: optionalNonNegativeInteger(
      value.finalization_terminal,
      'finalization terminal'
    ),
    oldest_finalization_age_seconds: optionalNonNegativeInteger(
      value.oldest_finalization_age_seconds,
      'oldest finalization age'
    )
  };
}

function positiveInteger(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new Error(`recording spool metrics ${label} is invalid`);
  }
  return result;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`recording spool metrics ${label} is invalid`);
  }
  return result;
}

function optionalNonNegativeInteger(value: unknown, label: string): number {
  return value === undefined ? 0 : nonNegativeInteger(value, label);
}

function checkedDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('recording spool capacity time is invalid');
  }
  return value;
}
