import type { PgQueryable } from '../../db-pg.js';
import { pgId } from '../../db-pg.js';
import { normalizeExternalRemoteTool } from './external-link-adapter.js';
import type { RemoteGatewayClient } from './remote-gateway-client.js';
import type { RustDeskDisconnectReason } from './rustdesk-device-command-store.js';
import type { RustDeskPhysicalDisconnectSummary } from './rustdesk-physical-disconnect.js';
import { normalizeRemoteGatewaySession } from './remote-gateway-adapter.js';
import type { RemoteGatewaySessionInput } from './remote-gateway-adapter.js';
import { rustDeskGatewayEventPermissionError } from './rustdesk-gateway-event.js';
import { RustDeskAccessPolicyStore } from './rustdesk-access-policy-store.js';
import { RustDeskDeviceStore } from './rustdesk-device-store.js';
import {
  hasRustDeskGatewayUnattendedAlias,
  rustDeskGatewayAccessMode,
  rustDeskGatewayMetadata,
  type RustDeskGatewayAccessMode
} from './rustdesk-gateway-security.js';
import {
  rustDeskConsentAuthorizationLock,
  rustDeskPolicyAuthorizationLock,
  withRustDeskAuthorizationLocks
} from './rustdesk-gateway-authorization-lock.js';
import type {
  BusinessRef,
  EvidenceRecord,
  RemoteAssistanceMode,
  RemoteAssistanceSession,
  RemoteAuditEvent,
  RemoteConsentEvent,
  RemoteConsentScope,
  RemoteToolProvider,
  RemoteToolSession
} from './types.js';

interface PendingGatewayAuthorization {
  access_mode: RustDeskGatewayAccessMode;
  consent_event_id: string;
  device_id?: string;
  policy_version?: number;
}

export class RemoteAssistanceStore {
  constructor(private readonly pg: PgQueryable) {}

