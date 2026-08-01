import type { ConveractFabricMediaCallStatus } from './media-types.js';
import type { ConveractFabricSdkBusinessRef } from './types.js';

export interface ConveractFabricBusinessContext {
  tenant_id: string;
  business_ref: Pick<ConveractFabricSdkBusinessRef, 'type' | 'id'>;
  viewer: {
    identity: string;
    system: boolean;
  };
  capabilities: {
    chat: boolean;
    media: boolean;
    remote_assistance: boolean;
  };
  chat: {
    count: number;
    sessions: ConveractFabricBusinessContextChatSession[];
  };
  media: {
    count: number;
    calls: ConveractFabricBusinessContextMediaCall[];
  };
  remote_assistance: {
    count: number;
    sessions: ConveractFabricBusinessContextRemoteSession[];
    devices: ConveractFabricBusinessContextDevice[];
  };
  authorization: {
    chat: ConveractFabricBusinessContextChatAuthorization[];
    media: ConveractFabricBusinessContextMediaAuthorization[];
    remote_assistance: ConveractFabricBusinessContextRemoteAuthorization[];
  };
}

export interface ConveractFabricBusinessContextChatSession {
  id: string;
  title: string;
  status: 'open' | 'closed';
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface ConveractFabricBusinessContextMediaCall {
  id: string;
  title: string;
  media: 'voice' | 'video';
  status: ConveractFabricMediaCallStatus;
  room_name: string;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

export interface ConveractFabricBusinessContextRemoteSession {
  id: string;
  collaboration_session_id: string;
  status: 'created' | 'active' | 'ended';
  mode: string;
  adapter_provider: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export interface ConveractFabricBusinessContextDevice {
  id: string;
  display_name: string;
  status: 'active' | 'inactive';
  runtime_status: 'unknown' | 'online' | 'offline';
  last_seen_at: string | null;
}

export interface ConveractFabricBusinessContextChatAuthorization {
  session_id: string;
  viewer_role: string | null;
  participants: Array<{
    identity: string;
    display_name: string;
    role: string;
    status: 'active' | 'left';
  }>;
}

export interface ConveractFabricBusinessContextMediaAuthorization {
  call_id: string;
  viewer_role: string | null;
  viewer_status: string | null;
  participants: Array<{
    identity: string;
    display_name: string;
    role: string;
    status: string;
  }>;
}

export interface ConveractFabricBusinessContextRemoteAuthorization {
  remote_session_id: string;
  viewer_role: string | null;
  consent: {
    active: boolean;
    scopes: string[];
    expires_at: string | null;
  };
  gateway: {
    external_id: string;
    status: 'active' | 'ended';
    permissions: string[];
    controller: {
      status: string;
      owner_identity: string | null;
      lease_expires_at: string | null;
      version: number;
    };
  } | null;
}

export interface ConveractFabricUnifiedTimelineEvent {
  id: string;
  source: 'chat' | 'media' | 'remote' | 'evidence' | 'quality';
  event_type: string;
  resource_type: 'chat_session' | 'media_call' | 'remote_session' | 'evidence' | 'finding';
  resource_id: string;
  actor_identity: string;
  occurred_at: string;
  attributes: Record<string, unknown>;
  evidence_ref: {
    id: string;
    kind: string;
    checksum: string;
    retention_until: string | null;
  } | null;
}

export interface ConveractFabricUnifiedTimelinePage {
  items: ConveractFabricUnifiedTimelineEvent[];
  has_more: boolean;
  next_cursor: string | null;
}
