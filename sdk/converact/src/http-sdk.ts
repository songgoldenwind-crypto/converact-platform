import type {
  ConveractFabricChatAttachmentResult,
  ConveractFabricChatAttachmentUploadDescriptor,
  ConveractFabricChatBinding,
  ConveractFabricChatCapabilities,
  ConveractFabricChatClientPlan,
  ConveractFabricChatClientPlanInput,
  ConveractFabricChatDeleteInput,
  ConveractFabricChatDeliveryResult,
  ConveractFabricChatEditInput,
  ConveractFabricChatMessage,
  ConveractFabricChatMessageInput,
  ConveractFabricChatMessagePageInput,
  ConveractFabricChatMessageState,
  ConveractFabricChatMutationListResult,
  ConveractFabricChatMutationResult,
  ConveractFabricChatParticipant,
  ConveractFabricChatParticipantInput,
  ConveractFabricChatPostMessageResult,
  ConveractFabricChatPresenceInput,
  ConveractFabricChatReceiptInput,
  ConveractFabricChatReceiptListResult,
  ConveractFabricChatReceiptResult,
  ConveractFabricChatRealtimeResult,
  ConveractFabricChatReactionResult,
  ConveractFabricChatSession,
  ConveractFabricChatSessionListInput,
  ConveractFabricChatSnapshot,
  ConveractFabricChatPinResult,
  ConveractFabricChatTypingInput,
  ConveractFabricCreateSecureFileInput,
  ConveractFabricOpenChatSessionInput,
  ConveractFabricCursorPage,
  ConveractFabricPolicyFindingListResult,
  ConveractFabricPolicyFindingResult,
  ConveractFabricPolicyFindingReviewInput,
  ConveractFabricQualityReviewResult,
  ConveractFabricSecureFile,
  ConveractFabricSecureFilePart,
  ConveractFabricTinodeDeadLetter,
  ConveractFabricTinodeDeadLetterReplayResult,
  ConveractFabricTinodeMutationDeadLetter,
  ConveractFabricTinodeMutationDeadLetterReplayResult,
  ConveractFabricTinodeOperationsSnapshot,
  ConveractFabricWorkerRunResult
} from './chat-types.js';
import type {
  ConveractFabricCreateMediaCallInput,
  ConveractFabricCreateMediaIngressInput,
  ConveractFabricCreateMediaIngressResult,
  ConveractFabricCreateMediaRoomInput,
  ConveractFabricMediaConnectionEventInput,
  ConveractFabricMediaConnectionEventResult,
  ConveractFabricMediaCallActionInput,
  ConveractFabricMediaCallParticipantListResult,
  ConveractFabricMediaCallSnapshot,
  ConveractFabricMediaCapabilities,
  ConveractFabricMediaJoinInput,
  ConveractFabricMediaJoinPlan,
  ConveractFabricMediaIngress,
  ConveractFabricMediaModerationResult,
  ConveractFabricMediaModerationRecoveryResult,
  ConveractFabricMediaMuteInput,
  ConveractFabricMediaProviderParticipant,
  ConveractFabricMediaQualityReportResult,
  ConveractFabricMediaQualitySnapshotInput,
  ConveractFabricMediaQualitySummary,
  ConveractFabricMediaRecording,
  ConveractFabricMediaEgressJob,
  ConveractFabricMediaRecordingListInput,
  ConveractFabricMediaRecordingPage,
  ConveractFabricMediaRecordingObjectInspection,
  ConveractFabricMediaRecordingRetentionInput,
  ConveractFabricMediaRecordingRetentionResult,
  ConveractFabricRealtimeSpeechSegmentPage,
  ConveractFabricMediaRoom,
  ConveractFabricMediaRoomJoinInput,
  ConveractFabricStartMediaRecordingInput,
  ConveractFabricUpdateMediaIngressInput
} from './media-types.js';
import type { ConveractFabricSdkBusinessRef } from './types.js';
import type { ConveractFabricBusinessContext, ConveractFabricUnifiedTimelinePage } from './context-types.js';
import type {
  ConveractFabricContactCenterAgent,
  ConveractFabricContactCenterAgentSkill,
  ConveractFabricContactCenterAgentSnapshot,
  ConveractFabricContactCenterCallback,
  ConveractFabricContactCenterCallbackState,
  ConveractFabricContactCenterCapabilities,
  ConveractFabricContactCenterCreateQueueInput,
  ConveractFabricContactCenterListInput,
  ConveractFabricContactCenterMembership,
  ConveractFabricContactCenterMonitorSnapshot,
  ConveractFabricContactCenterPage,
  ConveractFabricContactCenterPresence,
  ConveractFabricContactCenterQueue,
  ConveractFabricContactCenterQueueConfiguration,
  ConveractFabricContactCenterQueueEntrySnapshot,
  ConveractFabricContactCenterQueueEntryState,
  ConveractFabricContactCenterSkill,
  ConveractFabricContactCenterSkillRequirement,
  ConveractFabricContactCenterSupervisorMode,
  ConveractFabricContactCenterSupervisorSession
} from './contact-center-types.js';
import type {
  ConveractFabricEventPage,
  ConveractFabricEventPageInput,
  ConveractFabricEventReplayInput,
  ConveractFabricEventReplayResult,
  ConveractFabricIntegrationEventCatalog,
  ConveractFabricEventWebhookSubscription,
  ConveractFabricEventWebhookSubscriptionPage,
  ConveractFabricCreateEventWebhookSubscriptionInput,
  ConveractFabricUpdateEventWebhookSubscriptionInput
} from './event-types.js';
import type {
  ConveractFabricFindingQueueInput,
  ConveractFabricFindingQueueDetail,
  ConveractFabricFindingQueuePage,
  ConveractFabricFindingQueueReviewInput,
  ConveractFabricIntelligenceCapabilities,
  ConveractFabricIntelligencePolicy,
  ConveractFabricIntelligencePolicyWrite,
  ConveractFabricIntelligenceSourceSnapshot,
  ConveractFabricProviderHealthResult,
  ConveractFabricProviderProfileSummary,
  ConveractFabricProviderRuntimeSnapshot,
  ConveractFabricTranslationListResult,
  ConveractFabricTranslationRequestInput,
  ConveractFabricTranslationRequestResult,
  ConveractFabricTranslationJob
} from './intelligence-types.js';
import type {
  ConveractFabricIvrAudioAsset, ConveractFabricIvrCompilationReport, ConveractFabricIvrCreateAudioAssetInput,
  ConveractFabricIvrCreateRegionGroupInput, ConveractFabricIvrCreateRingGroupInput, ConveractFabricIvrCreateTimeGroupInput,
  ConveractFabricIvrFlow, ConveractFabricIvrFlowGraph, ConveractFabricIvrFlowVersion, ConveractFabricIvrRegionGroup,
  ConveractFabricIvrRingGroup, ConveractFabricIvrSession, ConveractFabricIvrSessionResult, ConveractFabricIvrSettings,
  ConveractFabricIvrSimulationResult, ConveractFabricIvrTimeGroup, ConveractFabricIvrUpdateAudioAssetInput,
  ConveractFabricIvrUpdateRegionGroupInput, ConveractFabricIvrUpdateRingGroupInput, ConveractFabricIvrUpdateSettingsInput,
  ConveractFabricIvrUpdateTimeGroupInput
} from './ivr-types.js';
import type {
  ConveractFabricVoiceCall,
  ConveractFabricVoiceCallActionInput,
  ConveractFabricVoiceCallCommand,
  ConveractFabricVoiceCallState,
  ConveractFabricVoiceCapabilities,
  ConveractFabricVoiceCapabilitySnapshot,
  ConveractFabricVoiceConfigurationCommand,
  ConveractFabricVoiceConsent,
  ConveractFabricVoiceCreateCallResult,
  ConveractFabricVoiceCreateConsentInput,
  ConveractFabricVoiceCreateDidInput,
  ConveractFabricVoiceCreateExtensionInput,
  ConveractFabricVoiceCreateOutboundCallInput,
  ConveractFabricVoiceCreateProfileInput,
  ConveractFabricVoiceCreateRouteInput,
  ConveractFabricVoiceCreateTrunkInput,
  ConveractFabricVoiceDeploymentProfile,
  ConveractFabricVoiceDid,
  ConveractFabricVoiceDidPatch,
  ConveractFabricVoiceExtension,
  ConveractFabricVoiceExtensionPatch,
  ConveractFabricVoiceExtensionSessionPlan,
  ConveractFabricVoiceLiveKitBridge,
  ConveractFabricVoicePage,
  ConveractFabricVoicePageInput,
  ConveractFabricVoiceParkingSlot,
  ConveractFabricVoiceParkingSlotState,
  ConveractFabricVoiceParticipant,
  ConveractFabricVoicePolicy,
  ConveractFabricVoicePolicyWrite,
  ConveractFabricVoiceProfilePatch,
  ConveractFabricVoiceProviderEvent,
  ConveractFabricVoicePublishRouteResult,
  ConveractFabricVoiceRecording,
  ConveractFabricVoiceRoute,
  ConveractFabricVoiceRoutePatch,
  ConveractFabricVoiceRouteVersion,
  ConveractFabricVoiceSipTrunk,
  ConveractFabricVoiceTrunkPatch
} from './voice-types.js';
import type {
  ConveractFabricCreateNotificationEndpointInput,
  ConveractFabricCreateNotificationInput,
  ConveractFabricNotification,
  ConveractFabricNotificationCapabilities,
  ConveractFabricNotificationCreateResult,
  ConveractFabricNotificationDelivery,
  ConveractFabricNotificationDeliveryListInput,
  ConveractFabricNotificationEndpoint,
  ConveractFabricNotificationEndpointListInput,
  ConveractFabricNotificationEndpointTestInput,
  ConveractFabricNotificationInboxAction,
  ConveractFabricNotificationInboxItem,
  ConveractFabricNotificationInboxPage,
  ConveractFabricNotificationPage,
  ConveractFabricNotificationPreference,
  ConveractFabricNotificationTemplate,
  ConveractFabricNotificationTemplateListInput,
  ConveractFabricNotificationTemplateSnapshot,
  ConveractFabricNotificationTemplateVersion,
  ConveractFabricNotificationTemplateVersionListInput,
  ConveractFabricRetryNotificationDeliveryInput
} from './notification-types.js';
import type {
  ConveractFabricAuditCapabilities,
  ConveractFabricAuditListInput,
  ConveractFabricAuditPage
} from './audit-types.js';
import type {
  ConveractFabricLegalHold,
  ConveractFabricRetentionCapabilities,
  ConveractFabricRetentionCategory,
  ConveractFabricRetentionPolicy
} from './retention-types.js';
import {
  createConveractFabricUploadTransport,
  type ConveractFabricUploadOperation,
  type ConveractFabricUploadProgress,
  type ConveractFabricUploadTransport
} from './upload-transport.js';

export type ConveractFabricSdkFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type ConveractFabricSdkRequestBody = Exclude<RequestInit['body'], null | undefined>;

export interface ConveractFabricHttpSdkInput {
  baseUrl: string;
  tenantId: string;
  apiKey?: string;
  accessToken?: string;
  userId?: string;
  timeoutMs?: number;
  fetch?: ConveractFabricSdkFetch;
  uploadTransport?: ConveractFabricUploadTransport;
}

export type { ConveractFabricSdkBusinessRef } from './types.js';

export interface ConveractFabricSdkBinary {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
}

export interface ConveractFabricMediaHttpClient {
  getCapabilities(): Promise<ConveractFabricMediaCapabilities>;
  createIngress(
    input: ConveractFabricCreateMediaIngressInput,
    options: { idempotencyKey: string }
  ): Promise<ConveractFabricCreateMediaIngressResult>;
  listIngresses(input: { room_name: string }): Promise<ConveractFabricMediaIngress[]>;
  getIngress(ingressId: string): Promise<ConveractFabricMediaIngress>;
  updateIngress(
    ingressId: string,
    input: ConveractFabricUpdateMediaIngressInput
  ): Promise<ConveractFabricMediaIngress>;
  deleteIngress(ingressId: string): Promise<ConveractFabricMediaIngress>;
  createCall(input: ConveractFabricCreateMediaCallInput): Promise<ConveractFabricMediaCallSnapshot>;
  getCall(callId: string): Promise<ConveractFabricMediaCallSnapshot>;
  transitionCall(
    callId: string,
    input: ConveractFabricMediaCallActionInput,
    options: { idempotencyKey: string }
  ): Promise<ConveractFabricMediaCallSnapshot>;
  createCallJoinPlan(callId: string, input: ConveractFabricMediaJoinInput): Promise<ConveractFabricMediaJoinPlan>;
  listCallParticipants(callId: string): Promise<ConveractFabricMediaCallParticipantListResult>;
  reportCallQuality(
    callId: string,
    snapshots: ConveractFabricMediaQualitySnapshotInput[]
  ): Promise<ConveractFabricMediaQualityReportResult>;
  getCallQuality(callId: string, input?: { limit?: number }): Promise<ConveractFabricMediaQualitySummary>;
  reportCallConnectionEvent(
    callId: string,
    input: ConveractFabricMediaConnectionEventInput
  ): Promise<ConveractFabricMediaConnectionEventResult>;
  listRealtimeSpeech(
    callId: string,
    input?: { limit?: number; cursor?: string }
  ): Promise<ConveractFabricRealtimeSpeechSegmentPage>;
  createRoom(input: ConveractFabricCreateMediaRoomInput): Promise<ConveractFabricMediaRoom>;
  getRoom(roomName: string): Promise<ConveractFabricMediaRoom>;
  closeRoom(roomName: string): Promise<ConveractFabricMediaRoom>;
  createJoinPlan(roomName: string, input: ConveractFabricMediaRoomJoinInput): Promise<ConveractFabricMediaJoinPlan>;
  listParticipants(
    roomName: string,
    input?: { include_left?: boolean; limit?: number }
  ): Promise<ConveractFabricMediaProviderParticipant[]>;
  muteParticipant(
    roomName: string,
    identity: string,
    input: ConveractFabricMediaMuteInput,
    options: { idempotencyKey: string }
  ): Promise<ConveractFabricMediaModerationResult>;
  removeParticipant(
    roomName: string,
    identity: string,
    input: { reason?: string },
    options: { idempotencyKey: string }
  ): Promise<ConveractFabricMediaModerationResult>;
  recoverModerationCommands(input?: { limit?: number }): Promise<ConveractFabricMediaModerationRecoveryResult>;
  startRecording(roomName: string, input: ConveractFabricStartMediaRecordingInput): Promise<ConveractFabricMediaRecording>;
  stopRecording(recordingOrEgressId: string): Promise<ConveractFabricMediaRecording>;
  listRecordings(input?: Omit<ConveractFabricMediaRecordingListInput, 'cursor'>): Promise<ConveractFabricMediaRecording[]>;
  listRecordingsPage(input?: ConveractFabricMediaRecordingListInput): Promise<ConveractFabricMediaRecordingPage>;
  getRecording(recordingId: string): Promise<ConveractFabricMediaRecording>;
  listRecordingJobs(recordingId: string): Promise<ConveractFabricMediaEgressJob[]>;
  inspectRecordingObject(recordingId: string): Promise<ConveractFabricMediaRecordingObjectInspection>;
  exportRecordingObject(recordingId: string): Promise<ConveractFabricSdkBinary>;
  inspectRecordingJobObject(recordingId: string, jobId: string): Promise<ConveractFabricMediaRecordingObjectInspection>;
  exportRecordingJobObject(recordingId: string, jobId: string): Promise<ConveractFabricSdkBinary>;
  cleanupRecordings(input?: ConveractFabricMediaRecordingRetentionInput): Promise<ConveractFabricMediaRecordingRetentionResult>;
}

