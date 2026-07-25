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
import { RustDeskAccessPolicyStore } from './rustdesk-access-policy-store.js';
import { RustDeskAuthorizationCodeStore } from './rustdesk-authorization-code-store.js';
import { RustDeskControlLockStore } from './rustdesk-control-lock-store.js';
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
    rustdeskAccessPolicies: new RustDeskAccessPolicyStore(input.pg),
    rustdeskAuthorizationCodes: new RustDeskAuthorizationCodeStore(input.pg),
    rustdeskControlLocks: new RustDeskControlLockStore(input.pg),
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
export {
  TinodeMessageMutationService,
  TinodeMessageMutationStore
} from './tinode-message-mutation.js';
export type * from './tinode-message-mutation.js';
export { TinodeFileDeliveryGate } from './tinode-file-delivery-gate.js';
export type * from './tinode-file-delivery-gate.js';
export { TinodeOperationsService } from './tinode-operations.js';
export type * from './tinode-operations.js';
export {
  SecureTinodeInboundAttachmentImporter,
  TinodeInboundAttachmentImportError
} from './tinode-inbound-attachment-import.js';
export type * from './tinode-inbound-attachment-import.js';
export type * from './tinode-message-delivery.js';
export { TinodeProviderUserStore } from './tinode-provider-user-store.js';
export type * from './tinode-provider-user-store.js';
export {
  TinodeInboundProjectionError,
  TinodeInboundStore
} from './tinode-inbound-store.js';
export type * from './tinode-inbound-store.js';
export { TinodeInboundProjector } from './tinode-inbound-projector.js';
export {
  configuredTinodeInboundSource,
  TinodeInboundWireSource
} from './tinode-inbound-source.js';
export type * from './tinode-inbound-source.js';
export {
  startTinodeInboundWorker,
  TinodeInboundService,
  TinodeInboundWorker,
  tinodeInboundWorkerConfig
} from './tinode-inbound-worker.js';
export type * from './tinode-inbound-worker.js';
export { normalizeExternalRemoteTool } from './external-link-adapter.js';
export { scanTextPolicy } from './policy-scan.js';
export { SessionPolicyAggregation } from './session-policy-aggregation.js';
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
export { SecureFileStore, assertSecureFileStatusTransition } from './secure-file-store.js';
export type * from './secure-file-types.js';
export { SecureFileService } from './secure-file-service.js';
export type * from './secure-file-service.js';
export { detectSecureFileMime } from './secure-file-mime.js';
export type * from './secure-file-mime.js';
export {
  ControlledFileThreatScanner,
  FileThreatScannerError,
  createClamdFileThreatScanner,
  createHttpFileThreatScanner,
  encodeClamdInstream
} from './file-threat-scanner.js';
export type * from './file-threat-scanner.js';
export { SecureFileScanService } from './secure-file-scan-service.js';
export type * from './secure-file-scan-service.js';
export {
  configuredFileThreatScanner,
  SecureFileScanWorker,
  secureFileScanWorkerConfig,
  startSecureFileScanWorker
} from './secure-file-scan-worker.js';
export type * from './secure-file-scan-worker.js';
export {
  FileDerivativeProviderError,
  createHttpFileDerivativeProvider,
  createLocalFfmpegDerivativeProvider,
  ffmpegDerivativeSpec
} from './file-derivative-provider.js';
export type * from './file-derivative-provider.js';
export { SecureFileDerivativeStore, requiredDerivativeKinds } from './secure-file-derivative-store.js';
export type * from './secure-file-derivative-store.js';
export { SecureFileDerivativeService } from './secure-file-derivative-service.js';
export type * from './secure-file-derivative-service.js';
export {
  SecureFileDerivativeWorker,
  configuredFileDerivativeProvider,
  secureFileDerivativeWorkerConfig,
  startSecureFileDerivativeWorker
} from './secure-file-derivative-worker.js';
export type * from './secure-file-derivative-worker.js';
export { SecureFileCleanupService } from './secure-file-cleanup-service.js';
export type * from './secure-file-cleanup-service.js';
export {
  SecureFileCleanupWorker,
  secureFileCleanupWorkerConfig,
  startSecureFileCleanupWorker
} from './secure-file-cleanup-worker.js';
export type * from './secure-file-cleanup-worker.js';
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
export { createIntelligenceProviderRegistry } from './intelligence-provider-registry.js';
export type * from './intelligence-provider-registry.js';
export { IntelligencePolicyStore } from './intelligence-policy-store.js';
export type * from './intelligence-policy-store.js';
export { IntelligenceProviderHealthService } from './intelligence-provider-health.js';
export type * from './intelligence-provider-health.js';
export { IntelligenceProviderGovernanceStore } from './intelligence-provider-governance-store.js';
export type * from './intelligence-provider-governance-store.js';
export {
  createPolicyAttachmentProviderResolver,
  createPolicyQualityReviewProviderResolver,
  createPolicyTranslationProviderResolver
} from './intelligence-provider-routing.js';
export type * from './intelligence-provider-routing.js';
export {
  createPolicyModelGatewayProviderResolver,
  createPolicyTtsProviderResolver
} from './generic-provider-routing.js';
export type * from './generic-provider-routing.js';
export {
  executeIntelligenceProviderRoute,
  IntelligenceProviderRouteError
} from './intelligence-provider-route.js';
export type * from './intelligence-provider-route.js';
export {
  intelligenceProviderMetricDefinitions
} from './intelligence-provider-metrics.js';
export { IntelligenceSourceService } from './intelligence-source-service.js';
export type * from './intelligence-source-service.js';
export { RustDeskEvidenceIntelligenceService } from './rustdesk-evidence-intelligence.js';
export type * from './rustdesk-evidence-intelligence.js';
export {
  sanitizeProviderErrorCode,
  sanitizeProviderMetadata,
  sanitizeProviderRequestId
} from './provider-safety.js';
export type * from './provider-safety.js';
export { createHttpTtsProvider, TtsProviderError } from './tts-provider.js';
export type * from './tts-provider.js';
export {
  createHttpModelGatewayProvider,
  ModelGatewayProviderError
} from './model-gateway-provider.js';
export type * from './model-gateway-provider.js';
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
export { RustDeskAccessPolicyStore } from './rustdesk-access-policy-store.js';
export {
  RustDeskAuthorizationCodeStore,
  rustDeskRequireAuthorizationCode
} from './rustdesk-authorization-code-store.js';
export type * from './rustdesk-authorization-code-store.js';
export { RustDeskControlLockStore } from './rustdesk-control-lock-store.js';
export type * from './rustdesk-control-lock-store.js';
export type * from './rustdesk-access-policy-store.js';
export { RustDeskDeviceCommandStore } from './rustdesk-device-command-store.js';
export {
  createRustDeskEdgeCommandToken,
  verifyRustDeskEdgeCommandToken
} from './rustdesk-edge-auth.js';
export { normalizeRustDeskOperationObservation } from './rustdesk-operation-observation.js';
export type * from './rustdesk-operation-observation.js';
export type {
  CreateRustDeskEdgeCommandTokenInput,
  RustDeskEdgeCommandIdentity
} from './rustdesk-edge-auth.js';
export type * from './rustdesk-device-command-store.js';
export { RustDeskPhysicalDisconnectService } from './rustdesk-physical-disconnect.js';
export type * from './rustdesk-physical-disconnect.js';
export type * from './types.js';
