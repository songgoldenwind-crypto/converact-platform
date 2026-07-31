import { createHash } from 'node:crypto';

import type { PgQueryable } from '../../db-pg.js';
import { createObjectStorage } from '../../storage/object-storage.js';
import { SecureFileDerivativeStore } from './secure-file-derivative-store.js';
import { SecureFileService } from './secure-file-service.js';
import { SecureFileStore } from './secure-file-store.js';
import {
  SecureTinodeInboundAttachmentImporter,
  TinodeInboundAttachmentImportError,
  type TinodeInboundAttachmentImporter
} from './tinode-inbound-attachment-import.js';
import { TinodeInboundProjector } from './tinode-inbound-projector.js';
import {
  describeRejectedTinodePacket,
  normalizeTinodeInboundPacket,
  TinodeInboundProtocolError,
  type TinodeInboundNormalizedEvent,
  type TinodeInboundRejectedEvent
} from './tinode-inbound-protocol.js';
import {
  configuredTinodeInboundSource,
  type TinodeInboundSource
} from './tinode-inbound-source.js';
import {
  TinodeInboundStore,
  type TinodeInboundClaim,
  type TinodeInboundProcessResult
} from './tinode-inbound-store.js';
import { tinodeApiKeysDistinct } from './tinode-env.js';

export interface TinodeInboundWorkerConfig {
  enabled: boolean;
  intervalMs: number;
  tenantLimit: number;
  pullLimit: number;
  claimLeaseMs: number;
  retryDelayMs: number;
  deadLetterMaxAttempts: number;
  allowedAttachmentHosts: string[];
}

export interface TinodeInboundServiceConfig {
  tenantLimit: number;
  pullLimit: number;
  claimLeaseMs: number;
  retryDelayMs: number;
  deadLetterMaxAttempts: number;
  allowedAttachmentHosts: string[];
}

export interface TinodeInboundRunSummary {
  tenants: number;
  claimed: number;
  packets: number;
  retried: number;
  projected: number;
  ignored: number;
  dead_letter: number;
  failed: number;
}

export interface TinodeInboundProcessedEvent {
  claim: TinodeInboundClaim;
  event: TinodeInboundNormalizedEvent;
  result: TinodeInboundProcessResult;
}

export interface TinodeInboundProjectedEvent {
  pg: PgQueryable;
  claim: TinodeInboundClaim;
  event: TinodeInboundNormalizedEvent;
  projection: Awaited<ReturnType<TinodeInboundProjector['project']>>;
}

export interface TinodeInboundServiceInput {
  store: TinodeInboundStore;
  source: TinodeInboundSource;
  projector: TinodeInboundProjector;
  config: TinodeInboundServiceConfig;
  onProjected?: (input: TinodeInboundProjectedEvent) => void | Promise<void>;
  onProcessed?: (input: TinodeInboundProcessedEvent) => void | Promise<void>;
  prepareEvent?: TinodeInboundAttachmentImporter['prepare'];
}

export class TinodeInboundService {
  constructor(private readonly input: TinodeInboundServiceInput) {}

  async runDue(): Promise<TinodeInboundRunSummary> {
    const summary = emptySummary();
    const tenantIds = await this.input.store.discoverTenantIds({ limit: this.input.config.tenantLimit });
    summary.tenants = tenantIds.length;
    for (const tenantId of tenantIds) {
      const claim = await this.input.store.claimNext({
        tenant_id: tenantId,
        lease_ms: this.input.config.claimLeaseMs
      });
      if (!claim) continue;
      summary.claimed += 1;
      try {
        const retried = await this.input.store.retryDueDeadLetters(
          claim,
          {
            limit: this.input.config.pullLimit,
            maxAttempts: this.input.config.deadLetterMaxAttempts,
            retryDelayMs: this.input.config.retryDelayMs
          },
          (pg, event) => this.project(pg, claim, event)
        );
        summary.retried += retried.length;
        for (const retriedEvent of retried) {
          summary[retriedEvent.result.status] += 1;
          await this.input.onProcessed?.({
            claim,
            event: retriedEvent.event,
            result: retriedEvent.result
          });
        }
        const packets = await this.input.source.pull({
          provider_topic_id: claim.provider_topic_id,
          last_data_seq: claim.cursor.last_data_seq,
          last_del_id: claim.cursor.last_del_id,
          limit: this.input.config.pullLimit
        });
        summary.packets += packets.length;
        const events = packets.map((packet): TinodeInboundQueueItem => {
          try {
            return { event: normalizeTinodeInboundPacket(packet, {
              expectedTopic: claim.provider_topic_id,
              allowedAttachmentHosts: this.input.config.allowedAttachmentHosts
            }) };
          } catch (error) {
            if (!(error instanceof TinodeInboundProtocolError)) throw error;
            return { rejected: describeRejectedTinodePacket(packet, claim.provider_topic_id, error) };
          }
        }).sort(compareQueueItems);
        for (const item of events) {
          let event = 'event' in item ? item.event : null;
          let rejected = 'rejected' in item ? item.rejected : null;
          if (event && this.input.prepareEvent) {
            try {
              event = await this.input.prepareEvent(claim, event);
            } catch (error) {
              if (!(error instanceof TinodeInboundAttachmentImportError) || error.retryable) throw error;
              rejected = attachmentImportRejection(event, error);
              event = null;
            }
          }
          const result = rejected
            ? await this.input.store.rejectEvent(claim, rejected)
            : await this.input.store.processEvent(
              claim,
              event!,
              (pg) => this.project(pg, claim, event!)
            );
          summary[result.status] += 1;
          if (event) await this.input.onProcessed?.({ claim, event, result });
        }
        await this.input.store.releaseClaim(claim);
      } catch (error) {
        summary.failed += 1;
        await this.input.store.recordFailure(claim, error, this.input.config.retryDelayMs);
      }
    }
    return summary;
  }

