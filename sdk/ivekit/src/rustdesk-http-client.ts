import type {
  RemoteConsentScope,
  RemoteGatewayAuditEvent,
  RemoteToolSession,
  RustDeskAccessPolicyCurrent,
  RustDeskAccessPolicyEvent,
  RustDeskAccessPolicyHistory,
  RustDeskAccessPolicyMode,
  RustDeskAccessPolicyMutationResult,
  RustDeskAuthorizationCode,
  RustDeskAuthorizationCodeCreateResult,
  RustDeskClientConfig,
  RustDeskClientDistributionArchitecture,
  RustDeskClientDistributionPlatform,
  RustDeskClientDistributionProfile,
  RustDeskClientVersion,
  RustDeskConfiguredFields,
  RustDeskConfirmedOperation,
  RustDeskControlOwnership,
  RustDeskDevice,
  RustDeskDeviceCommand,
  RustDeskDeviceCommandStatus,
  RustDeskDisconnectState,
  RustDeskEvidenceSecurity,
  RustDeskGatewayLaunchPlan,
  RustDeskObservedOperation,
  RustDeskOperationDirection,
  RustDeskOperationEvidence,
  RustDeskOperationEvidenceMetadata,
  RustDeskOperationEvidenceReference,
  RustDeskOperationObserver,
  RustDeskOperationAuthorization,
  RustDeskPermissionScopes,
  RustDeskRuntimeCapabilities,
  RustDeskSecondaryConfirmation,
  RustDeskTerminalArchitecture,
  RustDeskTerminalPlatform,
  RustDeskTerminalProfile
} from './types.js';

export type IveKitRustDeskFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface IveKitRustDeskHttpClientInput {
  baseUrl: string;
  apiKey?: string;
  accessToken?: string;
  tenantId: string;
  userId?: string;
  timeoutMs?: number;
  fetch?: IveKitRustDeskFetch;
}

export interface IveKitRustDeskBusinessRefInput {
  tenant_id?: string;
  type: string;
  id: string;
  display_name?: string;
  metadata?: Record<string, unknown>;
}

export interface RegisterIveKitRustDeskDeviceInput {
  business_ref: IveKitRustDeskBusinessRefInput;
  rustdesk_id: string;
  display_name: string;
  metadata?: Record<string, unknown>;
}

export interface ListIveKitRustDeskDevicesByRefInput {
  business_ref: IveKitRustDeskBusinessRefInput;
  limit?: number;
}

export interface GetIveKitRustDeskClientProfileInput {
  platform: RustDeskClientDistributionPlatform;
  architecture: RustDeskClientDistributionArchitecture;
  client_version: string;
  expected_server_version: string;
  expected_server_key_fingerprint: string;
}

export interface HeartbeatIveKitRustDeskDeviceInput {
  actor_identity: string;
  runtime_status?: 'online' | 'offline';
  seen_at?: string;
  metadata?: Record<string, unknown>;
}

export interface StartIveKitRustDeskGatewaySessionInput {
  remote_session_id: string;
  device_id: string;
  actor_identity: string;
  permissions: readonly RemoteConsentScope[];
  access_mode?: 'attended' | 'unattended';
  authorization_id?: string;
  metadata?: Record<string, unknown>;
}

export interface RequestIveKitRustDeskAuthorizationCodeInput {
  remote_session_id: string;
  device_id: string;
  scopes: readonly RemoteConsentScope[];
  ttl_seconds?: number;
  max_attempts?: number;
}

export interface VerifyIveKitRustDeskAuthorizationCodeInput { code: string; }

export interface IveKitRustDeskAuthorizationCodeOptions { idempotencyKey: string; }

export interface GetIveKitRustDeskGatewayLaunchPlanInput {
  confirmation_id?: string;
}

export interface ConfigureIveKitRustDeskAccessPolicyInput {
  mode: RustDeskAccessPolicyMode;
  allowed_scopes: readonly RemoteConsentScope[];
  business_ref: Pick<IveKitRustDeskBusinessRefInput, 'type' | 'id'>;
  expires_at?: string | null;
  reason: string;
}

export interface RevokeIveKitRustDeskAccessPolicyInput {
  reason: string;
}

export interface IveKitRustDeskAccessPolicyMutationOptions {
  idempotencyKey: string;
}

export interface IssueIveKitRustDeskConfirmationInput {
  operation: RustDeskConfirmedOperation;
  ttl_seconds?: number;
}

export interface AcquireIveKitRustDeskControlInput {
  confirmation_id: string;
  lease_ms?: number;
}

export interface HeartbeatIveKitRustDeskControlInput {
  version: number;
  lease_ms?: number;
}

export interface ReleaseIveKitRustDeskControlInput { version: number; }

export interface TransferIveKitRustDeskControlInput extends HeartbeatIveKitRustDeskControlInput {
  to_identity: string;
  confirmation_id: string;
}

export interface ConfirmIveKitRustDeskOperationInput {
  operation: RustDeskConfirmedOperation;
  confirmation_id: string;
  version?: number;
}

export interface RecordIveKitRustDeskGatewayEventInput {
  event_type: string;
  actor_identity: string;
  target?: string;
  idempotency_key?: string;
  metadata?: Record<string, unknown>;
  occurred_at?: string;
}

export interface ListIveKitRustDeskGatewayAuditEventsInput {
  since?: string;
}

export interface EndIveKitRustDeskGatewaySessionInput {
  actor_identity: string;
}

export interface AuthorizeIveKitRustDeskEmergencyFallbackInput {
  reason: string;
  collateral_sessions_may_disconnect: true;
}

export interface IveKitRustDeskGatewayDisconnectState {
  required: true;
  status: RustDeskDeviceCommandStatus | 'unavailable';
  command: RustDeskDeviceCommand | null;
}

export interface IveKitRustDeskHttpClient {
  getClientConfig(): Promise<RustDeskClientConfig>;
  getClientProfile(input: GetIveKitRustDeskClientProfileInput): Promise<RustDeskClientDistributionProfile>;
  registerDevice(input: RegisterIveKitRustDeskDeviceInput): Promise<RustDeskDevice>;
  getDevice(deviceId: string): Promise<RustDeskDevice>;
  listDevicesByBusinessRef(input: ListIveKitRustDeskDevicesByRefInput): Promise<RustDeskDevice[]>;
  heartbeatDevice(deviceId: string, input: HeartbeatIveKitRustDeskDeviceInput): Promise<RustDeskDevice>;
  deactivateDevice(deviceId: string): Promise<RustDeskDevice>;
  startGatewaySession(input: StartIveKitRustDeskGatewaySessionInput): Promise<RemoteToolSession>;
  getGatewayLaunchPlan(externalId: string, input?: GetIveKitRustDeskGatewayLaunchPlanInput): Promise<RustDeskGatewayLaunchPlan>;
  recordGatewayEvent(
    externalId: string,
    input: RecordIveKitRustDeskGatewayEventInput
  ): Promise<RemoteGatewayAuditEvent>;
  listGatewayAuditEvents(
    externalId: string,
    input?: ListIveKitRustDeskGatewayAuditEventsInput
  ): Promise<RemoteGatewayAuditEvent[]>;
  endGatewaySession(externalId: string, input: EndIveKitRustDeskGatewaySessionInput): Promise<void>;
  authorizeEmergencyFallback(
    externalId: string,
    input: AuthorizeIveKitRustDeskEmergencyFallbackInput
  ): Promise<RustDeskDeviceCommand>;
  getGatewayDisconnectState(externalId: string): Promise<RustDeskDisconnectState>;
}

export interface IveKitRustDeskAuthorizationHttpClient extends IveKitRustDeskHttpClient {
  requestAuthorizationCode(
    input: RequestIveKitRustDeskAuthorizationCodeInput,
    options: IveKitRustDeskAuthorizationCodeOptions
  ): Promise<RustDeskAuthorizationCodeCreateResult>;
  getAuthorizationCode(authorizationId: string): Promise<RustDeskAuthorizationCode>;
  verifyAuthorizationCode(
    authorizationId: string,
    input: VerifyIveKitRustDeskAuthorizationCodeInput
  ): Promise<RustDeskAuthorizationCode>;
}

