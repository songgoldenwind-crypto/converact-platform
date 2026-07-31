import { createHash } from 'node:crypto';

import {
  startAttachmentProcessingWorker
} from '../collaboration/attachment-processing-worker.js';
import { startSecureFileScanWorker } from '../collaboration/secure-file-scan-worker.js';
import { startSecureFileDerivativeWorker } from '../collaboration/secure-file-derivative-worker.js';
import { startSecureFileCleanupWorker } from '../collaboration/secure-file-cleanup-worker.js';
import type { SecureFile } from '../collaboration/secure-file-types.js';
import {
  TinodeFileDeliveryGate,
  type TinodeFileDeliveryTransition
} from '../collaboration/tinode-file-delivery-gate.js';
import { observeTinodeFileGateTransition } from '../collaboration/tinode-metrics.js';
import {
  QualityReviewService
} from '../collaboration/quality-review.js';
import { startQualityReviewWorker } from '../collaboration/quality-review-worker.js';
import { startTinodeInboundWorker } from '../collaboration/tinode-inbound-worker.js';
import type {
  TinodeInboundProviderMutationProjection
} from '../collaboration/tinode-inbound-store.js';
import { startTinodeSyncWorker } from '../collaboration/tinode-sync-worker.js';
import { startMediaCallTimeoutWorker } from '../livekit/media-call-timeout-worker.js';
import { startLiveKitEgressReconciliationWorker } from '../livekit/egress-reconciliation-runtime.js';
import { startLiveKitEgressCapacityMetricsWorker } from '../livekit/egress-capacity-metrics.js';
import { startIveKitTenantEventRetentionWorker } from './tenant-event-retention-worker.js';
import { MemoryPg, type PgQueryable } from '../../db-pg.js';
import { wsBroadcast, wsBroadcastPersisted, wsBroadcastToUsers } from '../../ws.js';
import { syncIntelligenceSourceForAttachment } from '../collaboration/intelligence-source-service.js';
import {
  RustDeskEvidenceIntelligenceService,
  type RustDeskEvidenceIntelligenceResult
} from '../collaboration/rustdesk-evidence-intelligence.js';
import { createIntelligenceProviderRegistry } from '../collaboration/intelligence-provider-registry.js';
import {
  createPolicyAttachmentProviderResolver,
  createPolicyQualityReviewProviderResolver,
  createPolicyTranslationProviderResolver
} from '../collaboration/intelligence-provider-routing.js';
import type { IntelligenceProviderRouteEventHandler } from '../collaboration/intelligence-provider-route.js';
import { IntelligencePolicyStore } from '../collaboration/intelligence-policy-store.js';
import { CollaborationStore } from '../collaboration/collaboration-store.js';
import { TranslationService } from '../collaboration/translation-service.js';
import { startTranslationWorker } from '../collaboration/translation-worker.js';
import { withPgTenant } from '../../db-pg-tenant.js';
import {
  IveKitTenantEventJournal,
  IveKitTenantEventStore,
  iveKitEventReplayEnabled
} from './tenant-event-store.js';
import type { IvrPendingActionExecutor, IvrPendingActionReconciler } from './ivr/ports.js';
import {
  iveKitIvrWorkerConfig,
  startIveKitIvrPendingActionWorker,
  startIveKitIvrReconciliationWorker
} from './ivr/runtime.js';
import {
  iveKitVoiceWorkerConfig,
  startIveKitVoiceCommandWorker,
  startIveKitVoiceProviderEventWorker,
  startIveKitVoiceReconciliationWorker
} from './voice/runtime.js';
import { startWebPhoneSessionCleanupWorker } from './voice/webphone-session-service.js';
import { startContactCenterMaintenanceWorker } from './contact-center/maintenance-worker.js';
import {
  notificationDeliveryWorkerConfig,
  startNotificationDeliveryWorker
} from './notifications/runtime.js';
import {
  notificationHealthWorkerConfig,
  startNotificationHealthWorker
} from './notifications/health-worker.js';
import {
  integrationEventWebhookWorkerConfig,
  startIveKitEventWebhookWorker
} from './integration-events/worker.js';
import { startPostgresIveKitRetentionWorker } from './operations/retention/runtime.js';
import {
  iveKitRuntimeComponents,
  startIveKitRuntimeHeartbeat
} from './operations/runtime-heartbeat.js';
import {
  startInteractionPlacementWorker,
  type IveKitPlacementFoundation
} from './placement/index.js';
import {
  startIveKitWorkerBacklogMetrics,
  workerBacklogMetricsConfig
} from './operations/worker-backlog-metrics.js';
import { RealtimeSpeechProjection } from './voice/realtime-speech-projection.js';
import { RealtimeSpeechStore } from './voice/realtime-speech-store.js';

