import { createHash } from 'node:crypto';

import {
  startAttachmentProcessingWorker
} from '../collaboration/attachment-processing-worker.js';
import {
  QualityReviewService
} from '../collaboration/quality-review.js';
import { startQualityReviewWorker } from '../collaboration/quality-review-worker.js';
import { startTinodeInboundWorker } from '../collaboration/tinode-inbound-worker.js';
import { startTinodeSyncWorker } from '../collaboration/tinode-sync-worker.js';
import { startMediaCallTimeoutWorker } from '../livekit/media-call-timeout-worker.js';
import { startIveKitTenantEventRetentionWorker } from './tenant-event-retention-worker.js';
import type { PgQueryable } from '../../db-pg.js';
import { wsBroadcast } from '../../ws.js';
import { syncIntelligenceSourceForAttachment } from '../collaboration/intelligence-source-service.js';
import { createIntelligenceProviderRegistry } from '../collaboration/intelligence-provider-registry.js';
import {
  createPolicyQualityReviewProviderResolver,
  createPolicyTranslationProviderResolver
} from '../collaboration/intelligence-provider-routing.js';
import { IntelligencePolicyStore } from '../collaboration/intelligence-policy-store.js';
import { CollaborationStore } from '../collaboration/collaboration-store.js';
import { TranslationService } from '../collaboration/translation-service.js';
import { startTranslationWorker } from '../collaboration/translation-worker.js';
import { withPgTenant } from '../../db-pg-tenant.js';
import { IveKitTenantEventStore, iveKitEventReplayEnabled } from './tenant-event-store.js';
import {
  iveKitVoiceWorkerConfig,
  startIveKitVoiceCommandWorker,
  startIveKitVoiceProviderEventWorker,
  startIveKitVoiceReconciliationWorker
} from './voice/runtime.js';

export interface IveKitWorkerHandle {
  stop(): Promise<void>;
}

export interface IveKitRuntimeAdapters {
  startTinode(input: Parameters<typeof startTinodeSyncWorker>[0]): IveKitWorkerHandle;
  startTinodeInbound(input: Parameters<typeof startTinodeInboundWorker>[0]): IveKitWorkerHandle;
  startAttachment(input: Parameters<typeof startAttachmentProcessingWorker>[0]): IveKitWorkerHandle;
  startQuality(input: Parameters<typeof startQualityReviewWorker>[0]): IveKitWorkerHandle;
  startTranslation(input: Parameters<typeof startTranslationWorker>[0]): IveKitWorkerHandle;
  startMediaTimeout(input: Parameters<typeof startMediaCallTimeoutWorker>[0]): IveKitWorkerHandle;
  startEventRetention(input: Parameters<typeof startIveKitTenantEventRetentionWorker>[0]): IveKitWorkerHandle;
  startVoiceCommand(input: Parameters<typeof startIveKitVoiceCommandWorker>[0]): IveKitWorkerHandle;
  startVoiceEvent(input: Parameters<typeof startIveKitVoiceProviderEventWorker>[0]): IveKitWorkerHandle;
  startVoiceReconciliation(input: Parameters<typeof startIveKitVoiceReconciliationWorker>[0]): IveKitWorkerHandle;
}

export interface IveKitApplicationInput {
  pg: PgQueryable;
  env?: NodeJS.ProcessEnv;
  publish?: IveKitEventPublisher;
  qualityReviewEnqueuer?: IveKitQualityReviewEnqueuer;
  translationEnqueuer?: IveKitTranslationEnqueuer;
  adapters?: Partial<IveKitRuntimeAdapters>;
}

export interface IveKitApplication {
  stop(): Promise<void>;
}

export type IveKitEventPublisher = (
  tenantId: string,
  type: string,
  data: unknown
) => void | Promise<void>;

export interface IveKitQualityReviewEnqueuer {
  enabled: boolean;
  enqueueMessage(
    input: { tenant_id: string; message_id: string },
    pg?: PgQueryable
  ): Promise<unknown>;
}

export interface IveKitTranslationEnqueuer {
  enabled: boolean;
  enqueueSource(input: {
    tenant_id: string;
    session_id: string;
    source_type: 'message' | 'attachment';
    source_ref_id: string;
  }, pg?: PgQueryable): Promise<unknown>;
}