export interface IveKitRustDeskAccessPolicyHttpClient extends IveKitRustDeskAuthorizationHttpClient {
  getAccessPolicy(deviceId: string): Promise<RustDeskAccessPolicyCurrent>;
  listAccessPolicyHistory(deviceId: string): Promise<RustDeskAccessPolicyHistory>;
  configureAccessPolicy(
    deviceId: string,
    input: ConfigureIveKitRustDeskAccessPolicyInput,
    options: IveKitRustDeskAccessPolicyMutationOptions
  ): Promise<RustDeskAccessPolicyMutationResult>;
  revokeAccessPolicy(
    deviceId: string,
    input: RevokeIveKitRustDeskAccessPolicyInput,
    options: IveKitRustDeskAccessPolicyMutationOptions
  ): Promise<RustDeskAccessPolicyMutationResult>;
}

export interface IveKitRustDeskControlHttpClient extends IveKitRustDeskAccessPolicyHttpClient {
  getControlOwnership(externalId: string): Promise<RustDeskControlOwnership>;
  issueControlConfirmation(externalId: string, input: IssueIveKitRustDeskConfirmationInput): Promise<RustDeskSecondaryConfirmation>;
  acquireControl(externalId: string, input: AcquireIveKitRustDeskControlInput): Promise<RustDeskControlOwnership>;
  heartbeatControl(externalId: string, input: HeartbeatIveKitRustDeskControlInput): Promise<RustDeskControlOwnership>;
  releaseControl(externalId: string, input: ReleaseIveKitRustDeskControlInput): Promise<RustDeskControlOwnership>;
  transferControl(externalId: string, input: TransferIveKitRustDeskControlInput): Promise<RustDeskControlOwnership>;
  confirmOperation(externalId: string, input: ConfirmIveKitRustDeskOperationInput): Promise<RustDeskOperationAuthorization>;
}

export class IveKitRustDeskHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly payload: unknown
  ) {
    super(message);
    this.name = 'IveKitRustDeskHttpError';
  }
}

export function createIveKitRustDeskHttpClient(
  input: IveKitRustDeskHttpClientInput
): IveKitRustDeskControlHttpClient {
  const baseUrl = validateBaseUrl(input.baseUrl);
  const apiKey = String(input.apiKey || '').trim();
  const accessToken = String(input.accessToken || '').trim();
  if (Boolean(apiKey) === Boolean(accessToken)) {
    throw new Error('exactly one of apiKey or accessToken is required');
  }
  const tenantId = requiredString(input.tenantId, 'tenantId is required');
  const userId = String(input.userId || '').trim();
  const timeoutMs = validTimeout(input.timeoutMs);
  const fetchImpl = input.fetch || globalThis.fetch;
  if (!fetchImpl) throw new Error('fetch is required');

  const request = async <T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
    requestHeaders?: Record<string, string>
  ): Promise<T> => {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(query || {})) {
      if (value) url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = {
      ...(apiKey ? { 'x-api-key': apiKey } : { authorization: `Bearer ${accessToken}` }),
      'x-tenant-id': tenantId,
      ...(requestHeaders || {})
    };
    if (apiKey && userId) headers['x-user-id'] = userId;
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const controller = new AbortController();
    init.signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url.toString(), init);
    } catch (error) {
      const message = controller.signal.aborted
        ? `${method} ${path} timed out after ${timeoutMs}ms`
        : `${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`;
      throw new IveKitRustDeskHttpError(message, 0, method, path, null);
    } finally {
      clearTimeout(timer);
    }
    const payload = await readResponsePayload(response);
    if (!response.ok) {
      throw new IveKitRustDeskHttpError(
        `${method} ${path} failed with ${response.status}: ${errorDetail(payload)}`,
        response.status,
        method,
        path,
        payload
      );
    }
    return payload as T;
  };

  return {
    getClientConfig() {
      return request<RustDeskClientConfig>('GET', '/api/ivekit/rustdesk/client-config');
    },
    async getClientProfile(profileInput) {
      const expectedServerVersion = requiredString(
        profileInput.expected_server_version,
        'expected_server_version is required'
      );
      if (expectedServerVersion !== '1.1.15') {
        throw new Error('expected_server_version must equal 1.1.15');
      }
      const expectedFingerprint = requiredString(
        profileInput.expected_server_key_fingerprint,
        'expected_server_key_fingerprint is required'
      );
      if (!/^sha256:[a-f0-9]{16}$/.test(expectedFingerprint)) {
        throw new Error('expected_server_key_fingerprint is invalid');
      }
      const profile = await request<unknown>('GET', '/api/ivekit/rustdesk/client-profile', undefined, {
        platform: profileInput.platform,
        architecture: profileInput.architecture,
        client_version: profileInput.client_version,
        expected_server_version: expectedServerVersion,
        expected_server_key_fingerprint: expectedFingerprint
      });
      return await projectRustDeskClientDistributionProfile(profile, profileInput);
    },
    async registerDevice(device) {
      return projectRustDeskDevice(
        await request<RustDeskDevice>('POST', '/api/ivekit/rustdesk/devices', device)
      );
    },
    async getDevice(deviceId) {
      return projectRustDeskDevice(
        await request<RustDeskDevice>('GET', `/api/ivekit/rustdesk/devices/${encodeURIComponent(requiredString(deviceId, 'deviceId is required'))}`)
      );
    },
    async listDevicesByBusinessRef(input) {
      const businessRef = input.business_ref;
      const devices = await request<unknown>('GET', '/api/ivekit/rustdesk/devices/by-ref', undefined, {
        business_ref_type: requiredString(businessRef?.type, 'business_ref.type is required'),
        business_ref_id: requiredString(businessRef?.id, 'business_ref.id is required'),
        limit: input.limit === undefined ? '' : String(input.limit)
      });
      if (!Array.isArray(devices)) throw new Error('invalid RustDesk device list');
      return devices.map(projectRustDeskDevice);
    },
    async heartbeatDevice(deviceId, input) {
      return projectRustDeskDevice(
        await request<RustDeskDevice>(
          'POST',
          `/api/ivekit/rustdesk/devices/${encodeURIComponent(requiredString(deviceId, 'deviceId is required'))}/heartbeat`,
          input
        )
      );
    },
    async deactivateDevice(deviceId) {
      return projectRustDeskDevice(
        await request<RustDeskDevice>(
          'POST',
          `/api/ivekit/rustdesk/devices/${encodeURIComponent(requiredString(deviceId, 'deviceId is required'))}/deactivate`,
          {}
        )
      );
    },
    async requestAuthorizationCode(authorizationInput, options) {
      const idempotencyKey = requiredString(options?.idempotencyKey, 'idempotencyKey is required');
      return projectRustDeskAuthorizationCodeCreateResult(await request<unknown>(
        'POST',
        '/api/ivekit/rustdesk/authorization-codes',
        projectAuthorizationCodeRequest(authorizationInput),
        undefined,
        { 'idempotency-key': idempotencyKey }
      ));
    },
    async getAuthorizationCode(authorizationId) {
      return projectRustDeskAuthorizationCode(await request<unknown>(
        'GET',
        rustDeskAuthorizationCodePath(authorizationId)
      ));
    },
    async verifyAuthorizationCode(authorizationId, verificationInput) {
      return projectRustDeskAuthorizationCode(await request<unknown>(
        'POST',
        `${rustDeskAuthorizationCodePath(authorizationId)}/verify`,
        { code: requiredString(verificationInput?.code, 'code is required') }
      ));
    },
    async getAccessPolicy(deviceId) {
      const path = rustDeskAccessPolicyPath(deviceId);
      return projectRustDeskAccessPolicyCurrent(
        await request<unknown>('GET', path)
      );
    },
    async listAccessPolicyHistory(deviceId) {
      const path = `${rustDeskAccessPolicyPath(deviceId)}/history`;
      return projectRustDeskAccessPolicyHistory(
        await request<unknown>('GET', path)
      );
    },
    async configureAccessPolicy(deviceId, policyInput, options) {
      const path = rustDeskAccessPolicyPath(deviceId);
      const mutation = projectConfigureAccessPolicyInput(policyInput);
      const idempotencyKey = policyIdempotencyKey(options);
      return projectRustDeskAccessPolicyMutationResult(
        await request<unknown>('PUT', path, mutation, undefined, { 'idempotency-key': idempotencyKey })
      );
    },
    async revokeAccessPolicy(deviceId, policyInput, options) {
      const path = `${rustDeskAccessPolicyPath(deviceId)}/revoke`;
      const mutation = projectRevokeAccessPolicyInput(policyInput);
      const idempotencyKey = policyIdempotencyKey(options);
      return projectRustDeskAccessPolicyMutationResult(
        await request<unknown>('POST', path, mutation, undefined, { 'idempotency-key': idempotencyKey })
      );
    },
    async getControlOwnership(externalId) {
      return projectRustDeskControlOwnership(await request<unknown>('GET', rustDeskControlPath(externalId)));
    },
    async issueControlConfirmation(externalId, confirmationInput) {
      return projectRustDeskSecondaryConfirmation(await request<unknown>(
        'POST', `${rustDeskControlPath(externalId)}/confirmations`, confirmationInput
      ));
    },
    async acquireControl(externalId, controlInput) {
      return projectRustDeskControlOwnership(await request<unknown>(
        'POST', `${rustDeskControlPath(externalId)}/acquire`, controlInput
      ));
    },
    async heartbeatControl(externalId, controlInput) {
      return projectRustDeskControlOwnership(await request<unknown>(
        'POST', `${rustDeskControlPath(externalId)}/heartbeat`, controlInput
      ));
    },
    async releaseControl(externalId, controlInput) {
      return projectRustDeskControlOwnership(await request<unknown>(
        'POST', `${rustDeskControlPath(externalId)}/release`, controlInput
      ));
    },
    async transferControl(externalId, controlInput) {
      return projectRustDeskControlOwnership(await request<unknown>(
        'POST', `${rustDeskControlPath(externalId)}/transfer`, controlInput
      ));
    },
    async confirmOperation(externalId, operationInput) {
      return projectRustDeskOperationAuthorization(await request<unknown>(
        'POST', `${rustDeskControlPath(externalId)}/operations`, operationInput
      ));
    },
    async startGatewaySession(input) {
      if (
        input.access_mode !== undefined &&
        input.access_mode !== 'attended' &&
        input.access_mode !== 'unattended'
      ) {
        throw new Error('access_mode must be attended or unattended');
      }
      if (input.authorization_id !== undefined) {
        requiredString(input.authorization_id, 'authorization_id is required');
      }
      const session = await request<RemoteToolSession>('POST', '/api/ivekit/rustdesk/gateway-sessions', input);
      return projectEvidenceContainer(session, 'remote tool session');
    },
    async getGatewayLaunchPlan(externalId, launchInput = {}) {
      const plan = await request<RustDeskGatewayLaunchPlan>(
        'GET',
        `/api/ivekit/rustdesk/gateway-sessions/${encodeURIComponent(requiredString(externalId, 'externalId is required'))}/launch`,
        undefined,
        { confirmation_id: String(launchInput.confirmation_id || '').trim() }
      );
      return projectEvidenceContainer(plan, 'gateway launch plan');
    },
    async recordGatewayEvent(externalId, input) {
      const result = await request<{ event: RemoteGatewayAuditEvent }>(
        'POST',
        `/api/ivekit/rustdesk/gateway-sessions/${encodeURIComponent(requiredString(externalId, 'externalId is required'))}/events`,
        input
      );
      return result.event;
    },
    async listGatewayAuditEvents(externalId, input = {}) {
      const result = await request<{ events: RemoteGatewayAuditEvent[] }>(
        'GET',
        `/api/ivekit/rustdesk/gateway-sessions/${encodeURIComponent(requiredString(externalId, 'externalId is required'))}/audit`,
        undefined,
        { since: input.since || '' }
      );
      return result.events;
    },
    async endGatewaySession(externalId, input) {
      await request<null>(
        'DELETE',
        `/api/ivekit/rustdesk/gateway-sessions/${encodeURIComponent(requiredString(externalId, 'externalId is required'))}`,
        input
      );
    },
    async authorizeEmergencyFallback(externalId, fallbackInput) {
      const reason = requiredString(fallbackInput.reason, 'reason is required');
      if (reason.length < 8 || reason.length > 500 || /[\r\n]/.test(reason)) {
        throw new Error('reason must be 8 to 500 single-line characters');
      }
      if (fallbackInput.collateral_sessions_may_disconnect !== true) {
        throw new Error('collateral_sessions_may_disconnect must be true');
      }
      const result = await request<{ command: RustDeskDeviceCommand }>(
        'POST',
        `/api/ivekit/rustdesk/gateway-sessions/${encodeURIComponent(requiredString(externalId, 'externalId is required'))}` +
          '/disconnect/emergency-fallback',
        { reason, collateral_sessions_may_disconnect: true }
      );
      return result.command;
    },
    async getGatewayDisconnectState(externalId) {
      const state = await request<RustDeskDisconnectState>(
        'GET',
        `/api/ivekit/rustdesk/gateway-sessions/${encodeURIComponent(requiredString(externalId, 'externalId is required'))}/disconnect`
      );
      return projectRustDeskDisconnectState(state);
    }
  };
}

