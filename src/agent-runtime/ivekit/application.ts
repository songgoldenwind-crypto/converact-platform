import {
  startAttachmentProcessingWorker
} from '../collaboration/attachment-processing-worker.js';
import {
  configuredQualityReviewProvider,
  QualityReviewService
} from '../collaboration/quality-review.js';
import { startQualityReviewWorker } from '../collaboration/quality-review-worker.js';
import { startTinodeSyncWorker } from '../collaboration/tinode-sync-worker.js';
import type { PgQueryable } from '../../db-pg.js';
import { wsBroadcast } from '../../ws.js';

export interface IveKitWorkerHandle {
  stop(): Promise<void>;
}

export interface IveKitRuntimeAdapters {
  startTinode(input: Parameters<typeof startTinodeSyncWorker>[0]): IveKitWorkerHandle;
  startAttachment(input: Parameters<typeof startAttachmentProcessingWorker>[0]): IveKitWorkerHandle;
  startQuality(input: Parameters<typeof startQualityReviewWorker>[0]): IveKitWorkerHandle;
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
  enqueueMessage(input: { tenant_id: string; message_id: string }): Promise<unknown>;
}

export function startIveKitApplication(input: IveKitApplicationInput): IveKitApplication {
  const env = input.env || process.env;
  const publish = input.publish || wsBroadcast;
  const qualityReviewEnqueuer = input.qualityReviewEnqueuer || createQualityReviewEnqueuer(input.pg, env);
  const adapters: IveKitRuntimeAdapters = {
    startTinode: input.adapters?.startTinode || startTinodeSyncWorker,
    startAttachment: input.adapters?.startAttachment || startAttachmentProcessingWorker,
    startQuality: input.adapters?.startQuality || startQualityReviewWorker
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
    adapters.startAttachment({
      pg: input.pg,
      env,
      onProcessed: async ({ attachment, job, policy }) => {
        await publish(attachment.tenant_id, 'collaboration.attachment.processed', {
          session_id: attachment.session_id,
          message_id: attachment.message_id,
          attachment,
          job,
          policy
        });
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
    })
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
  const provider = configuredQualityReviewProvider(env);
  const service = new QualityReviewService({ pg, provider });
  return {
    enabled: Boolean(provider || env.OPC_QUALITY_REVIEW_AUTO_ENQUEUE === '1'),
    enqueueMessage: (enqueueInput) => service.enqueueMessage(enqueueInput)
  };
}