  async createSession(input: {
    tenant_id: string;
    collaboration_session_id: string;
    business_ref: BusinessRef;
    mode: RemoteAssistanceMode;
    adapter_provider?: string;
    started_by: string;
    metadata?: Record<string, unknown>;
  }): Promise<RemoteAssistanceSession> {
    assertTenantRef(input.tenant_id, input.business_ref);
    const remoteId = pgId('remote');
    await this.pg.query(
      `INSERT INTO remote_assistance_sessions
        (id, tenant_id, collaboration_session_id, business_ref_type, business_ref_id, mode, adapter_provider, started_by, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        remoteId,
        input.tenant_id,
        input.collaboration_session_id,
        input.business_ref.type,
        input.business_ref.id,
        input.mode,
        input.adapter_provider || 'external_link',
        input.started_by,
        toJson({
          ...(input.metadata || {}),
          business_ref_display_name: input.business_ref.display_name || '',
          business_ref_metadata: input.business_ref.metadata || {}
        })
      ]
    );
    await this.recordAudit({
      tenant_id: input.tenant_id,
      remote_session_id: remoteId,
      actor_identity: input.started_by,
      event_type: 'remote.session.created',
      target: remoteId,
      metadata: { mode: input.mode, adapter_provider: input.adapter_provider || 'external_link' }
    });
    return (await this.getSession(remoteId))!;
  }

  async getSession(remoteSessionId: string): Promise<RemoteAssistanceSession | null> {
    const result = await this.pg.query('SELECT * FROM remote_assistance_sessions WHERE id = $1', [remoteSessionId]);
    return result.rows[0] ? decodeRemoteSession(result.rows[0]) : null;
  }

  async listByBusinessRef(input: {
    tenant_id: string;
    business_ref: BusinessRef;
    limit?: number;
  }): Promise<RemoteAssistanceSession[]> {
    assertTenantRef(input.tenant_id, input.business_ref);
    const result = await this.pg.query(
      `SELECT * FROM remote_assistance_sessions
       WHERE tenant_id = $1 AND business_ref_type = $2 AND business_ref_id = $3
       ORDER BY created_at DESC
       LIMIT $4`,
      [input.tenant_id, input.business_ref.type, input.business_ref.id, input.limit || 50]
    );
    return result.rows.map(decodeRemoteSession);
  }

  async endSession(input: {
    remote_session_id: string;
    actor_identity: string;
  }): Promise<RemoteAssistanceSession | null> {
    const existing = await this.getSession(input.remote_session_id);
    if (!existing) return null;
    const activeTools = await this.pg.query(
      `SELECT * FROM remote_tool_sessions
       WHERE remote_session_id = $1 AND status = 'active'
       ORDER BY started_at ASC`,
      [input.remote_session_id]
    );
    for (const row of activeTools.rows) {
      await this.endToolSession(String(row.id), input.actor_identity);
    }
    await this.pg.query(
      `UPDATE remote_assistance_sessions
       SET status = 'ended', ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP)
       WHERE id = $1`,
      [input.remote_session_id]
    );
    await this.recordAudit({
      tenant_id: existing.tenant_id,
      remote_session_id: existing.id,
      actor_identity: input.actor_identity,
      event_type: 'remote.session.ended',
      target: existing.id,
      metadata: { active_tool_sessions_closed: activeTools.rows.length }
    });
    return this.getSession(input.remote_session_id);
  }

  async requestConsent(input: {
    tenant_id: string;
    remote_session_id: string;
    actor_identity: string;
    scopes: RemoteConsentScope[];
    expires_at?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<RemoteConsentEvent> {
    const event = await this.insertConsent({ ...input, event_type: 'requested' });
    await this.recordAudit({
      tenant_id: input.tenant_id,
      remote_session_id: input.remote_session_id,
      actor_identity: input.actor_identity,
      event_type: 'remote.consent.requested',
      target: input.remote_session_id,
      metadata: { scopes: input.scopes }
    });
    return event;
  }

  async grantConsent(input: {
    tenant_id: string;
    remote_session_id: string;
    actor_identity: string;
    scopes: RemoteConsentScope[];
    expires_at?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<RemoteConsentEvent> {
    const event = await this.insertConsent({ ...input, event_type: 'granted' });
    const remote = await this.getSession(input.remote_session_id);
    await this.recordAudit({
      tenant_id: input.tenant_id,
      remote_session_id: input.remote_session_id,
      actor_identity: input.actor_identity,
      event_type: 'remote.consent.granted',
      target: input.remote_session_id,
      metadata: { scopes: input.scopes, consent_event_id: event.id }
    });
    if (remote) {
      await this.recordEvidence({
        tenant_id: input.tenant_id,
        business_ref: remote.business_ref,
        session_id: input.remote_session_id,
        kind: 'consent_grant',
        created_by: input.actor_identity,
        metadata: { scopes: input.scopes, consent_event_id: event.id, expires_at: input.expires_at || null }
      });
    }
    return event;
  }

  async denyConsent(input: {
    tenant_id: string;
    remote_session_id: string;
    actor_identity: string;
    scopes: RemoteConsentScope[];
    metadata?: Record<string, unknown>;
  }): Promise<RemoteConsentEvent> {
    const event = await this.insertConsent({ ...input, event_type: 'denied', expires_at: null });
    await this.recordAudit({
      tenant_id: input.tenant_id,
      remote_session_id: input.remote_session_id,
      actor_identity: input.actor_identity,
      event_type: 'remote.consent.denied',
      target: input.remote_session_id,
      metadata: { scopes: input.scopes, consent_event_id: event.id }
    });
    return event;
  }

  async revokeConsent(input: {
    tenant_id: string;
    remote_session_id: string;
    actor_identity: string;
    scopes: RemoteConsentScope[];
    gateway_client?: RemoteGatewayClient;
    gateway_client_for_tool?: (
      tool: RemoteToolSession
    ) => Promise<RemoteGatewayClient | undefined> | RemoteGatewayClient | undefined;
    metadata?: Record<string, unknown>;
  }): Promise<RemoteConsentEvent> {
    const event = await withRustDeskAuthorizationLocks(
      this.pg,
      [rustDeskConsentAuthorizationLock(input.tenant_id, input.remote_session_id)],
      (pg) => new RemoteAssistanceStore(pg).insertConsent({
        ...input,
        event_type: 'revoked',
        expires_at: null
      })
    );
    const remote = await this.getSession(input.remote_session_id);
    const activeTools = await this.pg.query(
      `SELECT * FROM remote_tool_sessions
       WHERE remote_session_id = $1 AND status = 'active'
       ORDER BY started_at ASC`,
      [input.remote_session_id]
    );
    let physicalDisconnect: RustDeskPhysicalDisconnectSummary | undefined;
    for (const row of activeTools.rows) {
      const tool = decodeToolSession(row);
      const gatewayClient = input.gateway_client_for_tool
        ? await input.gateway_client_for_tool(tool)
        : input.gateway_client;
      if (gatewayClient && isGatewayManagedTool(tool, gatewayClient)) {
        const gatewayResult = await gatewayClient.endSession({
          external_id: tool.external_id,
          actor_identity: input.actor_identity,
          reason: 'consent_revoked'
        });
        physicalDisconnect ||= gatewayResult && typeof gatewayResult === 'object'
          ? gatewayResult.physical_disconnect
          : undefined;
        await this.syncGatewayAuditEvents({
          tenant_id: tool.tenant_id,
          remote_session_id: tool.remote_session_id,
          actor_identity: input.actor_identity,
          client: gatewayClient,
          external_id: tool.external_id
        });
      }
      await this.endToolSession(tool.id, input.actor_identity);
    }
    await this.recordAudit({
      tenant_id: input.tenant_id,
      remote_session_id: input.remote_session_id,
      actor_identity: input.actor_identity,
      event_type: 'remote.consent.revoked',
      target: input.remote_session_id,
      metadata: {
        scopes: input.scopes,
        consent_event_id: event.id,
        active_tool_sessions_closed: activeTools.rows.length
      }
    });
    if (remote) {
      await this.recordEvidence({
        tenant_id: input.tenant_id,
        business_ref: remote.business_ref,
        session_id: input.remote_session_id,
        kind: 'consent_revocation',
        created_by: input.actor_identity,
        metadata: {
          scopes: input.scopes,
          consent_event_id: event.id,
          active_tool_sessions_closed: activeTools.rows.length
        }
      });
    }
    return physicalDisconnect ? { ...event, physical_disconnect: physicalDisconnect } : event;
  }

  async hasActiveConsent(remoteSessionId: string, now: Date = new Date()): Promise<boolean> {
    return Boolean(await this.getActiveConsent(remoteSessionId, now));
  }

  private async getActiveConsent(remoteSessionId: string, now: Date = new Date()): Promise<RemoteConsentEvent | null> {
    const result = await this.pg.query(
      `SELECT * FROM remote_consent_events
       WHERE remote_session_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [remoteSessionId]
    );
    const row = result.rows[0];
    if (!row) return null;
    const event = decodeConsentEvent(row);
    if (event.event_type !== 'granted') return null;
    if (event.expires_at && new Date(event.expires_at).getTime() <= now.getTime()) return null;
    return event.scopes.length > 0 ? event : null;
  }

  async listConsentEvents(remoteSessionId: string, limit = 50): Promise<RemoteConsentEvent[]> {
    const result = await this.pg.query(
      `SELECT * FROM remote_consent_events
       WHERE remote_session_id = $1
       ORDER BY created_at ASC
       LIMIT $2`,
      [remoteSessionId, limit]
    );
    return result.rows.map(decodeConsentEvent);
  }

  async startToolSession(input: {
    tenant_id: string;
    remote_session_id: string;
    actor_identity: string;
    provider: RemoteToolProvider;
    external_id?: string;
    launch_url?: string;
    metadata?: Record<string, unknown>;
  }): Promise<RemoteToolSession> {
    if (input.provider === 'rustdesk') {
      throw Object.assign(new Error(
        'generic RustDesk tool creation is not allowed; use the dedicated RustDesk gateway path'
      ), { status: 400 });
    }
    if (!(await this.hasActiveConsent(input.remote_session_id))) {
      throw Object.assign(new Error('active consent required before starting remote tool session'), { status: 403 });
    }
    const normalized = normalizeExternalRemoteTool(input);
    return this.persistToolSession({
      tenant_id: input.tenant_id,
      remote_session_id: input.remote_session_id,
      actor_identity: input.actor_identity,
      normalized
    });
  }

  private async persistToolSession(input: {
    tenant_id: string;
    remote_session_id: string;
    actor_identity: string;
    normalized: {
      provider: RemoteToolProvider;
      external_id: string;
      launch_url: string;
      metadata: Record<string, unknown>;
    };
  }): Promise<RemoteToolSession> {
    const { normalized } = input;
    const toolId = pgId('rtool');
    await this.pg.query(
      `INSERT INTO remote_tool_sessions
        (id, tenant_id, remote_session_id, provider, external_id, launch_url, started_by, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        toolId,
        input.tenant_id,
        input.remote_session_id,
        normalized.provider,
        normalized.external_id,
        normalized.launch_url,
        input.actor_identity,
        toJson(normalized.metadata)
      ]
    );
    await this.pg.query(
      `UPDATE remote_assistance_sessions
       SET status = 'active', started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
       WHERE id = $1`,
      [input.remote_session_id]
    );
    await this.recordAudit({
      tenant_id: input.tenant_id,
      remote_session_id: input.remote_session_id,
      actor_identity: input.actor_identity,
      event_type: 'remote.tool_session.started',
      target: toolId,
      metadata: {
        provider: normalized.provider,
        external_id: normalized.external_id,
        launch_url: normalized.launch_url
      }
    });
    const result = await this.pg.query('SELECT * FROM remote_tool_sessions WHERE id = $1', [toolId]);
    return decodeToolSession(result.rows[0]);
  }

  async startGatewayToolSession(input: {
    tenant_id: string;
    remote_session_id: string;
    actor_identity: string;
    gateway: RemoteGatewaySessionInput;
  }): Promise<RemoteToolSession> {
    const normalized = normalizeRemoteGatewaySession(input.gateway);
    if (normalized.provider === 'rustdesk') {
      if (hasRustDeskGatewayUnattendedAlias(input.gateway)) {
        throw Object.assign(new Error('direct RustDesk gateway tool start is attended-only'), { status: 403 });
      }
      await this.assertActiveConsent(input.remote_session_id, input.gateway.permissions);
    } else if (!(await this.hasActiveConsent(input.remote_session_id))) {
      throw Object.assign(new Error('active consent required before starting remote tool session'), { status: 403 });
    }
    return this.persistToolSession({
      tenant_id: input.tenant_id,
      remote_session_id: input.remote_session_id,
      actor_identity: input.actor_identity,
      normalized
    });
  }

  async startGatewayClientSession(input: {
    tenant_id: string;
    remote_session_id: string;
    actor_identity: string;
    client: RemoteGatewayClient;
    target: RemoteGatewaySessionInput['target'];
    permissions: RemoteGatewaySessionInput['permissions'];
    access_mode?: RustDeskGatewayAccessMode;
    device_id?: string;
    metadata?: Record<string, unknown>;
  }): Promise<RemoteToolSession> {
    const accessMode = rustDeskGatewayAccessMode(input.access_mode);
    const metadata = input.client.provider === 'rustdesk'
      ? rustDeskGatewayMetadata(input.metadata)
      : input.metadata;
    let authorization: PendingGatewayAuthorization;
    if (input.client.provider === 'rustdesk') {
      authorization = await this.authorizeRustDeskGatewayCreation({
        tenant_id: input.tenant_id,
        remote_session_id: input.remote_session_id,
        target: input.target,
        permissions: input.permissions,
        access_mode: accessMode,
        device_id: input.device_id,
        metadata
      });
    } else {
      const consent = await this.assertActiveConsent(input.remote_session_id, input.permissions);
      authorization = { consent_event_id: consent.id, access_mode: 'attended' };
    }
    const createInput = {
      target: input.target,
      permissions: input.permissions,
      actor_identity: input.actor_identity,
      metadata
    };
    const gateway = input.client.createAuthorizedSession
      ? await input.client.createAuthorizedSession(createInput, {
        tenant_id: input.tenant_id,
        remote_session_id: input.remote_session_id,
        device_id: input.device_id,
        access_mode: accessMode
      })
      : await input.client.createSession(createInput);
    const normalized = normalizeRemoteGatewaySession(gateway);
    try {
      return await this.activateAuthorizedGatewaySession(input, authorization, normalized);
    } catch (error) {
      try {
        await input.client.endSession({
          external_id: normalized.external_id,
          actor_identity: input.actor_identity,
          reason: 'gateway_ended'
        });
      } catch {
        // The authorization failure remains authoritative; callers can retry cleanup separately.
      }
      throw error;
    }
  }

  async authorizeRustDeskGatewayCreation(input: {
    tenant_id: string;
    remote_session_id: string;
    target: RemoteGatewaySessionInput['target'];
    permissions: readonly RemoteConsentScope[];
    access_mode?: RustDeskGatewayAccessMode;
    device_id?: string;
    metadata?: Record<string, unknown>;
  }): Promise<PendingGatewayAuthorization> {
    const accessMode = rustDeskGatewayAccessMode(input.access_mode);
    rustDeskGatewayMetadata(input.metadata);
    const remote = await this.getSession(input.remote_session_id);
    if (!remote || remote.tenant_id !== input.tenant_id) {
      throw Object.assign(new Error('remote session not found'), { status: 404 });
    }
    if (accessMode === 'attended') {
      const consent = await this.assertActiveConsent(input.remote_session_id, input.permissions);
      return { access_mode: accessMode, consent_event_id: consent.id };
    }

    const deviceId = String(input.device_id || '').trim();
    if (!deviceId) {
      throw Object.assign(new Error('registered RustDesk device required for unattended access'), { status: 403 });
    }
    const device = await new RustDeskDeviceStore(this.pg).getDevice({
      tenant_id: input.tenant_id,
      device_id: deviceId
    });
    if (
      !device ||
      device.status !== 'active' ||
      input.target.type !== 'device' ||
      input.target.id !== device.rustdesk_id
    ) {
      throw Object.assign(new Error('registered RustDesk device does not match the remote business reference'), {
        status: 403
      });
    }
    const policy = await new RustDeskAccessPolicyStore(this.pg).assertUnattendedAccess({
      tenant_id: input.tenant_id,
      device_id: device.id,
      business_ref: remote.business_ref,
      permissions: input.permissions
    });
    const consent = await this.assertActiveConsent(input.remote_session_id, input.permissions);
    return {
      access_mode: accessMode,
      consent_event_id: consent.id,
      device_id: device.id,
      policy_version: policy.version
    };
  }

  private async assertActiveConsent(
    remoteSessionId: string,
    permissions: readonly RemoteConsentScope[]
  ): Promise<RemoteConsentEvent> {
    const activeConsent = await this.getActiveConsent(remoteSessionId);
    if (!activeConsent) {
      throw Object.assign(new Error('active consent required before starting remote tool session'), { status: 403 });
    }
    const grantedScopes = new Set(activeConsent.scopes);
    const missingPermission = permissions.find((permission) => !grantedScopes.has(permission));
    if (missingPermission) {
      throw Object.assign(new Error('active consent does not cover requested remote permissions'), {
        status: 403,
        permission: missingPermission
      });
    }
    return activeConsent;
  }

  private async activateAuthorizedGatewaySession(
    input: {
      tenant_id: string;
      remote_session_id: string;
      actor_identity: string;
      client: RemoteGatewayClient;
      target: RemoteGatewaySessionInput['target'];
      permissions: RemoteGatewaySessionInput['permissions'];
      access_mode?: RustDeskGatewayAccessMode;
      device_id?: string;
      metadata?: Record<string, unknown>;
    },
    pending: PendingGatewayAuthorization,
    normalized: ReturnType<typeof normalizeRemoteGatewaySession>
  ): Promise<RemoteToolSession> {
    const locks = [rustDeskConsentAuthorizationLock(input.tenant_id, input.remote_session_id)];
    if (pending.device_id) {
      locks.push(rustDeskPolicyAuthorizationLock(input.tenant_id, pending.device_id));
    }
    return withRustDeskAuthorizationLocks(this.pg, locks, async (pg) => {
      const store = new RemoteAssistanceStore(pg);
      let current: PendingGatewayAuthorization;
      try {
        current = input.client.provider === 'rustdesk'
          ? await store.authorizeRustDeskGatewayCreation({
            tenant_id: input.tenant_id,
            remote_session_id: input.remote_session_id,
            target: input.target,
            permissions: input.permissions,
            access_mode: input.access_mode,
            device_id: input.device_id,
            metadata: input.metadata
          })
          : {
            access_mode: 'attended',
            consent_event_id: (await store.assertActiveConsent(
              input.remote_session_id,
              input.permissions
            )).id
          };
      } catch (error) {
        throw gatewayAuthorizationChanged(error);
      }
      if (!sameGatewayAuthorization(pending, current)) {
        throw gatewayAuthorizationChanged();
      }
      return store.persistToolSession({
        tenant_id: input.tenant_id,
        remote_session_id: input.remote_session_id,
        actor_identity: input.actor_identity,
        normalized
      });
    });
  }

  async syncGatewayAuditEvents(input: {
    tenant_id: string;
    remote_session_id: string;
    actor_identity: string;
    client: RemoteGatewayClient;
    external_id: string;
    since?: string;
  }): Promise<RemoteAuditEvent[]> {
    const events = await input.client.listAuditEvents({
      external_id: input.external_id,
      since: input.since
    });
    const gatewayTool = await this.findGatewayToolSession({
      tenant_id: input.tenant_id,
      remote_session_id: input.remote_session_id,
      provider: input.client.provider,
      external_id: input.external_id
    });
    const gatewayPermissions = remoteConsentScopesFromMetadata(gatewayTool?.metadata.permissions);
    const existingEvents = await this.listAuditEvents({
      tenant_id: input.tenant_id,
      remote_session_id: input.remote_session_id,
      limit: 500
    });
    const existingKeys = new Set(
      existingEvents
        .map((event) => gatewayAuditDedupeKey(event))
        .filter((key): key is string => Boolean(key))
    );
    const recorded: RemoteAuditEvent[] = [];
    for (const event of events) {
      const metadata = {
        ...event.metadata,
        gateway_provider: input.client.provider,
        gateway_external_id: event.external_id,
        occurred_at: event.occurred_at
      };
      if (input.client.provider === 'rustdesk' && event.event_type.startsWith('remote.rustdesk.')) {
        const targetError = rustDeskGatewaySyncTargetError(event.target, gatewayTool);
        if (targetError) {
          throw Object.assign(new Error(targetError), { status: 502 });
        }
      }
      const permissionError = rustDeskGatewayEventPermissionError(event.event_type, event.metadata, gatewayPermissions);
      if (permissionError) {
        throw Object.assign(new Error(permissionError), { status: 403 });
      }
      const dedupeKey = gatewayAuditDedupeKey({
        event_type: event.event_type,
        target: event.target,
        metadata
      });
      if (dedupeKey && existingKeys.has(dedupeKey)) continue;
      recorded.push(
        await this.recordAudit({
          tenant_id: input.tenant_id,
          remote_session_id: input.remote_session_id,
          actor_identity: event.actor_identity || input.actor_identity,
          event_type: event.event_type,
          target: event.target,
          metadata
        })
      );
      if (dedupeKey) existingKeys.add(dedupeKey);
    }
    return recorded;
  }

  async endGatewayClientSession(input: {
    tool_session_id: string;
    actor_identity: string;
    client: RemoteGatewayClient;
    reason?: RustDeskDisconnectReason;
  }): Promise<RemoteToolSession | null> {
    const tool = await this.getToolSession(input.tool_session_id);
    if (!tool) return null;
    const gatewayResult = await input.client.endSession({
      external_id: tool.external_id,
      actor_identity: input.actor_identity,
      reason: input.reason
    });
    await this.syncGatewayAuditEvents({
      tenant_id: tool.tenant_id,
      remote_session_id: tool.remote_session_id,
      actor_identity: input.actor_identity,
      client: input.client,
      external_id: tool.external_id
    });
    const ended = await this.endToolSession(input.tool_session_id, input.actor_identity);
    const physicalDisconnect = gatewayResult && typeof gatewayResult === 'object'
      ? gatewayResult.physical_disconnect
      : undefined;
    if (!ended || !physicalDisconnect) return ended;
    return { ...ended, physical_disconnect: physicalDisconnect };
  }

  private async findGatewayToolSession(input: {
    tenant_id: string;
    remote_session_id: string;
    provider: string;
    external_id: string;
  }): Promise<RemoteToolSession | null> {
    const result = await this.pg.query(
      `SELECT * FROM remote_tool_sessions
       WHERE remote_session_id = $1
       ORDER BY started_at ASC
       LIMIT $2`,
      [input.remote_session_id, 100]
    );
    const tools = result.rows.map(decodeToolSession);
    return [...tools].reverse().find((tool) =>
      tool.tenant_id === input.tenant_id &&
      tool.provider === input.provider &&
      tool.external_id === input.external_id
    ) || null;
  }

  async endToolSession(toolSessionId: string, actorIdentity?: string): Promise<RemoteToolSession | null> {
    const existing = await this.pg.query('SELECT * FROM remote_tool_sessions WHERE id = $1', [toolSessionId]);
    if (!existing.rows[0]) return null;
    await this.pg.query(
      `UPDATE remote_tool_sessions SET status = 'ended', ended_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [toolSessionId]
    );
    const endedResult = await this.pg.query('SELECT * FROM remote_tool_sessions WHERE id = $1', [toolSessionId]);
    const ended = decodeToolSession(endedResult.rows[0]);
    await this.recordAudit({
      tenant_id: ended.tenant_id,
      remote_session_id: ended.remote_session_id,
      actor_identity: actorIdentity || ended.started_by,
      event_type: 'remote.tool_session.ended',
      target: ended.id,
      metadata: { provider: ended.provider }
    });
    return ended;
  }

  async getToolSession(toolSessionId: string): Promise<RemoteToolSession | null> {
    const result = await this.pg.query('SELECT * FROM remote_tool_sessions WHERE id = $1', [toolSessionId]);
    return result.rows[0] ? decodeToolSession(result.rows[0]) : null;
  }

  async getToolSessionByExternalId(input: {
    tenant_id: string;
    external_id: string;
  }): Promise<RemoteToolSession | null> {
    const result = await this.pg.query(
      `SELECT * FROM remote_tool_sessions
       WHERE tenant_id = $1 AND external_id = $2
       LIMIT 1`,
      [input.tenant_id, input.external_id]
    );
    return result.rows[0] ? decodeToolSession(result.rows[0]) : null;
  }

  async listToolSessions(remoteSessionId: string, limit = 50): Promise<RemoteToolSession[]> {
    const result = await this.pg.query(
      `SELECT * FROM remote_tool_sessions
       WHERE remote_session_id = $1
       ORDER BY started_at ASC
       LIMIT $2`,
      [remoteSessionId, limit]
    );
    return result.rows.map(decodeToolSession);
  }

  async recordAudit(input: {
    tenant_id: string;
    remote_session_id: string;
    actor_identity: string;
    event_type: string;
    target?: string;
    metadata?: Record<string, unknown>;
  }): Promise<RemoteAuditEvent> {
    const auditId = pgId('raudit');
    await this.pg.query(
      `INSERT INTO remote_audit_events
        (id, tenant_id, remote_session_id, actor_identity, event_type, target, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        auditId,
        input.tenant_id,
        input.remote_session_id,
        input.actor_identity,
        input.event_type,
        input.target || '',
        toJson(input.metadata || {})
      ]
    );
    const result = await this.pg.query('SELECT * FROM remote_audit_events WHERE id = $1', [auditId]);
    return decodeAuditEvent(result.rows[0]);
  }

  async listAuditEvents(input: {
    tenant_id: string;
    remote_session_id: string;
    limit?: number;
  }): Promise<RemoteAuditEvent[]> {
    const result = await this.pg.query(
      `SELECT * FROM remote_audit_events
       WHERE tenant_id = $1 AND remote_session_id = $2
       ORDER BY created_at ASC
       LIMIT $3`,
      [input.tenant_id, input.remote_session_id, input.limit || 100]
    );
    return result.rows.map(decodeAuditEvent);
  }

  async recordEvidence(input: {
    tenant_id: string;
    business_ref: BusinessRef;
    session_id: string;
    kind: EvidenceRecord['kind'];
    storage_url?: string;
    checksum?: string;
    retention_until?: string | null;
    created_by?: string;
    metadata?: Record<string, unknown>;
  }): Promise<EvidenceRecord> {
    const evidenceId = pgId('evid');
    await this.pg.query(
      `INSERT INTO evidence_records
        (id, tenant_id, business_ref_type, business_ref_id, session_id, kind, storage_url, checksum, retention_until, created_by, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        evidenceId,
        input.tenant_id,
        input.business_ref.type,
        input.business_ref.id,
        input.session_id,
        input.kind,
        input.storage_url || '',
        input.checksum || '',
        input.retention_until || null,
        input.created_by || '',
        toJson(input.metadata || {})
      ]
    );
    const result = await this.pg.query('SELECT * FROM evidence_records WHERE id = $1', [evidenceId]);
    return decodeEvidence(result.rows[0]);
  }

  async listEvidence(input: {
    tenant_id: string;
    business_ref: BusinessRef;
    limit?: number;
  }): Promise<EvidenceRecord[]> {
    const result = await this.pg.query(
      `SELECT * FROM evidence_records
       WHERE tenant_id = $1 AND business_ref_type = $2 AND business_ref_id = $3
       ORDER BY created_at DESC
       LIMIT $4`,
      [input.tenant_id, input.business_ref.type, input.business_ref.id, input.limit || 50]
    );
    return result.rows.map(decodeEvidence);
  }

  async listEvidenceBySession(input: {
    tenant_id: string;
    session_id: string;
    limit?: number;
  }): Promise<EvidenceRecord[]> {
    const result = await this.pg.query(
      `SELECT * FROM evidence_records
       WHERE tenant_id = $1 AND session_id = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [input.tenant_id, input.session_id, input.limit || 50]
    );
    return result.rows.map(decodeEvidence);
  }

  private async insertConsent(input: {
    tenant_id: string;
    remote_session_id: string;
    actor_identity: string;
    event_type: RemoteConsentEvent['event_type'];
    scopes: RemoteConsentScope[];
    expires_at?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<RemoteConsentEvent> {
    const consentId = pgId('rconsent');
    await this.pg.query(
      `INSERT INTO remote_consent_events
        (id, tenant_id, remote_session_id, actor_identity, event_type, scopes, expires_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        consentId,
        input.tenant_id,
        input.remote_session_id,
        input.actor_identity,
        input.event_type,
        toJson(input.scopes),
        input.expires_at || null,
        toJson(input.metadata || {})
      ]
    );
    const result = await this.pg.query('SELECT * FROM remote_consent_events WHERE id = $1', [consentId]);
    return decodeConsentEvent(result.rows[0]);
  }
}

