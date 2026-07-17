import { createCollaborationModule } from '../collaboration/index.js';
import { rustDeskClientConfig } from '../collaboration/rustdesk-client-config.js';
import {
  rustDeskGatewayEventPermissionError,
  rustDeskGatewayEventValidationError
} from '../collaboration/rustdesk-gateway-event.js';
import {
  assertRustDeskDeviceOnlineIfRequired,
  assertRustDeskPhysicalDisconnectCapableIfRequired
} from '../collaboration/rustdesk-device-online.js';
import {
  RustDeskGatewaySessionStore,
  type RustDeskGatewaySession
} from '../collaboration/rustdesk-gateway-session-store.js';
import {
  rustDeskGatewayAccessMode,
  rustDeskGatewayMetadata
} from '../collaboration/rustdesk-gateway-security.js';
import type { RemoteGatewayClient } from '../collaboration/remote-gateway-client.js';
import { rustDeskLaunchPlan } from '../collaboration/rustdesk-launch-plan.js';
import { createLiveKitMediaModule } from '../livekit/index.js';
import type {
  CollaborationParticipantRole,
  RemoteAssistanceMode,
  RemoteAssistanceSession,
  RemoteToolSession
} from '../collaboration/types.js';
import type { MediaJoinPlan, ParticipantRole } from '../media-gateway/index.js';
import { createWebAssistJoinPath, verifyWebAssistJoinToken, webAssistExpiresAt } from './remote-assist-token.js';
import { IveKitTenantEventJournal } from './tenant-event-store.js';
import type {
  IveBusinessRef,
  IveEvidenceRecord,
  IveKitModule,
  IveKitModuleInput,
  IveRemoteAssistEvent,
  IveMediaRoom,
  OpenIveSessionInput
} from './types.js';

function badRequest(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 400 });
}

function assertTenantRef(tenantId: string, ref: { tenant_id: string }): void {
  if (ref.tenant_id !== tenantId) {
    throw badRequest('business_ref tenant mismatch');
  }
}

function roomNameFor(input: OpenIveSessionInput): string {
  return (
    input.media?.room_name ||
    `${input.tenant_id}-${input.business_ref.type}-${input.business_ref.id}`.replace(/[^a-zA-Z0-9_-]/g, '-')
  );
}

function customerJoinPath(input: {
  tenantId: string;
  roomName: string;
  identity: string;
  media: 'voice' | 'video';
}): string {
  const params = new URLSearchParams({
    room: input.roomName,
    room_name: input.roomName,
    tenant_id: input.tenantId,
    identity: input.identity,
    media: input.media
  });
  return `/video?${params.toString()}`;
}

function remoteAssistRequestPath(input: { tenantId: string; remoteSessionId: string }): string {
  const params = new URLSearchParams({
    tenant_id: input.tenantId,
    remote_session_id: input.remoteSessionId
  });
  return `/remote-assist?${params.toString()}`;
}

function forbidden(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 403 });
}

function toCollaborationRole(role: string): CollaborationParticipantRole {
  if (role === 'system') return 'admin';
  return role as CollaborationParticipantRole;
}

function toRemoteMode(mode: string): RemoteAssistanceMode {
  return mode as RemoteAssistanceMode;
}

function isGatewayManagedProvider(provider: string): boolean {
  return provider === 'rustdesk' || provider === 'meshcentral' || provider === 'guacamole';
}

function toMediaGatewayRole(role: 'customer' | 'agent' | 'engineer' | 'supervisor'): ParticipantRole {
  return role === 'customer' ? 'customer' : 'agent';
}

function toIveMediaJoinPlan(
  plan: MediaJoinPlan,
  input: {
    room_name: string;
    identity: string;
    role: 'customer' | 'agent' | 'engineer' | 'supervisor';
    media: 'voice' | 'video';
  }
) {
  return {
    channel: plan.channel as 'webrtc' | 'sip_volte',
    room_name: input.room_name,
    identity: input.identity,
    role: input.role,
    media: input.media,
    token: plan.mode === 'webrtc' ? plan.token.token : undefined,
    livekit_url: plan.mode === 'webrtc' ? plan.token.livekit_url : undefined,
    join_path: plan.mode === 'webrtc' ? plan.joinPath : undefined,
    metadata:
      plan.mode === 'sip_bridge'
        ? { sip_dial_target: plan.sipDialTarget, trunk: plan.trunk, note: plan.note, video: plan.video }
        : { configured: plan.token.configured }
  };
}