export function projectRustDeskAccessPolicyCurrent(value: unknown): RustDeskAccessPolicyCurrent {
  const current = policyRecord(value, 'current policy');
  const deviceId = policyString(current.device_id, 'device_id');
  const state = policyEnum(
    current.state,
    ['not_configured', 'active', 'expired', 'revoked'] as const,
    'state'
  );
  if (state === 'not_configured') {
    if (current.policy !== null) throw invalidPolicy('policy');
    return { device_id: deviceId, state, policy: null };
  }
  const policy = projectRustDeskAccessPolicyEvent(current.policy);
  if (policy.device_id !== deviceId || policy.state !== state) throw invalidPolicy('current policy binding');
  return { device_id: deviceId, state, policy };
}

export function projectRustDeskAccessPolicyHistory(value: unknown): RustDeskAccessPolicyHistory {
  const history = policyRecord(value, 'policy history');
  const deviceId = policyString(history.device_id, 'device_id');
  if (!Array.isArray(history.events)) throw invalidPolicy('events');
  const events = history.events.map(projectRustDeskAccessPolicyEvent);
  let previousVersion = 0;
  for (const event of events) {
    if (event.device_id !== deviceId || event.version <= previousVersion) {
      throw invalidPolicy('history ordering or binding');
    }
    previousVersion = event.version;
  }
  return { device_id: deviceId, events };
}

export function projectRustDeskAccessPolicyMutationResult(
  value: unknown
): RustDeskAccessPolicyMutationResult {
  const result = policyRecord(value, 'policy mutation');
  if (typeof result.replayed !== 'boolean') throw invalidPolicy('replayed');
  return {
    policy: projectRustDeskAccessPolicyEvent(result.policy),
    replayed: result.replayed
  };
}

