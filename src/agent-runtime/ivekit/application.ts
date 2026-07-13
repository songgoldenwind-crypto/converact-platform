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
import { createPolicyQualityReviewProviderResolver } from '../collaboration/intelligence-provider-routing.js';

export interface IveKitWorkerHandle {
  stop(): Promise<void>;
}

export interface IveKitRuntimeAdapters {
  startTinode(input: Parameters<typeof startTinodeSyncWorker>[0]): IveKitWorkerHandle;
  startTinodeInbound(input: Parameters<typeof startTinodeInboundWorker>[0]): IveKitWorkerHandle;
  startAttachment(input: Parameters<typeof startAttachmentProcessingWorker>[0]): IveKitWorkerHandle;
  startQuality(input: Parameters<typeof startQualityReviewWorker>[0]): IveKitWorkerHandle;
  startMediaTimeout(input: Parameters<typeof startMediaCallTimeoutWorker>[0]): IveKitWorkerHandle;
  startEventRetention(input: Parameters<typeof startIveKitTenantEventRetentionWorker>[0]): IveKitWorkerHandle;
}

export interface IveKitApplicationInput {
  pg: PgQueryable;
  env?: NodeJS.ProcessEnv;
  publish?: IveKitEventPublisher;
  qualityReviewEnqueuer?: IveKitQualityReviewEnqueuer;
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

export function startIveKitApplication(input: IveKitApplicationInput): IveKitApplication {
  const env = input.env || process.env;
  const publish = input.publish || wsBroadcast;
  const qualityReviewEnqueuer = input.qualityReviewEnqueuer || createQualityReviewEnqueuer(input.pg, env);
  const adapters: IveKitRuntimeAdapters = {
    startTinode: input.adapters?.startTinode || startTinodeSyncWorker,
    startTinodeInbound: input.adapters?.startTinodeInbound || startTinodeInboundWorker,
    startAttachment: input.adapters?.startAttachment || startAttachmentProcessingWorker,
    startQuality: input.adapters?.startQuality || startQualityReviewWorker,
    startMediaTimeout: input.adapters?.startMediaTimeout || startMediaCallTimeoutWorker,
    startEventRetention: input.adapters?.startEventRetention || startIveKitTenantEventRetentionWorker
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
    adapters.startMediaTimeout({
      pg: input.pg,
      env,
      onTimedOut: (snapshot) => publish(
        snapshot.call.tenant_id,
        'ivekit.media.call.updated',
        snapshot
      )
    }),
    adapters.startEventRetention({ pg: input.pg, env })
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