export interface ConveractFabricAttachmentUploadInput {
  kind: 'image' | 'video' | 'audio' | 'file' | 'screen_recording';
  filename: string;
  contentType: string;
  body: ConveractFabricSdkRequestBody;
}

export interface ConveractFabricAttachmentUploadOptions {
  onProgress?: (progress: ConveractFabricUploadProgress) => void;
}

export interface ConveractFabricChatHttpClient {
  getCapabilities(): Promise<ConveractFabricChatCapabilities>;
  openSession(input: ConveractFabricOpenChatSessionInput): Promise<ConveractFabricChatSession>;
  closeSession(sessionId: string): Promise<ConveractFabricChatSession>;
  listSessions(input?: ConveractFabricChatSessionListInput): Promise<ConveractFabricCursorPage<ConveractFabricChatSession>>;
  listSessionsByBusinessRef(
    businessRef: ConveractFabricSdkBusinessRef,
    input?: { limit?: number }
  ): Promise<ConveractFabricChatSession[]>;
  bindSession(sessionId: string, input?: Record<string, unknown>): Promise<ConveractFabricChatBinding>;
  createClientPlan(sessionId: string, input: ConveractFabricChatClientPlanInput): Promise<ConveractFabricChatClientPlan>;
  addParticipant(sessionId: string, input: ConveractFabricChatParticipantInput): Promise<ConveractFabricChatParticipant>;
  leaveParticipant(sessionId: string, input: { identity?: string }): Promise<ConveractFabricChatParticipant | null>;
  listMessages(sessionId: string, input?: { limit?: number }): Promise<ConveractFabricChatMessage[]>;
  listMessagesPage(
    sessionId: string,
    input?: ConveractFabricChatMessagePageInput
  ): Promise<ConveractFabricCursorPage<ConveractFabricChatMessage>>;
  postMessage(
    sessionId: string,
    input: ConveractFabricChatMessageInput,
    options?: { idempotencyKey?: string }
  ): Promise<ConveractFabricChatPostMessageResult>;
  getSnapshot(sessionId: string, input?: { limit?: number }): Promise<ConveractFabricChatSnapshot>;
  getDelivery(sessionId: string, messageId: string): Promise<ConveractFabricChatDeliveryResult>;
  retryDelivery(sessionId: string, messageId: string): Promise<ConveractFabricChatDeliveryResult>;
  getTinodeOperations(): Promise<ConveractFabricTinodeOperationsSnapshot>;
  listTinodeDeadLetters(input?: {
    state?: 'open' | 'resolved' | 'all';
    limit?: number;
  }): Promise<ConveractFabricTinodeDeadLetter[]>;
  replayTinodeDeadLetter(
    deadLetterId: string,
    options: { idempotencyKey: string }
  ): Promise<ConveractFabricTinodeDeadLetterReplayResult>;
  listTinodeMutationDeadLetters(input?: { limit?: number }): Promise<ConveractFabricTinodeMutationDeadLetter[]>;
  replayTinodeMutationDeadLetter(
    outboxId: string,
    options: { idempotencyKey: string }
  ): Promise<ConveractFabricTinodeMutationDeadLetterReplayResult>;
  listReceipts(sessionId: string, messageId: string): Promise<ConveractFabricChatReceiptListResult>;
  markReceipt(
    sessionId: string,
    messageId: string,
    input: ConveractFabricChatReceiptInput
  ): Promise<ConveractFabricChatReceiptResult>;
  getMessageState(sessionId: string): Promise<ConveractFabricChatMessageState>;
  setTyping(sessionId: string, input: ConveractFabricChatTypingInput): Promise<ConveractFabricChatRealtimeResult>;
  setPresence(sessionId: string, input: ConveractFabricChatPresenceInput): Promise<ConveractFabricChatRealtimeResult>;
  listRealtimeState(sessionId: string): Promise<ConveractFabricChatRealtimeResult>;
  editMessage(
    sessionId: string,
    messageId: string,
    input: ConveractFabricChatEditInput
  ): Promise<ConveractFabricChatMutationResult>;
  deleteMessage(
    sessionId: string,
    messageId: string,
    input?: ConveractFabricChatDeleteInput
  ): Promise<ConveractFabricChatMutationResult>;
  listMutations(sessionId: string, messageId: string): Promise<ConveractFabricChatMutationListResult>;
  listReactions(sessionId: string, messageId: string): Promise<ConveractFabricChatReactionResult>;
  addReaction(sessionId: string, messageId: string, emoji: string): Promise<ConveractFabricChatReactionResult>;
  removeReaction(sessionId: string, messageId: string, emoji: string): Promise<ConveractFabricChatReactionResult>;
  listPins(sessionId: string): Promise<ConveractFabricChatPinResult>;
  pinMessage(sessionId: string, messageId: string): Promise<ConveractFabricChatPinResult>;
  unpinMessage(sessionId: string, messageId: string): Promise<ConveractFabricChatPinResult>;
  uploadAttachment(sessionId: string, input: ConveractFabricAttachmentUploadInput): Promise<ConveractFabricChatAttachmentUploadDescriptor>;
  uploadAttachmentWithProgress(
    sessionId: string,
    input: ConveractFabricAttachmentUploadInput,
    options?: ConveractFabricAttachmentUploadOptions
  ): ConveractFabricUploadOperation<ConveractFabricChatAttachmentUploadDescriptor>;
  downloadAttachment(sessionId: string, attachmentId: string): Promise<ConveractFabricSdkBinary>;
  createSecureFile(
    sessionId: string,
    input: ConveractFabricCreateSecureFileInput,
    options: { idempotencyKey: string }
  ): Promise<ConveractFabricSecureFile>;
  uploadSecureFileContent(
    sessionId: string,
    fileId: string,
    body: ConveractFabricSdkRequestBody,
    sha256: string
  ): Promise<ConveractFabricSecureFile>;
  uploadSecureFilePart(
    sessionId: string,
    fileId: string,
    partNumber: number,
    body: ConveractFabricSdkRequestBody,
    sha256: string
  ): Promise<ConveractFabricSecureFilePart>;
  listSecureFileParts(sessionId: string, fileId: string): Promise<ConveractFabricSecureFilePart[]>;
  completeSecureFile(
    sessionId: string,
    fileId: string,
    input: { size_bytes: number; sha256: string }
  ): Promise<ConveractFabricSecureFile>;
  getSecureFile(sessionId: string, fileId: string): Promise<ConveractFabricSecureFile>;
  abortSecureFile(sessionId: string, fileId: string): Promise<ConveractFabricSecureFile>;
  downloadSecureFile(sessionId: string, fileId: string): Promise<ConveractFabricSdkBinary>;
  getAttachment(sessionId: string, attachmentId: string): Promise<ConveractFabricChatAttachmentResult>;
  retryAttachment(sessionId: string, attachmentId: string): Promise<ConveractFabricChatAttachmentResult>;
  listFindings(
    sessionId: string,
    input?: { message_id?: string; source?: string; review_status?: string; limit?: number }
  ): Promise<ConveractFabricPolicyFindingListResult>;
  getFinding(sessionId: string, findingId: string): Promise<ConveractFabricPolicyFindingResult>;
  reviewFinding(
    sessionId: string,
    findingId: string,
    input: ConveractFabricPolicyFindingReviewInput
  ): Promise<ConveractFabricPolicyFindingResult>;
  getQualityReview(sessionId: string, messageId: string): Promise<ConveractFabricQualityReviewResult>;
  enqueueQualityReview(sessionId: string, messageId: string): Promise<ConveractFabricQualityReviewResult>;
  runAttachmentProcessing(input?: { limit?: number }): Promise<ConveractFabricWorkerRunResult>;
  runQualityReview(input?: { limit?: number }): Promise<ConveractFabricWorkerRunResult>;
  listMessageTranslations(
    sessionId: string,
    messageId: string,
    input?: { target_language?: string; history?: boolean }
  ): Promise<ConveractFabricTranslationListResult>;
  requestMessageTranslation(
    sessionId: string,
    messageId: string,
    input: ConveractFabricTranslationRequestInput,
    options: { idempotencyKey: string }
  ): Promise<ConveractFabricTranslationRequestResult>;
  listAttachmentTranslations(
    sessionId: string,
    attachmentId: string,
    input?: { target_language?: string; history?: boolean }
  ): Promise<ConveractFabricTranslationListResult>;
  requestAttachmentTranslation(
    sessionId: string,
    attachmentId: string,
    input: ConveractFabricTranslationRequestInput,
    options: { idempotencyKey: string }
  ): Promise<ConveractFabricTranslationRequestResult>;
  retryTranslation(sessionId: string, jobId: string): Promise<{ job: ConveractFabricTranslationJob }>;
  runTranslation(input?: { limit?: number }): Promise<ConveractFabricWorkerRunResult>;
}

export interface ConveractFabricIntelligenceHttpClient {
  getCapabilities(): Promise<ConveractFabricIntelligenceCapabilities>;
  getPolicy(): Promise<ConveractFabricIntelligencePolicy>;
  updatePolicy(input: ConveractFabricIntelligencePolicyWrite): Promise<ConveractFabricIntelligencePolicy>;
  listProviders(): Promise<{ items: ConveractFabricProviderProfileSummary[] }>;
  listProviderRuntime(): Promise<{ items: ConveractFabricProviderRuntimeSnapshot[] }>;
  probeProviderHealth(input?: { profile_ids?: string[] }): Promise<{ items: ConveractFabricProviderHealthResult[] }>;
  importSource(
    sessionId: string,
    input: { source_type: 'media_recording' | 'remote_recording'; source_ref_id: string },
    options: { idempotencyKey: string }
  ): Promise<ConveractFabricIntelligenceSourceSnapshot>;
  getSource(sessionId: string, sourceId: string): Promise<ConveractFabricIntelligenceSourceSnapshot>;
  retrySource(sessionId: string, sourceId: string): Promise<ConveractFabricIntelligenceSourceSnapshot>;
  listFindings(input?: ConveractFabricFindingQueueInput): Promise<ConveractFabricFindingQueuePage>;
  getFinding(findingId: string): Promise<ConveractFabricFindingQueueDetail>;
  reviewFinding(findingId: string, input: ConveractFabricFindingQueueReviewInput): Promise<ConveractFabricFindingQueueDetail>;
}

export interface ConveractFabricContextHttpClient {
  getByBusinessRef(businessRef: Pick<ConveractFabricSdkBusinessRef, 'type' | 'id'>): Promise<ConveractFabricBusinessContext>;
  listTimeline(
    businessRef: Pick<ConveractFabricSdkBusinessRef, 'type' | 'id'>,
    input?: { cursor?: string; limit?: number }
  ): Promise<ConveractFabricUnifiedTimelinePage>;
}

