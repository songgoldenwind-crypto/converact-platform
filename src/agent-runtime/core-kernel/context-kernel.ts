import { createHash } from 'node:crypto';

import type { BuildContextEnvelopeInput, ContextEnvelope } from './types.js';

export function buildContextEnvelope(input: BuildContextEnvelopeInput): ContextEnvelope {
  const isolationScope = `${input.tenantId}:${input.runId}`;
  const phase = String(input.phase || 'goal_created');
  const loadedSlices = Object.keys(input.slices ?? {});
  const retain = input.compression?.retain ?? loadedSlices;
  const maxChars = input.compression?.maxChars ?? 1024;
  const compressor = new AdaptiveCompressor(maxChars);
  const compressedContext = input.compression
    ? compressor.compress(input.slices ?? {}, retain)
    : compressContext(input.slices ?? {}, retain, maxChars);
  const discardAudit = input.compression
    ? buildCompressionDiscardAudit(input.slices ?? {}, compressedContext, retain)
    : null;
  const resumeToken =
    input.resumeToken ??
    createHash('sha256').update(`${isolationScope}:${phase}`).digest('hex').slice(0, 24);

  return {
    isolation_scope: isolationScope,
    phase,
    loaded_slices: loadedSlices,
    compressed_context: compressedContext,
    compression_applied: Boolean(input.compression),
    compression_trace: input.compressionTrace ?? {
      phase,
      max_chars: maxChars,
      total_before_chars: measureJsonChars(input.slices ?? {}),
      total_after_chars: measureJsonChars(compressedContext),
      retained_count: loadedSlices.length,
      discarded_count: Number(discardAudit?.discarded_count || 0),
      retained_categories: loadedSlices,
      discarded_categories: Array.isArray(discardAudit?.discarded_categories) ? discardAudit.discarded_categories as string[] : [],
      retained_ids: [],
      discarded_ids: [],
      critical_open_loops_retained: true,
      discard_audit: discardAudit && Array.isArray(discardAudit.discarded_categories) ? {
        discarded_categories: discardAudit.discarded_categories as string[],
        discarded_count: Number(discardAudit.discarded_count || 0),
        retained_count: Number(discardAudit.retained_count || 0),
        audited_at: String(discardAudit.audited_at || new Date().toISOString())
      } : undefined
    },
    resume_token: resumeToken
  };
}

export function compressContext(
  slices: Record<string, any>,
  retain: string[],
  maxChars: number
): Record<string, any> {
  const context: Record<string, any> = {};
  for (const key of retain) {
    if (Object.hasOwn(slices, key)) {
      context[key] = slices[key];
    }
  }

  return enforceMaxChars(context, Math.max(maxChars, 64));
}

function enforceMaxChars(context: Record<string, any>, maxChars: number): Record<string, any> {
  const compact = cloneContextForCompression(context);
  if (measureJsonChars(compact) <= maxChars) {
    return compact;
  }

  const keys = Object.keys(compact);
  let cursor = 0;
  while (measureJsonChars(compact) > maxChars && keys.length > 0) {
    const key = keys[cursor % keys.length];
    const value = compact[key];

    if (Array.isArray(value) && value.length > 1) {
      value.pop();
    } else if (Array.isArray(value) && value.length === 1) {
      const head = value[0];
      if (typeof head === 'string' && head.length > 16) {
        value[0] = `${head.slice(0, 13)}...`;
      } else {
        delete compact[key];
      }
    } else if (typeof value === 'string' && value.length > 16) {
      compact[key] = `${value.slice(0, 13)}...`;
    } else {
      delete compact[key];
    }

    cursor += 1;
    if (cursor > keys.length * 8) {
      break;
    }
  }

  return compact;
}