function toIveMediaRoom(room: {
  id: string;
  tenant_id: string;
  room_name: string;
  purpose: string;
  status: 'created' | 'active' | 'closed';
  metadata: Record<string, unknown>;
}): IveMediaRoom {
  const businessRef = room.metadata.business_ref as IveBusinessRef | undefined;
  return {
    id: room.id,
    tenant_id: room.tenant_id,
    room_name: room.room_name,
    purpose: (room.metadata.media_kind === 'voice' ? 'voice_service' : room.purpose) as IveMediaRoom['purpose'],
    status: room.status,
    business_ref: businessRef || {
      tenant_id: room.tenant_id,
      type: '',
      id: ''
    },
    metadata: room.metadata
  };
}

function toIveEvidence(record: {
  id: string;
  tenant_id: string;
  business_ref_type: string;
  business_ref_id: string;
  session_id: string;
  kind: IveEvidenceRecord['kind'];
  storage_url: string;
  checksum?: string;
  retention_until?: string | null;
  created_by: string;
  created_at: string;
  metadata: Record<string, unknown>;
}): IveEvidenceRecord {
  return {
    id: record.id,
    tenant_id: record.tenant_id,
    business_ref: {
      tenant_id: record.tenant_id,
      type: record.business_ref_type,
      id: record.business_ref_id
    },
    session_id: record.session_id,
    kind: record.kind,
    storage_url: record.storage_url,
    checksum: record.checksum,
    retention_until: record.retention_until,
    created_by: record.created_by,
    created_at: record.created_at,
    metadata: record.metadata
  };
}

function toIveRemoteAssistEvent(audit: {
  id: string;
  tenant_id: string;
  remote_session_id: string;
  actor_identity: string;
  event_type: string;
  created_at: string;
  metadata: Record<string, unknown>;
}): IveRemoteAssistEvent {
  return {
    id: audit.id,
    tenant_id: audit.tenant_id,
    remote_session_id: audit.remote_session_id,
    actor_identity: audit.actor_identity,
    event_type: String(audit.metadata.web_assist_event_type || audit.event_type) as IveRemoteAssistEvent['event_type'],
    payload: (audit.metadata.payload as Record<string, unknown> | undefined) || {},
    created_at: audit.created_at
  };
}