export interface ConveractFabricContactCenterHttpClient {
  getCapabilities(): Promise<ConveractFabricContactCenterCapabilities>;
  getMonitorSnapshot(): Promise<ConveractFabricContactCenterMonitorSnapshot>;
  listSkills(input?: ConveractFabricContactCenterListInput): Promise<ConveractFabricContactCenterPage<ConveractFabricContactCenterSkill>>;
  createSkill(
    input: { name: string; description?: string; status?: ConveractFabricContactCenterSkill['status'] },
    options: { idempotencyKey: string }
  ): Promise<ConveractFabricContactCenterSkill>;
  getSkill(skillId: string): Promise<ConveractFabricContactCenterSkill>;
  updateSkill(
    skillId: string,
    input: { revision: number; patch: Partial<Pick<ConveractFabricContactCenterSkill, 'name' | 'description' | 'status'>> }
  ): Promise<ConveractFabricContactCenterSkill>;
  listAgents(input?: ConveractFabricContactCenterListInput): Promise<ConveractFabricContactCenterPage<ConveractFabricContactCenterAgent>>;
  createAgent(input: {
    identity: string; display_name?: string; voice_extension_id?: string | null;
    voice_capacity?: number; metadata?: Record<string, unknown>;
    status?: ConveractFabricContactCenterAgent['status'];
  }, options: { idempotencyKey: string }): Promise<ConveractFabricContactCenterAgentSnapshot>;
  getAgent(agentId: string): Promise<ConveractFabricContactCenterAgentSnapshot>;
  updateAgent(agentId: string, input: {
    revision: number;
    patch: Partial<Pick<ConveractFabricContactCenterAgent,
      'identity' | 'display_name' | 'voice_extension_id' | 'voice_capacity' | 'metadata' | 'status'>>;
  }): Promise<ConveractFabricContactCenterAgentSnapshot>;
  updatePresence(
    agentId: string,
    input: { state: 'available' | 'away' | 'offline'; session_ref?: string }
  ): Promise<ConveractFabricContactCenterPresence>;
  listAgentSkills(agentId: string): Promise<ConveractFabricContactCenterAgentSkill[]>;
  replaceAgentSkills(
    agentId: string,
    skills: ConveractFabricContactCenterAgentSkill[]
  ): Promise<ConveractFabricContactCenterAgentSkill[]>;
  listQueues(input?: ConveractFabricContactCenterListInput): Promise<ConveractFabricContactCenterPage<ConveractFabricContactCenterQueue>>;
  createQueue(
    input: ConveractFabricContactCenterCreateQueueInput,
    options: { idempotencyKey: string }
  ): Promise<ConveractFabricContactCenterQueueConfiguration>;
  getQueue(queueId: string): Promise<ConveractFabricContactCenterQueueConfiguration>;
  updateQueue(queueId: string, input: {
    revision: number;
    patch: Partial<Omit<ConveractFabricContactCenterCreateQueueInput, 'name'> & { name: string }>;
  }): Promise<ConveractFabricContactCenterQueueConfiguration>;
  listMemberships(queueId: string): Promise<ConveractFabricContactCenterMembership[]>;
  upsertMembership(
    queueId: string,
    input: { agent_id: string; priority?: number; enabled?: boolean }
  ): Promise<ConveractFabricContactCenterMembership>;
  removeMembership(queueId: string, agentId: string): Promise<{ removed: boolean }>;
  listQueueSkillRequirements(queueId: string): Promise<ConveractFabricContactCenterSkillRequirement[]>;
  replaceQueueSkillRequirements(
    queueId: string,
    requirements: ConveractFabricContactCenterSkillRequirement[]
  ): Promise<ConveractFabricContactCenterSkillRequirement[]>;
  listQueueEntries(queueId: string, input?: {
    state?: ConveractFabricContactCenterQueueEntryState; cursor?: string; limit?: number;
  }): Promise<ConveractFabricContactCenterPage<ConveractFabricContactCenterQueueEntrySnapshot>>;
  listCallbacks(input?: {
    queue_id?: string; state?: ConveractFabricContactCenterCallbackState; cursor?: string; limit?: number;
  }): Promise<ConveractFabricContactCenterPage<ConveractFabricContactCenterCallback>>;
  requestCallback(input: {
    queue_entry_id: string; source_call_id: string;
    address: { kind: 'e164' | 'extension' | 'sip_uri'; value: string };
    scheduled_for?: string; max_attempts?: number;
  }, options: { idempotencyKey: string }): Promise<{
    callback: ConveractFabricContactCenterCallback; replayed: boolean;
  }>;
  getCallback(callbackId: string): Promise<ConveractFabricContactCenterCallback>;
  cancelCallback(callbackId: string, input?: { reason?: string }): Promise<ConveractFabricContactCenterCallback>;
  offerNext(
    input: { queue_id: string; offer_ttl_seconds: number },
    options: { idempotencyKey: string }
  ): Promise<{ entry: ConveractFabricContactCenterQueueEntrySnapshot['entry']; assignment: ConveractFabricContactCenterQueueEntrySnapshot['assignments'][number] } | null>;
  actOnAssignment(
    assignmentId: string,
    action: 'accept' | 'reject' | 'connect' | 'complete',
    input?: { agent_id?: string; reason?: string }
  ): Promise<{ entry: ConveractFabricContactCenterQueueEntrySnapshot['entry']; assignment: ConveractFabricContactCenterQueueEntrySnapshot['assignments'][number] }>;
  startSupervisor(input: {
    call_id: string; target_agent_id: string; mode: ConveractFabricContactCenterSupervisorMode;
    authorization_ref: string;
  }, options: { idempotencyKey: string }): Promise<ConveractFabricContactCenterSupervisorSession>;
  endSupervisor(
    sessionId: string,
    input?: { reason?: string }
  ): Promise<ConveractFabricContactCenterSupervisorSession>;
}

export interface ConveractFabricEventHttpClient {
  getHeadCursor(): Promise<string>;
  listPage<T = unknown>(input: ConveractFabricEventPageInput): Promise<ConveractFabricEventPage<T>>;
  replay<T = unknown>(input: ConveractFabricEventReplayInput): Promise<ConveractFabricEventReplayResult<T>>;
  getCatalog(): Promise<ConveractFabricIntegrationEventCatalog>;
  createWebhookSubscription(
    input: ConveractFabricCreateEventWebhookSubscriptionInput,
    options: { idempotencyKey: string }
  ): Promise<{ created: boolean; subscription: ConveractFabricEventWebhookSubscription }>;
  listWebhookSubscriptions(input?: {
    status?: ConveractFabricEventWebhookSubscription['status'];
    cursor?: string;
    limit?: number;
  }): Promise<ConveractFabricEventWebhookSubscriptionPage>;
  getWebhookSubscription(subscriptionId: string): Promise<ConveractFabricEventWebhookSubscription>;
  updateWebhookSubscription(
    subscriptionId: string,
    input: ConveractFabricUpdateEventWebhookSubscriptionInput,
    options: { idempotencyKey: string }
  ): Promise<ConveractFabricEventWebhookSubscription>;
  archiveWebhookSubscription(
    subscriptionId: string,
    input: { expected_revision: number },
    options: { idempotencyKey: string }
  ): Promise<ConveractFabricEventWebhookSubscription>;
}

export interface ConveractFabricIvrHttpClient {
  listFlows(): Promise<ConveractFabricIvrFlow[]>;
  createFlow(input: { name: string; graph: ConveractFabricIvrFlowGraph; metadata?: Record<string, unknown> }): Promise<ConveractFabricIvrFlow>;
  getFlow(flowId: string): Promise<ConveractFabricIvrFlow>;
  updateFlow(flowId: string, input: { expected_revision: number; name?: string; graph?: ConveractFabricIvrFlowGraph; metadata?: Record<string, unknown> }): Promise<ConveractFabricIvrFlow>;
  listVersions(flowId: string): Promise<ConveractFabricIvrFlowVersion[]>;
  validateFlow(flowId: string): Promise<ConveractFabricIvrCompilationReport>;
  publishFlow(flowId: string, expectedDraftRevision: number, options: { idempotencyKey: string }): Promise<{ flow: ConveractFabricIvrFlow; version: ConveractFabricIvrFlowVersion; replayed: boolean }>;
  rollbackFlow(flowId: string, input: { expected_draft_revision: number; source_version: number }, options: { idempotencyKey: string }): Promise<{ flow: ConveractFabricIvrFlow; version: ConveractFabricIvrFlowVersion; replayed: boolean }>;
  simulate(input: Record<string, unknown> & { flow_id: string }): Promise<ConveractFabricIvrSimulationResult>;
  listSessions(input?: { limit?: number }): Promise<ConveractFabricIvrSession[]>;
  startSession(input: { call_id: string; flow_id: string; flow_version?: number; variables?: Record<string, unknown>; trace_id?: string }): Promise<ConveractFabricIvrSessionResult>;
  getSession(sessionId: string): Promise<{ session: ConveractFabricIvrSession; steps: Array<Record<string, unknown>> }>;
  advanceSession(sessionId: string, input: { event_sequence: number; action_revision: number; event: Record<string, unknown> }): Promise<ConveractFabricIvrSessionResult>;
  listAudioAssets(): Promise<ConveractFabricIvrAudioAsset[]>;
  createAudioAsset(input: ConveractFabricIvrCreateAudioAssetInput): Promise<ConveractFabricIvrAudioAsset>;
  getAudioAsset(id: string): Promise<ConveractFabricIvrAudioAsset>;
  updateAudioAsset(id: string, input: ConveractFabricIvrUpdateAudioAssetInput): Promise<ConveractFabricIvrAudioAsset>;
  listTimeGroups(): Promise<ConveractFabricIvrTimeGroup[]>;
  createTimeGroup(input: ConveractFabricIvrCreateTimeGroupInput): Promise<ConveractFabricIvrTimeGroup>;
  getTimeGroup(id: string): Promise<ConveractFabricIvrTimeGroup>;
  updateTimeGroup(id: string, input: ConveractFabricIvrUpdateTimeGroupInput): Promise<ConveractFabricIvrTimeGroup>;
  listRegionGroups(): Promise<ConveractFabricIvrRegionGroup[]>;
  createRegionGroup(input: ConveractFabricIvrCreateRegionGroupInput): Promise<ConveractFabricIvrRegionGroup>;
  getRegionGroup(id: string): Promise<ConveractFabricIvrRegionGroup>;
  updateRegionGroup(id: string, input: ConveractFabricIvrUpdateRegionGroupInput): Promise<ConveractFabricIvrRegionGroup>;
  listRingGroups(): Promise<ConveractFabricIvrRingGroup[]>;
  createRingGroup(input: ConveractFabricIvrCreateRingGroupInput): Promise<ConveractFabricIvrRingGroup>;
  getRingGroup(id: string): Promise<ConveractFabricIvrRingGroup>;
  updateRingGroup(id: string, input: ConveractFabricIvrUpdateRingGroupInput): Promise<ConveractFabricIvrRingGroup>;
  getSettings(): Promise<ConveractFabricIvrSettings>;
  updateSettings(input: ConveractFabricIvrUpdateSettingsInput): Promise<ConveractFabricIvrSettings>;
}

export interface ConveractFabricVoiceIdempotencyOptions {
  idempotencyKey: string;
}