function assertTenantRef(tenantId: string, ref: BusinessRef): void {
  if (ref.tenant_id !== tenantId) {
    throw Object.assign(new Error('business_ref tenant mismatch'), { status: 400 });
  }
}

function toJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function parseJson<T>(value: string | null | undefined, fallback: T = {} as T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

const REMOTE_CONSENT_SCOPES = new Set<RemoteConsentScope>([
  'view_screen',
  'control_mouse_keyboard',
  'record_screen',
  'transfer_file',
  'clipboard'
]);

function remoteConsentScopesFromMetadata(value: unknown): RemoteConsentScope[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((permission) => String(permission).trim())
    .filter((permission): permission is RemoteConsentScope =>
      REMOTE_CONSENT_SCOPES.has(permission as RemoteConsentScope)
    );
}

function decodeRemoteSession(row: Record<string, unknown>): RemoteAssistanceSession {
  const metadata = parseJson<Record<string, unknown>>(String(row.metadata || '{}'), {});
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    collaboration_session_id: String(row.collaboration_session_id),
    business_ref_type: String(row.business_ref_type),
    business_ref_id: String(row.business_ref_id),
    business_ref: {
      tenant_id: String(row.tenant_id),
      type: String(row.business_ref_type),
      id: String(row.business_ref_id),
      display_name: String(metadata.business_ref_display_name || ''),
      metadata: (metadata.business_ref_metadata || {}) as Record<string, unknown>
    },
    status: String(row.status) as RemoteAssistanceSession['status'],
    mode: String(row.mode) as RemoteAssistanceSession['mode'],
    adapter_provider: String(row.adapter_provider || ''),
    started_by: String(row.started_by || ''),
    started_at: row.started_at ? String(row.started_at) : null,
    ended_at: row.ended_at ? String(row.ended_at) : null,
    metadata,
    created_at: String(row.created_at)
  };
}