export function projectRustDeskAccessPolicyEvent(value: unknown): RustDeskAccessPolicyEvent {
  const event = policyRecord(value, 'policy event');
  const scopes = policyScopes(event.allowed_scopes, 'allowed_scopes');
  const businessRef = policyRecord(event.business_ref, 'business_ref');
  const version = Number(event.version);
  if (!Number.isInteger(version) || version < 1) throw invalidPolicy('version');
  return {
    id: policyString(event.id, 'id'),
    tenant_id: policyString(event.tenant_id, 'tenant_id'),
    device_id: policyString(event.device_id, 'device_id'),
    event_type: policyEnum(event.event_type, ['configured', 'revoked'] as const, 'event_type'),
    mode: policyEnum(event.mode, ['attended_only', 'unattended_allowed'] as const, 'mode'),
    allowed_scopes: scopes,
    business_ref: {
      type: policyString(businessRef.type, 'business_ref.type'),
      id: policyString(businessRef.id, 'business_ref.id')
    },
    approved_by: policyString(event.approved_by, 'approved_by'),
    reason: policyReason(event.reason),
    expires_at: policyNullableTimestamp(event.expires_at, 'expires_at'),
    version,
    state: policyEnum(event.state, ['active', 'expired', 'revoked', 'superseded'] as const, 'state'),
    created_at: policyTimestamp(event.created_at, 'created_at')
  };
}

function projectConfigureAccessPolicyInput(input: ConfigureIveKitRustDeskAccessPolicyInput) {
  const policy = policyMutationInput(input, [
    'mode',
    'allowed_scopes',
    'business_ref',
    'expires_at',
    'reason'
  ]);
  const businessRef = policyMutationInput(policy.business_ref, ['type', 'id']);
  const mode = policyEnum(policy.mode, ['attended_only', 'unattended_allowed'] as const, 'mode');
  const allowedScopes = policyScopes(policy.allowed_scopes, 'allowed_scopes');
  if (mode === 'unattended_allowed' && !allowedScopes.length) {
    throw invalidPolicyInput();
  }
  if (mode === 'attended_only' && allowedScopes.length) {
    throw invalidPolicyInput();
  }
  return {
    mode,
    allowed_scopes: allowedScopes,
    business_ref: {
      type: policyString(businessRef.type, 'business_ref.type'),
      id: policyString(businessRef.id, 'business_ref.id')
    },
    expires_at: policy.expires_at == null
      ? null
      : policyTimestamp(policy.expires_at, 'expires_at'),
    reason: policyReason(policy.reason)
  };
}

function projectRevokeAccessPolicyInput(input: RevokeIveKitRustDeskAccessPolicyInput) {
  const policy = policyMutationInput(input, ['reason']);
  return { reason: policyReason(policy.reason) };
}

function policyMutationInput(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidPolicyInput();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw invalidPolicyInput();
  return input;
}

function policyIdempotencyKey(options: IveKitRustDeskAccessPolicyMutationOptions): string {
  const key = String(options?.idempotencyKey || '').trim();
  if (!key) throw new Error('idempotencyKey is required');
  if (key.length > 200) throw new Error('idempotencyKey must be at most 200 characters');
  return key;
}

function rustDeskAccessPolicyPath(deviceId: string): string {
  return `/api/ivekit/rustdesk/devices/${encodeURIComponent(requiredString(deviceId, 'deviceId is required'))}/access-policy`;
}

function rustDeskAuthorizationCodePath(authorizationId: string): string {
  return `/api/ivekit/rustdesk/authorization-codes/${encodeURIComponent(
    requiredString(authorizationId, 'authorizationId is required')
  )}`;
}

function projectAuthorizationCodeRequest(input: RequestIveKitRustDeskAuthorizationCodeInput) {
  const row = policyMutationInput(input, [
    'remote_session_id',
    'device_id',
    'scopes',
    'ttl_seconds',
    'max_attempts'
  ]);
  const scopes = policyScopes(row.scopes, 'scopes');
  if (!scopes.length) throw new Error('scopes are required');
  const ttlSeconds = optionalBoundedInteger(row.ttl_seconds, 60, 900, 'ttl_seconds');
  const maxAttempts = optionalBoundedInteger(row.max_attempts, 1, 10, 'max_attempts');
  return {
    remote_session_id: policyString(row.remote_session_id, 'remote_session_id'),
    device_id: policyString(row.device_id, 'device_id'),
    scopes,
    ...(ttlSeconds === undefined ? {} : { ttl_seconds: ttlSeconds }),
    ...(maxAttempts === undefined ? {} : { max_attempts: maxAttempts })
  };
}

function optionalBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function projectRustDeskAuthorizationCode(value: unknown): RustDeskAuthorizationCode {
  const row = policyRecord(value, 'authorization code');
  for (const field of ['code', 'code_hmac', 'code_salt', 'request_hash', 'idempotency_key']) {
    if (field in row) throw new Error(`invalid RustDesk authorization code response: ${field}`);
  }
  const maxAttempts = Number(row.max_attempts);
  const attemptCount = Number(row.attempt_count);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error('invalid RustDesk authorization code response: max_attempts');
  }
  if (!Number.isInteger(attemptCount) || attemptCount < 0 || attemptCount > maxAttempts) {
    throw new Error('invalid RustDesk authorization code response: attempt_count');
  }
  return {
    id: policyString(row.id, 'id'),
    tenant_id: policyString(row.tenant_id, 'tenant_id'),
    remote_session_id: policyString(row.remote_session_id, 'remote_session_id'),
    device_id: policyString(row.device_id, 'device_id'),
    scopes: policyScopes(row.scopes, 'scopes'),
    requested_by: policyString(row.requested_by, 'requested_by'),
    requested_at: policyTimestamp(row.requested_at, 'requested_at'),
    expires_at: policyTimestamp(row.expires_at, 'expires_at'),
    max_attempts: maxAttempts,
    attempt_count: attemptCount,
    status: policyEnum(row.status, ['pending', 'verified', 'claimed', 'consumed', 'expired', 'locked'] as const, 'status'),
    verified_by: nullableAuthorizationString(row.verified_by, 'verified_by'),
    verified_at: policyNullableTimestamp(row.verified_at, 'verified_at'),
    consumed_external_id: nullableAuthorizationString(row.consumed_external_id, 'consumed_external_id'),
    consumed_at: policyNullableTimestamp(row.consumed_at, 'consumed_at'),
    updated_at: policyTimestamp(row.updated_at, 'updated_at')
  };
}

export function projectRustDeskAuthorizationCodeCreateResult(
  value: unknown
): RustDeskAuthorizationCodeCreateResult {
  const row = policyRecord(value, 'authorization code result');
  if (typeof row.replayed !== 'boolean') {
    throw new Error('invalid RustDesk authorization code response: replayed');
  }
  const code = row.code === null ? null : String(row.code || '');
  if ((row.replayed && code !== null) || (!row.replayed && !/^\d{8}$/.test(code || ''))) {
    throw new Error('invalid RustDesk authorization code response: code');
  }
  return {
    authorization: projectRustDeskAuthorizationCode(row.authorization),
    code,
    replayed: row.replayed
  };
}

function nullableAuthorizationString(value: unknown, field: string): string | null {
  return value === null ? null : policyString(value, field);
}

function rustDeskControlPath(externalId: string): string {
  return `/api/ivekit/rustdesk/gateway-sessions/${encodeURIComponent(requiredString(externalId, 'externalId is required'))}/control`;
}

export function projectRustDeskControlOwnership(value: unknown): RustDeskControlOwnership {
  const row = controlRecord(value, 'ownership');
  const status = controlEnum(row.status, ['unowned', 'owned', 'transferring', 'released', 'expired'] as const, 'status');
  const owner = row.owner_identity === null ? null : controlString(row.owner_identity, 'owner_identity');
  const lease = row.lease_expires_at === null ? null : controlTimestamp(row.lease_expires_at, 'lease_expires_at');
  const version = Number(row.version);
  if (!Number.isInteger(version) || version < 0) throw invalidControl('version');
  if ((status === 'owned' || status === 'transferring') !== Boolean(owner && lease)) throw invalidControl('owner_identity');
  return {
    status,
    owner_identity: owner,
    lease_expires_at: lease,
    version,
    updated_at: controlTimestamp(row.updated_at, 'updated_at')
  };
}

