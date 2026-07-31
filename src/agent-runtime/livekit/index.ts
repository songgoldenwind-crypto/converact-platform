import { getMediaGatewayRegistry } from '../media-gateway/index.js';
import { dispatchAiAgent } from './agent-dispatch-service.js';
import { LiveKitParticipantStore } from './participant-store.js';
import { LiveKitRecordingService } from './recording-service.js';
import { LiveKitRoomStore } from './room-store.js';
import { issueLiveKitToken, issueSupervisorToken } from './token-service.js';
import { handleLiveKitWebhook } from './webhook-handler.js';
import type { LiveKitMediaModule, LiveKitMediaModuleInput } from './types.js';

function notFound(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 404 });
}

function conflict(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 409 });
}

export function createLiveKitMediaModule(input: LiveKitMediaModuleInput): LiveKitMediaModule {
  const rooms = new LiveKitRoomStore(input.db, input.config, {
    syncLegacyVoiceCallSession: false
  });
  const participants = new LiveKitParticipantStore(input.db);
  const gateways = input.gateways || getMediaGatewayRegistry();
  const recordings = new LiveKitRecordingService(input.db, {
    livekitUrl: input.config?.url || '',
    livekitApiKey: input.config?.apiKey || '',
    livekitApiSecret: input.config?.apiSecret || '',
    minioBucket: input.config?.minioBucket,
    recordingRetentionDays: input.config?.recordingRetentionDays
  }, input.recordingDependencies);

  function requireOpenRoom(roomName: string, tenantId?: string): void {
    const room = rooms.getRoomByName(roomName);
    if (!room || (tenantId && room.tenant_id !== tenantId)) {
      throw notFound('media room not found');
    }
    if (room.status === 'closed') {
      throw conflict('media room is closed');
    }
  }

  return {
    rooms,
    participants,
    tokens: {
      issueParticipantToken: async (tokenInput) => {
        requireOpenRoom(tokenInput.room_name, tokenInput.tenant_id);
        return issueLiveKitToken(tokenInput, input.config);
      },
      issueSupervisorToken: async (tokenInput) => {
        requireOpenRoom(tokenInput.room_name, tokenInput.tenant_id);
        return issueSupervisorToken(tokenInput, input.config);
      }
    },
    joins: {
      prepareJoin: async (channel, ctx) => {
        requireOpenRoom(ctx.roomName, ctx.tenantId);
        return gateways.prepareJoin(channel, ctx);
      }
    },
    recordings: {
      startRecording: async (tenantId, callSessionId, roomName, opts) => {
        requireOpenRoom(roomName, tenantId);
        return recordings.startRecording(tenantId, callSessionId, roomName, opts);
      },
      startCallRecording: (tenantId, callSessionId, roomName, opts) =>
        recordings.startRecording(tenantId, callSessionId, roomName, opts),
      stopRecording: (egressId) => recordings.stopRecording(egressId),
      getRecording: (recordingId) => recordings.getRecording(recordingId),
      getRecordingByEgressId: (egressId) => recordings.getRecordingByEgressId(egressId),
      listEgressJobs: (recordingId) => recordings.listEgressJobs(recordingId),
      getEgressJob: (recordingId, jobId) => recordings.getEgressJob(recordingId, jobId),
      getRecordingBySession: (callSessionId) => recordings.getRecordingBySession(callSessionId),
      setEvidenceRecordId: (recordingId, evidenceRecordId) => recordings.setEvidenceRecordId(recordingId, evidenceRecordId),
      listRecordings: (tenantId, opts) => recordings.listRecordings(tenantId, opts),
      listRecordingsPage: (tenantId, opts) => recordings.listRecordingsPage(tenantId, opts),
      inspectObject: (recordingId) => recordings.inspectObject(recordingId),
      exportObject: (recordingId) => recordings.exportObject(recordingId),
      inspectJobObject: (recordingId, jobId) => recordings.inspectJobObject(recordingId, jobId),
      exportJobObject: (recordingId, jobId) => recordings.exportJobObject(recordingId, jobId),
      listRetentionCandidates: (tenantId, opts) => recordings.listRetentionCandidates(tenantId, opts),
      cleanupExpiredRecordings: (tenantId, opts) => recordings.cleanupExpiredRecordings(tenantId, opts)
    },
    dispatch: {
      dispatchAiAgent: async (roomName, metadata, agentName) => {
        const tenantId = typeof metadata.tenant_id === 'string' ? metadata.tenant_id : undefined;
        requireOpenRoom(roomName, tenantId);
        return dispatchAiAgent(roomName, metadata, agentName, input.config);
      }
    },
    webhooks: {
      handleWebhook: (rawBody, authHeader) =>
        handleLiveKitWebhook(rawBody, authHeader, {
          roomStore: rooms,
          participantStore: participants,
          participantEvents: input.participantEvents,
          recordingEvents: input.recordingEvents,
          config: input.config
        })
    },
    gateways
  };
}

export { dispatchAiAgent } from './agent-dispatch-service.js';
export { readLiveKitConfig, isLiveKitConfigured } from './config.js';
export { LiveKitParticipantStore } from './participant-store.js';
export { MediaCallService } from './media-call-service.js';
export { MediaCallStore } from './media-call-store.js';
export {
  MediaQualityService,
  mediaQualityServiceOptionsFromEnv
} from './media-quality-service.js';
export type {
  MediaQualityServiceOptions,
  MediaQualityStorePort
} from './media-quality-service.js';
export { MediaQualityStore } from './media-quality-store.js';
export {
  mediaQualityMetricDefinitions,
  observeMediaConnectionEvent,
  observeMediaQualityReport,
  observeMediaQualityTransition
} from './media-quality-metrics.js';
export {
  createConfiguredLiveKitModerationProvider,
  LiveKitModerationService
} from './livekit-moderation-service.js';
export type {
  LiveKitModerationProvider,
  LiveKitModerationResult
} from './livekit-moderation-service.js';
export { LiveKitRecordingService } from './recording-service.js';
export type { EgressConfig } from './recording-service.js';
export {
  liveKitEgressReconciliationConfig,
  runLiveKitEgressReconciliationBatch,
  startLiveKitEgressReconciliationWorker
} from './egress-reconciliation-runtime.js';
export {
  liveKitEgressCapacityMetricsConfig,
  refreshLiveKitEgressCapacityMetrics,
  startLiveKitEgressCapacityMetricsWorker
} from './egress-capacity-metrics.js';
export { LiveKitRoomStore } from './room-store.js';
export {
  createLiveKitRoomClient,
  issueLiveKitToken,
  issueSupervisorToken,
  liveKitConfigForPlacement
} from './token-service.js';
export { createLiveKitWebhookReceiver, handleLiveKitWebhook } from './webhook-handler.js';
export type * from './types.js';
export type * from './token-service.js';