export interface ConveractFabricVoiceHttpClient {
  getCapabilities(): Promise<ConveractFabricVoiceCapabilities>;
  listProfiles(input?: ConveractFabricVoicePageInput): Promise<ConveractFabricVoicePage<ConveractFabricVoiceDeploymentProfile>>;
  createProfile(input: ConveractFabricVoiceCreateProfileInput): Promise<ConveractFabricVoiceDeploymentProfile>;
  getProfile(profileId: string): Promise<ConveractFabricVoiceDeploymentProfile>;
  updateProfile(
    profileId: string,
    input: { revision: number; patch: ConveractFabricVoiceProfilePatch }
  ): Promise<ConveractFabricVoiceDeploymentProfile>;
  preflightProfile(profileId: string): Promise<ConveractFabricVoiceCapabilitySnapshot>;
  getProfileCapabilities(profileId: string): Promise<ConveractFabricVoiceCapabilitySnapshot | null>;
  listTrunks(
    input?: ConveractFabricVoicePageInput & { profile_id?: string }
  ): Promise<ConveractFabricVoicePage<ConveractFabricVoiceSipTrunk>>;
  createTrunk(input: ConveractFabricVoiceCreateTrunkInput): Promise<ConveractFabricVoiceSipTrunk>;
  getTrunk(trunkId: string): Promise<ConveractFabricVoiceSipTrunk>;
  updateTrunk(
    trunkId: string,
    input: { revision: number; patch: ConveractFabricVoiceTrunkPatch }
  ): Promise<ConveractFabricVoiceSipTrunk>;
  applyTrunk(trunkId: string, options: ConveractFabricVoiceIdempotencyOptions): Promise<ConveractFabricVoiceConfigurationCommand>;
  testTrunk(trunkId: string, options: ConveractFabricVoiceIdempotencyOptions): Promise<ConveractFabricVoiceConfigurationCommand>;
  listDids(
    input?: ConveractFabricVoicePageInput & { trunk_id?: string }
  ): Promise<ConveractFabricVoicePage<ConveractFabricVoiceDid>>;
  createDid(input: ConveractFabricVoiceCreateDidInput): Promise<ConveractFabricVoiceDid>;
  getDid(didId: string): Promise<ConveractFabricVoiceDid>;
  updateDid(
    didId: string,
    input: { revision: number; patch: ConveractFabricVoiceDidPatch }
  ): Promise<ConveractFabricVoiceDid>;
  applyDid(didId: string, options: ConveractFabricVoiceIdempotencyOptions): Promise<ConveractFabricVoiceConfigurationCommand>;
  listExtensions(
    input?: ConveractFabricVoicePageInput & { profile_id?: string }
  ): Promise<ConveractFabricVoicePage<ConveractFabricVoiceExtension>>;
  createExtension(input: ConveractFabricVoiceCreateExtensionInput): Promise<ConveractFabricVoiceExtension>;
  getExtension(extensionId: string): Promise<ConveractFabricVoiceExtension>;
  updateExtension(
    extensionId: string,
    input: { revision: number; patch: ConveractFabricVoiceExtensionPatch }
  ): Promise<ConveractFabricVoiceExtension>;
  applyExtension(
    extensionId: string,
    options: ConveractFabricVoiceIdempotencyOptions
  ): Promise<ConveractFabricVoiceConfigurationCommand>;
  createExtensionSession(
    extensionId: string,
    options: ConveractFabricVoiceIdempotencyOptions
  ): Promise<ConveractFabricVoiceExtensionSessionPlan>;
  listRoutes(
    input?: ConveractFabricVoicePageInput & { profile_id?: string }
  ): Promise<ConveractFabricVoicePage<ConveractFabricVoiceRoute>>;
  createRoute(input: ConveractFabricVoiceCreateRouteInput): Promise<ConveractFabricVoiceRoute>;
  getRoute(routeId: string): Promise<ConveractFabricVoiceRoute>;
  updateRoute(
    routeId: string,
    input: { revision: number; patch: ConveractFabricVoiceRoutePatch }
  ): Promise<ConveractFabricVoiceRoute>;
  validateRoute(
    routeId: string,
    input?: { rules?: Record<string, unknown> }
  ): Promise<{ valid: true; payload_hash: string }>;
  listRouteVersions(routeId: string): Promise<ConveractFabricVoicePage<ConveractFabricVoiceRouteVersion>>;
  publishRoute(
    routeId: string,
    input: { revision: number },
    options: ConveractFabricVoiceIdempotencyOptions
  ): Promise<ConveractFabricVoicePublishRouteResult>;
  listCalls(
    input?: ConveractFabricVoicePageInput & {
      state?: ConveractFabricVoiceCallState;
      business_ref?: Pick<ConveractFabricSdkBusinessRef, 'type' | 'id'>;
    }
  ): Promise<ConveractFabricVoicePage<ConveractFabricVoiceCall>>;
  listParkingSlots(
    input?: ConveractFabricVoicePageInput & {
      profile_id?: string;
      state?: ConveractFabricVoiceParkingSlotState;
    }
  ): Promise<ConveractFabricVoicePage<ConveractFabricVoiceParkingSlot>>;
  createOutboundCall(
    input: ConveractFabricVoiceCreateOutboundCallInput,
    options: ConveractFabricVoiceIdempotencyOptions
  ): Promise<ConveractFabricVoiceCreateCallResult>;
  getCall(callId: string): Promise<ConveractFabricVoiceCall>;
  enqueueCallAction(
    callId: string,
    input: ConveractFabricVoiceCallActionInput,
    options: ConveractFabricVoiceIdempotencyOptions
  ): Promise<ConveractFabricVoiceCallCommand>;
  createLiveKitBridge(
    callId: string,
    input: { sip_trunk_id: string },
    options: ConveractFabricVoiceIdempotencyOptions
  ): Promise<ConveractFabricVoiceCallCommand>;
  listCallEvents(
    callId: string,
    input?: ConveractFabricVoicePageInput
  ): Promise<ConveractFabricVoicePage<ConveractFabricVoiceProviderEvent>>;
  listCallRecordings(
    callId: string,
    input?: ConveractFabricVoicePageInput & { status?: ConveractFabricVoiceRecording['status'] }
  ): Promise<ConveractFabricVoicePage<ConveractFabricVoiceRecording>>;
  listCallBridges(callId: string): Promise<ConveractFabricVoicePage<ConveractFabricVoiceLiveKitBridge>>;
  listCallParticipants(callId: string): Promise<ConveractFabricVoicePage<ConveractFabricVoiceParticipant>>;
  getPolicy(): Promise<ConveractFabricVoicePolicy | null>;
  updatePolicy(input: ConveractFabricVoicePolicyWrite): Promise<ConveractFabricVoicePolicy>;
  listConsents(
    input?: ConveractFabricVoicePageInput & { subject_ref_type?: string; subject_ref_id?: string }
  ): Promise<ConveractFabricVoicePage<ConveractFabricVoiceConsent>>;
  createConsent(input: ConveractFabricVoiceCreateConsentInput): Promise<ConveractFabricVoiceConsent>;
  listRecordings(
    input?: ConveractFabricVoicePageInput & {
      call_id?: string;
      status?: ConveractFabricVoiceRecording['status'];
    }
  ): Promise<ConveractFabricVoicePage<ConveractFabricVoiceRecording>>;
}

export interface ConveractFabricHttpSdk {
  media: ConveractFabricMediaHttpClient;
  chat: ConveractFabricChatHttpClient;
  contactCenter: ConveractFabricContactCenterHttpClient;
  context: ConveractFabricContextHttpClient;
  events: ConveractFabricEventHttpClient;
  intelligence: ConveractFabricIntelligenceHttpClient;
  ivr: ConveractFabricIvrHttpClient;
  voice: ConveractFabricVoiceHttpClient;
  notifications: ConveractFabricNotificationHttpClient;
  audit: ConveractFabricAuditHttpClient;
  retention: ConveractFabricRetentionHttpClient;
}

export interface ConveractFabricAuditHttpClient {
  getCapabilities(): Promise<ConveractFabricAuditCapabilities>;
  listEvents(input?: ConveractFabricAuditListInput): Promise<ConveractFabricAuditPage>;
  exportJsonl(input?: ConveractFabricAuditListInput & { max_events?: number }): Promise<ConveractFabricSdkBinary>;
}

export interface ConveractFabricRetentionHttpClient {
  getCapabilities(): Promise<ConveractFabricRetentionCapabilities>;
  listPolicies(): Promise<ConveractFabricRetentionPolicy[]>;
  putPolicy(category: ConveractFabricRetentionCategory, input: {
    enabled: boolean; retention_days: number; batch_size: number;
    interval_seconds: number; expected_revision: number;
  }): Promise<ConveractFabricRetentionPolicy>;
  listLegalHolds(input?: {
    category?: ConveractFabricRetentionCategory; status?: 'active' | 'released';
  }): Promise<ConveractFabricLegalHold[]>;
  placeLegalHold(input: {
    category: ConveractFabricRetentionCategory; resource_type: string;
    resource_id: string; reason_code: string;
  }, options: { idempotencyKey: string }): Promise<{ legal_hold: ConveractFabricLegalHold; created: boolean }>;
  releaseLegalHold(holdId: string): Promise<ConveractFabricLegalHold>;
}

export interface ConveractFabricNotificationHttpClient {
  getCapabilities(): Promise<ConveractFabricNotificationCapabilities>;
  create(
    input: ConveractFabricCreateNotificationInput,
    options: { idempotencyKey: string }
  ): Promise<ConveractFabricNotificationCreateResult>;
  get(notificationId: string): Promise<ConveractFabricNotification>;
  listInbox(input?: {
    user_id?: string; limit?: number; cursor?: string; include_archived?: boolean;
  }): Promise<ConveractFabricNotificationInboxPage>;
  countUnread(input?: { user_id?: string }): Promise<number>;
  mutateInbox(
    itemId: string,
    action: ConveractFabricNotificationInboxAction,
    input?: { user_id?: string }
  ): Promise<ConveractFabricNotificationInboxItem>;
  createEndpoint(
    input: ConveractFabricCreateNotificationEndpointInput,
    options: { idempotencyKey: string }
  ): Promise<{ endpoint: ConveractFabricNotificationEndpoint; created: boolean }>;
  getEndpoint(endpointId: string): Promise<ConveractFabricNotificationEndpoint>;
  listEndpoints(
    input?: ConveractFabricNotificationEndpointListInput
  ): Promise<ConveractFabricNotificationPage<ConveractFabricNotificationEndpoint>>;
  updateEndpoint(
    endpointId: string,
    expectedRevision: number,
    patch: Record<string, unknown>
  ): Promise<ConveractFabricNotificationEndpoint>;
  testEndpoint(
    endpointId: string,
    input: ConveractFabricNotificationEndpointTestInput,
    options: { idempotencyKey: string }
  ): Promise<ConveractFabricNotificationCreateResult>;
  archiveEndpoint(endpointId: string, expectedRevision: number): Promise<ConveractFabricNotificationEndpoint>;
  createTemplate(input: {
    template_key: string; description?: string; locale: string;
    channels: import('./notification-types.js').ConveractFabricNotificationChannel[];
    content: Record<string, unknown>;
  }): Promise<ConveractFabricNotificationTemplateSnapshot>;
  getTemplate(templateId: string): Promise<ConveractFabricNotificationTemplate>;
  listTemplates(
    input?: ConveractFabricNotificationTemplateListInput
  ): Promise<ConveractFabricNotificationPage<ConveractFabricNotificationTemplate>>;
  listTemplateVersions(
    templateId: string,
    input?: ConveractFabricNotificationTemplateVersionListInput
  ): Promise<ConveractFabricNotificationPage<ConveractFabricNotificationTemplateVersion>>;
  updateTemplate(templateId: string, input: {
    expected_revision: number; description?: string; locale: string;
    channels: import('./notification-types.js').ConveractFabricNotificationChannel[];
    content: Record<string, unknown>;
  }): Promise<ConveractFabricNotificationTemplateSnapshot>;
  publishTemplate(
    templateId: string,
    input: { expected_revision: number; locale: string }
  ): Promise<ConveractFabricNotificationTemplateSnapshot>;
  archiveTemplate(templateId: string, expectedRevision: number): Promise<ConveractFabricNotificationTemplate>;
  getDelivery(deliveryId: string): Promise<ConveractFabricNotificationDelivery>;
  listDeliveries(
    input?: ConveractFabricNotificationDeliveryListInput
  ): Promise<ConveractFabricNotificationPage<ConveractFabricNotificationDelivery>>;
  retryDelivery(
    deliveryId: string,
    input: ConveractFabricRetryNotificationDeliveryInput
  ): Promise<ConveractFabricNotificationDelivery>;
  listPreferences(input?: { user_id?: string }): Promise<ConveractFabricNotificationPreference[]>;
  putPreference(
    eventType: string,
    channel: import('./notification-types.js').ConveractFabricNotificationChannel,
    input: { enabled: boolean; locale?: string; quiet_hours?: Record<string, unknown>; expected_revision: number },
    options?: { user_id?: string }
  ): Promise<ConveractFabricNotificationPreference>;
}

export class ConveractFabricHttpSdkError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly payload: unknown
  ) {
    super(message);
    this.name = 'ConveractFabricHttpSdkError';
  }
}

export function createConveractFabricHttpSdk(input: ConveractFabricHttpSdkInput): ConveractFabricHttpSdk {
  const transport = createTransport(input);
  return {
    media: createMediaClient(transport),
    chat: createChatClient(transport, createAttachmentUploadClient(input)),
    contactCenter: createContactCenterClient(transport),
    context: createContextClient(transport),
    events: createEventClient(transport),
    intelligence: createIntelligenceClient(transport),
    ivr: createIvrClient(transport),
    voice: createVoiceClient(transport),
    notifications: createNotificationClient(transport),
    audit: createAuditClient(transport),
    retention: createRetentionClient(transport)
  };
}

function createRetentionClient(transport: ConveractFabricTransport): ConveractFabricRetentionHttpClient {
  const root = '/api/ivekit/retention';
  return {
    getCapabilities: () => transport.json('GET', `${root}/capabilities`),
    async listPolicies() {
      return (await transport.json<{ policies: ConveractFabricRetentionPolicy[] }>(
        'GET', `${root}/policies`
      )).policies;
    },
    async putPolicy(category, body) {
      return (await transport.json<{ policy: ConveractFabricRetentionPolicy }>(
        'PUT', `${root}/policies/${pathSegment(category, 'category')}`, { body }
      )).policy;
    },
    async listLegalHolds(input = {}) {
      return (await transport.json<{ legal_holds: ConveractFabricLegalHold[] }>(
        'GET', `${root}/legal-holds`, {
          query: { category: input.category || '', status: input.status || '' }
        }
      )).legal_holds;
    },
    placeLegalHold: (body, options) => transport.json('POST', `${root}/legal-holds`, {
      body,
      headers: {
        'idempotency-key': requiredString(options?.idempotencyKey, 'idempotencyKey is required')
      }
    }),
    async releaseLegalHold(holdId) {
      return (await transport.json<{ legal_hold: ConveractFabricLegalHold }>(
        'POST', `${root}/legal-holds/${pathSegment(holdId, 'holdId')}/release`, { body: {} }
      )).legal_hold;
    }
  };
}

function createAuditClient(transport: ConveractFabricTransport): ConveractFabricAuditHttpClient {
  const root = '/api/ivekit/audit';
  const query = (input: ConveractFabricAuditListInput & { max_events?: number } = {}) => ({
    limit: optionalNumber(input.limit),
    cursor: input.cursor || '',
    action: input.action || '',
    resource_type: input.resource_type || '',
    resource_id: input.resource_id || '',
    max_events: optionalNumber(input.max_events)
  });
  return {
    getCapabilities: () => transport.json('GET', `${root}/capabilities`),
    listEvents: (input = {}) => transport.json('GET', `${root}/events`, { query: query(input) }),
    exportJsonl: (input = {}) => transport.binary('GET', `${root}/export`, { query: query(input) })
  };
}