export function projectRustDeskSecondaryConfirmation(value: unknown): RustDeskSecondaryConfirmation {
  const row = controlRecord(value, 'confirmation');
  return {
    id: controlString(row.id, 'id'),
    external_id: controlString(row.external_id, 'external_id'),
    actor_identity: controlString(row.actor_identity, 'actor_identity'),
    operation: controlEnum(row.operation, [
      'control_mouse_keyboard', 'transfer_file', 'clipboard', 'unattended_launch', 'control_transfer'
    ] as const, 'operation'),
    expires_at: controlTimestamp(row.expires_at, 'expires_at'),
    consumed_at: row.consumed_at === null ? null : controlTimestamp(row.consumed_at, 'consumed_at'),
    created_at: controlTimestamp(row.created_at, 'created_at')
  };
}

export function projectRustDeskOperationAuthorization(value: unknown): RustDeskOperationAuthorization {
  const row = controlRecord(value, 'operation_authorization');
  const version = Number(row.control_version);
  if (!Number.isInteger(version) || version < 0) throw invalidControl('control_version');
  return {
    id: controlString(row.id, 'id'),
    external_id: controlString(row.external_id, 'external_id'),
    actor_identity: controlString(row.actor_identity, 'actor_identity'),
    operation: controlEnum(row.operation, [
      'control_mouse_keyboard', 'transfer_file', 'clipboard', 'unattended_launch', 'control_transfer'
    ] as const, 'operation'),
    control_version: version,
    expires_at: controlTimestamp(row.expires_at, 'expires_at'),
    authorized_at: controlTimestamp(row.authorized_at, 'authorized_at')
  };
}

function controlRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidControl(field);
  return value as Record<string, unknown>;
}
function controlString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw invalidControl(field);
  return value.trim();
}
function controlTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw invalidControl(field);
  return value;
}
function controlEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw invalidControl(field);
  return value as T;
}
function invalidControl(field: string): Error { return new Error(`invalid RustDesk control response: ${field}`); }

function policyRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidPolicy(field);
  return value as Record<string, unknown>;
}

function policyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw invalidPolicy(field);
  return value.trim();
}

function policyReason(value: unknown): string {
  const reason = policyString(value, 'reason');
  if (reason.length > 1000) throw invalidPolicy('reason');
  return reason;
}

function policyEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw invalidPolicy(field);
  return value as T;
}

function policyScopes(value: unknown, field: string): RemoteConsentScope[] {
  if (!Array.isArray(value)) throw invalidPolicy(field);
  const scopes = value.map((scope) => policyEnum(scope, remoteConsentScopes, field));
  if (new Set(scopes).size !== scopes.length) throw invalidPolicy(field);
  return scopes;
}

function policyTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw invalidPolicy(field);
  return value;
}

function policyNullableTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : policyTimestamp(value, field);
}

function invalidPolicy(field: string): Error {
  return new Error(`invalid RustDesk access policy: ${field}`);
}

function invalidPolicyInput(): Error {
  return new Error('unsupported or sensitive RustDesk access policy field');
}

export async function projectRustDeskClientDistributionProfile(
  value: unknown,
  expected: GetIveKitRustDeskClientProfileInput,
  now = new Date()
): Promise<RustDeskClientDistributionProfile> {
  const nowMs = now.getTime();
  if (Number.isNaN(nowMs)) throw invalidDistribution('validation clock');
  const expectedServerVersion = distributionRequiredString(
    expected.expected_server_version,
    'expected_server_version is required'
  );
  const expectedFingerprint = distributionRequiredString(
    expected.expected_server_key_fingerprint,
    'expected_server_key_fingerprint is required'
  );
  if (expectedServerVersion !== '1.1.15') throw invalidDistribution('expected_server_version');
  if (!/^sha256:[a-f0-9]{16}$/.test(expectedFingerprint)) {
    throw invalidDistribution('expected_server_key_fingerprint');
  }
  const profile = distributionRecord(value, 'payload');
  const platform = distributionEnum(
    profile.platform,
    ['windows', 'macos', 'linux'] as const,
    'platform'
  );
  const architecture = distributionEnum(
    profile.architecture,
    ['x86_64', 'aarch64'] as const,
    'architecture'
  );
  if (!isSupportedDistributionTarget(platform, architecture)) throw invalidDistribution('tuple');
  if (platform !== expected.platform) throw invalidDistribution('platform drift');
  if (architecture !== expected.architecture) throw invalidDistribution('architecture drift');

  const clientVersion = distributionRecord(profile.client_version, 'client_version');
  if (
    clientVersion.exact !== '1.4.7' ||
    !Array.isArray(clientVersion.allowed) ||
    clientVersion.allowed.length !== 1 ||
    clientVersion.allowed[0] !== '1.4.7' ||
    expected.client_version !== '1.4.7'
  ) {
    throw invalidDistribution('client_version');
  }
  if (profile.server_version !== '1.1.15' || profile.server_version !== expectedServerVersion) {
    throw invalidDistribution('server_version drift');
  }

  const issuedAt = distributionTimestamp(profile.issued_at, 'issued_at');
  const expiresAt = distributionTimestamp(profile.expires_at, 'expires_at');
  const issuedAtMs = Date.parse(issuedAt);
  const expiresAtMs = Date.parse(expiresAt);
  if (expiresAtMs <= nowMs) throw invalidDistribution('expired');
  if (issuedAtMs > nowMs + 60_000) throw invalidDistribution('issued_at');
  if (expiresAtMs <= issuedAtMs) throw invalidDistribution('expires_at');
  if (expiresAtMs - issuedAtMs < 60_000 || expiresAtMs - issuedAtMs > 3_600_000) {
    throw invalidDistribution('profile lifetime');
  }

  const manual = distributionRecord(profile.manual_fields, 'manual_fields');
  const manualFields = {
    id_server: distributionRequiredString(manual.id_server, 'manual_fields.id_server'),
    relay_server: distributionString(manual.relay_server, 'manual_fields.relay_server'),
    api_server: distributionString(manual.api_server, 'manual_fields.api_server'),
    key: distributionRequiredString(manual.key, 'manual_fields.key')
  };
  validateDistributionApiServer(manualFields.api_server);
  const derivedFingerprint = await distributionPublicKeyFingerprint(manualFields.key);

  const fingerprint = distributionRequiredString(
    profile.server_key_fingerprint,
    'server_key_fingerprint'
  );
  if (!/^sha256:[a-f0-9]{16,64}$/.test(fingerprint)) {
    throw invalidDistribution('server_key_fingerprint');
  }
  if (fingerprint !== derivedFingerprint) {
    throw invalidDistribution('public key fingerprint');
  }
  if (fingerprint !== expectedFingerprint) {
    throw invalidDistribution('server_key_fingerprint drift');
  }

  const protocol = distributionRecord(profile.protocol_handler, 'protocol_handler');
  if (protocol.supported !== true || protocol.user_initiated_only !== true) {
    throw invalidDistribution('protocol_handler');
  }
  const unattended = distributionRecord(profile.unattended_policy, 'unattended_policy');
  if (unattended.mode !== 'attended_only' || unattended.state !== 'not_configured') {
    throw invalidDistribution('unattended_policy');
  }

  return {
    platform,
    architecture,
    client_version: { exact: '1.4.7', allowed: ['1.4.7'] },
    server_version: '1.1.15',
    issued_at: issuedAt,
    expires_at: expiresAt,
    manual_fields: manualFields,
    server_key_fingerprint: fingerprint,
    protocol_handler: { supported: true, user_initiated_only: true },
    install_source: projectDistributionInstallSource(profile.install_source, platform, architecture),
    unattended_policy: { mode: 'attended_only', state: 'not_configured' }
  };
}