function cloneContextForCompression(context: Record<string, any>): Record<string, any> {
  let cloned: unknown = context;

  try {
    cloned = structuredClone(context);
  } catch {
    // structuredClone fails on non-cloneable values (functions, class instances,
    // detached ArrayBuffers). Fall back to sanitizing the original object in-
    // place — sanitizeForCompression handles cycles and strips non-serializable
    // values, so the result is equivalent. Logged at debug to surface repeated
    // failures (which indicate upstream context is carrying non-cloneable data).
    if (process.env.DEBUG_CONTEXT_KERNEL) {
      console.debug('[context-kernel] structuredClone failed, falling back to in-place sanitize');
    }
  }

  const sanitized = sanitizeForCompression(cloned, new WeakSet<object>());
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
    return {};
  }

  return sanitized as Record<string, any>;
}

function sanitizeForCompression(value: unknown, visited: WeakSet<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === 'bigint') {
    return `${value.toString()}n`;
  }

  if (typeof value === 'function') {
    return `[function:${value.name || 'anonymous'}]`;
  }

  if (typeof value === 'symbol') {
    return value.toString();
  }

  if (typeof value === 'undefined') {
    return '[undefined]';
  }

  if (typeof value !== 'object') {
    return String(value);
  }

  if (visited.has(value)) {
    return '[circular]';
  }
  visited.add(value);

  try {
    if (value instanceof Date) {
      return Number.isFinite(value.getTime()) ? value.toISOString() : '[invalid-date]';
    }

    if (value instanceof Map) {
      const sanitizedMap: Record<string, any> = {};
      for (const [mapKey, mapValue] of value.entries()) {
        sanitizedMap[String(mapKey)] = sanitizeForCompression(mapValue, visited);
      }
      return sanitizedMap;
    }

    if (value instanceof Set) {
      const sanitizedSet: unknown[] = [];
      for (const setValue of value.values()) {
        sanitizedSet.push(sanitizeForCompression(setValue, visited));
      }
      return sanitizedSet;
    }

    if (ArrayBuffer.isView(value)) {
      if (value instanceof DataView) {
        return serializeDataView(value);
      }

      return serializeTypedArrayView(value);
    }

    if (value instanceof ArrayBuffer) {
      return `[array-buffer:${value.byteLength}]`;
    }

    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack
      };
    }

    if (Array.isArray(value)) {
      const sanitizedItems: unknown[] = [];
      for (const item of value) {
        sanitizedItems.push(sanitizeForCompression(item, visited));
      }
      return sanitizedItems;
    }

    const sanitizedRecord: Record<string, any> = {};
    for (const key of Object.keys(value as Record<string, any>)) {
      let nested: unknown;
      try {
        nested = (value as Record<string, any>)[key];
      } catch (error) {
        const readableError =
          error instanceof Error ? `${error.name}:${error.message}` : String(error);
        sanitizedRecord[key] = `[unreadable:${readableError}]`;
        continue;
      }

      sanitizedRecord[key] = sanitizeForCompression(nested, visited);
    }
    return sanitizedRecord;
  } finally {
    visited.delete(value);
  }
}

type TypedArrayLikeView = ArrayBufferView & ArrayLike<number | bigint>;

function serializeDataView(value: DataView): Record<string, any> {
  try {
    const byteOffset = value.byteOffset;
    const byteLength = value.byteLength;
    const bytes = Array.from(new Uint8Array(value.buffer, byteOffset, byteLength));

    return {
      view_type: 'DataView',
      byte_offset: byteOffset,
      byte_length: byteLength,
      bytes
    };
  } catch (error) {
    const readableError = error instanceof Error ? `${error.name}:${error.message}` : String(error);
    return {
      view_type: 'DataView',
      byte_offset: '[unavailable]',
      byte_length: '[unavailable]',
      bytes: [],
      error: `[unreadable:${readableError}]`
    };
  }
}

function serializeTypedArrayView(value: ArrayBufferView): unknown[] | string {
  if (!isTypedArrayLikeView(value)) {
    return describeArrayBufferView(value);
  }

  const sanitizedValues: Array<number | string> = [];
  for (let index = 0; index < value.length; index += 1) {
    sanitizedValues.push(sanitizeTypedArrayElement(value[index]));
  }
  return sanitizedValues;
}