export interface IveKitWorkerHandle {
  stop(): Promise<void>;
}

export interface IveKitRuntimeAdapters {
  startTinode(input: Parameters<typeof startTinodeSyncWorker>[0]): IveKitWorkerHandle;
  startTinodeInbound(input: Parameters<typeof startTinodeInboundWorker>[0]): IveKitWorkerHandle;
  startFileScan(input: Parameters<typeof startSecureFileScanWorker>[0]): IveKitWorkerHandle;
  startFileDerivative(input: Parameters<typeof startSecureFileDerivativeWorker>[0]): IveKitWorkerHandle;
  startFileCleanup(input: Parameters<typeof startSecureFileCleanupWorker>[0]): IveKitWorkerHandle;
  startAttachment(input: Parameters<typeof startAttachmentProcessingWorker>[0]): IveKitWorkerHandle;
  startQuality(input: Parameters<typeof startQualityReviewWorker>[0]): IveKitWorkerHandle;
  startTranslation(input: Parameters<typeof startTranslationWorker>[0]): IveKitWorkerHandle;
  startMediaTimeout(input: Parameters<typeof startMediaCallTimeoutWorker>[0]): IveKitWorkerHandle;
  startEgressReconciliation(input: Parameters<typeof startLiveKitEgressReconciliationWorker>[0]): IveKitWorkerHandle;
  startEgressMetrics(input: Parameters<typeof startLiveKitEgressCapacityMetricsWorker>[0]): IveKitWorkerHandle;
  startPlacement(input: Parameters<typeof startInteractionPlacementWorker>[0]): IveKitWorkerHandle;
  startEventRetention(input: Parameters<typeof startIveKitTenantEventRetentionWorker>[0]): IveKitWorkerHandle;
  startContactCenter(input: Parameters<typeof startContactCenterMaintenanceWorker>[0]): IveKitWorkerHandle;
  startNotification(input: Parameters<typeof startNotificationDeliveryWorker>[0]): IveKitWorkerHandle;
  startNotificationHealth(input: Parameters<typeof startNotificationHealthWorker>[0]): IveKitWorkerHandle;
  startEventWebhook(input: Parameters<typeof startIveKitEventWebhookWorker>[0]): IveKitWorkerHandle;
  startRetention(input: Parameters<typeof startPostgresIveKitRetentionWorker>[0]): IveKitWorkerHandle;
  startRuntimeHeartbeat(input: Parameters<typeof startIveKitRuntimeHeartbeat>[0]): IveKitWorkerHandle;
  startWorkerBacklogMetrics(input: Parameters<typeof startIveKitWorkerBacklogMetrics>[0]): IveKitWorkerHandle;
  startIvrAction(input: Parameters<typeof startIveKitIvrPendingActionWorker>[0]): IveKitWorkerHandle;
  startIvrReconciliation(input: Parameters<typeof startIveKitIvrReconciliationWorker>[0]): IveKitWorkerHandle;
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
  ivr_executor?: IvrPendingActionExecutor;
  ivr_reconciler?: IvrPendingActionReconciler;
  adapters?: Partial<IveKitRuntimeAdapters>;
  instanceId?: string;
  placement?: Pick<
    IveKitPlacementFoundation,
    'coordinator' | 'media' | 'voice' | 'worker_id'
  >;
}

export interface IveKitApplication {
  realtimeSpeechProjection: RealtimeSpeechProjection;
  stop(): Promise<void>;
}