export function startIveKitApplication(input: IveKitApplicationInput): IveKitApplication {
  const env = input.env || process.env;
  const voiceConfig = iveKitVoiceWorkerConfig(env);
  const publish = input.publish || applicationPublisher(input.pg, env);
  const qualityReviewEnqueuer = input.qualityReviewEnqueuer || createQualityReviewEnqueuer(input.pg, env);
  const translationEnqueuer = input.translationEnqueuer || createTranslationEnqueuer(input.pg, env);
  const adapters: IveKitRuntimeAdapters = {
    startTinode: input.adapters?.startTinode || startTinodeSyncWorker,
    startTinodeInbound: input.adapters?.startTinodeInbound || startTinodeInboundWorker,
    startAttachment: input.adapters?.startAttachment || startAttachmentProcessingWorker,
    startQuality: input.adapters?.startQuality || startQualityReviewWorker,
    startTranslation: input.adapters?.startTranslation || startTranslationWorker,
    startMediaTimeout: input.adapters?.startMediaTimeout || startMediaCallTimeoutWorker,
    startEventRetention: input.adapters?.startEventRetention || startIveKitTenantEventRetentionWorker,
    startVoiceCommand: input.adapters?.startVoiceCommand || startIveKitVoiceCommandWorker,
    startVoiceEvent: input.adapters?.startVoiceEvent || startIveKitVoiceProviderEventWorker,
    startVoiceReconciliation: input.adapters?.startVoiceReconciliation || startIveKitVoiceReconciliationWorker
  };
  const workers: IveKitWorkerHandle[] = [
    adapters.startTinode({
      pg: input.pg,
      env,
      onDeliveryUpdated: (message) => publish(
        message.tenant_id,
        'collaboration.message.delivery_updated',
        {
          session_id: message.session_id,
          message_id: message.id,
          delivery: message.provider_delivery
        }
      )
    }),
    adapters.startTinodeInbound({
      pg: input.pg,
      env,
      onProjected: async ({ pg, claim, event, projection }) => {
        if (
          qualityReviewEnqueuer.enabled &&
          event.kind === 'data' &&
          projection.status === 'projected' &&
          projection.message_id
        ) {
          await qualityReviewEnqueuer.enqueueMessage({
            tenant_id: claim.tenant_id,
            message_id: projection.message_id
          }, pg);
        }
        if (
          translationEnqueuer.enabled && event.kind === 'data' &&
          projection.status === 'projected' && projection.message_id
        ) {
          await translationEnqueuer.enqueueSource({
            tenant_id: claim.tenant_id,
            session_id: claim.session_id,
            source_type: 'message',
            source_ref_id: projection.message_id
          }, pg);
        }
      },
      onProcessed: async ({ claim, event, result }) => {
        await publish(claim.tenant_id, 'collaboration.message.provider_synced', {
          session_id: claim.session_id,
          binding_id: claim.binding_id,
          event_id: result.event_id,
          event_kind: event.kind,
          provider_sequence: event.provider_sequence,
          provider_delete_id: event.provider_delete_id,
          status: result.status,
          message_id: result.message_id,
          replayed: result.replayed
        });
      }
    }),
    adapters.startAttachment({
      pg: input.pg,
      env,
      onProcessed: async ({ attachment, job, policy }) => {
        const source = await syncIntelligenceSourceForAttachment(input.pg, {
          tenant_id: attachment.tenant_id,
          attachment_id: attachment.id,
          job
        });
        await publish(attachment.tenant_id, 'collaboration.attachment.processed', {
          session_id: attachment.session_id,
          message_id: attachment.message_id,
          attachment,
          job,
          policy
        });
        if (source) {
          await publish(attachment.tenant_id, 'collaboration.intelligence.source_processed', {
            session_id: source.session_id,
            source_id: source.id,
            message_id: source.message_id,
            attachment_id: source.attachment_id,
            status: source.status,
            error_code: source.error_code
          });
        }
        if (qualityReviewEnqueuer.enabled) {
          await qualityReviewEnqueuer.enqueueMessage({
            tenant_id: attachment.tenant_id,
            message_id: attachment.message_id
          });
        }
        if (translationEnqueuer.enabled) {
          await translationEnqueuer.enqueueSource({
            tenant_id: attachment.tenant_id,
            session_id: attachment.session_id,
            source_type: 'attachment',
            source_ref_id: attachment.id
          });
        }
      }
    }),
    adapters.startQuality({
      pg: input.pg,
      env,
      onCompleted: ({ job, findings }) => publish(
        job.tenant_id,
        'collaboration.quality_review.completed',
        {
          session_id: job.session_id,
          message_id: job.message_id,
          job,
          findings
        }
      )
    }),
    adapters.startTranslation({
      pg: input.pg,
      env,
      onCompleted: ({ job }) => publish(job.tenant_id, 'collaboration.translation.completed', {
        job_id: job.id,
        session_id: job.session_id,
        message_id: job.message_id,
        source_type: job.source_type,
        source_ref_id: job.source_ref_id,
        source_language: job.source_language,
        target_language: job.target_language,
        status: job.status
      }),
      onFailed: (job) => publish(job.tenant_id, 'collaboration.translation.failed', {
        job_id: job.id,
        session_id: job.session_id,
        message_id: job.message_id,
        source_type: job.source_type,
        source_ref_id: job.source_ref_id,
        target_language: job.target_language,
        status: job.status,
        error_code: job.error_code
      })
    }),
    adapters.startMediaTimeout({
      pg: input.pg,
      env,
      onTimedOut: (snapshot) => publish(
        snapshot.call.tenant_id,
        'ivekit.media.call.updated',
        snapshot
      )
    }),
    adapters.startEventRetention({ pg: input.pg, env }),
    ...(voiceConfig.enabled ? [
      adapters.startVoiceCommand({ pg: input.pg, env }),
      adapters.startVoiceEvent({ pg: input.pg, env }),
      adapters.startVoiceReconciliation({ pg: input.pg, env })
    ] : [])
  ];
  let stopPromise: Promise<void> | null = null;

  return {
    stop() {
      if (!stopPromise) {
        stopPromise = (async () => {
          const errors: unknown[] = [];
          for (const worker of [...workers].reverse()) {
            try {
              await worker.stop();
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length) {
            const label = errors.length === 1 ? 'worker' : 'workers';
            throw new AggregateError(errors, `failed to stop ${errors.length} iveKit ${label}`);
          }
        })();
      }
      return stopPromise;
    }
  };
}

function createQualityReviewEnqueuer(
  pg: PgQueryable,
  env: NodeJS.ProcessEnv
): IveKitQualityReviewEnqueuer {
  const registry = createIntelligenceProviderRegistry(env);
  const enabled = registry.list().some((profile) => profile.capability === 'quality_review');
  return {
    enabled: enabled || env.OPC_QUALITY_REVIEW_AUTO_ENQUEUE === '1',
    enqueueMessage: (enqueueInput, transactionPg) => {
      const servicePg = transactionPg || pg;
      return new QualityReviewService({
        pg: servicePg,
        ...(enabled
          ? { resolveProvider: createPolicyQualityReviewProviderResolver({ pg: servicePg, registry }) }
          : { provider: null })
      }).enqueueMessage(enqueueInput);
    }
  };
}

function createTranslationEnqueuer(
  pg: PgQueryable,
  env: NodeJS.ProcessEnv
): IveKitTranslationEnqueuer {
  const registry = createIntelligenceProviderRegistry(env);
  const enabled = registry.list().some((profile) => profile.capability === 'translation');
  return {
    enabled,
    async enqueueSource(sourceInput, transactionPg) {
      if (!enabled) return [];
      const servicePg = transactionPg || pg;
      const details = await withPgTenant(servicePg, sourceInput.tenant_id, async (scopedPg) => {
        const policy = await new IntelligencePolicyStore(scopedPg, registry)
          .getEffectivePolicy(sourceInput.tenant_id);
        if (!policy.translation_enabled || !policy.auto_translation) return null;
        const store = new CollaborationStore(scopedPg);
        let text = '';
        if (sourceInput.source_type === 'message') {
          const message = await store.getMessage({
            tenant_id: sourceInput.tenant_id,
            message_id: sourceInput.source_ref_id
          });
          if (!message || message.session_id !== sourceInput.session_id || message.deleted_at) return null;
          text = message.body;
        } else {
          const attachment = await store.getAttachment({
            tenant_id: sourceInput.tenant_id,
            attachment_id: sourceInput.source_ref_id
          });
          if (!attachment || attachment.session_id !== sourceInput.session_id) return null;
          text = attachment.extracted_text || attachment.ocr_text || attachment.asr_text;
        }
        if (!String(text || '').trim()) return null;
        return {
          targets: policy.translation_target_languages,
          source_hash: createHash('sha256').update(String(text).trim()).digest('hex')
        };
      });
      if (!details) return [];
      const service = new TranslationService({
        pg: servicePg,
        resolveProvider: createPolicyTranslationProviderResolver({ pg: servicePg, registry })
      });
      return Promise.all(details.targets.map((target) => service.requestTranslation({
        ...sourceInput,
        target_language: target,
        idempotency_key: `auto-${createHash('sha256').update([
          sourceInput.tenant_id,
          sourceInput.source_type,
          sourceInput.source_ref_id,
          details.source_hash,
          target
        ].join('\u0000')).digest('hex')}`,
        automatic: true
      })));
    }
  };
}

function applicationPublisher(pg: PgQueryable, env: NodeJS.ProcessEnv): IveKitEventPublisher {
  const eventStore = iveKitEventReplayEnabled(env) ? new IveKitTenantEventStore(pg) : null;
  return async (tenantId, type, data) => {
    if (eventStore) await eventStore.append({ tenant_id: tenantId, type, data });
    wsBroadcast(tenantId, type, data);
  };
}
