import type { IveKitMediaCallStatus } from './media-types.js';
import type { IveKitSdkBusinessRef } from './types.js';

export interface IveKitBusinessContext {
  tenant_id: string;
  business_ref: Pick<IveKitSdkBusinessRef, 'type' | 'id'>;
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
    sessions: IveKitBusinessContextChatSession[];
  };
  media: {
    count: number;
    calls: IveKitBusinessContextMediaCall[];
  };
  remote_assistance: {
    count: number;
    sessions: IveKitBusinessContextRemoteSession[];
    devices: IveKitBusinessContextDevice[];
  };
}

export interface IveKitBusinessContextChatSession {
  id: string;
  title: string;
  status: 'open' | 'closed';
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface IveKitBusinessContextMediaCall {
  id: string;
  title: string;
  media: 'voice' | 'video';
  status: IveKitMediaCallStatus;
  room_name: string;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

export interface IveKitBusinessContextRemoteSession {
  id: string;
  collaboration_session_id: string;
  status: 'created' | 'active' | 'ended';
  mode: string;
  adapter_provider: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export interface IveKitBusinessContextDevice {
  id: string;
  display_name: string;
  status: 'active' | 'inactive';
  runtime_status: 'unknown' | 'online' | 'offline';
  last_seen_at: string | null;
}