function decodeConsentEvent(row: Record<string, unknown>): RemoteConsentEvent {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    remote_session_id: String(row.remote_session_id),
    actor_identity: String(row.actor_identity),
    event_type: String(row.event_type) as RemoteConsentEvent['event_type'],
    scopes: parseJson(String(row.scopes || '[]'), []),
    expires_at: row.expires_at ? String(row.expires_at) : null,
    created_at: String(row.created_at),
    metadata: parseJson(String(row.metadata || '{}'), {})
  };
}

function decodeToolSession(row: Record<string, unknown>): RemoteToolSession {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    remote_session_id: String(row.remote_session_id),
    provider: String(row.provider),
    external_id: String(row.external_id || ''),
    launch_url: String(row.launch_url || ''),
    status: String(row.status) as RemoteToolSession['status'],
    started_by: String(row.started_by || ''),
    started_at: String(row.started_at),
    ended_at: row.ended_at ? String(row.ended_at) : null,
    metadata: parseJson(String(row.metadata || '{}'), {})
  };
}

function isGatewayManagedTool(tool: RemoteToolSession, client: RemoteGatewayClient): boolean {
  const gatewayProvider = String(tool.metadata.gateway_provider || '');
  return Boolean(tool.external_id) && gatewayProvider === client.provider;
}

