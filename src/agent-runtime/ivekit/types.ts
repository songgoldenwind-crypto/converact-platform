import type { PgQueryable } from '../../db-pg.js';
import type { ChatGateway } from '../collaboration/chat-gateway.js';
import type { RemoteGatewayAuditEvent, RemoteGatewayClient } from '../collaboration/remote-gateway-client.js';
import type { RustDeskGatewaySession } from '../collaboration/rustdesk-gateway-session-store.js';
import type { RustDeskClientConfig } from '../collaboration/rustdesk-client-config.js';
import type { RustDeskDevice } from '../collaboration/rustdesk-device-store.js';
import type { RustDeskGatewayLaunchPlan } from '../collaboration/rustdesk-launch-plan.js';
import type {
  RustDeskAuthorizationCode,
  RustDeskAuthorizationCodeCreateResult
} from '../collaboration/rustdesk-authorization-code-store.js';
import type {
  CollaborationMessage,
  CollaborationMessageAttachmentKind,
  CollaborationMessageAttachmentStatus,
  CollaborationMessageTranslation,
  PolicyEvidenceRef,
  PolicyFindingReviewStatus,
  PolicyFindingSource,
  PolicySeverity,
  PolicyScanResult,
  RemoteAssistanceSession,
  RemoteAuditEvent,
  RemoteConsentEvent,
  RemoteConsentScope,
  RemoteToolSession
} from '../collaboration/types.js';
import type { LiveKitConfig } from '../livekit/config.js';