export type IveKitEventPublisher = (
  tenantId: string,
  type: string,
  data: unknown,
  options?: { idempotency_key?: string }
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

export function createIveKitRealtimeSpeechProjection(
  pg: PgQueryable,
  env: NodeJS.ProcessEnv = process.env,
  publish: IveKitEventPublisher = applicationPublisher(pg, env)
): RealtimeSpeechProjection {
  return new RealtimeSpeechProjection({
    store: new RealtimeSpeechStore(pg),
    broadcastEphemeral: (event) => wsBroadcastToUsers(
      event.tenant_id,
      event.audience_user_ids,
      event.type,
      event.data
    ),
    publishFinal: (event) => publish(event.tenant_id, event.type, event.data, {
      idempotency_key: `realtime-speech-final:${event.data.projection_id}`
    })
  });
}

export function startIveKitApplication(input: IveKitApplicationInput): IveKitApplication {
  const env = input.env || process.env;
  const voiceConfig = iveKitVoiceWorkerConfig(env);
  const ivrConfig = iveKitIvrWorkerConfig(env);
  const notificationConfig = notificationDeliveryWorkerConfig(env);
  const notificationHealthConfig = notificationHealthWorkerConfig(env);
  const eventWebhookConfig = integrationEventWebhookWorkerConfig(env);
  const backlogMetricsConfig = workerBacklogMetricsConfig(env);
  if (ivrConfig.enabled && !input.ivr_executor) {
    throw new Error('enabled iveKit IVR pending-action executor must be injected');
  }
  if (ivrConfig.enabled && !input.ivr_reconciler) {
    throw new Error('enabled iveKit IVR pending-action reconciler must be injected');
  }
  const publish = input.publish || applicationPublisher(input.pg, env);
  const realtimeSpeechProjection = createIveKitRealtimeSpeechProjection(
    input.pg,
    env,
    publish
  );
  const replayEnabled = iveKitEventReplayEnabled(env);
  const providerEventJournal = new IveKitTenantEventJournal(input.pg, { env });
  const providerReplayStore = !input.publish && replayEnabled
    ? new IveKitTenantEventStore(input.pg, { env })
    : null;
  const publishProviderRealtime = input.publish || publish;
  const providerEvent: IntelligenceProviderRouteEventHandler = async (event) => {
    if (providerReplayStore) {
      const persisted = await providerReplayStore.append({
        tenant_id: event.tenant_id,
        type: event.type,
        data: event.data
      });
      try {
        await wsBroadcastPersisted(persisted);
      } catch {
        // Persistence succeeded; realtime delivery can recover through replay.
      }
      return;
    }
    await providerEventJournal.append({
      tenant_id: event.tenant_id,
      type: event.type,
      data: event.data
    });
    try {
      await publishProviderRealtime(event.tenant_id, event.type, event.data);
    } catch {
      // The durable journal is authoritative; realtime delivery can recover through replay.
    }
  };
  const qualityReviewEnqueuer = input.qualityReviewEnqueuer || createQualityReviewEnqueuer(
    input.pg, env, providerEvent
  );
  const translationEnqueuer = input.translationEnqueuer || createTranslationEnqueuer(
    input.pg, env, providerEvent
  );
  const intelligenceRegistry = createIntelligenceProviderRegistry(env);
  const rustDeskEvidenceIntelligence = new RustDeskEvidenceIntelligenceService({
    pg: input.pg,
    resolveProvider: createPolicyAttachmentProviderResolver({
      pg: input.pg,
      registry: intelligenceRegistry,
      onEvent: providerEvent
    })
  });
  const publishRustDeskEvidenceIntelligence = async (
    file: SecureFile,
    intelligence: RustDeskEvidenceIntelligenceResult
  ): Promise<void> => {
    const rustDeskEvent = rustDeskEvidenceFileEventData(file);
    if (!rustDeskEvent || intelligence.status !== 'enqueued') return;
    await publish(file.tenant_id, 'remote.rustdesk.evidence.intelligence_enqueued', {
      ...rustDeskEvent,
      message_id: intelligence.message?.id || '',
      attachment_id: intelligence.attachment?.id || '',
      processors: intelligence.jobs.map((job) => ({
        processor: job.processor,
        status: job.status,
        provider_profile_id: job.provider_profile_id,
        error_code: job.error_code
      })),
      replayed: intelligence.replayed
    });
  };
  const publishFileDeliveryTransition = (transition: TinodeFileDeliveryTransition) => publish(
    transition.tenant_id,
    transition.status === 'pending'
      ? 'collaboration.message.delivery_unblocked'
      : transition.status === 'blocked'
        ? 'collaboration.message.delivery_blocked'
        : 'collaboration.message.delivery_blocked_by_file_security',
    transition
  );
  const tinodeFileGate = input.pg instanceof MemoryPg
    ? null
    : new TinodeFileDeliveryGate({
      pg: input.pg,
      onTransition: async (transition) => {
        observeTinodeFileGateTransition(transition);
        await publishFileDeliveryTransition(transition);
      }
    });
  const adapters: IveKitRuntimeAdapters = {
    startTinode: input.adapters?.startTinode || startTinodeSyncWorker,
    startTinodeInbound: input.adapters?.startTinodeInbound || startTinodeInboundWorker,
    startFileScan: input.adapters?.startFileScan || startSecureFileScanWorker,
    startFileDerivative: input.adapters?.startFileDerivative || startSecureFileDerivativeWorker,
    startFileCleanup: input.adapters?.startFileCleanup || startSecureFileCleanupWorker,
    startAttachment: input.adapters?.startAttachment || startAttachmentProcessingWorker,
    startQuality: input.adapters?.startQuality || startQualityReviewWorker,
    startTranslation: input.adapters?.startTranslation || startTranslationWorker,
    startMediaTimeout: input.adapters?.startMediaTimeout || startMediaCallTimeoutWorker,
    startEgressReconciliation: input.adapters?.startEgressReconciliation || startLiveKitEgressReconciliationWorker,
    startEgressMetrics: input.adapters?.startEgressMetrics || startLiveKitEgressCapacityMetricsWorker,
    startPlacement: input.adapters?.startPlacement || startInteractionPlacementWorker,
    startEventRetention: input.adapters?.startEventRetention || startIveKitTenantEventRetentionWorker,
    startContactCenter: input.adapters?.startContactCenter || startContactCenterMaintenanceWorker,
    startNotification: input.adapters?.startNotification || startNotificationDeliveryWorker,
    startNotificationHealth: input.adapters?.startNotificationHealth || startNotificationHealthWorker,
    startEventWebhook: input.adapters?.startEventWebhook || startIveKitEventWebhookWorker,
    startRetention: input.adapters?.startRetention || startPostgresIveKitRetentionWorker,
    startRuntimeHeartbeat: input.adapters?.startRuntimeHeartbeat || startIveKitRuntimeHeartbeat,
    startWorkerBacklogMetrics: input.adapters?.startWorkerBacklogMetrics || startIveKitWorkerBacklogMetrics,
    startIvrAction: input.adapters?.startIvrAction || startIveKitIvrPendingActionWorker,
    startIvrReconciliation: input.adapters?.startIvrReconciliation || startIveKitIvrReconciliationWorker,
    startVoiceCommand: input.adapters?.startVoiceCommand || startIveKitVoiceCommandWorker,
    startVoiceEvent: input.adapters?.startVoiceEvent || startIveKitVoiceProviderEventWorker,
    startVoiceReconciliation: input.adapters?.startVoiceReconciliation || startIveKitVoiceReconciliationWorker
  };
  const workers: IveKitWorkerHandle[] = [
    adapters.startRuntimeHeartbeat({
      pg: input.pg,
      env,
      instance_id: input.instanceId || env.OPC_IVEKIT_INSTANCE_ID || env.HOSTNAME || `ivekit-${process.pid}`,
      components: iveKitRuntimeComponents(env)
    }),
    ...(backlogMetricsConfig.enabled ? [
      adapters.startWorkerBacklogMetrics({ pg: input.pg, env })
    ] : []),
    adapters.startTinode({
      pg: input.pg,
      env,
      fileSecurityGate: tinodeFileGate,
      onDeliveryUpdated: (message) => publish(
        message.tenant_id,
        'collaboration.message.delivery_updated',
        {
          session_id: message.session_id,
          message_id: message.id,
          delivery: message.provider_delivery
        }
      ),
      onMutationUpdated: (mutation, status) => publish(
        mutation.tenant_id,
        'collaboration.message.provider_mutation_updated',
        {
          session_id: mutation.session_id,
          message_id: mutation.message_id,
          mutation_id: mutation.mutation_id,
          mutation_version: mutation.mutation_version,
          action: mutation.action,
          provider: 'tinode',
          status
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
        if (projection.provider_mutation) {
          const correction = tinodeMutationCorrectionEvent(
            claim.session_id,
            projection.provider_mutation
          );
          await new IveKitTenantEventJournal(pg, { env }).append({
            tenant_id: claim.tenant_id,
            type: correction.type,
            data: correction.data,
            idempotency_key: correction.idempotency_key
          });
        }
      },
      onProcessed: async ({ claim, event, result }) => {
        if (result.provider_mutation) {
          const correction = tinodeMutationCorrectionEvent(
            claim.session_id,
            result.provider_mutation
          );
          await publish(
            claim.tenant_id,
            correction.type,
            correction.data,
            { idempotency_key: correction.idempotency_key }
          );
        }
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
    adapters.startFileScan({
      pg: input.pg,
      env,
      onProcessed: async (file) => {
        await tinodeFileGate?.reconcileFile({
          tenant_id: file.tenant_id,
          secure_file_id: file.id
        });
        await publish(
          file.tenant_id,
          'collaboration.file.security_updated',
          fileSecurityEventData(file)
        );
        const rustDeskEvent = rustDeskEvidenceFileEventData(file);
        if (rustDeskEvent) {
          await publish(file.tenant_id, 'remote.rustdesk.evidence.security_updated', rustDeskEvent);
        }
      }
    }),
    adapters.startFileDerivative({
      pg: input.pg,
      env,
      onProcessed: async ({ derivative, file }) => {
        await publish(file.tenant_id, 'collaboration.file.derivative_updated', {
          session_id: derivative.session_id,
          secure_file_id: derivative.secure_file_id,
          derivative_kind: derivative.derivative_kind,
          status: derivative.status,
          mime: derivative.mime,
          size_bytes: derivative.size_bytes,
          attempt_count: derivative.attempt_count,
          error_code: derivative.error_code,
          provider_profile_id: derivative.provider_profile_id,
          parent_status: file.status
        });
        const rustDeskEvent = rustDeskEvidenceFileEventData(file);
        if (rustDeskEvent) {
          await publish(file.tenant_id, 'remote.rustdesk.evidence.derivative_updated', {
            ...rustDeskEvent,
            derivative_kind: derivative.derivative_kind,
            derivative_status: derivative.status,
            derivative_mime: derivative.mime,
            derivative_size_bytes: derivative.size_bytes,
            attempt_count: derivative.attempt_count,
            error_code: derivative.error_code,
            provider_profile_id: derivative.provider_profile_id
          });
        }
      },
      onFileConverged: async (file) => {
        await tinodeFileGate?.reconcileFile({
          tenant_id: file.tenant_id,
          secure_file_id: file.id
        });
        await publish(
          file.tenant_id,
          'collaboration.file.security_updated',
          fileSecurityEventData(file)
        );
        const rustDeskEvent = rustDeskEvidenceFileEventData(file);
        if (!rustDeskEvent) return;
        await publish(file.tenant_id, 'remote.rustdesk.evidence.security_updated', rustDeskEvent);
        const intelligence = await rustDeskEvidenceIntelligence.enqueueFile(file);
        await publishRustDeskEvidenceIntelligence(file, intelligence);
      },
      afterBatch: async () => {
        await rustDeskEvidenceIntelligence.reconcileDue({
          limit: 100,
          onEnqueued: publishRustDeskEvidenceIntelligence,
          onError: async (file) => {
            const rustDeskEvent = rustDeskEvidenceFileEventData(file);
            if (!rustDeskEvent) return;
            await publish(file.tenant_id, 'remote.rustdesk.evidence.intelligence_updated', {
              ...rustDeskEvent,
              processing_status: 'retry_wait',
              error_code: 'intelligence_enqueue_failed'
            });
          }
        });
      }
    }),
    adapters.startFileCleanup({
      pg: input.pg,
      env,
      onProcessed: ({ file, outcome, error_code }) => publish(
        file.tenant_id,
        'collaboration.file.cleanup_updated',
        {
          session_id: file.session_id,
          secure_file_id: file.id,
          status: file.status,
          outcome,
          error_code
        }
      )
    }),
    adapters.startAttachment({
      pg: input.pg,
      env,
      onProviderEvent: providerEvent,
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
        const rustDeskEvent = rustDeskEvidenceAttachmentEventData(attachment.metadata);
        if (rustDeskEvent) {
          await publish(attachment.tenant_id, 'remote.rustdesk.evidence.intelligence_updated', {
            ...rustDeskEvent,
            secure_file_id: attachment.secure_file_id,
            message_id: attachment.message_id,
            attachment_id: attachment.id,
            processor: job.processor,
            processing_status: attachment.processing_status,
            job_status: job.status,
            provider_profile_id: job.provider_profile_id,
            error_code: job.error_code,
            policy_matched: policy.matched,
            policy_finding_count: policy.findings.length
          });
        }
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
      onProviderEvent: providerEvent,
      onCompleted: async ({ job, findings }) => {
        await publish(job.tenant_id, 'collaboration.quality_review.completed', {
          session_id: job.session_id,
          message_id: job.message_id,
          job,
          findings
        });
        const message = await new CollaborationStore(input.pg).getMessage({
          tenant_id: job.tenant_id,
          message_id: job.message_id
        });
        const rustDeskEvent = rustDeskEvidenceAttachmentEventData(message?.metadata);
        if (rustDeskEvent) {
          await publish(job.tenant_id, 'remote.rustdesk.evidence.quality_updated', {
            ...rustDeskEvent,
            message_id: job.message_id,
            quality_job_id: job.id,
            status: job.status,
            provider_profile_id: job.provider_profile_id,
            error_code: job.error_code,
            finding_count: findings.length
          });
        }
      }
    }),
    adapters.startTranslation({
      pg: input.pg,
      env,
      onProviderEvent: providerEvent,
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
      placement: input.placement?.media,
      placementWorkerId: input.placement?.worker_id,
      onTimedOut: (snapshot) => publish(
        snapshot.call.tenant_id,
        'ivekit.media.call.updated',
        snapshot
      )
    }),
    adapters.startEgressReconciliation({
      pg: input.pg,
      env,
      worker_id: input.instanceId || env.OPC_IVEKIT_INSTANCE_ID || env.HOSTNAME || `ivekit-${process.pid}`
    }),
    adapters.startEgressMetrics({ pg: input.pg, env }),
    ...(input.placement ? [
      adapters.startPlacement({
        coordinator: input.placement.coordinator,
        worker_id: input.placement.worker_id,
        env
      })
    ] : []),
    adapters.startEventRetention({ pg: input.pg, env }),
    adapters.startRetention({ pg: input.pg, env }),
    startWebPhoneSessionCleanupWorker({ pg: input.pg, env }),
    adapters.startContactCenter({ pg: input.pg, env }),
    ...(notificationConfig.enabled ? [
      adapters.startNotification({ pg: input.pg, env })
    ] : []),
    ...(eventWebhookConfig.enabled ? [
      adapters.startEventWebhook({ pg: input.pg, env })
    ] : []),
    ...(notificationHealthConfig.enabled ? [
      adapters.startNotificationHealth({ pg: input.pg, env })
    ] : []),
    ...(ivrConfig.enabled ? [
      adapters.startIvrAction({
        pg: input.pg, env, executor: input.ivr_executor, publish
      }),
      adapters.startIvrReconciliation({
        pg: input.pg, env, reconciler: input.ivr_reconciler, publish
      })
    ] : []),
    ...(voiceConfig.enabled ? [
      adapters.startVoiceCommand({
        pg: input.pg,
        env,
        placement: input.placement?.voice,
        media_placement: input.placement?.media,
        placement_worker_id: input.placement?.worker_id
      }),
      adapters.startVoiceEvent({
        pg: input.pg,
        env,
        placement: input.placement?.voice,
        placement_worker_id: input.placement?.worker_id
      }),
      adapters.startVoiceReconciliation({ pg: input.pg, env })
    ] : [])
  ];
  let stopPromise: Promise<void> | null = null;

  return {
    realtimeSpeechProjection,
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
  env: NodeJS.ProcessEnv,
  onProviderEvent: IntelligenceProviderRouteEventHandler
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
          ? { resolveProvider: createPolicyQualityReviewProviderResolver({
            pg: servicePg, registry, onEvent: onProviderEvent
          }) }
          : { provider: null })
      }).enqueueMessage(enqueueInput);
    }
  };
}

function createTranslationEnqueuer(
  pg: PgQueryable,
  env: NodeJS.ProcessEnv,
  onProviderEvent: IntelligenceProviderRouteEventHandler
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
        resolveProvider: createPolicyTranslationProviderResolver({
          pg: servicePg, registry, onEvent: onProviderEvent
        })
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
  const eventStore = iveKitEventReplayEnabled(env) ? new IveKitTenantEventStore(pg, { env }) : null;
  return async (tenantId, type, data, options) => {
    if (eventStore) {
      const event = await eventStore.append({
        tenant_id: tenantId,
        type,
        data,
        idempotency_key: options?.idempotency_key
      });
      await wsBroadcastPersisted(event);
      return;
    }
    await wsBroadcast(tenantId, type, data);
  };
}

function tinodeMutationCorrectionEvent(
  sessionId: string,
  mutation: TinodeInboundProviderMutationProjection
): {
  type: 'collaboration.message.provider_mutation_updated';
  data: Record<string, unknown>;
  idempotency_key: string;
} {
  return {
    type: 'collaboration.message.provider_mutation_updated',
    data: {
      session_id: sessionId,
      message_id: mutation.message_id,
      mutation_id: mutation.mutation_id,
      mutation_version: mutation.mutation_version,
      action: mutation.action,
      provider: 'tinode',
      status: mutation.status,
      reconciled_from_status: mutation.previous_status
    },
    idempotency_key: `tinode-mutation-correction:${createHash('sha256').update([
      sessionId,
      mutation.mutation_id,
      String(mutation.mutation_version),
      mutation.status
    ].join('\u0000')).digest('hex')}`
  };
}

function fileSecurityEventData(file: SecureFile): Record<string, unknown> {
  return {
    session_id: file.session_id,
    secure_file_id: file.id,
    status: file.status,
    threat_status: file.threat_status,
    detected_mime: file.detected_mime,
    mime_conflict: file.mime_conflict,
    failure_code: file.failure_code,
    scan_attempt_count: file.scan_attempt_count,
    scanner_name: file.scanner_name,
    scanner_mode: file.scanner_mode
  };
}

function rustDeskEvidenceFileEventData(file: SecureFile): Record<string, unknown> | null {
  if (file.metadata?.source !== 'rustdesk_companion_evidence') return null;
  return {
    session_id: file.session_id,
    secure_file_id: file.id,
    evidence_kind: file.kind,
    status: file.status,
    threat_status: file.threat_status,
    detected_mime: file.detected_mime,
    failure_code: file.failure_code,
    ...rustDeskEvidenceAttachmentEventData(file.metadata)
  };
}

function rustDeskEvidenceAttachmentEventData(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | null {
  if (!metadata || (
    metadata.source !== 'rustdesk_companion_evidence' &&
    metadata.source !== 'rustdesk_secure_evidence'
  )) return null;
  return {
    native_event_id: String(metadata.native_event_id || ''),
    gateway_external_id: String(metadata.gateway_external_id || ''),
    operation_id: String(metadata.operation_id || ''),
    authorization_scope: String(metadata.authorization_scope || ''),
    authorization_id: String(metadata.authorization_id || ''),
    observed_at: String(metadata.observed_at || ''),
    ...(metadata.direction ? { direction: String(metadata.direction) } : {}),
    ...(metadata.control_version === undefined
      ? {}
      : { control_version: Number(metadata.control_version) })
  };
}