function rustDeskGatewaySyncTargetError(target: string, tool: RemoteToolSession | null): string {
  const normalizedTarget = String(target || '').trim();
  const allowedTargets = [
    rustDeskToolMetadataString(tool?.metadata.target_id),
    rustDeskToolMetadataString(tool?.metadata.rustdesk_id),
    rustDeskToolMetadataString(tool?.metadata.rustdesk_device_id)
  ].filter(Boolean);
  if (!normalizedTarget || !allowedTargets.includes(normalizedTarget)) {
    return 'RustDesk gateway audit event target must match tool session target';
  }
  return '';
}

function rustDeskToolMetadataString(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  return '';
}

function sameGatewayAuthorization(
  pending: PendingGatewayAuthorization,
  current: PendingGatewayAuthorization
): boolean {
  return pending.access_mode === current.access_mode &&
    pending.consent_event_id === current.consent_event_id &&
    pending.device_id === current.device_id &&
    pending.policy_version === current.policy_version;
}

function gatewayAuthorizationChanged(cause?: unknown): Error & { status: number; cause?: unknown } {
  return Object.assign(new Error('gateway authorization changed during upstream creation'), {
    status: 409,
    ...(cause === undefined ? {} : { cause })
  });
}

function gatewayAuditDedupeKey(event: {
  event_type: string;
  target?: string;
  metadata?: Record<string, unknown>;
}): string {
  const metadata = event.metadata || {};
  const gatewayExternalId = String(metadata.gateway_external_id || '').trim();
  if (!gatewayExternalId) return '';
  const idempotencyKey = String(metadata.idempotency_key || '').trim();
  if (idempotencyKey) {
    return `${gatewayExternalId}:idempotency:${idempotencyKey}`;
  }
  return [
    gatewayExternalId,
    event.event_type,
    String(event.target || '').trim(),
    String(metadata.occurred_at || '').trim()
  ].join(':');
}

function decodeAuditEvent(row: Record<string, unknown>): RemoteAuditEvent {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    remote_session_id: String(row.remote_session_id),
    actor_identity: String(row.actor_identity || ''),
    event_type: String(row.event_type),
    target: String(row.target || ''),
    metadata: parseJson(String(row.metadata || '{}'), {}),
    created_at: String(row.created_at)
  };
}

function decodeEvidence(row: Record<string, unknown>): EvidenceRecord {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    business_ref_type: String(row.business_ref_type),
    business_ref_id: String(row.business_ref_id),
    session_id: String(row.session_id || ''),
    kind: String(row.kind) as EvidenceRecord['kind'],
    storage_url: String(row.storage_url || ''),
    checksum: String(row.checksum || ''),
    retention_until: row.retention_until ? String(row.retention_until) : null,
    created_by: String(row.created_by || ''),
    created_at: String(row.created_at),
    metadata: parseJson(String(row.metadata || '{}'), {})
  };
}