function isTypedArrayLikeView(value: ArrayBufferView): value is TypedArrayLikeView {
  return !(value instanceof DataView) && typeof (value as { length?: unknown }).length === 'number';
}

function sanitizeTypedArrayElement(value: number | bigint): number | string {
  if (typeof value === 'bigint') {
    return `${value.toString()}n`;
  }
  return Number.isFinite(value) ? value : String(value);
}

function describeArrayBufferView(value: ArrayBufferView): string {
  let byteLength: number | string = 'unknown';
  try {
    byteLength = value.byteLength;
  } catch {
    // Reading byteLength throws on detached ArrayBuffers (TypeError). This is a
    // diagnostic fallback path — 'unknown' is the expected degraded label.
  }

  const constructorName =
    value.constructor && typeof value.constructor.name === 'string'
      ? value.constructor.name
      : 'ArrayBufferView';
  return `[array-buffer-view:${constructorName}:${byteLength}]`;
}

/** I72: adaptive compression fallback when enforceMaxChars still exceeds budget */
export class AdaptiveCompressor {
  constructor(private readonly maxChars: number) {}

  compress(slices: Record<string, any>, retain: string[]): Record<string, any> {
    let compressed = compressContext(slices, retain, this.maxChars);
    if (measureJsonChars(compressed) <= this.maxChars) {
      return compressed;
    }
    const halved = Math.max(Math.floor(this.maxChars / 2), 64);
    compressed = compressContext(slices, retain.slice(0, Math.max(1, Math.ceil(retain.length / 2))), halved);
    return compressed;
  }
}

/** I73: compression discard audit trace — persisted as particle via context-builder */
export function buildCompressionDiscardAudit(
  before: Record<string, any>,
  after: Record<string, any>,
  retain: string[]
): Record<string, any> {
  const beforeKeys = new Set(Object.keys(before));
  const afterKeys = new Set(Object.keys(after));
  const discarded = [...beforeKeys].filter((key) => !afterKeys.has(key) && retain.includes(key));
  return {
    discarded_categories: discarded,
    discarded_count: discarded.length,
    retained_count: afterKeys.size,
    audited_at: new Date().toISOString()
  };
}

const MEMORY_CATEGORY_WEIGHTS: Record<string, number> = {
  founder_preference: 1.2,
  objection_pattern: 1.1,
  source_quality: 1.0,
  script_efficacy: 1.0,
  outcome_proof: 0.9,
  channel_receipt: 0.85
};

/** I76: rank context slice categories with memory weights */
export function injectMemoryCategoryWeights(categories: string[]): string[] {
  return new MemoryCategoryWeightInjector().rank(categories);
}

/** I74: six-class memory weight injection stub */
export class MemoryCategoryWeightInjector {
  rank(categories: string[]): string[] {
    return [...categories].sort((left, right) => {
      const lw = MEMORY_CATEGORY_WEIGHTS[left] ?? 0.5;
      const rw = MEMORY_CATEGORY_WEIGHTS[right] ?? 0.5;
      return rw - lw;
    });
  }
}

/** I71: phase-aware slice prioritization (stub — full weights in Batch 71+) */
export class PhaseAwarePrioritizer {
  constructor(private readonly phase: string) {}

  rank(categories: string[]): string[] {
    const phaseBoost = this.phase === 'call_execution'
      ? ['call_readiness', 'objection_turn', 'live_call_guidance']
      : this.phase === 'lead_discovery_ready'
        ? ['discovery_plan', 'candidate_sources', 'import_gate']
        : ['today_workbench', 'next_recommended_action'];
    const boosted = new Set(phaseBoost);
    return [
      ...categories.filter((item) => boosted.has(item)),
      ...categories.filter((item) => !boosted.has(item))
    ];
  }
}

function measureJsonChars(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return (serialized ?? 'null').length;
  } catch {
    const sanitized = sanitizeForCompression(value, new WeakSet<object>());
    const serialized = JSON.stringify(sanitized);
    return (serialized ?? 'null').length;
  }
}
