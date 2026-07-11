export interface IveKitSdkBusinessRef {
  tenant_id?: string;
  type: string;
  id: string;
  display_name?: string;
  metadata?: Record<string, unknown>;
}

export type RemoteConsentScope =
  | 'view_screen'
  | 'control_mouse_keyboard'
  | 'record_screen'
  | 'transfer_file'
  | 'clipboard';

export interface RemoteGatewayAuditEvent {
  external_id: string;
  event_type: string;
  actor_identity: string;
  target: string;
  metadata: Record<string, unknown>;
  occurred_at: string;
}

export type RustDeskPublicKeySource = 'env' | 'file' | 'none';

export interface RustDeskClientConfig {
  provider: 'rustdesk';
  id_server: string;
  relay_server: string;
  api_server: string;
  api_server_error?: string;
  public_key: string;
  public_key_source: RustDeskPublicKeySource;
  public_key_file: string;
  public_key_configured: boolean;
  public_key_error?: string;
  server_key_fingerprint: string;
  manual_fields: {
    id_server: string;
    relay_server: string;
    api_server?: string;
    key: string;
  };
}

export interface RustDeskDevice {
  id: string;
  tenant_id: string;
  business_ref_type: string;
  business_ref_id: string;
  rustdesk_id: string;
  display_name: string;
  status: 'active' | 'inactive';
  runtime_status: 'unknown' | 'online' | 'offline';
  last_seen_at: string | null;
  last_seen_actor: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  deactivated_at: string | null;
}

export type RustDeskDeviceCommandStatus = 'pending' | 'claimed' | 'succeeded' | 'failed';
export type RustDeskDisconnectReason =
  | 'consent_revoked'
  | 'remote_session_ended'
  | 'tool_ended'
  | 'gateway_ended';

export interface RustDeskDeviceCommand {
  id: string;
  tenant_id: string;
  device_id: string;
  external_id: string;
  command_type: 'disconnect_session';
  status: RustDeskDeviceCommandStatus;
  requested_by: string;
  requested_reason: RustDeskDisconnectReason;
  attempt_count: number;
  max_attempts: number;
  claimed_by: string;
  lease_expires_at: string | null;
  next_attempt_at: string | null;
  execution_method: 'session_adapter' | 'service_restart' | null;
  exit_code: number | null;
  duration_ms: number | null;
  stdout_bytes: number | null;
  stderr_bytes: number | null;
  stdout_sha256: string;
  stderr_sha256: string;
  result_metadata: Record<string, unknown>;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

export interface RustDeskPhysicalDisconnectSummary {
  required: true;
  command_id?: string;
  status: RustDeskDeviceCommandStatus | 'unavailable';
}

export interface RemoteGatewayTarget {
  type: 'device' | 'connection' | 'browser' | string;
  id: string;
  display_name?: string;
}

export interface RemoteToolSession {
  id: string;
  tenant_id: string;
  remote_session_id: string;
  provider: string;
  external_id: string;
  launch_url: string;
  status: 'active' | 'ended';
  started_by: string;
  started_at: string;
  ended_at: string | null;
  metadata: Record<string, unknown>;
  physical_disconnect?: RustDeskPhysicalDisconnectSummary;
}

export interface RustDeskGatewayLaunchPlan {
  external_id: string;
  status: 'active' | 'ended';
  launch_url: string;
  target: RemoteGatewayTarget;
  permissions: RemoteConsentScope[];
  runtime: {
    rustdesk_id: string;
    id_server: string;
    relay_server: string;
    api_server: string;
    server_key_fingerprint: string;
    public_key_configured: string;
    public_key_source: string;
  };
  client_config: {
    public_key_configured: boolean;
    public_key_source: string;
    manual_fields: {
      id_server: string;
      relay_server: string;
      api_server?: string;
      key: string;
    };
  };
  actions: {
    can_launch: boolean;
    open_url: string;
    protocol_url: string;
  };
  metadata: Record<string, unknown>;
  created_at: string;
  ended_at: string | null;
}