function createNotificationClient(transport: ConveractFabricTransport): ConveractFabricNotificationHttpClient {
  const root = '/api/ivekit/notifications';
  const path = (collection: string, id: string) =>
    `${root}/${collection}/${pathSegment(id, `${collection}Id`)}`;
  const query = (userId?: string) => ({ user_id: userId || '' });
  return {
    getCapabilities: () => transport.json('GET', `${root}/capabilities`),
    create: (body, options) => transport.json('POST', root, {
      body, headers: { 'idempotency-key': requiredString(options?.idempotencyKey, 'idempotencyKey is required') }
    }),
    async get(id) {
      return (await transport.json<{ notification: ConveractFabricNotification }>('GET', `${root}/${pathSegment(id, 'notificationId')}`)).notification;
    },
    listInbox: (input = {}) => transport.json('GET', `${root}/inbox`, {
      query: {
        ...query(input.user_id), limit: optionalNumber(input.limit), cursor: input.cursor || '',
        include_archived: input.include_archived ? 'true' : ''
      }
    }),
    async countUnread(input = {}) {
      return (await transport.json<{ unread_count: number }>(
        'GET', `${root}/inbox/unread-count`, { query: query(input.user_id) }
      )).unread_count;
    },
    mutateInbox: (itemId, action, input = {}) => transport.json(
      'POST', `${path('inbox', itemId)}/${action}`, { body: {}, query: query(input.user_id) }
    ),
    createEndpoint: (body, options) => transport.json('POST', `${root}/endpoints`, {
      body, headers: { 'idempotency-key': requiredString(options?.idempotencyKey, 'idempotencyKey is required') }
    }),
    async getEndpoint(id) {
      return (await transport.json<{ endpoint: ConveractFabricNotificationEndpoint }>(
        'GET', path('endpoints', id)
      )).endpoint;
    },
    listEndpoints: (input = {}) => transport.json('GET', `${root}/endpoints`, {
      query: {
        channel: input.channel || '', status: input.status || '',
        limit: optionalNumber(input.limit), cursor: input.cursor || ''
      }
    }),
    async updateEndpoint(id, expectedRevision, patch) {
      return (await transport.json<{ endpoint: ConveractFabricNotificationEndpoint }>(
        'PUT', path('endpoints', id), { body: { expected_revision: expectedRevision, patch } }
      )).endpoint;
    },
    testEndpoint: (id, body, options) => transport.json('POST', `${path('endpoints', id)}/test`, {
      body,
      headers: {
        'idempotency-key': requiredString(options?.idempotencyKey, 'idempotencyKey is required')
      }
    }),
    async archiveEndpoint(id, expectedRevision) {
      return (await transport.json<{ endpoint: ConveractFabricNotificationEndpoint }>(
        'POST', `${path('endpoints', id)}/archive`, {
          body: { expected_revision: expectedRevision }
        }
      )).endpoint;
    },
    createTemplate: (body) => transport.json('POST', `${root}/templates`, { body }),
    async getTemplate(id) {
      return (await transport.json<{ template: ConveractFabricNotificationTemplate }>(
        'GET', path('templates', id)
      )).template;
    },
    listTemplates: (input = {}) => transport.json('GET', `${root}/templates`, {
      query: {
        status: input.status || '', limit: optionalNumber(input.limit), cursor: input.cursor || ''
      }
    }),
    listTemplateVersions: (id, input = {}) => transport.json(
      'GET', `${path('templates', id)}/versions`, {
        query: {
          locale: input.locale || '', limit: optionalNumber(input.limit), cursor: input.cursor || ''
        }
      }
    ),
    updateTemplate: (id, body) => transport.json('PUT', path('templates', id), { body }),
    publishTemplate: (id, body) => transport.json('POST', `${path('templates', id)}/publish`, { body }),
    async archiveTemplate(id, expectedRevision) {
      return (await transport.json<{ template: ConveractFabricNotificationTemplate }>(
        'POST', `${path('templates', id)}/archive`, {
          body: { expected_revision: expectedRevision }
        }
      )).template;
    },
    async getDelivery(id) {
      return (await transport.json<{ delivery: ConveractFabricNotificationDelivery }>(
        'GET', path('deliveries', id)
      )).delivery;
    },
    listDeliveries: (input = {}) => transport.json('GET', `${root}/deliveries`, {
      query: {
        notification_id: input.notification_id || '', endpoint_id: input.endpoint_id || '',
        channel: input.channel || '', state: input.state || '',
        limit: optionalNumber(input.limit), cursor: input.cursor || ''
      }
    }),
    async retryDelivery(id, input) {
      return (await transport.json<{ delivery: ConveractFabricNotificationDelivery }>(
        'POST', `${path('deliveries', id)}/retry`, {
          body: {
            expected_state: input.expected_state,
            allow_uncertain: input.allow_uncertain === true
          }
        }
      )).delivery;
    },
    async listPreferences(input = {}) {
      return (await transport.json<{ preferences: ConveractFabricNotificationPreference[] }>(
        'GET', `${root}/preferences`, { query: query(input.user_id) }
      )).preferences;
    },
    async putPreference(eventType, channel, body, options = {}) {
      return (await transport.json<{ preference: ConveractFabricNotificationPreference }>(
        'PUT', `${root}/preferences/${pathSegment(eventType, 'eventType')}/${pathSegment(channel, 'channel')}`,
        { body, query: query(options.user_id) }
      )).preference;
    }
  };
}

function createContactCenterClient(transport: ConveractFabricTransport): ConveractFabricContactCenterHttpClient {
  const root = '/api/ivekit/contact-center';
  const resourcePath = (collection: string, id: string, field: string) =>
    `${root}/${collection}/${pathSegment(id, field)}`;
  const skillPath = (id: string) => resourcePath('skills', id, 'skillId');
  const agentPath = (id: string) => resourcePath('agents', id, 'agentId');
  const queuePath = (id: string) => resourcePath('queues', id, 'queueId');
  const callbackPath = (id: string) => resourcePath('callbacks', id, 'callbackId');
  const idempotencyHeaders = (options: { idempotencyKey: string }) => ({
    'Idempotency-Key': requiredString(options?.idempotencyKey, 'idempotencyKey is required')
  });
  const listQuery = (input: ConveractFabricContactCenterListInput) => ({
    status: input.status || '', cursor: input.cursor || '', limit: optionalNumber(input.limit)
  });
  return {
    getCapabilities: () => transport.json('GET', `${root}/capabilities`),
    getMonitorSnapshot: () => transport.json('GET', `${root}/monitor`),
    listSkills: (input = {}) => transport.json('GET', `${root}/skills`, { query: listQuery(input) }),
    createSkill: (body, options) => transport.json('POST', `${root}/skills`, {
      body, headers: idempotencyHeaders(options)
    }),
    getSkill: (id) => transport.json('GET', skillPath(id)),
    updateSkill: (id, body) => transport.json('PATCH', skillPath(id), { body }),
    listAgents: (input = {}) => transport.json('GET', `${root}/agents`, { query: listQuery(input) }),
    createAgent: (body, options) => transport.json('POST', `${root}/agents`, {
      body, headers: idempotencyHeaders(options)
    }),
    getAgent: (id) => transport.json('GET', agentPath(id)),
    updateAgent: (id, body) => transport.json('PATCH', agentPath(id), { body }),
    updatePresence: (id, body) => transport.json('POST', `${agentPath(id)}/presence`, { body }),
    async listAgentSkills(id) {
      return (await transport.json<{ items: ConveractFabricContactCenterAgentSkill[] }>(
        'GET', `${agentPath(id)}/skills`
      )).items;
    },
    async replaceAgentSkills(id, skills) {
      return (await transport.json<{ items: ConveractFabricContactCenterAgentSkill[] }>(
        'PUT', `${agentPath(id)}/skills`, { body: { skills } }
      )).items;
    },
    listQueues: (input = {}) => transport.json('GET', `${root}/queues`, { query: listQuery(input) }),
    createQueue: (body, options) => transport.json('POST', `${root}/queues`, {
      body, headers: idempotencyHeaders(options)
    }),
    getQueue: (id) => transport.json('GET', queuePath(id)),
    updateQueue: (id, body) => transport.json('PATCH', queuePath(id), { body }),
    async listMemberships(id) {
      return (await transport.json<{ items: ConveractFabricContactCenterMembership[] }>(
        'GET', `${queuePath(id)}/memberships`
      )).items;
    },
    upsertMembership: (id, body) => transport.json('POST', `${queuePath(id)}/memberships`, { body }),
    removeMembership: (queueId, agentId) => transport.json(
      'DELETE', `${queuePath(queueId)}/memberships/${pathSegment(agentId, 'agentId')}`
    ),
    async listQueueSkillRequirements(id) {
      return (await transport.json<{ items: ConveractFabricContactCenterSkillRequirement[] }>(
        'GET', `${queuePath(id)}/skill-requirements`
      )).items;
    },
    async replaceQueueSkillRequirements(id, requirements) {
      return (await transport.json<{ items: ConveractFabricContactCenterSkillRequirement[] }>(
        'PUT', `${queuePath(id)}/skill-requirements`, { body: { requirements } }
      )).items;
    },
    listQueueEntries: (id, input = {}) => transport.json('GET', `${queuePath(id)}/entries`, {
      query: {
        state: input.state || '', cursor: input.cursor || '', limit: optionalNumber(input.limit)
      }
    }),
    listCallbacks: (input = {}) => transport.json('GET', `${root}/callbacks`, {
      query: {
        queue_id: input.queue_id || '', state: input.state || '',
        cursor: input.cursor || '', limit: optionalNumber(input.limit)
      }
    }),
    requestCallback: (body, options) => transport.json('POST', `${root}/callbacks`, {
      body, headers: idempotencyHeaders(options)
    }),
    getCallback: (id) => transport.json('GET', callbackPath(id)),
    cancelCallback: (id, body = {}) => transport.json('POST', `${callbackPath(id)}/cancel`, { body }),
    offerNext: (body, options) => transport.json('POST', `${root}/routing/assignments`, {
      body, headers: idempotencyHeaders(options)
    }),
    actOnAssignment: (id, action, body = {}) => transport.json(
      'POST', `${root}/assignments/${pathSegment(id, 'assignmentId')}/${action}`, { body }
    ),
    startSupervisor: (input, options) => transport.json('POST', `${root}/supervisor/actions`, {
      body: { action: 'start', ...input }, headers: idempotencyHeaders(options)
    }),
    endSupervisor: (sessionId, input = {}) => transport.json('POST', `${root}/supervisor/actions`, {
      body: { action: 'end', session_id: sessionId, ...input }
    })
  };
}

interface ConveractFabricTransport {
  json<T>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      rawBody?: ConveractFabricSdkRequestBody;
      contentType?: string;
      headers?: Record<string, string>;
      query?: Record<string, string>;
    }
  ): Promise<T>;
  binary(
    method: string,
    path: string,
    options?: { query?: Record<string, string> }
  ): Promise<ConveractFabricSdkBinary>;
}

function createTransport(input: ConveractFabricHttpSdkInput): ConveractFabricTransport {
  const baseUrl = validBaseUrl(input.baseUrl);
  const tenantId = requiredString(input.tenantId, 'tenantId is required');
  const apiKey = String(input.apiKey || '').trim();
  const accessToken = String(input.accessToken || '').trim();
  if (Boolean(apiKey) === Boolean(accessToken)) {
    throw new Error('exactly one of apiKey or accessToken is required');
  }
  const userId = String(input.userId || '').trim();
  const timeoutMs = validTimeout(input.timeoutMs);
  const fetchImpl = input.fetch || globalThis.fetch;
  if (!fetchImpl) throw new Error('fetch is required');

  const send = async (
    method: string,
    path: string,
    options: {
      body?: unknown;
      rawBody?: ConveractFabricSdkRequestBody;
      contentType?: string;
      headers?: Record<string, string>;
      query?: Record<string, string>;
    } = {}
  ): Promise<Response> => {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(options.query || {})) {
      if (value) url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = {
      'x-tenant-id': tenantId,
      ...(apiKey ? { 'x-api-key': apiKey } : { authorization: `Bearer ${accessToken}` }),
      ...(apiKey && userId ? { 'x-user-id': userId } : {}),
      ...(options.headers || {})
    };
    const init: RequestInit = { method, headers };
    if (options.rawBody !== undefined) {
      init.body = options.rawBody;
      if (options.contentType) headers['content-type'] = options.contentType;
    } else if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    const controller = new AbortController();
    init.signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url.toString(), init);
    } catch (error) {
      const message = controller.signal.aborted
        ? `${method} ${path} timed out after ${timeoutMs}ms`
        : `${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`;
      throw new ConveractFabricHttpSdkError(message, 0, method, path, null);
    } finally {
      clearTimeout(timer);
    }
  };

  const requireOk = async (response: Response, method: string, path: string): Promise<void> => {
    if (response.ok) return;
    const payload = await readPayload(response);
    throw new ConveractFabricHttpSdkError(
      `${method} ${path} failed with ${response.status}: ${errorDetail(payload)}`,
      response.status,
      method,
      path,
      payload
    );
  };

  return {
    async json<T>(method: string, path: string, options = {}) {
      const response = await send(method, path, options);
      await requireOk(response, method, path);
      return await readPayload(response) as T;
    },
    async binary(method, path, options = {}) {
      const response = await send(method, path, options);
      await requireOk(response, method, path);
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get('content-type') || 'application/octet-stream',
        filename: responseFilename(response.headers.get('content-disposition'))
      };
    }
  };
}