  private async project(
    pg: PgQueryable,
    claim: TinodeInboundClaim,
    event: TinodeInboundNormalizedEvent
  ) {
    const projection = await this.input.projector.project(pg, claim, event);
    await this.input.onProjected?.({ pg, claim, event, projection });
    return projection;
  }
}

export interface TinodeInboundWorkerInput {
  config: Pick<TinodeInboundWorkerConfig, 'enabled' | 'intervalMs'>;
  runBatch: () => Promise<TinodeInboundRunSummary>;
  onResult?: (result: TinodeInboundRunSummary) => void;
  onError?: (error: unknown) => void;
}

export class TinodeInboundWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<TinodeInboundRunSummary> | null = null;
  private stopped = true;

  constructor(private readonly input: TinodeInboundWorkerInput) {}

  start(): void {
    if (!this.input.config.enabled || !this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  runOnce(): Promise<TinodeInboundRunSummary> {
    if (this.active) return this.active;
    let running: Promise<TinodeInboundRunSummary>;
    try {
      running = Promise.resolve(this.input.runBatch());
    } catch (error) {
      running = Promise.reject(error);
    }
    const wrapped = running.finally(() => {
      if (this.active === wrapped) this.active = null;
    });
    this.active = wrapped;
    return wrapped;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.active) await this.active.catch(() => undefined);
  }

  private schedule(delayMs: number): void {
    if (this.stopped || !this.input.config.enabled) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce()
        .then((result) => this.input.onResult?.(result))
        .catch((error) => this.input.onError?.(error))
        .finally(() => this.schedule(this.input.config.intervalMs));
    }, delayMs);
    this.timer.unref?.();
  }
}

export function tinodeInboundWorkerConfig(
  env: NodeJS.ProcessEnv = process.env
): TinodeInboundWorkerConfig {
  const enabledFlag = String(env.OPC_TINODE_INBOUND_WORKER_ENABLED || '').trim();
  if (enabledFlag && enabledFlag !== '0' && enabledFlag !== '1') {
    throw new Error('OPC_TINODE_INBOUND_WORKER_ENABLED must be 0 or 1');
  }
  const providerConfigured = hasValue(env.TINODE_WS_URL) || hasValue(env.TINODE_BASE_URL);
  const authenticationConfigured = hasValue(env.TINODE_AUTH_TOKEN) || (
    hasValue(env.TINODE_BASIC_USER) && hasValue(env.TINODE_BASIC_PASSWORD)
  );
  return {
    enabled: providerConfigured && authenticationConfigured &&
      tinodeApiKeysDistinct(env) && enabledFlag !== '0',
    intervalMs: boundedInteger(
      env.OPC_TINODE_INBOUND_INTERVAL_MS,
      5_000,
      1_000,
      300_000,
      'OPC_TINODE_INBOUND_INTERVAL_MS'
    ),
    tenantLimit: boundedInteger(
      env.OPC_TINODE_INBOUND_TENANT_LIMIT,
      100,
      1,
      1_000,
      'OPC_TINODE_INBOUND_TENANT_LIMIT'
    ),
    pullLimit: boundedInteger(
      env.OPC_TINODE_INBOUND_PULL_LIMIT,
      100,
      1,
      200,
      'OPC_TINODE_INBOUND_PULL_LIMIT'
    ),
    claimLeaseMs: boundedInteger(
      env.OPC_TINODE_INBOUND_CLAIM_LEASE_MS,
      60_000,
      5_000,
      600_000,
      'OPC_TINODE_INBOUND_CLAIM_LEASE_MS'
    ),
    retryDelayMs: boundedInteger(
      env.OPC_TINODE_INBOUND_RETRY_DELAY_MS,
      10_000,
      1_000,
      300_000,
      'OPC_TINODE_INBOUND_RETRY_DELAY_MS'
    ),
    deadLetterMaxAttempts: boundedInteger(
      env.OPC_TINODE_INBOUND_DEAD_LETTER_MAX_ATTEMPTS,
      3,
      1,
      10,
      'OPC_TINODE_INBOUND_DEAD_LETTER_MAX_ATTEMPTS'
    ),
    allowedAttachmentHosts: csvValues(env.OPC_TINODE_ATTACHMENT_ALLOWED_HOSTS)
  };
}