export function createIveKitModule(input: IveKitModuleInput): IveKitModule {
  const media = createLiveKitMediaModule({
    db: input.db,
    config: input.media?.livekit
  });
  const collaboration = createCollaborationModule({ pg: input.pg });
  const tenantEvents = new IveKitTenantEventJournal(input.pg);
  const rustdeskGatewaySessions = new RustDeskGatewaySessionStore(input.pg);
  const localRustDeskGatewayClient: RemoteGatewayClient = {
    provider: 'rustdesk',
    createSession: async () => {
      throw badRequest('rustdesk gateway session creation is not supported by this facade client');
    },
    endSession: async (endInput) => {
      const ended = await collaboration.rustdeskPhysicalDisconnect.endGatewaySession({
        external_id: endInput.external_id,
        actor_identity: endInput.actor_identity,
        requested_reason: endInput.reason || 'gateway_ended'
      });
      return { physical_disconnect: ended.physical_disconnect };
    },
    listAuditEvents: async (auditInput) => {
      const events = await rustdeskGatewaySessions.listAuditEvents(auditInput);
      if (!events) throw badRequest('rustdesk gateway session not found');
      return events;
    }
  };
  const gatewayClientForTool = async (
    tool: RemoteToolSession
  ): Promise<RemoteGatewayClient | undefined> => {
    if (input.remoteGateway?.provider === tool.provider) return input.remoteGateway;
    if (tool.provider !== 'rustdesk') return undefined;
    const session = await rustdeskGatewaySessions.getSession(tool.external_id);
    return session && session.tenant_id === tool.tenant_id
      ? localRustDeskGatewayClient
      : undefined;
  };

  async function syncRustDeskGatewayTimeline(input: {
    session: RustDeskGatewaySession;
    actor_identity: string;
    endMatchingTool?: boolean;
  }): Promise<void> {
    const remoteSessionId = String(input.session.metadata.remote_session_id || '').trim();
    if (!remoteSessionId) return;
    const remote = await collaboration.remote.getSession(remoteSessionId);
    if (!remote || remote.tenant_id !== input.session.tenant_id) return;
    await collaboration.remote.syncGatewayAuditEvents({
      tenant_id: input.session.tenant_id,
      remote_session_id: remote.id,
      actor_identity: input.actor_identity,
      client: localRustDeskGatewayClient,
      external_id: input.session.external_id
    });
    if (!input.endMatchingTool) return;
    const tools = await collaboration.remote.listToolSessions(remote.id, 100);
    const matchingTool = [...tools].reverse().find((tool) =>
      tool.provider === 'rustdesk' &&
      tool.external_id === input.session.external_id
    );
    if (matchingTool && matchingTool.status !== 'ended') {
      await collaboration.remote.endToolSession(matchingTool.id, input.actor_identity);
    }
  }

  async function open(sessionInput: OpenIveSessionInput) {
    assertTenantRef(sessionInput.tenant_id, sessionInput.business_ref);
    const collab = await collaboration.sessions.openSession({
      tenant_id: sessionInput.tenant_id,
      business_ref: sessionInput.business_ref,
      title: sessionInput.title || sessionInput.business_ref.display_name || '',
      metadata: sessionInput.metadata
    });

    for (const participant of sessionInput.participants || []) {
      await collaboration.sessions.addParticipant({
        tenant_id: sessionInput.tenant_id,
        session_id: collab.id,
        identity: participant.identity,
        role: toCollaborationRole(participant.role),
        display_name: participant.display_name,
        user_ref: participant.user_ref
          ? { tenant_id: sessionInput.tenant_id, type: participant.user_ref.type, id: participant.user_ref.id }
          : undefined
      });
    }

    const roomName = sessionInput.media?.enabled ? roomNameFor(sessionInput) : '';
    if (sessionInput.media?.enabled) {
      await media.rooms.createRoom({
        tenant_id: sessionInput.tenant_id,
        purpose: 'video_service',
        room_name: roomName,
        metadata: {
          ...(sessionInput.metadata || {}),
          media_kind: sessionInput.media.kind,
          business_ref: sessionInput.business_ref
        }
      });
    }

    let remoteSessionId = '';
    let requestPath = '';
    if (sessionInput.remote_assistance?.enabled) {
      const remote = await collaboration.remote.createSession({
        tenant_id: sessionInput.tenant_id,
        collaboration_session_id: collab.id,
        business_ref: sessionInput.business_ref,
        mode: toRemoteMode(sessionInput.remote_assistance.mode),
        adapter_provider: sessionInput.remote_assistance.adapter_provider || 'ivekit_web',
        started_by: sessionInput.remote_assistance.started_by,
        metadata: {
          ...(sessionInput.metadata || {}),
          ...(roomName ? { media_room_name: roomName } : {})
        }
      });
      remoteSessionId = remote.id;
      if (sessionInput.remote_assistance.mode === 'web_remote_assist') {
        requestPath = remoteAssistRequestPath({
          tenantId: sessionInput.tenant_id,
          remoteSessionId
        });
      }
    }

    return {
      business_ref: sessionInput.business_ref,
      collaboration_session_id: collab.id,
      media_room_name: roomName,
      customer_join_path:
        sessionInput.media?.enabled &&
        sessionInput.media.create_customer_join_path &&
        sessionInput.media.customer_identity
          ? customerJoinPath({
              tenantId: sessionInput.tenant_id,
              roomName,
              identity: sessionInput.media.customer_identity,
              media: sessionInput.media.kind
            })
          : undefined,
      remote_session_id: remoteSessionId || undefined,
      remote_assist_request_path: requestPath || undefined
    };
  }

  return {
    sessions: {
      open,
      getByBusinessRef: async (lookup) => {
        assertTenantRef(lookup.tenant_id, lookup.business_ref);
        const sessions = await collaboration.sessions.listByBusinessRef({
          tenant_id: lookup.tenant_id,
          business_ref: lookup.business_ref
        });
        const remotes = await collaboration.remote.listByBusinessRef({
          tenant_id: lookup.tenant_id,
          business_ref: lookup.business_ref
        });
        return sessions.map((session) => {
          const remote = remotes.find((item) => item.collaboration_session_id === session.id);
          return {
            business_ref: session.business_ref,
            collaboration_session_id: session.id,
            media_room_name: '',
            remote_session_id: remote?.id,
            remote_assist_request_path:
              remote?.mode === 'web_remote_assist'
                ? remoteAssistRequestPath({ tenantId: lookup.tenant_id, remoteSessionId: remote.id })
                : undefined
          };
        });
      },
      close: async (closeInput) => {
        await collaboration.sessions.closeSession(closeInput.collaboration_session_id);
      }
    },
    media: {
      createRoom: async (roomInput) => {
        assertTenantRef(roomInput.tenant_id, roomInput.business_ref);
        const room = await media.rooms.createRoom({
          tenant_id: roomInput.tenant_id,
          purpose: roomInput.purpose === 'voice_service' ? 'video_service' : roomInput.purpose,
          room_name: roomInput.room_name,
          metadata: {
            ...(roomInput.metadata || {}),
            media_kind: roomInput.purpose === 'voice_service' ? 'voice' : 'video',
            business_ref: roomInput.business_ref
          }
        });
        return toIveMediaRoom(room);
      },
      issueJoinPlan: async (joinInput) => {
        const plan = await media.joins.prepareJoin(joinInput.channel || 'webrtc', {
          tenantId: joinInput.tenant_id,
          roomName: joinInput.room_name,
          identity: joinInput.identity,
          role: toMediaGatewayRole(joinInput.role),
          media: joinInput.media
        });
        return toIveMediaJoinPlan(plan, joinInput);
      }
    },
    collaboration: {
      postMessage: collaboration.sessions.postMessage.bind(collaboration.sessions),
      addTranslation: collaboration.sessions.addTranslation.bind(collaboration.sessions),
      scanPolicy: collaboration.sessions.scanPolicy.bind(collaboration.sessions),
      listTimeline: async (timelineInput) => collaboration.sessions.listTimeline(timelineInput.session_id)
    },
    remote: {
      create: collaboration.remote.createSession.bind(collaboration.remote),
      requestConsent: collaboration.remote.requestConsent.bind(collaboration.remote),
      grantConsent: collaboration.remote.grantConsent.bind(collaboration.remote),
      denyConsent: collaboration.remote.denyConsent.bind(collaboration.remote),
      revokeConsent: async (revokeInput) => collaboration.remote.revokeConsent({
        ...revokeInput,
        gateway_client_for_tool: gatewayClientForTool
      }),
      createWebAssistJoin: async (joinInput) => {
        const remote = await collaboration.remote.getSession(joinInput.remote_session_id);
        if (!remote || remote.tenant_id !== joinInput.tenant_id) {
          throw badRequest('remote session not found');
        }
        if (remote.mode !== 'web_remote_assist') {
          throw badRequest('remote session is not Web Assist');
        }
        if (joinInput.role !== 'customer' && !(await collaboration.remote.hasActiveConsent(joinInput.remote_session_id))) {
          throw forbidden('active consent required before joining Web Assist');
        }
        const expiresAt = webAssistExpiresAt(joinInput.expires_in_ms);
        const joinPath = createWebAssistJoinPath(
          {
            tenant_id: joinInput.tenant_id,
            remote_session_id: joinInput.remote_session_id,
            actor_identity: joinInput.actor_identity,
            role: joinInput.role,
            expires_at: expiresAt
          },
          input.media?.livekit?.apiSecret
        );
        await collaboration.remote.recordAudit({
          tenant_id: joinInput.tenant_id,
          remote_session_id: joinInput.remote_session_id,
          actor_identity: joinInput.actor_identity,
          event_type: 'remote.web_assist.join_issued',
          target: joinInput.remote_session_id,
          metadata: {
            role: joinInput.role,
            expires_at: expiresAt
          }
        });
        return {
          remote_session_id: joinInput.remote_session_id,
          role: joinInput.role,
          join_path: joinPath,
          expires_at: expiresAt
        };
      },
      verifyWebAssistJoin: async (verifyInput) => {
        const remote = await collaboration.remote.getSession(verifyInput.remote_session_id);
        if (!remote || remote.tenant_id !== verifyInput.tenant_id) {
          throw badRequest('remote session not found');
        }
        if (remote.mode !== 'web_remote_assist') {
          throw badRequest('remote session is not Web Assist');
        }
        const token = verifyWebAssistJoinToken({
          tenant_id: verifyInput.tenant_id,
          remote_session_id: verifyInput.remote_session_id,
          token: verifyInput.token,
          secret: input.media?.livekit?.apiSecret,
          now: verifyInput.now
        });
        await collaboration.remote.recordAudit({
          tenant_id: verifyInput.tenant_id,
          remote_session_id: verifyInput.remote_session_id,
          actor_identity: token.actor_identity,
          event_type: 'remote.web_assist.join_verified',
          target: verifyInput.remote_session_id,
          metadata: {
            role: token.role,
            expires_at: token.expires_at
          }
        });
        return {
          tenant_id: token.tenant_id,
          remote_session_id: token.remote_session_id,
          actor_identity: token.actor_identity,
          role: token.role,
          expires_at: token.expires_at
        };
      },
      recordAssistEvent: async (eventInput) => {
        const remote = await collaboration.remote.getSession(eventInput.remote_session_id);
        if (!remote || remote.tenant_id !== eventInput.tenant_id) {
          throw badRequest('remote session not found');
        }
        if (remote.mode !== 'web_remote_assist') {
          throw badRequest('remote session is not Web Assist');
        }
        if (!(await collaboration.remote.hasActiveConsent(eventInput.remote_session_id))) {
          throw forbidden('active consent required before recording Web Assist event');
        }
        const audit = await collaboration.remote.recordAudit({
          tenant_id: eventInput.tenant_id,
          remote_session_id: eventInput.remote_session_id,
          actor_identity: eventInput.actor_identity,
          event_type: `remote.web_assist.${eventInput.event_type}`,
          target: eventInput.remote_session_id,
          metadata: {
            web_assist_event_type: eventInput.event_type,
            payload: eventInput.payload || {}
          }
        });
        return toIveRemoteAssistEvent(audit);
      },
      startExternalTool: collaboration.remote.startToolSession.bind(collaboration.remote),
      endExternalTool: async (toolInput) => {
        const remote = await collaboration.remote.getSession(toolInput.remote_session_id);
        if (!remote || remote.tenant_id !== toolInput.tenant_id) {
          throw badRequest('remote session not found');
        }
        const tool = await collaboration.remote.getToolSession(toolInput.tool_session_id);
        if (!tool || tool.tenant_id !== toolInput.tenant_id || tool.remote_session_id !== toolInput.remote_session_id) {
          throw badRequest('remote tool session not found');
        }
        const gatewayClient = await gatewayClientForTool(tool);
        if (gatewayClient && isGatewayManagedProvider(tool.provider)) {
          return collaboration.remote.endGatewayClientSession({
            tool_session_id: tool.id,
            actor_identity: toolInput.actor_identity,
            client: gatewayClient,
            reason: 'tool_ended'
          });
        }
        return collaboration.remote.endToolSession(tool.id, toolInput.actor_identity);
      },
      end: async (endInput) => {
        const remote = await collaboration.remote.getSession(endInput.remote_session_id);
        if (!remote || remote.tenant_id !== endInput.tenant_id) {
          throw badRequest('remote session not found');
        }
        const tools = await collaboration.remote.listToolSessions(remote.id);
        let physicalDisconnect: RemoteAssistanceSession['physical_disconnect'];
        for (const tool of tools) {
          if (tool.status !== 'active' || !isGatewayManagedProvider(tool.provider)) continue;
          const gatewayClient = await gatewayClientForTool(tool);
          if (gatewayClient) {
            const endedTool = await collaboration.remote.endGatewayClientSession({
              tool_session_id: tool.id,
              actor_identity: endInput.actor_identity,
              client: gatewayClient,
              reason: 'remote_session_ended'
            });
            physicalDisconnect ||= endedTool?.physical_disconnect;
          }
        }
        const endedRemote = await collaboration.remote.endSession({
          remote_session_id: remote.id,
          actor_identity: endInput.actor_identity
        });
        return endedRemote && physicalDisconnect
          ? { ...endedRemote, physical_disconnect: physicalDisconnect }
          : endedRemote;
      },
      listAuditEvents: collaboration.remote.listAuditEvents.bind(collaboration.remote)
    },
    rustdesk: {
      registerDevice: async (deviceInput) => {
        assertTenantRef(deviceInput.tenant_id, deviceInput.business_ref);
        return collaboration.rustdeskDevices.registerDevice(deviceInput);
      },
      listDevicesByBusinessRef: async (lookup) => {
        assertTenantRef(lookup.tenant_id, lookup.business_ref);
        return collaboration.rustdeskDevices.getByBusinessRef(lookup);
      },
      deactivateDevice: collaboration.rustdeskDevices.deactivateDevice.bind(collaboration.rustdeskDevices),
      heartbeatDevice: collaboration.rustdeskDevices.heartbeatDevice.bind(collaboration.rustdeskDevices),
      requestAuthorizationCode: async (authorizationInput) => {
        const remote = await collaboration.remote.getSession(authorizationInput.remote_session_id);
        if (!remote || remote.tenant_id !== authorizationInput.tenant_id) {
          throw badRequest('remote session not found');
        }
        const participants = await collaboration.sessions.listParticipants({
          tenant_id: authorizationInput.tenant_id,
          session_id: remote.collaboration_session_id
        });
        const requester = participants.find((participant) =>
          participant.identity === authorizationInput.requested_by && !participant.left_at
        );
        if (!requester || !['customer', 'admin'].includes(requester.role)) {
          throw forbidden('authorization code request requires an active customer or admin');
        }
        const device = await collaboration.rustdeskDevices.getDevice({
          tenant_id: authorizationInput.tenant_id,
          device_id: authorizationInput.device_id
        });
        if (
          !device ||
          device.status !== 'active' ||
          device.business_ref_type !== remote.business_ref.type ||
          device.business_ref_id !== remote.business_ref.id
        ) {
          throw badRequest('rustdesk device not found');
        }
        const consent = await collaboration.remote.getActiveConsent(remote.id);
        const consentScopes = new Set(consent?.scopes || []);
        if (!consent || authorizationInput.scopes.some((scope) => !consentScopes.has(scope))) {
          throw forbidden('active consent does not cover requested authorization scopes');
        }
        const result = await collaboration.rustdeskAuthorizationCodes.create(authorizationInput);
        if (!result.replayed) {
          const eventType = 'remote.rustdesk.authorization_code.requested';
          const eventData = {
            remote_session_id: remote.id,
            authorization_id: result.authorization.id,
            device_id: device.id,
            scopes: result.authorization.scopes,
            expires_at: result.authorization.expires_at
          };
          await collaboration.remote.recordAudit({
            tenant_id: authorizationInput.tenant_id,
            remote_session_id: remote.id,
            actor_identity: authorizationInput.requested_by,
            event_type: eventType,
            target: result.authorization.id,
            metadata: eventData
          });
          await tenantEvents.append({
            tenant_id: authorizationInput.tenant_id,
            type: eventType,
            data: eventData,
            audience_user_ids: participants.filter((participant) => !participant.left_at)
              .map((participant) => participant.identity)
          });
        }
        return result;
      },
      getAuthorizationCode: collaboration.rustdeskAuthorizationCodes.get.bind(
        collaboration.rustdeskAuthorizationCodes
      ),
      verifyAuthorizationCode: async (verificationInput) => {
        const authorization = await collaboration.rustdeskAuthorizationCodes.get({
          tenant_id: verificationInput.tenant_id,
          authorization_id: verificationInput.authorization_id
        });
        if (!authorization) throw badRequest('RustDesk authorization code not found');
        const remote = await collaboration.remote.getSession(authorization.remote_session_id);
        if (!remote || remote.tenant_id !== verificationInput.tenant_id) {
          throw badRequest('RustDesk authorization code not found');
        }
        const participants = await collaboration.sessions.listParticipants({
          tenant_id: verificationInput.tenant_id,
          session_id: remote.collaboration_session_id
        });
        const verifier = participants.find((participant) =>
          participant.identity === verificationInput.verified_by && !participant.left_at
        );
        if (!verifier || !['agent', 'engineer', 'supervisor', 'admin'].includes(verifier.role)) {
          throw forbidden('authorization code verification requires an active engineer');
        }
        const audienceUserIds = participants.filter((participant) => !participant.left_at)
          .map((participant) => participant.identity);
        const recordVerificationEvent = async (
          eventType: string,
          eventData: Record<string, unknown>
        ) => {
          await collaboration.remote.recordAudit({
            tenant_id: verificationInput.tenant_id,
            remote_session_id: remote.id,
            actor_identity: verificationInput.verified_by,
            event_type: eventType,
            target: authorization.id,
            metadata: eventData
          });
          await tenantEvents.append({
            tenant_id: verificationInput.tenant_id,
            type: eventType,
            data: eventData,
            audience_user_ids: audienceUserIds
          });
        };
        try {
          const verified = await collaboration.rustdeskAuthorizationCodes.verify(verificationInput);
          if (authorization.status === 'pending') await recordVerificationEvent('remote.rustdesk.authorization_code.verified', {
            remote_session_id: remote.id,
            authorization_id: authorization.id,
            device_id: authorization.device_id,
            scopes: authorization.scopes,
            verified_by: verificationInput.verified_by
          });
          return verified;
        } catch (error) {
          const current = await collaboration.rustdeskAuthorizationCodes.get({
            tenant_id: verificationInput.tenant_id,
            authorization_id: authorization.id
          });
          await recordVerificationEvent(
            current?.status === 'locked'
              ? 'remote.rustdesk.authorization_code.locked'
              : 'remote.rustdesk.authorization_code.failed',
            {
              remote_session_id: remote.id,
              authorization_id: authorization.id,
              device_id: authorization.device_id,
              status: current?.status || 'unavailable',
              attempt_count: current?.attempt_count ?? authorization.attempt_count
            }
          );
          throw error;
        }
      },
      getClientConfig: async () => rustDeskClientConfig(),
      getGatewayLaunchPlan: async (planInput) => {
        const session = await rustdeskGatewaySessions.getSession(planInput.external_id);
        if (!session || session.tenant_id !== planInput.tenant_id) {
          throw badRequest('rustdesk gateway session not found');
        }
        return rustDeskLaunchPlan(session);
      },
      recordGatewayEvent: async (eventInput) => {
        const session = await rustdeskGatewaySessions.getSession(eventInput.external_id);
        if (!session || session.tenant_id !== eventInput.tenant_id) {
          throw badRequest('rustdesk gateway session not found');
        }
        if (session.status !== 'active') {
          throw badRequest('RustDesk gateway session is not active');
        }
        const eventValidationError = rustDeskGatewayEventValidationError(
          eventInput.event_type,
          eventInput.metadata || {}
        );
        if (eventValidationError) throw badRequest(eventValidationError);
        const eventPermissionError = rustDeskGatewayEventPermissionError(
          eventInput.event_type,
          eventInput.metadata || {},
          session.permissions
        );
        if (eventPermissionError) throw forbidden(eventPermissionError);
        const event = await rustdeskGatewaySessions.appendAuditEvent({
          external_id: eventInput.external_id,
          event_type: eventInput.event_type,
          actor_identity: eventInput.actor_identity,
          target: eventInput.target,
          idempotency_key: eventInput.idempotency_key,
          metadata: eventInput.metadata,
          occurred_at: eventInput.occurred_at
        });
        if (!event) throw badRequest('rustdesk gateway session not found');
        await syncRustDeskGatewayTimeline({
          session,
          actor_identity: eventInput.actor_identity
        });
        return event;
      },
      listGatewayAuditEvents: async (auditInput) => {
        const session = await rustdeskGatewaySessions.getSession(auditInput.external_id);
        if (!session || session.tenant_id !== auditInput.tenant_id) {
          throw badRequest('rustdesk gateway session not found');
        }
        const events = await rustdeskGatewaySessions.listAuditEvents({
          external_id: auditInput.external_id,
          since: auditInput.since
        });
        if (!events) throw badRequest('rustdesk gateway session not found');
        return events;
      },
      listGatewaySessions: async (sessionsInput) => rustdeskGatewaySessions.listSessions({
        tenant_id: sessionsInput.tenant_id,
        status: sessionsInput.status === 'all' ? undefined : sessionsInput.status,
        limit: sessionsInput.limit
      }),
      endGatewaySession: async (endInput) => {
        const session = await rustdeskGatewaySessions.getSession(endInput.external_id);
        if (!session || session.tenant_id !== endInput.tenant_id) {
          throw badRequest('rustdesk gateway session not found');
        }
        const ended = await collaboration.rustdeskPhysicalDisconnect.endGatewaySession({
          tenant_id: endInput.tenant_id,
          external_id: endInput.external_id,
          actor_identity: endInput.actor_identity,
          requested_reason: 'gateway_ended'
        });
        await syncRustDeskGatewayTimeline({
          session: ended.session,
          actor_identity: endInput.actor_identity,
          endMatchingTool: true
        });
        return ended.session;
      },
      startGatewaySession: async (gatewayInput) => {
        if (!input.remoteGateway) {
          throw badRequest('rustdesk remote gateway client is not configured');
        }
        if (input.remoteGateway.provider !== 'rustdesk') {
          throw badRequest('rustdesk facade requires a rustdesk remote gateway client');
        }
        const { authorization_id: authorizationId, ...metadataSafeGatewayInput } = gatewayInput;
        rustDeskGatewayMetadata(metadataSafeGatewayInput, 'RustDesk gateway request');
        const accessMode = rustDeskGatewayAccessMode(gatewayInput.access_mode);
        const remote = await collaboration.remote.getSession(gatewayInput.remote_session_id);
        if (!remote || remote.tenant_id !== gatewayInput.tenant_id) {
          throw badRequest('remote session not found');
        }
        const device = await collaboration.rustdeskDevices.getDevice({
          tenant_id: gatewayInput.tenant_id,
          device_id: gatewayInput.device_id
        });
        if (!device || device.status !== 'active') {
          throw badRequest('rustdesk device not found');
        }
        assertRustDeskDeviceOnlineIfRequired(device);
        assertRustDeskPhysicalDisconnectCapableIfRequired(device);
        const requestMetadata = rustDeskGatewayMetadata(gatewayInput.metadata);
        if (requestMetadata.access_mode !== undefined) {
          throw badRequest('RustDesk access_mode must be a top-level field');
        }
        const tool = await collaboration.remote.startGatewayClientSession({
          tenant_id: gatewayInput.tenant_id,
          remote_session_id: gatewayInput.remote_session_id,
          actor_identity: gatewayInput.actor_identity,
          client: input.remoteGateway,
          target: {
            type: 'device',
            id: device.rustdesk_id,
            display_name: device.display_name
          },
          permissions: gatewayInput.permissions,
          access_mode: accessMode,
          device_id: device.id,
          authorization_id: authorizationId,
          metadata: {
            ...requestMetadata,
            ...(gatewayInput.access_mode ? { access_mode: accessMode } : {}),
            remote_session_id: remote.id,
            collaboration_session_id: remote.collaboration_session_id,
            rustdesk_target_mode: 'registered_device',
            target_id: device.id,
            rustdesk_id: device.rustdesk_id,
            rustdesk_device_id: device.id,
            target_display_name: device.display_name
          }
        });
        if (authorizationId) {
          await tenantEvents.append({
            tenant_id: gatewayInput.tenant_id,
            type: 'remote.rustdesk.authorization_code.consumed',
            data: {
              remote_session_id: remote.id,
              authorization_id: authorizationId,
              device_id: device.id,
              gateway_external_id: tool.external_id
            }
          });
        }
        return tool;
      }
    },
    evidence: {
      record: async (evidenceInput) => {
        assertTenantRef(evidenceInput.tenant_id, evidenceInput.business_ref);
        const evidence = await collaboration.remote.recordEvidence({
          tenant_id: evidenceInput.tenant_id,
          business_ref: evidenceInput.business_ref,
          session_id: evidenceInput.session_id,
          kind: evidenceInput.kind,
          storage_url: evidenceInput.storage_url,
          checksum: evidenceInput.checksum,
          retention_until: evidenceInput.retention_until,
          created_by: evidenceInput.created_by,
          metadata: evidenceInput.metadata
        });
        return toIveEvidence(evidence);
      },
      listByBusinessRef: async (lookup) => {
        assertTenantRef(lookup.tenant_id, lookup.business_ref);
        const evidence = await collaboration.remote.listEvidence({
          tenant_id: lookup.tenant_id,
          business_ref: lookup.business_ref,
          limit: lookup.limit
        });
        return evidence.map(toIveEvidence);
      },
      listBySession: async (lookup) => {
        const evidence = await collaboration.remote.listEvidenceBySession({
          tenant_id: lookup.tenant_id,
          session_id: lookup.session_id,
          limit: lookup.limit
        });
        return evidence.map(toIveEvidence);
      }
    }
  };
}