function createIvrClient(transport: ConveractFabricTransport): ConveractFabricIvrHttpClient {
  const flowPath = (id: string) => `/api/ivekit/ivr/flows/${pathSegment(id, 'flowId')}`;
  const sessionPath = (id: string) => `/api/ivekit/ivr/sessions/${pathSegment(id, 'sessionId')}`;
  const resourcePath = (collection: string, id: string) =>
    `/api/ivekit/ivr/${collection}/${pathSegment(id, 'resourceId')}`;
  return {
    async listFlows() { return (await transport.json<{ items: ConveractFabricIvrFlow[] }>('GET', '/api/ivekit/ivr/flows')).items; },
    createFlow: (body) => transport.json('POST', '/api/ivekit/ivr/flows', { body }),
    getFlow: (id) => transport.json('GET', flowPath(id)),
    updateFlow: (id, body) => transport.json('PATCH', flowPath(id), { body }),
    async listVersions(id) { return (await transport.json<{ items: ConveractFabricIvrFlowVersion[] }>('GET', `${flowPath(id)}/versions`)).items; },
    validateFlow: (id) => transport.json('POST', `${flowPath(id)}/validate`),
    publishFlow: (id, expected, options) => transport.json('POST', `${flowPath(id)}/publish`, {
      body: { expected_draft_revision: expected }, headers: { 'idempotency-key': options.idempotencyKey }
    }),
    rollbackFlow: (id, body, options) => transport.json('POST', `${flowPath(id)}/rollback`, {
      body, headers: { 'idempotency-key': options.idempotencyKey }
    }),
    simulate: (body) => transport.json('POST', '/api/ivekit/ivr/simulations', { body }),
    async listSessions(input = {}) {
      return (await transport.json<{ items: ConveractFabricIvrSession[] }>('GET', '/api/ivekit/ivr/sessions', {
        query: { limit: optionalNumber(input.limit) }
      })).items;
    },
    startSession: (body) => transport.json('POST', '/api/ivekit/ivr/sessions', { body }),
    getSession: (id) => transport.json('GET', sessionPath(id)),
    advanceSession: (id, body) => transport.json('POST', `${sessionPath(id)}/advance`, { body }),
    async listAudioAssets() { return (await transport.json<{ items: ConveractFabricIvrAudioAsset[] }>('GET', '/api/ivekit/ivr/audio-assets')).items; },
    createAudioAsset: (body) => transport.json('POST', '/api/ivekit/ivr/audio-assets', { body }),
    getAudioAsset: (id) => transport.json('GET', resourcePath('audio-assets', id)),
    updateAudioAsset: (id, body) => transport.json('PATCH', resourcePath('audio-assets', id), { body }),
    async listTimeGroups() { return (await transport.json<{ items: ConveractFabricIvrTimeGroup[] }>('GET', '/api/ivekit/ivr/time-groups')).items; },
    createTimeGroup: (body) => transport.json('POST', '/api/ivekit/ivr/time-groups', { body }),
    getTimeGroup: (id) => transport.json('GET', resourcePath('time-groups', id)),
    updateTimeGroup: (id, body) => transport.json('PATCH', resourcePath('time-groups', id), { body }),
    async listRegionGroups() { return (await transport.json<{ items: ConveractFabricIvrRegionGroup[] }>('GET', '/api/ivekit/ivr/region-groups')).items; },
    createRegionGroup: (body) => transport.json('POST', '/api/ivekit/ivr/region-groups', { body }),
    getRegionGroup: (id) => transport.json('GET', resourcePath('region-groups', id)),
    updateRegionGroup: (id, body) => transport.json('PATCH', resourcePath('region-groups', id), { body }),
    async listRingGroups() { return (await transport.json<{ items: ConveractFabricIvrRingGroup[] }>('GET', '/api/ivekit/ivr/ring-groups')).items; },
    createRingGroup: (body) => transport.json('POST', '/api/ivekit/ivr/ring-groups', { body }),
    getRingGroup: (id) => transport.json('GET', resourcePath('ring-groups', id)),
    updateRingGroup: (id, body) => transport.json('PATCH', resourcePath('ring-groups', id), { body }),
    getSettings: () => transport.json('GET', '/api/ivekit/ivr/settings'),
    updateSettings: (body) => transport.json('PATCH', '/api/ivekit/ivr/settings', { body })
  };
}

function createVoiceClient(transport: ConveractFabricTransport): ConveractFabricVoiceHttpClient {
  const resourcePath = (collection: string, id: string, field: string) =>
    `/api/ivekit/voice/${collection}/${pathSegment(id, field)}`;
  const profilePath = (id: string) => resourcePath('profiles', id, 'profileId');
  const trunkPath = (id: string) => resourcePath('trunks', id, 'trunkId');
  const didPath = (id: string) => resourcePath('dids', id, 'didId');
  const extensionPath = (id: string) => resourcePath('extensions', id, 'extensionId');
  const routePath = (id: string) => resourcePath('routes', id, 'routeId');
  const callPath = (id: string) => resourcePath('calls', id, 'callId');
  const idempotencyHeaders = (options: ConveractFabricVoiceIdempotencyOptions) => ({
    'Idempotency-Key': requiredString(options?.idempotencyKey, 'idempotencyKey is required')
  });

  return {
    getCapabilities: () => transport.json('GET', '/api/ivekit/voice/capabilities'),
    listProfiles: (input = {}) => transport.json('GET', '/api/ivekit/voice/profiles', {
      query: voicePageQuery(input)
    }),
    createProfile: (body) => transport.json('POST', '/api/ivekit/voice/profiles', { body }),
    getProfile: (id) => transport.json('GET', profilePath(id)),
    updateProfile: (id, body) => transport.json('PATCH', profilePath(id), { body }),
    preflightProfile: (id) => transport.json('POST', `${profilePath(id)}/preflight`),
    getProfileCapabilities: (id) => transport.json('GET', `${profilePath(id)}/capabilities`),
    listTrunks: (input = {}) => transport.json('GET', '/api/ivekit/voice/trunks', {
      query: { ...voicePageQuery(input), profile_id: input.profile_id || '' }
    }),
    createTrunk: (body) => transport.json('POST', '/api/ivekit/voice/trunks', { body }),
    getTrunk: (id) => transport.json('GET', trunkPath(id)),
    updateTrunk: (id, body) => transport.json('PATCH', trunkPath(id), { body }),
    applyTrunk: (id, options) => transport.json('POST', `${trunkPath(id)}/apply`, {
      headers: idempotencyHeaders(options)
    }),
    testTrunk: (id, options) => transport.json('POST', `${trunkPath(id)}/test`, {
      headers: idempotencyHeaders(options)
    }),
    listDids: (input = {}) => transport.json('GET', '/api/ivekit/voice/dids', {
      query: { ...voicePageQuery(input), trunk_id: input.trunk_id || '' }
    }),
    createDid: (body) => transport.json('POST', '/api/ivekit/voice/dids', { body }),
    getDid: (id) => transport.json('GET', didPath(id)),
    updateDid: (id, body) => transport.json('PATCH', didPath(id), { body }),
    applyDid: (id, options) => transport.json('POST', `${didPath(id)}/apply`, {
      headers: idempotencyHeaders(options)
    }),
    listExtensions: (input = {}) => transport.json('GET', '/api/ivekit/voice/extensions', {
      query: { ...voicePageQuery(input), profile_id: input.profile_id || '' }
    }),
    createExtension: (body) => transport.json('POST', '/api/ivekit/voice/extensions', { body }),
    getExtension: (id) => transport.json('GET', extensionPath(id)),
    updateExtension: (id, body) => transport.json('PATCH', extensionPath(id), { body }),
    applyExtension: (id, options) => transport.json('POST', `${extensionPath(id)}/apply`, {
      headers: idempotencyHeaders(options)
    }),
    createExtensionSession: (id, options) => transport.json('POST', `${extensionPath(id)}/session`, {
      headers: idempotencyHeaders(options)
    }),
    listRoutes: (input = {}) => transport.json('GET', '/api/ivekit/voice/routes', {
      query: { ...voicePageQuery(input), profile_id: input.profile_id || '' }
    }),
    createRoute: (body) => transport.json('POST', '/api/ivekit/voice/routes', { body }),
    getRoute: (id) => transport.json('GET', routePath(id)),
    updateRoute: (id, body) => transport.json('PATCH', routePath(id), { body }),
    validateRoute: (id, body = {}) => transport.json('POST', `${routePath(id)}/validate`, { body }),
    listRouteVersions: (id) => transport.json('GET', `${routePath(id)}/versions`),
    publishRoute: (id, body, options) => transport.json('POST', `${routePath(id)}/publish`, {
      body,
      headers: idempotencyHeaders(options)
    }),
    listCalls: (input = {}) => transport.json('GET', '/api/ivekit/voice/calls', {
      query: {
        ...voicePageQuery(input),
        state: input.state || '',
        business_ref_type: input.business_ref?.type || '',
        business_ref_id: input.business_ref?.id || ''
      }
    }),
    listParkingSlots: (input = {}) => transport.json('GET', '/api/ivekit/voice/parking-slots', {
      query: {
        ...voicePageQuery(input),
        profile_id: input.profile_id || '',
        state: input.state || ''
      }
    }),
    createOutboundCall: (body, options) => transport.json('POST', '/api/ivekit/voice/calls', {
      body,
      headers: idempotencyHeaders(options)
    }),
    getCall: (id) => transport.json('GET', callPath(id)),
    enqueueCallAction: (id, body, options) => transport.json('POST', `${callPath(id)}/actions`, {
      body,
      headers: idempotencyHeaders(options)
    }),
    createLiveKitBridge: (id, body, options) => transport.json('POST', `${callPath(id)}/livekit-bridge`, {
      body,
      headers: idempotencyHeaders(options)
    }),
    listCallEvents: (id, input = {}) => transport.json('GET', `${callPath(id)}/events`, {
      query: voicePageQuery(input)
    }),
    listCallRecordings: (id, input = {}) => transport.json('GET', `${callPath(id)}/recordings`, {
      query: { ...voicePageQuery(input), status: input.status || '' }
    }),
    listCallBridges: (id) => transport.json('GET', `${callPath(id)}/bridges`),
    listCallParticipants: (id) => transport.json('GET', `${callPath(id)}/participants`),
    getPolicy: () => transport.json('GET', '/api/ivekit/voice/policy'),
    updatePolicy: (body) => transport.json('PATCH', '/api/ivekit/voice/policy', { body }),
    listConsents: (input = {}) => transport.json('GET', '/api/ivekit/voice/consents', {
      query: {
        ...voicePageQuery(input),
        subject_ref_type: input.subject_ref_type || '',
        subject_ref_id: input.subject_ref_id || ''
      }
    }),
    createConsent: (body) => transport.json('POST', '/api/ivekit/voice/consents', { body }),
    listRecordings: (input = {}) => transport.json('GET', '/api/ivekit/voice/recordings', {
      query: {
        ...voicePageQuery(input),
        call_id: input.call_id || '',
        status: input.status || ''
      }
    })
  };
}

function createMediaClient(transport: ConveractFabricTransport): ConveractFabricMediaHttpClient {
  const callPath = (callId: string) => `/api/ivekit/media/calls/${pathSegment(callId, 'callId')}`;
  const roomPath = (roomName: string) => `/api/ivekit/media/rooms/${pathSegment(roomName, 'roomName')}`;
  const participantPath = (roomName: string, identity: string) =>
    `${roomPath(roomName)}/participants/${pathSegment(identity, 'identity')}`;
  const recordingPath = (recordingId: string) =>
    `/api/ivekit/media/recordings/${pathSegment(recordingId, 'recordingId')}`;
  const ingressPath = (ingressId: string) =>
    `/api/ivekit/media/ingresses/${pathSegment(ingressId, 'ingressId')}`;
  return {
    getCapabilities: () => transport.json('GET', '/api/ivekit/media/capabilities'),
    createIngress: (input, options) => transport.json(
      'POST',
      '/api/ivekit/media/ingresses',
      {
        body: input,
        headers: {
          'Idempotency-Key': requiredString(
            options?.idempotencyKey,
            'idempotencyKey is required'
          )
        }
      }
    ),
    listIngresses: (input) => transport.json('GET', '/api/ivekit/media/ingresses', {
      query: { room_name: requiredString(input?.room_name, 'room_name is required') }
    }),
    getIngress: (ingressId) => transport.json('GET', ingressPath(ingressId)),
    updateIngress: (ingressId, input) => transport.json(
      'PATCH', ingressPath(ingressId), { body: input }
    ),
    deleteIngress: (ingressId) => transport.json('DELETE', ingressPath(ingressId)),
    createCall: (input) => transport.json('POST', '/api/ivekit/media/calls', { body: input }),
    getCall: (callId) => transport.json('GET', callPath(callId)),
    transitionCall: (callId, input, options) => transport.json(
      'POST',
      `${callPath(callId)}/actions`,
      {
        body: input,
        headers: { 'Idempotency-Key': requiredString(options?.idempotencyKey, 'idempotencyKey is required') }
      }
    ),
    createCallJoinPlan: (callId, input) => transport.json(
      'POST',
      `${callPath(callId)}/join`,
      { body: input }
    ),
    listCallParticipants: (callId) => transport.json('GET', `${callPath(callId)}/participants`),
    reportCallQuality: (callId, snapshots) => transport.json(
      'POST',
      `${callPath(callId)}/qos`,
      { body: { snapshots } }
    ),
    getCallQuality: (callId, input = {}) => transport.json(
      'GET',
      `${callPath(callId)}/qos`,
      { query: { limit: optionalNumber(input.limit) } }
    ),
    reportCallConnectionEvent: (callId, input) => transport.json(
      'POST',
      `${callPath(callId)}/connection-events`,
      { body: input }
    ),
    listRealtimeSpeech: (callId, input = {}) => transport.json(
      'GET',
      `${callPath(callId)}/realtime-speech`,
      { query: { limit: optionalNumber(input.limit), cursor: input.cursor || '' } }
    ),
    createRoom: (input) => transport.json('POST', '/api/ivekit/media/rooms', { body: input }),
    getRoom: (roomName) => transport.json('GET', roomPath(roomName)),
    closeRoom: (roomName) => transport.json('POST', `${roomPath(roomName)}/close`, { body: {} }),
    createJoinPlan: (roomName, input) => transport.json('POST', `${roomPath(roomName)}/join`, { body: input }),
    listParticipants: (roomName, input = {}) => transport.json(
      'GET',
      `${roomPath(roomName)}/participants`,
      {
        query: {
          include_left: input.include_left ? '1' : '',
          limit: optionalNumber(input.limit)
        }
      }
    ),
    muteParticipant: (roomName, identity, input, options) => transport.json(
      'POST',
      `${participantPath(roomName, identity)}/mute`,
      {
        body: input,
        headers: { 'Idempotency-Key': requiredString(options?.idempotencyKey, 'idempotencyKey is required') }
      }
    ),
    removeParticipant: (roomName, identity, input, options) => transport.json(
      'POST',
      `${participantPath(roomName, identity)}/remove`,
      {
        body: input,
        headers: { 'Idempotency-Key': requiredString(options?.idempotencyKey, 'idempotencyKey is required') }
      }
    ),
    recoverModerationCommands: (input = {}) => transport.json(
      'POST',
      '/api/ivekit/media/moderation/recover',
      { body: { limit: input.limit } }
    ),
    startRecording: (roomName, input) => transport.json(
      'POST',
      `${roomPath(roomName)}/recordings/start`,
      { body: input }
    ),
    stopRecording: (recordingOrEgressId) => transport.json(
      'POST',
      `/api/ivekit/media/recordings/${pathSegment(recordingOrEgressId, 'recordingOrEgressId')}/stop`,
      { body: {} }
    ),
    listRecordings: (input = {}) => transport.json('GET', '/api/ivekit/media/recordings', {
      query: recordingListQuery(input)
    }),
    listRecordingsPage: (input = {}) => transport.json('GET', '/api/ivekit/media/recordings', {
      query: { ...recordingListQuery(input), cursor: input.cursor || '', page: '1' }
    }),
    getRecording: (recordingId) => transport.json('GET', recordingPath(recordingId)),
    listRecordingJobs: (recordingId) => transport.json('GET', `${recordingPath(recordingId)}/jobs`),
    inspectRecordingObject: (recordingId) => transport.json('GET', `${recordingPath(recordingId)}/object`),
    exportRecordingObject: (recordingId) => transport.binary('GET', `${recordingPath(recordingId)}/export`),
    inspectRecordingJobObject: (recordingId, jobId) => transport.json(
      'GET',
      `${recordingPath(recordingId)}/jobs/${pathSegment(jobId, 'jobId')}/object`
    ),
    exportRecordingJobObject: (recordingId, jobId) => transport.binary(
      'GET',
      `${recordingPath(recordingId)}/jobs/${pathSegment(jobId, 'jobId')}/export`
    ),
    cleanupRecordings: (input = {}) => transport.json(
      'POST',
      '/api/ivekit/media/recordings/retention/cleanup',
      { body: input }
    )
  };
}