export function startTinodeInboundWorker(input: {
  pg: PgQueryable;
  env?: NodeJS.ProcessEnv;
  onProjected?: TinodeInboundServiceInput['onProjected'];
  onProcessed?: TinodeInboundServiceInput['onProcessed'];
  secureFiles?: SecureFileService;
  attachmentImporter?: TinodeInboundAttachmentImporter;
  projector?: TinodeInboundProjector;
}): TinodeInboundWorker {
  const env = input.env || process.env;
  const config = tinodeInboundWorkerConfig(env);
  const source = config.enabled ? configuredTinodeInboundSource(env) : null;
  const service = source ? (() => {
    const secureFiles = input.secureFiles || new SecureFileService({
      files: new SecureFileStore(input.pg),
      derivatives: new SecureFileDerivativeStore(input.pg),
      storage: createObjectStorage()
    });
    const attachmentImporter = input.attachmentImporter || new SecureTinodeInboundAttachmentImporter({
      secureFiles,
      allowedHosts: config.allowedAttachmentHosts,
      maxBytes: boundedInteger(
        env.OPC_TINODE_INBOUND_ATTACHMENT_MAX_BYTES,
        25 * 1024 * 1024,
        1,
        512 * 1024 * 1024,
        'OPC_TINODE_INBOUND_ATTACHMENT_MAX_BYTES'
      ),
      timeoutMs: boundedInteger(
        env.OPC_TINODE_INBOUND_ATTACHMENT_TIMEOUT_MS,
        30_000,
        250,
        120_000,
        'OPC_TINODE_INBOUND_ATTACHMENT_TIMEOUT_MS'
      )
    });
    return new TinodeInboundService({
      store: new TinodeInboundStore({ pg: input.pg, deadLetterRetryDelayMs: config.retryDelayMs }),
      source,
      projector: input.projector || new TinodeInboundProjector({ secureAttachmentsRequired: true }),
      config,
      onProjected: input.onProjected,
      onProcessed: input.onProcessed,
      prepareEvent: (claim, event) => attachmentImporter.prepare(claim, event)
    });
  })() : null;
  const worker = new TinodeInboundWorker({
    config,
    runBatch: () => service ? service.runDue() : Promise.resolve(emptySummary()),
    onResult: (result) => {
      if (result.packets > 0 || result.retried > 0 || result.dead_letter > 0 || result.failed > 0) {
        console.log('[tinode-inbound] batch', JSON.stringify(result));
      }
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[tinode-inbound] worker failed:', redactWorkerError(message));
    }
  });
  worker.start();
  return worker;
}

type TinodeInboundQueueItem =
  | { event: TinodeInboundNormalizedEvent }
  | { rejected: TinodeInboundRejectedEvent };

function compareQueueItems(left: TinodeInboundQueueItem, right: TinodeInboundQueueItem): number {
  const leftEvent = 'event' in left ? left.event : left.rejected;
  const rightEvent = 'event' in right ? right.event : right.rejected;
  if (leftEvent.kind !== rightEvent.kind) return leftEvent.kind === 'data' ? -1 : 1;
  return leftEvent.kind === 'data'
    ? leftEvent.provider_sequence - rightEvent.provider_sequence
    : leftEvent.provider_delete_id - rightEvent.provider_delete_id;
}

function attachmentImportRejection(
  event: TinodeInboundNormalizedEvent,
  error: TinodeInboundAttachmentImportError
): TinodeInboundRejectedEvent {
  const payload: TinodeInboundRejectedEvent['payload'] = {
    rejected: true,
    topic: event.payload.topic,
    provider_sequence: event.provider_sequence,
    provider_delete_id: event.provider_delete_id,
    error_code: error.code
  };
  return {
    kind: event.kind,
    provider_sequence: event.provider_sequence,
    provider_delete_id: event.provider_delete_id,
    dedupe_key: event.dedupe_key,
    payload_hash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    payload,
    error_code: error.code,
    error_message: 'Tinode inbound attachment was rejected by the secure import policy',
    retryable: false
  };
}

function emptySummary(): TinodeInboundRunSummary {
  return {
    tenants: 0,
    claimed: 0,
    packets: 0,
    retried: 0,
    projected: 0,
    ignored: 0,
    dead_letter: 0,
    failed: 0
  };
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string
): number {
  if (value == null || !String(value).trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function csvValues(value: string | undefined): string[] {
  return [...new Set(String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean))];
}

function hasValue(value: string | undefined): boolean {
  return Boolean(String(value || '').trim());
}

function redactWorkerError(value: string): string {
  return String(value)
    .replace(/([?&](?:apikey|token|key|secret|password)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/((?:token|key|secret|password)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, '$1[redacted]')
    .slice(0, 500);
}