export interface IveKitFindingQueueItem {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  source: PolicyFindingSource;
  source_ref_id: string;
  policy_type: string;
  severity: PolicySeverity;
  action: string;
  confidence: number | null;
  rationale: string;
  evidence_refs: PolicyEvidenceRef[];
  review_status: PolicyFindingReviewStatus;
  reviewed_by: string;
  reviewed_at: string | null;
  review_note: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface IveKitFindingQueuePage {
  items: IveKitFindingQueueItem[];
  next_cursor: string;
}

export interface IveBusinessRef {
  tenant_id: string;
  type: 'call_session' | 'service_order' | 'support_ticket' | 'remote_support_order' | 'dispute_case' | string;
  id: string;
  display_name?: string;
  metadata?: Record<string, unknown>;
}

export type IveParticipantRole =
  | 'customer'
  | 'agent'
  | 'engineer'
  | 'supervisor'
  | 'ai'
  | 'admin'
  | 'system';

export interface IveParticipantRef {
  identity: string;
  role: IveParticipantRole;
  display_name?: string;
  user_ref?: {
    type: string;
    id: string;
  };
}

export interface IveSessionBundle {
  business_ref: IveBusinessRef;
  collaboration_session_id: string;
  media_room_name: string;
  customer_join_path?: string;
  agent_join_plan?: IveMediaJoinPlan;
  remote_session_id?: string;
  remote_assist_request_path?: string;
  timeline_url?: string;
}

export interface IveMediaRoom {
  id: string;
  tenant_id: string;
  room_name: string;
  purpose: 'voice_service' | 'video_service' | 'screen_share' | 'conference' | 'pstn_bridge';
  status: 'created' | 'active' | 'closed';
  business_ref: IveBusinessRef;
  metadata: Record<string, unknown>;
}

export interface IveMediaJoinPlan {
  channel: 'webrtc' | 'sip_volte';
  room_name: string;
  identity: string;
  role: IveParticipantRole;
  media: 'voice' | 'video';
  token?: string;
  livekit_url?: string;
  join_path?: string;
  expires_at?: string;
  metadata?: Record<string, unknown>;
}

export interface IveEvidenceRecord {
  id: string;
  tenant_id: string;
  business_ref: IveBusinessRef;
  session_id: string;
  kind:
    | 'audio_recording'
    | 'video_recording'
    | 'screen_recording'
    | 'remote_control_log'
    | 'consent_grant'
    | 'consent_revocation'
    | 'chat_export'
    | 'file_snapshot';
  storage_url: string;
  checksum?: string;
  retention_until?: string | null;
  created_by: string;
  created_at: string;
  metadata: Record<string, unknown>;
}

export type IveRemoteConsentScope =
  | 'view_screen'
  | 'control_mouse_keyboard'
  | 'record_screen'
  | 'transfer_file'
  | 'clipboard';

export type IveRemoteAssistEventType =
  | 'pointer.move'
  | 'pointer.click_hint'
  | 'annotation.draw'
  | 'annotation.clear'
  | 'viewport.changed'
  | 'page.action_hint'
  | 'control.action'
  | 'control.result'
  | 'control.requested'
  | 'control.released';

export interface IveCollaborationMessageAttachmentInput {
  kind: CollaborationMessageAttachmentKind;
  storage_url: string;
  filename?: string;
  content_type?: string;
  size_bytes?: number;
  checksum?: string;
  processing_status?: CollaborationMessageAttachmentStatus;
  metadata?: Record<string, unknown>;
}

export interface IveConsentInput {
  tenant_id: string;
  remote_session_id: string;
  actor_identity: string;
  scopes: IveRemoteConsentScope[];
  expires_at?: string | null;
  metadata?: Record<string, unknown>;
}

export interface IveRemoteAssistEvent {
  id: string;
  tenant_id: string;
  remote_session_id: string;
  actor_identity: string;
  event_type: IveRemoteAssistEventType;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface OpenIveSessionInput {
  tenant_id: string;
  business_ref: IveBusinessRef;
  title?: string;
  participants?: IveParticipantRef[];
  media?: {
    enabled: boolean;
    kind: 'voice' | 'video';
    room_name?: string;
    customer_identity?: string;
    agent_identity?: string;
    create_customer_join_path?: boolean;
  };
  remote_assistance?: {
    enabled: boolean;
    mode: 'web_remote_assist' | 'third_party_remote_tool' | 'remote_desktop_gateway';
    adapter_provider?: string;
    started_by: string;
  };
  metadata?: Record<string, unknown>;
}

export interface IveKitModuleInput {
  db: unknown;
  pg: PgQueryable;
  media?: {
    livekit?: LiveKitConfig;
  };
  chatGateway?: ChatGateway;
  remoteGateway?: RemoteGatewayClient;
  evidence?: {
    base_url?: string;
  };
}

export interface IveKitModule {
  sessions: {
    open(input: OpenIveSessionInput): Promise<IveSessionBundle>;
    getByBusinessRef(input: {
      tenant_id: string;
      business_ref: IveBusinessRef;
    }): Promise<IveSessionBundle[]>;
    close(input: {
      tenant_id: string;
      collaboration_session_id: string;
      actor_identity: string;
    }): Promise<void>;
  };
  media: {
    createRoom(input: {
      tenant_id: string;
      business_ref: IveBusinessRef;
      purpose: 'voice_service' | 'video_service' | 'screen_share' | 'conference' | 'pstn_bridge';
      room_name?: string;
      metadata?: Record<string, unknown>;
    }): Promise<IveMediaRoom>;
    issueJoinPlan(input: {
      tenant_id: string;
      room_name: string;
      identity: string;
      role: 'customer' | 'agent' | 'engineer' | 'supervisor';
      media: 'voice' | 'video';
      channel?: 'webrtc' | 'sip_volte';
    }): Promise<IveMediaJoinPlan>;
  };
  collaboration: {
    postMessage(input: {
      tenant_id: string;
      session_id: string;
      sender_identity: string;
      message_type: CollaborationMessage['message_type'];
      body: string;
      original_language?: string;
      metadata?: Record<string, unknown>;
      attachments?: IveCollaborationMessageAttachmentInput[];
    }): Promise<CollaborationMessage>;
    addTranslation(input: {
      tenant_id: string;
      message_id: string;
      target_language: string;
      translated_body: string;
      provider?: string;
      confidence?: number | null;
    }): Promise<CollaborationMessageTranslation>;
    scanPolicy(input: {
      tenant_id: string;
      session_id: string;
      message_id?: string;
      text: string;
    }): Promise<PolicyScanResult>;
    listTimeline(input: {
      tenant_id: string;
      session_id: string;
    }): Promise<unknown[]>;
  };
  remote: {
    create(input: {
      tenant_id: string;
      collaboration_session_id: string;
      business_ref: IveBusinessRef;
      mode: 'web_remote_assist' | 'third_party_remote_tool' | 'remote_desktop_gateway' | 'platform_remote_control';
      adapter_provider?: string;
      started_by: string;
      metadata?: Record<string, unknown>;
    }): Promise<RemoteAssistanceSession>;
    requestConsent(input: IveConsentInput): Promise<RemoteConsentEvent>;
    grantConsent(input: IveConsentInput): Promise<RemoteConsentEvent>;
    denyConsent(input: Omit<IveConsentInput, 'expires_at'>): Promise<RemoteConsentEvent>;
    revokeConsent(input: IveConsentInput): Promise<RemoteConsentEvent>;
    createWebAssistJoin(input: {
      tenant_id: string;
      remote_session_id: string;
      actor_identity: string;
      role: 'customer' | 'agent' | 'engineer';
      expires_in_ms?: number;
    }): Promise<{
      remote_session_id: string;
      role: 'customer' | 'agent' | 'engineer';
      join_path: string;
      expires_at: string;
    }>;
    verifyWebAssistJoin(input: {
      tenant_id: string;
      remote_session_id: string;
      token: string;
      now?: Date;
    }): Promise<{
      tenant_id: string;
      remote_session_id: string;
      actor_identity: string;
      role: 'customer' | 'agent' | 'engineer';
      expires_at: string;
    }>;
    recordAssistEvent(input: {
      tenant_id: string;
      remote_session_id: string;
      actor_identity: string;
      event_type: IveRemoteAssistEventType;
      payload?: Record<string, unknown>;
    }): Promise<IveRemoteAssistEvent>;
    startExternalTool(input: {
      tenant_id: string;
      remote_session_id: string;
      actor_identity: string;
      provider: string;
      external_id?: string;
      launch_url?: string;
      metadata?: Record<string, unknown>;
    }): Promise<RemoteToolSession>;
    endExternalTool(input: {
      tenant_id: string;
      remote_session_id: string;
      tool_session_id: string;
      actor_identity: string;
    }): Promise<RemoteToolSession | null>;
    end(input: {
      tenant_id: string;
      remote_session_id: string;
      actor_identity: string;
    }): Promise<RemoteAssistanceSession | null>;
    listAuditEvents(input: {
      tenant_id: string;
      remote_session_id: string;
      limit?: number;
    }): Promise<RemoteAuditEvent[]>;
  };
  rustdesk: {
    registerDevice(input: {
      tenant_id: string;
      business_ref: IveBusinessRef;
      rustdesk_id: string;
      display_name: string;
      metadata?: Record<string, unknown>;
    }): Promise<RustDeskDevice>;
    listDevicesByBusinessRef(input: {
      tenant_id: string;
      business_ref: IveBusinessRef;
      limit?: number;
    }): Promise<RustDeskDevice[]>;
    deactivateDevice(input: {
      tenant_id: string;
      device_id: string;
    }): Promise<RustDeskDevice | null>;
    heartbeatDevice(input: {
      tenant_id: string;
      device_id: string;
      actor_identity: string;
      runtime_status?: 'online' | 'offline';
      seen_at?: string;
      metadata?: Record<string, unknown>;
    }): Promise<RustDeskDevice | null>;
    requestAuthorizationCode(input: {
      tenant_id: string;
      remote_session_id: string;
      device_id: string;
      scopes: readonly RemoteConsentScope[];
      requested_by: string;
      idempotency_key: string;
      ttl_seconds?: number;
      max_attempts?: number;
    }): Promise<RustDeskAuthorizationCodeCreateResult>;
    getAuthorizationCode(input: {
      tenant_id: string;
      authorization_id: string;
    }): Promise<RustDeskAuthorizationCode | null>;
    verifyAuthorizationCode(input: {
      tenant_id: string;
      authorization_id: string;
      code: string;
      verified_by: string;
    }): Promise<RustDeskAuthorizationCode>;
    getClientConfig(): Promise<RustDeskClientConfig>;
    getGatewayLaunchPlan(input: {
      tenant_id: string;
      external_id: string;
    }): Promise<RustDeskGatewayLaunchPlan>;
    recordGatewayEvent(input: {
      tenant_id: string;
      external_id: string;
      event_type: string;
      actor_identity: string;
      target?: string;
      idempotency_key?: string;
      metadata?: Record<string, unknown>;
      occurred_at?: string;
    }): Promise<RemoteGatewayAuditEvent>;
    listGatewayAuditEvents(input: {
      tenant_id: string;
      external_id: string;
      since?: string;
    }): Promise<RemoteGatewayAuditEvent[]>;
    listGatewaySessions(input: {
      tenant_id: string;
      status?: 'active' | 'ended' | 'all';
      limit?: number;
    }): Promise<RustDeskGatewaySession[]>;
    endGatewaySession(input: {
      tenant_id: string;
      external_id: string;
      actor_identity: string;
    }): Promise<RustDeskGatewaySession>;
    startGatewaySession(input: {
      tenant_id: string;
      remote_session_id: string;
      actor_identity: string;
      device_id: string;
      permissions: readonly RemoteConsentScope[];
      access_mode?: 'attended' | 'unattended';
      authorization_id?: string;
      metadata?: Record<string, unknown>;
    }): Promise<RemoteToolSession>;
  };
  evidence: {
    record(input: {
      tenant_id: string;
      business_ref: IveBusinessRef;
      session_id: string;
      kind: IveEvidenceRecord['kind'];
      storage_url?: string;
      checksum?: string;
      retention_until?: string | null;
      created_by: string;
      metadata?: Record<string, unknown>;
    }): Promise<IveEvidenceRecord>;
    listByBusinessRef(input: {
      tenant_id: string;
      business_ref: IveBusinessRef;
      limit?: number;
    }): Promise<IveEvidenceRecord[]>;
    listBySession(input: {
      tenant_id: string;
      session_id: string;
      limit?: number;
    }): Promise<IveEvidenceRecord[]>;
  };
}