async function distributionPublicKeyFingerprint(value: string): Promise<string> {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw invalidDistribution('manual_fields.key');
  let binary: string;
  try {
    binary = globalThis.atob(value);
  } catch {
    throw invalidDistribution('manual_fields.key');
  }
  if (binary.length !== 32 || globalThis.btoa(binary) !== value) {
    throw invalidDistribution('manual_fields.key');
  }
  if (!globalThis.crypto?.subtle) throw invalidDistribution('public key fingerprint');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex.slice(0, 16)}`;
}

function projectDistributionInstallSource(
  value: unknown,
  platform: RustDeskClientDistributionPlatform,
  architecture: RustDeskClientDistributionArchitecture
): RustDeskClientDistributionProfile['install_source'] {
  const source = distributionRecord(value, 'install_source');
  if (source.state === 'not_configured') return { state: 'not_configured' };
  if (source.state !== 'configured') throw invalidDistribution('install_source.state');
  const url = distributionArtifactUrl(source.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw invalidDistribution('install_source.url');
  }
  const filename = distributionArtifactFilename(source.filename);
  validateDistributionCanonicalUrlFilename(url, filename);
  const pathSegments = distributionArtifactPathSegments(url);
  const urlFilename = pathSegments.at(-1) || '';
  if (filename !== urlFilename) throw invalidDistribution('install_source.filename');
  validateDistributionArtifactReleasePath(url, pathSegments);
  validateDistributionArtifactIdentity(pathSegments.join('/'), filename, platform, architecture);
  const sha256 = distributionRequiredString(source.sha256, 'install_source.sha256').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw invalidDistribution('install_source.sha256');
  const nativeControlProtocol = source.native_control_protocol === undefined
    ? undefined
    : distributionRequiredString(source.native_control_protocol, 'install_source.native_control_protocol');
  if (
    nativeControlProtocol !== undefined &&
    (platform !== 'windows' || architecture !== 'x86_64' ||
     (nativeControlProtocol !== 'ivekit-rustdesk-native-control-v1' &&
      nativeControlProtocol !== 'ivekit-rustdesk-native-control-v2'))
  ) {
    throw invalidDistribution('install_source.native_control_protocol');
  }
  return {
    state: 'configured',
    url: url.toString(),
    filename,
    sha256,
    ...(nativeControlProtocol
      ? {
          native_control_protocol: nativeControlProtocol as
            'ivekit-rustdesk-native-control-v1' | 'ivekit-rustdesk-native-control-v2'
        }
      : {})
  };
}

const distributionArtifactExtensions: Record<string, readonly string[]> = {
  'windows/x86_64': ['.exe'],
  'macos/x86_64': ['.dmg'],
  'macos/aarch64': ['.dmg'],
  'linux/x86_64': ['.deb'],
  'linux/aarch64': ['.deb']
};

const distributionArtifactArchitectureTokens: Record<RustDeskClientDistributionArchitecture, readonly string[]> = {
  x86_64: ['x86_64', 'amd64'],
  aarch64: ['aarch64', 'arm64']
};

function distributionArtifactUrl(value: unknown): URL {
  if (typeof value !== 'string' || !value || /[\u0000-\u0020\u007f-\u009f]/.test(value)) {
    throw invalidDistribution('install_source.url');
  }
  try {
    return new URL(value);
  } catch {
    throw invalidDistribution('install_source.url');
  }
}

function distributionArtifactFilename(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value === '.' ||
    value === '..' ||
    !/^[A-Za-z0-9._+-]{1,255}$/.test(value)
  ) {
    throw invalidDistribution('install_source.filename');
  }
  return value;
}

function validateDistributionCanonicalUrlFilename(url: URL, filename: string): void {
  const rawFilename = url.pathname.split('/').filter(Boolean).at(-1) || '';
  if (rawFilename !== filename) throw invalidDistribution('install_source.filename');
}

function distributionArtifactPathSegments(url: URL): string[] {
  try {
    return url.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
  } catch {
    throw invalidDistribution('install_source.url');
  }
}

function validateDistributionArtifactReleasePath(url: URL, pathSegments: readonly string[]): void {
  const releaseDirectory = url.hostname.toLowerCase() === 'github.com' ? 'download' : 'releases';
  if (
    pathSegments.length < 3 ||
    pathSegments.at(-3) !== releaseDirectory ||
    pathSegments.at(-2) !== '1.4.7'
  ) {
    throw invalidDistribution('install_source.release');
  }
}

function validateDistributionArtifactIdentity(
  pathIdentity: string,
  filename: string,
  platform: RustDeskClientDistributionPlatform,
  architecture: RustDeskClientDistributionArchitecture
): void {
  const lower = filename.toLowerCase();
  const lowerIdentity = pathIdentity.toLowerCase();
  if (!distributionArtifactToken(lower, '1.4.7')) throw invalidDistribution('install_source.version');
  for (const version of distributionSemanticVersionTokens(lowerIdentity)) {
    if (version !== '1.4.7') throw invalidDistribution('install_source.version');
  }
  for (const candidate of ['windows', 'macos', 'linux'] as const) {
    if (candidate !== platform && distributionArtifactToken(lowerIdentity, candidate)) {
      throw invalidDistribution('install_source.platform');
    }
  }
  for (const candidate of ['x86_64', 'aarch64'] as const) {
    if (
      candidate !== architecture &&
      distributionArtifactArchitectureTokens[candidate].some((token) => distributionArtifactToken(lowerIdentity, token))
    ) {
      throw invalidDistribution('install_source.architecture');
    }
  }
  const extensions = distributionArtifactExtensions[`${platform}/${architecture}`] || [];
  const extension = extensions.find((candidate) => lower.endsWith(candidate));
  if (!extension) {
    throw invalidDistribution('install_source.extension');
  }
  const customWindowsFilename = platform === 'windows' && architecture === 'x86_64' &&
    /^rustdesk-1\.4\.7-ivekit[A-Za-z0-9.-]*-x86_64\.exe$/.test(filename);
  if (filename !== `rustdesk-1.4.7-${architecture}${extension}` && !customWindowsFilename) {
    throw invalidDistribution('install_source.filename');
  }
}

function distributionSemanticVersionTokens(value: string): string[] {
  return Array.from(
    value.matchAll(/(?:^|[^0-9])(\d+\.\d+\.\d+)(?=$|[^0-9])/g),
    (match) => match[1]
  );
}

function distributionArtifactToken(filename: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(filename);
}

function isSupportedDistributionTarget(
  platform: RustDeskClientDistributionPlatform,
  architecture: RustDeskClientDistributionArchitecture
): boolean {
  return architecture === 'x86_64' || platform !== 'windows';
}

function distributionRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidDistribution(field);
  return value as Record<string, unknown>;
}

function distributionEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw invalidDistribution(field);
  return value as T;
}

function distributionRequiredString(value: unknown, field: string): string {
  const result = distributionString(value, field).trim();
  if (!result) throw invalidDistribution(field);
  return result;
}

function distributionString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw invalidDistribution(field);
  return value;
}

function distributionTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string') throw invalidDistribution(field);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw invalidDistribution(field);
  return value;
}

function validateDistributionApiServer(value: string): void {
  if (!value) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidDistribution('manual_fields.api_server');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw invalidDistribution('manual_fields.api_server');
  }
}

function invalidDistribution(field: string): Error {
  return new Error(`invalid RustDesk client distribution profile: ${field}`);
}

const evidenceOperations: readonly RustDeskObservedOperation[] = [
  'view_screen',
  'control_mouse_keyboard',
  'record_screen',
  'transfer_file',
  'clipboard',
  'multi_display',
  'session_disconnect'
];
const evidenceObservers: readonly RustDeskOperationObserver[] = [
  'native_client',
  'edge_adapter',
  'operator',
  'qa'
];
const evidenceDirections: readonly RustDeskOperationDirection[] = [
  'upload',
  'download',
  'agent_to_device',
  'device_to_agent'
];
const evidenceSecurityLabels: readonly RustDeskEvidenceSecurity[] = [
  'ivekit_secure_file',
  'native_unscanned',
  'local_only'
];
const terminalPlatforms: readonly RustDeskTerminalPlatform[] = ['windows', 'macos', 'linux'];
const terminalArchitectures: readonly RustDeskTerminalArchitecture[] = ['x86_64', 'aarch64', 'x86', 'armv7'];
const clientVersionSources: readonly RustDeskClientVersion['source'][] = [
  'terminal_heartbeat',
  'operator_report',
  'unknown'
];
const runtimeCapabilitySources: readonly RustDeskRuntimeCapabilities['source'][] = [
  'terminal_heartbeat',
  'native_observer',
  'operator_report',
  'unknown'
];
const capabilityAvailability = ['unknown', 'available', 'unavailable'] as const;
const remoteConsentScopes: readonly RemoteConsentScope[] = [
  'view_screen',
  'control_mouse_keyboard',
  'record_screen',
  'transfer_file',
  'clipboard'
];

export function projectRustDeskOperationEvidence(value: unknown): RustDeskOperationEvidence {
  const evidence = evidenceRecord(value);
  const operationId = evidenceString(evidence.operation_id, 'operation_id');
  const operation = evidenceEnum(evidence.operation, evidenceOperations, 'operation');
  const metadata = projectEvidenceMetadata(evidence.metadata);
  const references = projectEvidenceReferences(evidence.evidence_refs);

  if (evidence.status === 'not_observed') {
    if (evidence.observer !== 'none' || evidence.observed_at !== null || references.length !== 0) {
      throw invalidEvidence('not_observed provenance');
    }
    return {
      operation_id: operationId,
      operation,
      status: 'not_observed',
      observer: 'none',
      observed_at: null,
      evidence_refs: [],
      metadata
    };
  }

  if (evidence.status !== 'observed_succeeded' && evidence.status !== 'observed_failed') {
    throw invalidEvidence('status');
  }
  const observer = evidenceEnum(evidence.observer, evidenceObservers, 'observer');
  const observedAt = evidenceString(evidence.observed_at, 'observed_at');
  if (Number.isNaN(Date.parse(observedAt)) || references.length === 0) {
    throw invalidEvidence('observed provenance');
  }

  return {
    operation_id: operationId,
    operation,
    status: evidence.status,
    observer,
    observed_at: observedAt,
    evidence_refs: references as [RustDeskOperationEvidenceReference, ...RustDeskOperationEvidenceReference[]],
    metadata
  };
}

export function projectRustDeskTerminalProfile(value: unknown): RustDeskTerminalProfile {
  const profile = terminalRecord(value, 'terminal_profile');
  const observed = profile.observed;
  if (!Array.isArray(observed)) throw invalidTerminalProfile('observed');
  return {
    device_id: terminalIdentifier(profile.device_id, 'device_id'),
    rustdesk_id: terminalIdentifier(profile.rustdesk_id, 'rustdesk_id'),
    platform: terminalEnum(profile.platform, terminalPlatforms, 'platform'),
    architecture: terminalEnum(profile.architecture, terminalArchitectures, 'architecture'),
    client_version: projectTerminalClientVersion(profile.client_version),
    configured: projectTerminalConfiguredFields(profile.configured),
    available: projectTerminalRuntimeCapabilities(profile.available),
    granted: projectTerminalPermissionScopes(profile.granted),
    observed: observed.map(projectRustDeskOperationEvidence),
    updated_at: terminalTimestamp(profile.updated_at, 'updated_at')
  };
}

function projectTerminalClientVersion(value: unknown): RustDeskClientVersion {
  const clientVersion = terminalRecord(value, 'client_version');
  return {
    product: terminalEnum(clientVersion.product, ['rustdesk'] as const, 'client_version.product'),
    version: terminalIdentifier(clientVersion.version, 'client_version.version'),
    channel: terminalEnum(clientVersion.channel, ['stable'] as const, 'client_version.channel'),
    source: terminalEnum(clientVersion.source, clientVersionSources, 'client_version.source'),
    reported_at: terminalNullableTimestamp(clientVersion.reported_at, 'client_version.reported_at')
  };
}

function projectTerminalConfiguredFields(value: unknown): RustDeskConfiguredFields {
  const configured = terminalRecord(value, 'configured');
  return {
    id_server_configured: terminalBoolean(configured.id_server_configured, 'configured.id_server_configured'),
    relay_server_configured: terminalBoolean(configured.relay_server_configured, 'configured.relay_server_configured'),
    api_server_configured: terminalBoolean(configured.api_server_configured, 'configured.api_server_configured'),
    public_key_configured: terminalBoolean(configured.public_key_configured, 'configured.public_key_configured'),
    server_key_fingerprint: terminalText(configured.server_key_fingerprint, 'configured.server_key_fingerprint')
  };
}

function projectTerminalRuntimeCapabilities(value: unknown): RustDeskRuntimeCapabilities {
  const available = terminalRecord(value, 'available');
  return {
    source: terminalEnum(available.source, runtimeCapabilitySources, 'available.source'),
    reported_at: terminalNullableTimestamp(available.reported_at, 'available.reported_at'),
    view_screen: terminalEnum(available.view_screen, capabilityAvailability, 'available.view_screen'),
    control_mouse_keyboard: terminalEnum(
      available.control_mouse_keyboard,
      capabilityAvailability,
      'available.control_mouse_keyboard'
    ),
    multi_display: terminalEnum(available.multi_display, capabilityAvailability, 'available.multi_display'),
    transfer_file: terminalEnum(available.transfer_file, capabilityAvailability, 'available.transfer_file'),
    clipboard: terminalEnum(available.clipboard, capabilityAvailability, 'available.clipboard'),
    record_screen: terminalEnum(available.record_screen, capabilityAvailability, 'available.record_screen'),
    session_disconnect: terminalEnum(
      available.session_disconnect,
      capabilityAvailability,
      'available.session_disconnect'
    )
  };
}

function projectTerminalPermissionScopes(value: unknown): RustDeskPermissionScopes {
  const granted = terminalRecord(value, 'granted');
  const requested = terminalScopeArray(granted.requested, 'granted.requested');
  const consented = terminalScopeArray(granted.consented, 'granted.consented');
  const grantedScopes = terminalScopeArray(granted.granted, 'granted.granted');
  const requestedSet = new Set(requested);
  const consentedSet = new Set(consented);
  if (consented.some((scope) => !requestedSet.has(scope))) throw invalidTerminalProfile('granted.consented');
  if (grantedScopes.some((scope) => !consentedSet.has(scope))) throw invalidTerminalProfile('granted.granted');
  return { requested, consented, granted: grantedScopes };
}

export function projectRustDeskDevice(value: unknown): RustDeskDevice {
  const device = evidenceRecord(value, 'device');
  if (device.terminal_profile === undefined) return device as unknown as RustDeskDevice;
  const terminalProfile = projectRustDeskTerminalProfile(device.terminal_profile);
  if (
    terminalProfile.device_id !== terminalIdentifier(device.id, 'device binding') ||
    terminalProfile.rustdesk_id !== terminalIdentifier(device.rustdesk_id, 'device binding')
  ) {
    throw invalidTerminalProfile('device binding');
  }
  return {
    ...device,
    terminal_profile: terminalProfile
  } as unknown as RustDeskDevice;
}

function projectEvidenceContainer<T extends RemoteToolSession | RustDeskGatewayLaunchPlan>(
  value: T,
  label: string
): T {
  const record = evidenceRecord(value, label);
  const allowedKeys = label === 'remote tool session'
    ? [
      'id',
      'tenant_id',
      'remote_session_id',
      'provider',
      'external_id',
      'launch_url',
      'status',
      'started_by',
      'started_at',
      'ended_at',
      'metadata',
      'physical_disconnect',
      'permission_scopes',
      'control_ownership',
      'disconnect_state',
      'operation_evidence'
    ]
    : [
      'external_id',
      'status',
      'launch_url',
      'target',
      'permissions',
      'runtime',
      'client_config',
      'actions',
      'metadata',
      'created_at',
      'ended_at',
      'permission_scopes',
      'control_ownership',
      'operation_evidence'
    ];
  const projected: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (record[key] !== undefined) projected[key] = record[key];
  }
  if (record.metadata !== undefined) {
    projected.metadata = projectRustDeskGatewayMetadata(record.metadata);
  }
  if (record.operation_evidence !== undefined) {
    if (!Array.isArray(record.operation_evidence)) throw invalidEvidence('operation_evidence');
    projected.operation_evidence = record.operation_evidence.map(projectRustDeskOperationEvidence);
  }
  if (record.disconnect_state !== undefined) {
    projected.disconnect_state = projectRustDeskDisconnectState(record.disconnect_state);
  }
  return projected as unknown as T;
}

function projectRustDeskGatewayMetadata(value: unknown): Record<string, unknown> {
  const source = evidenceRecord(value, 'metadata');
  const result: Record<string, unknown> = {};
  for (const key of [
    'access_mode',
    'api_server',
    'business_ref_id',
    'business_ref_type',
    'collaboration_session_id',
    'gateway_provider',
    'id_server',
    'permissions',
    'relay_server',
    'remote_session_id',
    'rustdesk_device_id',
    'rustdesk_device_last_seen_actor',
    'rustdesk_device_last_seen_at',
    'rustdesk_device_runtime_status',
    'rustdesk_id',
    'rustdesk_target_mode',
    'server_key_fingerprint',
    'site',
    'source',
    'target_display_name',
    'target_id',
    'target_type',
    'tenant_id'
  ] as const) {
    const entry = source[key];
    if (key === 'permissions') {
      if (Array.isArray(entry) && entry.every((scope) => typeof scope === 'string')) {
        result[key] = [...entry];
      }
      continue;
    }
    if (typeof entry === 'string' && !sdkSensitiveMetadataString(entry)) result[key] = entry;
  }
  return result;
}

function sdkSensitiveMetadataString(value: string): boolean {
  if (/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/i.test(value)) return true;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password) return true;
    return [...url.searchParams.keys()].some((key) =>
      /password|passphrase|secret|token|credential|api[_-]?key|private[_-]?key|auth|cookie/i.test(key)
    );
  } catch {
    return false;
  }
}

function projectRustDeskDisconnectState(value: unknown): RustDeskDisconnectState {
  const state = disconnectRecord(value);
  const command = state.command;
  const concreteStatuses = ['pending', 'claimed', 'succeeded', 'failed'] as const;

  if (state.required !== true) throw invalidDisconnect('required');
  if (state.status === 'unavailable') {
    if (command !== null) throw invalidDisconnect('unavailable command');
  } else if (concreteStatuses.includes(state.status as (typeof concreteStatuses)[number])) {
    const commandRecord = disconnectRecord(command, 'command');
    if (commandRecord.status !== state.status) throw invalidDisconnect('command status');
  } else {
    throw invalidDisconnect('status');
  }

  const observationStatus = state.observation_status;
  if (observationStatus === undefined || observationStatus === 'not_observed') {
    if (state.observed === undefined) return value as RustDeskDisconnectState;
    const observed = projectRustDeskOperationEvidence(state.observed);
    if (observed.operation !== 'session_disconnect' || observed.status !== 'not_observed') {
      throw invalidDisconnect('not_observed evidence');
    }
    return { ...state, observed } as RustDeskDisconnectState;
  }
  if (observationStatus !== 'observed_disconnected' && observationStatus !== 'observed_connected') {
    throw invalidDisconnect('observation_status');
  }
  const observed = projectRustDeskOperationEvidence(state.observed);
  if (observed.operation !== 'session_disconnect' || observed.status === 'not_observed') {
    throw invalidDisconnect('observed evidence');
  }
  if (observationStatus === 'observed_disconnected' && observed.status !== 'observed_succeeded') {
    throw invalidDisconnect('observed_disconnected evidence');
  }
  if (observationStatus === 'observed_connected' && observed.status !== 'observed_failed') {
    throw invalidDisconnect('observed_connected evidence');
  }
  return { ...state, observed } as RustDeskDisconnectState;
}

function projectEvidenceMetadata(value: unknown): RustDeskOperationEvidenceMetadata {
  const source = evidenceRecord(value, 'metadata');
  const result: RustDeskOperationEvidenceMetadata = {};
  for (const key of [
    'external_id',
    'provider_operation_id',
    'provider_session_id',
    'target_id',
    'display_id',
    'reason',
    'status_detail'
  ] as const) {
    if (source[key] !== undefined) result[key] = evidenceString(source[key], `metadata.${key}`);
  }
  if (source.direction !== undefined) {
    result.direction = evidenceEnum(source.direction, evidenceDirections, 'metadata.direction');
  }
  if (source.evidence_security !== undefined) {
    result.evidence_security = evidenceEnum(
      source.evidence_security,
      evidenceSecurityLabels,
      'metadata.evidence_security'
    );
  }
  for (const key of ['byte_count', 'duration_ms'] as const) {
    if (source[key] !== undefined) result[key] = evidenceNumber(source[key], `metadata.${key}`);
  }
  if (source.checksum_sha256 !== undefined) {
    result.checksum_sha256 = evidenceSha256(source.checksum_sha256, 'metadata.checksum_sha256');
  }
  return result;
}

function projectEvidenceReferences(value: unknown): RustDeskOperationEvidenceReference[] {
  if (!Array.isArray(value)) throw invalidEvidence('evidence_refs');
  return value.map((entry) => {
    const reference = evidenceRecord(entry, 'evidence_ref');
    return {
      type: evidenceString(reference.type, 'evidence_ref.type'),
      ref: evidenceString(reference.ref, 'evidence_ref.ref'),
      sha256: evidenceSha256(reference.sha256, 'evidence_ref.sha256')
    };
  });
}

function evidenceRecord(value: unknown, field = 'payload'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidEvidence(field);
  return value as Record<string, unknown>;
}

function disconnectRecord(value: unknown, field = 'payload'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidDisconnect(field);
  return value as Record<string, unknown>;
}

function terminalRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidTerminalProfile(field);
  return value as Record<string, unknown>;
}

function terminalIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw invalidTerminalProfile(field);
  return value.trim();
}

function terminalText(value: unknown, field: string): string {
  if (typeof value !== 'string') throw invalidTerminalProfile(field);
  return value;
}

function terminalBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw invalidTerminalProfile(field);
  return value;
}

function terminalEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw invalidTerminalProfile(field);
  return value as T;
}

function terminalScopeArray(value: unknown, field: string): RemoteConsentScope[] {
  if (!Array.isArray(value)) throw invalidTerminalProfile(field);
  return value.map((scope) => terminalEnum(scope, remoteConsentScopes, field));
}

function terminalNullableTimestamp(value: unknown, field: string): string | null {
  if (value === null) return null;
  return terminalTimestamp(value, field);
}

function terminalTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string') throw invalidTerminalProfile(field);
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/
  );
  if (!match || Number.isNaN(Date.parse(value))) throw invalidTerminalProfile(field);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day
  ) {
    throw invalidTerminalProfile(field);
  }
  return value;
}

function evidenceString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw invalidEvidence(field);
  return value;
}

function evidenceNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw invalidEvidence(field);
  return value;
}

function evidenceSha256(value: unknown, field: string): string {
  const checksum = evidenceString(value, field);
  if (!/^[a-f\d]{64}$/i.test(checksum)) throw invalidEvidence(field);
  return checksum;
}

function evidenceEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw invalidEvidence(field);
  return value as T;
}

function invalidEvidence(field: string): Error {
  return new Error(`invalid RustDesk operation evidence: ${field}`);
}

function invalidDisconnect(field: string): Error {
  return new Error(`invalid RustDesk disconnect state: ${field}`);
}

function invalidTerminalProfile(field: string): Error {
  return new Error(`invalid RustDesk terminal profile: ${field}`);
}

function validateBaseUrl(value: string): URL {
  const raw = requiredString(value, 'baseUrl is required');
  const parsed = new URL(raw);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('baseUrl must use http(s)');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('baseUrl must not include credentials, query, or fragment');
  }
  if (parsed.pathname !== '/') throw new Error('baseUrl must not include a path');
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

async function readResponsePayload(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorDetail(payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    return String(record.error || record.message || JSON.stringify(record));
  }
  return String(payload || 'empty response');
}
