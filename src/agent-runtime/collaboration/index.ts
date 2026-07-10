import { CollaborationStore } from './collaboration-store.js';
import { configuredChatGateway, LocalChatGateway, TinodeChatGateway } from './chat-gateway.js';
import { normalizeExternalRemoteTool } from './external-link-adapter.js';
import { scanTextPolicy } from './policy-scan.js';
import {
  createGuacamoleGatewayClient,
  createInMemoryRemoteGatewayClient,
  createMeshCentralGatewayClient,
  createRustDeskGatewayClient
} from './remote-gateway-client.js';
import { normalizeRemoteGatewaySession } from './remote-gateway-adapter.js';
import { RemoteAssistanceStore } from './remote-assistance-store.js';
import { RustDeskDeviceCommandStore } from './rustdesk-device-command-store.js';
import { RustDeskDeviceStore } from './rustdesk-device-store.js';
import { RustDeskPhysicalDisconnectService } from './rustdesk-physical-disconnect.js';
import type { PgQueryable } from '../../db-pg.js';

export interface CollaborationModuleInput {
  pg: PgQueryable;
}

export function createCollaborationModule(input: CollaborationModuleInput) {
  return {
    sessions: new CollaborationStore(input.pg),
    remote: new RemoteAssistanceStore(input.pg),
    rustdeskCommands: new RustDeskDeviceCommandStore(input.pg),
    rustdeskDevices: new RustDeskDeviceStore(input.pg),
    rustdeskPhysicalDisconnect: new RustDeskPhysicalDisconnectService(input.pg),
    policy: {
      scanTextPolicy
    },
    chatGateways: {
      configuredChatGateway,
      LocalChatGateway,
      TinodeChatGateway
    },
    externalLinks: {
      normalizeExternalRemoteTool
    },
    remoteGateways: {
      createGuacamoleGatewayClient,
      createInMemoryRemoteGatewayClient,
      createMeshCentralGatewayClient,
      createRustDeskGatewayClient,
      normalizeRemoteGatewaySession
    }
  };
}

export { CollaborationStore } from './collaboration-store.js';
export {
  configuredChatGateway,
  LocalChatGateway,
  TinodeChatGateway,
  tinodeTopicNameForSession
} from './chat-gateway.js';
export type * from './chat-gateway.js';
export {
  startTinodeSyncWorker,
  TinodeSyncWorker,
  tinodeSyncWorkerConfig
} from './tinode-sync-worker.js';
export type * from './tinode-sync-worker.js';
export { TinodeMessageDeliveryService } from './tinode-message-delivery.js';
export type * from './tinode-message-delivery.js';
export { normalizeExternalRemoteTool } from './external-link-adapter.js';
export { scanTextPolicy } from './policy-scan.js';
export {
  AttachmentProcessingService
} from './attachment-processing.js';
export type * from './attachment-processing.js';
export {
  AttachmentProcessingWorker,
  attachmentProcessingWorkerConfig,
  startAttachmentProcessingWorker
} from './attachment-processing-worker.js';
export type * from './attachment-processing-worker.js';
export {
  QualityReviewService,
  configuredQualityReviewProvider,
  createHttpQualityReviewProvider
} from './quality-review.js';
export type * from './quality-review.js';
export {
  QualityReviewWorker,
  qualityReviewWorkerConfig,
  startQualityReviewWorker
} from './quality-review-worker.js';
export type * from './quality-review-worker.js';
export { CollaborationMessageStateStore } from './message-state-store.js';
export type * from './message-state-store.js';
export { createHttpOcrProvider, configuredOcrProvider } from './ocr-provider.js';
export { createHttpAsrProvider, configuredAsrProvider } from './asr-provider.js';
export {
  createGuacamoleGatewayClient,
  createInMemoryRemoteGatewayClient,
  createMeshCentralGatewayClient,
  createRustDeskGatewayClient,
  GuacamoleGatewayClient,
  InMemoryRemoteGatewayClient,
  MeshCentralGatewayClient,
  RustDeskGatewayClient
} from './remote-gateway-client.js';
export { normalizeRemoteGatewaySession } from './remote-gateway-adapter.js';
export { RemoteAssistanceStore } from './remote-assistance-store.js';
export {
  rustDeskClientConfig,
  rustDeskPublicKey,
  rustDeskServerKeyFingerprint
} from './rustdesk-client-config.js';
export type * from './rustdesk-client-config.js';
export {
  rustDeskGatewayEventValidationError
} from './rustdesk-gateway-event.js';
export {
  isValidRustDeskLaunchToken,
  rustDeskLaunchHtml,
  rustDeskLaunchPlan,
  rustDeskLaunchUrl,
  rustDeskRuntimeMetadata
} from './rustdesk-launch-plan.js';
export type * from './rustdesk-launch-plan.js';
export { RustDeskDeviceStore } from './rustdesk-device-store.js';
export { RustDeskDeviceCommandStore } from './rustdesk-device-command-store.js';
export {
  createRustDeskEdgeCommandToken,
  verifyRustDeskEdgeCommandToken
} from './rustdesk-edge-auth.js';
export type {
  CreateRustDeskEdgeCommandTokenInput,
  RustDeskEdgeCommandIdentity
} from './rustdesk-edge-auth.js';
export type * from './rustdesk-device-command-store.js';
export { RustDeskPhysicalDisconnectService } from './rustdesk-physical-disconnect.js';
export type * from './rustdesk-physical-disconnect.js';
export type * from './types.js';