function createChatClient(
  transport: ConveractFabricTransport,
  upload: ReturnType<typeof createAttachmentUploadClient>
): ConveractFabricChatHttpClient {
  const sessionPath = (sessionId: string) =>
    `/api/ivekit/chat/sessions/${pathSegment(sessionId, 'sessionId')}`;
  const messagePath = (sessionId: string, messageId: string) =>
    `${sessionPath(sessionId)}/messages/${pathSegment(messageId, 'messageId')}`;
  const attachmentPath = (sessionId: string, attachmentId: string) =>
    `${sessionPath(sessionId)}/attachments/${pathSegment(attachmentId, 'attachmentId')}`;
  const secureFilePath = (sessionId: string, fileId?: string) =>
    `${sessionPath(sessionId)}/files` +
    (fileId ? `/${pathSegment(fileId, 'fileId')}` : '');
  const findingPath = (sessionId: string, findingId: string) =>
    `${sessionPath(sessionId)}/findings/${pathSegment(findingId, 'findingId')}`;

  return {
    getCapabilities: () => transport.json('GET', '/api/ivekit/chat/capabilities'),
    openSession: (input) => transport.json('POST', '/api/ivekit/chat/sessions', { body: input }),
    closeSession: (sessionId) => transport.json('POST', `${sessionPath(sessionId)}/close`, { body: {} }),
    listSessions: (input = {}) => transport.json('GET', '/api/ivekit/chat/sessions', {
      query: {
        status: input.status || '',
        business_ref_type: input.business_ref_type || '',
        business_ref_id: input.business_ref_id || '',
        query: input.query || '',
        cursor: input.cursor || '',
        limit: optionalNumber(input.limit)
      }
    }),
    listSessionsByBusinessRef: (businessRef, input = {}) => transport.json(
      'GET',
      '/api/ivekit/chat/sessions/by-ref',
      {
        query: {
          business_ref_type: requiredString(businessRef.type, 'businessRef.type is required'),
          business_ref_id: requiredString(businessRef.id, 'businessRef.id is required'),
          limit: optionalNumber(input.limit)
        }
      }
    ),
    bindSession: (sessionId, input = {}) => transport.json('POST', `${sessionPath(sessionId)}/bind`, { body: input }),
    createClientPlan: (sessionId, input) => transport.json(
      'POST',
      `${sessionPath(sessionId)}/client-plan`,
      { body: input }
    ),
    addParticipant: (sessionId, input) => transport.json(
      'POST',
      `${sessionPath(sessionId)}/participants`,
      { body: input }
    ),
    leaveParticipant: (sessionId, input) => transport.json(
      'POST',
      `${sessionPath(sessionId)}/participants/leave`,
      { body: input }
    ),
    listMessages: (sessionId, input = {}) => transport.json(
      'GET',
      `${sessionPath(sessionId)}/messages`,
      { query: { limit: optionalNumber(input.limit) } }
    ),
    listMessagesPage: (sessionId, input = {}) => transport.json(
      'GET',
      `${sessionPath(sessionId)}/messages`,
      {
        query: {
          direction: input.direction || 'before',
          query: input.query || '',
          cursor: input.cursor || '',
          limit: optionalNumber(input.limit)
        }
      }
    ),
    postMessage: (sessionId, input, options = {}) => transport.json(
      'POST',
      `${sessionPath(sessionId)}/messages`,
      {
        body: input,
        headers: options.idempotencyKey
          ? { 'idempotency-key': requiredString(options.idempotencyKey, 'idempotencyKey is required') }
          : undefined
      }
    ),
    getSnapshot: (sessionId, input = {}) => transport.json(
      'GET',
      `${sessionPath(sessionId)}/snapshot`,
      { query: { limit: optionalNumber(input.limit) } }
    ),
    getDelivery: (sessionId, messageId) => transport.json('GET', `${messagePath(sessionId, messageId)}/delivery`),
    retryDelivery: (sessionId, messageId) => transport.json(
      'POST',
      `${messagePath(sessionId, messageId)}/delivery/retry`,
      { body: {} }
    ),
    getTinodeOperations: () => transport.json(
      'GET',
      '/api/ivekit/chat/operations/tinode'
    ),
    async listTinodeDeadLetters(input = {}) {
      return (await transport.json<{ items: ConveractFabricTinodeDeadLetter[] }>(
        'GET',
        '/api/ivekit/chat/operations/tinode/dead-letters',
        {
          query: {
            state: input.state || 'open',
            limit: optionalNumber(input.limit)
          }
        }
      )).items;
    },
    replayTinodeDeadLetter: (deadLetterId, options) => transport.json(
      'POST',
      `/api/ivekit/chat/operations/tinode/dead-letters/${pathSegment(deadLetterId, 'deadLetterId')}/replay`,
      {
        body: {},
        headers: {
          'idempotency-key': requiredString(
            options?.idempotencyKey,
            'idempotencyKey is required'
          )
        }
      }
    ),
    async listTinodeMutationDeadLetters(input = {}) {
      return (await transport.json<{ items: ConveractFabricTinodeMutationDeadLetter[] }>(
        'GET',
        '/api/ivekit/chat/operations/tinode/mutation-dead-letters',
        { query: { limit: optionalNumber(input.limit) } }
      )).items;
    },
    replayTinodeMutationDeadLetter: (outboxId, options) => transport.json(
      'POST',
      `/api/ivekit/chat/operations/tinode/mutation-dead-letters/${pathSegment(outboxId, 'outboxId')}/replay`,
      {
        body: {},
        headers: {
          'idempotency-key': requiredString(options?.idempotencyKey, 'idempotencyKey is required')
        }
      }
    ),
    listReceipts: (sessionId, messageId) => transport.json('GET', `${messagePath(sessionId, messageId)}/receipts`),
    markReceipt: (sessionId, messageId, input) => transport.json(
      'POST',
      `${messagePath(sessionId, messageId)}/receipts`,
      { body: input }
    ),
    getMessageState: (sessionId) => transport.json('GET', `${sessionPath(sessionId)}/message-state`),
    setTyping: (sessionId, input) => transport.json('POST', `${sessionPath(sessionId)}/typing`, { body: input }),
    setPresence: (sessionId, input) => transport.json('POST', `${sessionPath(sessionId)}/presence`, { body: input }),
    listRealtimeState: (sessionId) => transport.json('GET', `${sessionPath(sessionId)}/realtime-state`),
    editMessage: (sessionId, messageId, input) => transport.json(
      'PATCH',
      messagePath(sessionId, messageId),
      { body: input }
    ),
    deleteMessage: (sessionId, messageId, input = {}) => transport.json(
      'DELETE',
      messagePath(sessionId, messageId),
      { body: input }
    ),
    listMutations: (sessionId, messageId) => transport.json('GET', `${messagePath(sessionId, messageId)}/mutations`),
    listReactions: (sessionId, messageId) => transport.json(
      'GET',
      `${messagePath(sessionId, messageId)}/reactions`
    ),
    addReaction: (sessionId, messageId, emoji) => transport.json(
      'PUT',
      `${messagePath(sessionId, messageId)}/reactions/${pathSegment(emoji, 'emoji')}`
    ),
    removeReaction: (sessionId, messageId, emoji) => transport.json(
      'DELETE',
      `${messagePath(sessionId, messageId)}/reactions/${pathSegment(emoji, 'emoji')}`
    ),
    listPins: (sessionId) => transport.json('GET', `${sessionPath(sessionId)}/pins`),
    pinMessage: (sessionId, messageId) => transport.json(
      'PUT',
      `${sessionPath(sessionId)}/pins/${pathSegment(messageId, 'messageId')}`
    ),
    unpinMessage: (sessionId, messageId) => transport.json(
      'DELETE',
      `${sessionPath(sessionId)}/pins/${pathSegment(messageId, 'messageId')}`
    ),
    uploadAttachment: (sessionId, input) => transport.json(
      'POST',
      `${sessionPath(sessionId)}/attachments/upload`,
      {
        rawBody: input.body,
        contentType: requiredString(input.contentType, 'contentType is required'),
        query: {
          kind: requiredString(input.kind, 'kind is required'),
          filename: requiredString(input.filename, 'filename is required')
        }
      }
    ),
    uploadAttachmentWithProgress: (sessionId, input, options = {}) => upload(
      `${sessionPath(sessionId)}/attachments/upload`,
      input,
      options
    ),
    downloadAttachment: (sessionId, attachmentId) => transport.binary(
      'GET',
      `${attachmentPath(sessionId, attachmentId)}/download`
    ),
    async createSecureFile(sessionId, input, options) {
      return (await transport.json<{ file: ConveractFabricSecureFile }>(
        'POST', secureFilePath(sessionId), {
          body: input,
          headers: {
            'idempotency-key': requiredString(
              options?.idempotencyKey,
              'idempotencyKey is required'
            )
          }
        }
      )).file;
    },
    async uploadSecureFileContent(sessionId, fileId, body, sha256) {
      return (await transport.json<{ file: ConveractFabricSecureFile }>(
        'PUT', `${secureFilePath(sessionId, fileId)}/content`, {
          rawBody: body,
          contentType: 'application/octet-stream',
          headers: { 'x-content-sha256': requiredString(sha256, 'sha256 is required') }
        }
      )).file;
    },
    async uploadSecureFilePart(sessionId, fileId, partNumber, body, sha256) {
      return (await transport.json<{ part: ConveractFabricSecureFilePart }>(
        'PUT',
        `${secureFilePath(sessionId, fileId)}/parts/${positivePathInteger(partNumber, 'partNumber')}`,
        {
          rawBody: body,
          contentType: 'application/octet-stream',
          headers: { 'x-content-sha256': requiredString(sha256, 'sha256 is required') }
        }
      )).part;
    },
    async listSecureFileParts(sessionId, fileId) {
      return (await transport.json<{ parts: ConveractFabricSecureFilePart[] }>(
        'GET', `${secureFilePath(sessionId, fileId)}/parts`
      )).parts;
    },
    async completeSecureFile(sessionId, fileId, input) {
      return (await transport.json<{ file: ConveractFabricSecureFile }>(
        'POST', `${secureFilePath(sessionId, fileId)}/complete`, { body: input }
      )).file;
    },
    async getSecureFile(sessionId, fileId) {
      return (await transport.json<{ file: ConveractFabricSecureFile }>(
        'GET', secureFilePath(sessionId, fileId)
      )).file;
    },
    async abortSecureFile(sessionId, fileId) {
      return (await transport.json<{ file: ConveractFabricSecureFile }>(
        'DELETE', secureFilePath(sessionId, fileId)
      )).file;
    },
    downloadSecureFile: (sessionId, fileId) => transport.binary(
      'GET', `${secureFilePath(sessionId, fileId)}/download`
    ),
    getAttachment: (sessionId, attachmentId) => transport.json('GET', attachmentPath(sessionId, attachmentId)),
    retryAttachment: (sessionId, attachmentId) => transport.json(
      'POST',
      `${attachmentPath(sessionId, attachmentId)}/retry`,
      { body: {} }
    ),
    listFindings: (sessionId, input = {}) => transport.json('GET', `${sessionPath(sessionId)}/findings`, {
      query: {
        message_id: input.message_id || '',
        source: input.source || '',
        review_status: input.review_status || '',
        limit: optionalNumber(input.limit)
      }
    }),
    getFinding: (sessionId, findingId) => transport.json('GET', findingPath(sessionId, findingId)),
    reviewFinding: (sessionId, findingId, input) => transport.json(
      'POST',
      `${findingPath(sessionId, findingId)}/review`,
      { body: input }
    ),
    getQualityReview: (sessionId, messageId) => transport.json(
      'GET',
      `${messagePath(sessionId, messageId)}/quality-review`
    ),
    enqueueQualityReview: (sessionId, messageId) => transport.json(
      'POST',
      `${messagePath(sessionId, messageId)}/quality-review`,
      { body: {} }
    ),
    runAttachmentProcessing: (input = {}) => transport.json(
      'POST',
      '/api/ivekit/chat/attachment-processing/run',
      { body: input }
    ),
    runQualityReview: (input = {}) => transport.json(
      'POST',
      '/api/ivekit/chat/quality-review/run',
      { body: input }
    ),
    listMessageTranslations: (sessionId, messageId, input = {}) => transport.json(
      'GET', `${messagePath(sessionId, messageId)}/translations`,
      { query: translationListQuery(input) }
    ),
    requestMessageTranslation: (sessionId, messageId, input, options) => transport.json(
      'POST', `${messagePath(sessionId, messageId)}/translations`,
      { body: input, headers: { 'idempotency-key': requiredString(options.idempotencyKey, 'idempotencyKey is required') } }
    ),
    listAttachmentTranslations: (sessionId, attachmentId, input = {}) => transport.json(
      'GET', `${attachmentPath(sessionId, attachmentId)}/translations`,
      { query: translationListQuery(input) }
    ),
    requestAttachmentTranslation: (sessionId, attachmentId, input, options) => transport.json(
      'POST', `${attachmentPath(sessionId, attachmentId)}/translations`,
      { body: input, headers: { 'idempotency-key': requiredString(options.idempotencyKey, 'idempotencyKey is required') } }
    ),
    retryTranslation: (sessionId, jobId) => transport.json(
      'POST', `${sessionPath(sessionId)}/translations/${pathSegment(jobId, 'jobId')}/retry`, { body: {} }
    ),
    runTranslation: (input = {}) => transport.json(
      'POST', '/api/ivekit/chat/translation/run', { body: input }
    )
  };
}

function createIntelligenceClient(transport: ConveractFabricTransport): ConveractFabricIntelligenceHttpClient {
  const sourcePath = (sessionId: string, sourceId?: string) =>
    `/api/ivekit/intelligence/sessions/${pathSegment(sessionId, 'sessionId')}/sources` +
    (sourceId ? `/${pathSegment(sourceId, 'sourceId')}` : '');
  return {
    getCapabilities: () => transport.json('GET', '/api/ivekit/intelligence/capabilities'),
    getPolicy: () => transport.json('GET', '/api/ivekit/intelligence/policy'),
    updatePolicy: (input) => transport.json('PUT', '/api/ivekit/intelligence/policy', { body: input }),
    listProviders: () => transport.json('GET', '/api/ivekit/intelligence/providers'),
    listProviderRuntime: () => transport.json('GET', '/api/ivekit/intelligence/providers/runtime'),
    probeProviderHealth: (input = {}) => transport.json(
      'POST', '/api/ivekit/intelligence/providers/health', { body: input }
    ),
    importSource: (sessionId, input, options) => transport.json('POST', sourcePath(sessionId), {
      body: input,
      headers: { 'idempotency-key': requiredString(options.idempotencyKey, 'idempotencyKey is required') }
    }),
    getSource: (sessionId, sourceId) => transport.json('GET', sourcePath(sessionId, sourceId)),
    retrySource: (sessionId, sourceId) => transport.json('POST', `${sourcePath(sessionId, sourceId)}/retry`, {
      body: {}
    }),
    listFindings: (input = {}) => transport.json('GET', '/api/ivekit/intelligence/findings', {
      query: {
        session_id: input.session_id || '', source: input.source || '', severity: input.severity || '',
        review_status: input.review_status || '', created_from: input.created_from || '',
        created_to: input.created_to || '', cursor: input.cursor || '', limit: optionalNumber(input.limit)
      }
    }),
    getFinding: (findingId) => transport.json(
      'GET', `/api/ivekit/intelligence/findings/${pathSegment(findingId, 'findingId')}`
    ),
    reviewFinding: (findingId, input) => transport.json(
      'POST', `/api/ivekit/intelligence/findings/${pathSegment(findingId, 'findingId')}/review`, { body: input }
    )
  };
}

function createContextClient(transport: ConveractFabricTransport): ConveractFabricContextHttpClient {
  return {
    getByBusinessRef: (businessRef) => transport.json('GET', '/api/ivekit/context/by-ref', {
      query: {
        business_ref_type: requiredString(businessRef.type, 'businessRef.type is required'),
        business_ref_id: requiredString(businessRef.id, 'businessRef.id is required')
      }
    }),
    listTimeline: (businessRef, input = {}) => transport.json('GET', '/api/ivekit/context/timeline', {
      query: {
        business_ref_type: requiredString(businessRef.type, 'businessRef.type is required'),
        business_ref_id: requiredString(businessRef.id, 'businessRef.id is required'),
        cursor: input.cursor || '',
        limit: optionalNumber(input.limit)
      }
    })
  };
}

function createEventClient(transport: ConveractFabricTransport): ConveractFabricEventHttpClient {
  const subscriptionRoot = '/api/ivekit/events/webhook-subscriptions';
  const idempotencyHeaders = (options: { idempotencyKey: string }) => ({
    'idempotency-key': requiredString(options?.idempotencyKey, 'idempotencyKey is required')
  });
  const subscriptionPath = (id: string) => `${subscriptionRoot}/${pathSegment(id, 'subscriptionId')}`;
  const listPage = async <T = unknown>(input: ConveractFabricEventPageInput): Promise<ConveractFabricEventPage<T>> => {
    const cursor = requiredString(input.cursor, 'cursor is required');
    try {
      return await transport.json<ConveractFabricEventPage<T>>('GET', '/api/ivekit/events', {
        query: { cursor, limit: optionalNumber(input.limit) }
      });
    } catch (error) {
      if (
        error instanceof ConveractFabricHttpSdkError &&
        error.status === 409 &&
        isEventPage(error.payload)
      ) return error.payload as ConveractFabricEventPage<T>;
      throw error;
    }
  };
  return {
    getCatalog: () => transport.json('GET', '/api/ivekit/events/catalog'),
    createWebhookSubscription: (body, options) => transport.json('POST', subscriptionRoot, {
      body,
      headers: idempotencyHeaders(options)
    }),
    listWebhookSubscriptions: (input = {}) => transport.json('GET', subscriptionRoot, {
      query: {
        status: input.status || '',
        cursor: input.cursor || '',
        limit: optionalNumber(input.limit)
      }
    }),
    getWebhookSubscription: async (id) => (await transport.json<{
      subscription: ConveractFabricEventWebhookSubscription;
    }>('GET', subscriptionPath(id))).subscription,
    updateWebhookSubscription: async (id, body, options) => (await transport.json<{
      subscription: ConveractFabricEventWebhookSubscription;
    }>('PUT', subscriptionPath(id), { body, headers: idempotencyHeaders(options) })).subscription,
    archiveWebhookSubscription: async (id, body, options) => (await transport.json<{
      subscription: ConveractFabricEventWebhookSubscription;
    }>('POST', `${subscriptionPath(id)}/archive`, {
      body,
      headers: idempotencyHeaders(options)
    })).subscription,
    async getHeadCursor() {
      const page = await transport.json<ConveractFabricEventPage>('GET', '/api/ivekit/events');
      return requiredString(page.next_cursor, 'event head cursor is missing');
    },
    listPage,
    async replay<T = unknown>(input: ConveractFabricEventReplayInput): Promise<ConveractFabricEventReplayResult<T>> {
      const maxPages = boundedInteger(input.max_pages, 20, 1, 100, 'max_pages');
      const items: ConveractFabricEventReplayResult<T>['items'] = [];
      let cursor = requiredString(input.cursor, 'cursor is required');
      let page: ConveractFabricEventPage<T> = {
        items: [], next_cursor: cursor, has_more: false, snapshot_required: false
      };
      let pages = 0;
      while (pages < maxPages) {
        page = await listPage<T>({ cursor, limit: input.limit });
        pages += 1;
        if (page.snapshot_required) return { ...page, items: [], pages };
        items.push(...page.items);
        cursor = page.next_cursor;
        if (!page.has_more) break;
      }
      return { ...page, items, next_cursor: cursor, pages };
    }
  };
}

function createAttachmentUploadClient(input: ConveractFabricHttpSdkInput) {
  const baseUrl = validBaseUrl(input.baseUrl);
  const tenantId = requiredString(input.tenantId, 'tenantId is required');
  const apiKey = String(input.apiKey || '').trim();
  const accessToken = String(input.accessToken || '').trim();
  const userId = String(input.userId || '').trim();
  const timeoutMs = validTimeout(input.timeoutMs);
  const uploadTransport = input.uploadTransport || createConveractFabricUploadTransport();
  return (
    path: string,
    attachment: ConveractFabricAttachmentUploadInput,
    options: ConveractFabricAttachmentUploadOptions
  ): ConveractFabricUploadOperation<ConveractFabricChatAttachmentUploadDescriptor> => {
    const url = new URL(path, baseUrl);
    url.searchParams.set('kind', requiredString(attachment.kind, 'kind is required'));
    url.searchParams.set('filename', requiredString(attachment.filename, 'filename is required'));
    const headers: Record<string, string> = {
      'x-tenant-id': tenantId,
      'content-type': requiredString(attachment.contentType, 'contentType is required'),
      'x-upload-id': uploadId(),
      ...(apiKey ? { 'x-api-key': apiKey } : { authorization: `Bearer ${accessToken}` }),
      ...(apiKey && userId ? { 'x-user-id': userId } : {})
    };
    let loaded = 0;
    let percent = 0;
    const operation = uploadTransport.upload({
      url: url.toString(),
      headers,
      body: attachment.body,
      timeoutMs,
      fetch: input.fetch,
      onProgress: options.onProgress
        ? (progress) => {
          loaded = Math.max(loaded, progress.loaded);
          percent = Math.max(percent, progress.percent);
          options.onProgress?.({ ...progress, loaded, percent });
        }
        : undefined
    });
    return {
      result: operation.result as Promise<ConveractFabricChatAttachmentUploadDescriptor>,
      abort: operation.abort
    };
  };
}

function uploadId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function validBaseUrl(value: string): URL {
  const parsed = new URL(requiredString(value, 'baseUrl is required'));
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('baseUrl must use http(s)');
  }
  return parsed;
}

function validTimeout(value: number | undefined): number {
  if (value === undefined) return 30_000;
  if (!Number.isInteger(value) || value < 100 || value > 300_000) {
    throw new Error('timeoutMs must be an integer between 100 and 300000');
  }
  return value;
}

function requiredString(value: unknown, message: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(message);
  return normalized;
}

function pathSegment(value: unknown, field: string): string {
  return encodeURIComponent(requiredString(value, `${field} is required`));
}

function positivePathInteger(value: unknown, field: string): string {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${field} must be a positive integer`);
  return String(parsed);
}

function optionalNumber(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

function voicePageQuery(input: ConveractFabricVoicePageInput): Record<string, string> {
  return {
    cursor: input.cursor || '',
    limit: optionalNumber(input.limit)
  };
}

function translationListQuery(input: {
  target_language?: string;
  history?: boolean;
}): Record<string, string> {
  return {
    target_language: input.target_language || '',
    history: input.history ? '1' : ''
  };
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string
): number {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return resolved;
}

function isEventPage(value: unknown): value is ConveractFabricEventPage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const page = value as Partial<ConveractFabricEventPage>;
  return Array.isArray(page.items) &&
    typeof page.next_cursor === 'string' &&
    typeof page.has_more === 'boolean' &&
    page.snapshot_required === true;
}

function recordingListQuery(input: ConveractFabricMediaRecordingListInput): Record<string, string> {
  return {
    limit: optionalNumber(input.limit),
    call_id: input.call_id || '',
    room_name: input.room_name || '',
    business_ref_type: input.business_ref_type || '',
    business_ref_id: input.business_ref_id || '',
    status: input.status || ''
  };
}

async function readPayload(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function responseFilename(contentDisposition: string | null): string {
  if (!contentDisposition) return 'download.bin';
  const encoded = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  return contentDisposition.match(/filename="([^"]+)"/i)?.[1] ||
    contentDisposition.match(/filename=([^;]+)/i)?.[1]?.trim() ||
    'download.bin';
}

function errorDetail(payload: unknown): string {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const nested = record.error && typeof record.error === 'object' && !Array.isArray(record.error)
      ? record.error as Record<string, unknown>
      : null;
    return String(record.error && typeof record.error !== 'object'
      ? record.error
      : nested?.message || record.message || JSON.stringify(record));
  }
  return String(payload || 'empty response');
}
