import { resolveFabricEnv } from '../../../config/converact-env.js';
import { createHash } from 'node:crypto';

import type { PgQueryable } from '../../../db-pg.js';
import { withPgTenant } from '../../../db-pg-tenant.js';
import { resolveAuthContext, type AuthContext } from '../../../middleware/auth.js';
import { createObjectStorage, type ObjectStorage } from '../../../storage/object-storage.js';
import {
  PostgresRecordingManifestStore,
  PostgresRecordingSpoolPlacementStore,
  RecordingSegmentUploadService,
  RecordingSpoolIntakeService,
  RustPbxRecordingSpoolAuthorizer,
  recordingSpoolHttpPartMaxBytes,
  type RecordingSpoolInitializeInput
} from '../recordings/index.js';
import { configuredVoiceAddressProtector } from './address-protector.js';
import { RustPbxEventsAdapter } from './adapters/rustpbx-events.js';
import { RustPbxRouterAdapter } from './adapters/rustpbx-routing.js';
import {
  VoiceCallService,
  type VoiceCallOwnerContractFacts,
  type VoiceCallPlacementPort
} from './call-service.js';
import {
  parseVoiceDualLegCdr,
  type VoiceCdrConvergencePort
} from './cdr-convergence.js';
import { VoicePolicyComplianceService } from './compliance-service.js';
import { canonicalVoicePayloadHash } from './canonical.js';
import { VoiceConfigurationService } from './configuration-service.js';
import {
  assertVoiceConfigContainsNoSecrets,
  VoiceDeploymentProfileService
} from './deployment-profile-service.js';
import { VoiceError } from './errors.js';
import { resolveRustPbxMediaControlProfile } from './media-control-profile.js';
import type {
  VoiceAddressProtector,
  VoiceCallRepository,
  VoiceCompliancePort,
  VoiceConfigurationRepository,
  VoiceEventPort,
  VoiceProviderEventRepository,
  VoiceRecordingRepository,
  VoiceSecretResolver
} from './ports.js';
import { PostgresVoiceCallStore } from './postgres/call-store.js';
import { PostgresVoiceCdrConvergenceStore } from './postgres/cdr-convergence-store.js';
import { PostgresVoiceCommandStore } from './postgres/command-store.js';
import { PostgresVoiceConfigurationStore } from './postgres/configuration-store.js';
import { PostgresVoiceProviderEventStore } from './postgres/provider-event-store.js';
import { PostgresVoiceRecordingStore } from './postgres/recording-store.js';
import {
  PostgresVoiceCallUnitOfWork,
  PostgresVoiceConfigurationUnitOfWork
} from './postgres/unit-of-work.js';
import { VoiceProviderEventService, VoiceRouterDecisionService } from './provider-event-service.js';
import { VoiceProviderRegistry } from './provider-registry.js';
import type { RealtimeAudioTapGrantService } from './realtime-audio-tap-grant.js';
import { createIveKitVoiceProviderRegistry } from './runtime.js';
import { EnvVoiceSecretResolver } from './secret-resolver.js';
import type {
  VoiceAdapter,
  VoiceAddressKind,
  VoiceCallCommand,
  VoiceCallState,
  VoiceConfigurationCommand,
  VoiceDeploymentProfile,
  VoiceExtension,
  VoiceExtensionSessionPlan,
  VoiceRecording,
  VoiceRouteDirection,
  VoiceSipTrunk
} from './types.js';
import {
  PostgresVoiceProfileContextResolver,
  VoiceWebhookAuthenticator,
  type VoiceWebhookAuthentication
} from './webhook-auth.js';

export interface VoiceExtensionSessionPort {
  create(input: {
    tenant_id: string;
    extension: VoiceExtension;
    actor: string;
    idempotency_key: string;
  }): Promise<VoiceExtensionSessionPlan>;
}

export const RUSTPBX_AUDIO_TAP_TOKEN_HEADER = 'x-ivekit-audio-tap-token';

export interface RealtimeAudioTapRouteAuthorizationInput {
  tenant_id: string;
  interaction_id: string;
  media_session_id: string;
}

export interface RealtimeAudioTapRouteAuthorizer {
  authorize(input: RealtimeAudioTapRouteAuthorizationInput): Promise<string | null>;
}

export interface VoiceHttpModule {
  configuration: VoiceConfigurationService;
  profiles: VoiceDeploymentProfileService;
  calls: VoiceCallService;
  configuration_repository: VoiceConfigurationRepository;
  call_repository: VoiceCallRepository;
  provider_event_repository: VoiceProviderEventRepository;
  recordings: VoiceRecordingRepository;
  provider_events: VoiceProviderEventService;
  cdrs: VoiceCdrConvergencePort;
  rustpbx_events: RustPbxEventsAdapter;
  router: VoiceRouterDecisionService;
  extension_sessions?: VoiceExtensionSessionPort;
}

export interface RouteIveKitVoiceApiOptions {
  module?: VoiceHttpModule;
  create_module?: (pg: PgQueryable, tenantId: string) => VoiceHttpModule | Promise<VoiceHttpModule>;
  cdr_region_id?: string;
  webhook_authenticator?: VoiceWebhookAuthenticator;
  provider_registry?: VoiceProviderRegistry;
  address_protector?: VoiceAddressProtector;
  compliance?: VoiceCompliancePort;
  event_port?: VoiceEventPort;
  secret_resolver?: VoiceSecretResolver;
  extension_sessions?: VoiceExtensionSessionPort;
  available_route_dependencies?: readonly ('start_ivr' | 'enqueue' | 'bridge_livekit' | 'voicemail')[];
  placement?: VoiceCallPlacementPort;
  prepared_call_placement?: PreparedVoiceCallPlacement;
  recording_spool_intake?: Pick<
    RecordingSpoolIntakeService,
    'initialize' | 'uploadPart' | 'listParts' | 'complete' | 'finalize'
  >;
  recording_object_storage?: ObjectStorage;
  realtime_audio_tap_authorizer?: RealtimeAudioTapRouteAuthorizer;
  realtime_audio_tap_authorization_timeout_ms?: number;
  realtime_audio_tap_grants?: Pick<
    RealtimeAudioTapGrantService,
    'grant' | 'list' | 'revoke'
  >;
}

export interface PreparedVoiceCallPlacement {
  source: 'outbound_api' | 'rustpbx_inbound';
  tenant_id: string;
  call_id: string;
  reservation: Awaited<ReturnType<VoiceCallPlacementPort['reserve']>> | null;
  provider_authentication?: VoiceWebhookAuthentication;
}

type Headers = Record<string, string | string[] | undefined>;

export async function prepareIveKitVoiceCallPlacement(
  method: string,
  routePath: string,
  body: unknown,
  headers: Headers,
  options: RouteIveKitVoiceApiOptions,
  pg: PgQueryable | null = null,
  rawBody: string | Buffer = ''
): Promise<PreparedVoiceCallPlacement | null> {
  if (!options.placement || method !== 'POST') return null;
  const normalizedPath = routePath.split('?')[0];
  const providerRouter = normalizedPath.match(
    /^\/api\/ivekit\/voice\/providers\/([^/]+)\/(router|inbound-admission)$/
  );
  if (providerRouter) {
    const profileId = decodeSegment(providerRouter[1]);
    const request = new RustPbxRouterAdapter().normalizeRequest(body as never);
    if (request.direction !== 'inbound' || request.method !== 'INVITE') {
      return null;
    }
    const rootPg = requiredPg(pg);
    const authenticator = options.webhook_authenticator ??
      createWebhookAuthenticator(rootPg, options);
    const authenticated = await authenticator.authenticate({
      profile_id: profileId,
      raw_body: rawBody,
      headers
    });
    if (authenticated.adapter !== 'rustpbx' ||
        authenticated.profile_id !== profileId) {
      throw webhookAuthFailed();
    }
    const callId = stableInboundVoiceCallId(
      authenticated.tenant_id,
      authenticated.profile_id,
      request.call_id
    );
    if (options.placement.hasPlacement &&
        await options.placement.hasPlacement(rootPg, {
          tenant_id: authenticated.tenant_id,
          interaction_id: callId
        })) {
      return {
        source: 'rustpbx_inbound',
        tenant_id: authenticated.tenant_id,
        call_id: callId,
        reservation: null,
        provider_authentication: authenticated
      };
    }
    const input = bodyRecord(body);
    return {
      source: 'rustpbx_inbound',
      tenant_id: authenticated.tenant_id,
      call_id: callId,
      reservation: await options.placement.reserve({
        tenant_id: authenticated.tenant_id,
        interaction_id: callId,
        routing_partition_key: `inbound_sip:${request.call_id}`,
        idempotency_key:
          `inbound:${authenticated.profile_id}:${request.call_id}`,
        preferred_cell_id: requiredString(input.ivekit_cell_id),
        preferred_owner_node_id: requiredString(
          input.ivekit_owner_node_id
        )
      }),
      provider_authentication: authenticated
    };
  }
  if (normalizedPath !== '/api/ivekit/voice/calls') return null;
  const ctx = requireVoiceAuth(headers);
  requireOperator(ctx);
  const input = bodyRecord(body);
  const bodyTenant = typeof input.tenant_id === 'string'
    ? input.tenant_id.trim()
    : '';
  if (bodyTenant && bodyTenant !== ctx.tenantId) throw validationError();
  const businessRef = businessReference(input.business_ref);
  const idempotencyKey = requireIdempotencyKey(headers);
  const callId = stableVoiceCallId(ctx.tenantId, idempotencyKey);
  if (pg && options.placement.hasPlacement &&
      await options.placement.hasPlacement(pg, {
        tenant_id: ctx.tenantId,
        interaction_id: callId
      })) {
    return {
      source: 'outbound_api',
      tenant_id: ctx.tenantId,
      call_id: callId,
      reservation: null
    };
  }
  return {
    source: 'outbound_api',
    tenant_id: ctx.tenantId,
    call_id: callId,
    reservation: await options.placement.reserve({
      tenant_id: ctx.tenantId,
      interaction_id: callId,
      routing_partition_key: `${businessRef.type}:${businessRef.id}`,
      idempotency_key: idempotencyKey
    })
  };
}

export async function routeIveKitVoiceApi(
  pg: PgQueryable | null,
  method: string,
  path: string,
  url: URL,
  body: unknown,
  rawBody: string | Buffer = '',
  headers: Headers = {},
  options: RouteIveKitVoiceApiOptions = {}
): Promise<unknown | undefined> {
  const routePath = path.split('?')[0];
  if (!routePath.startsWith('/api/ivekit/voice/')) return undefined;

  const recordingCompletionMatch = routePath.match(
    /^\/api\/ivekit\/voice\/providers\/([^/]+)\/recording-spool\/recordings\/([^/]+)\/complete$/
  );
  if (recordingCompletionMatch) {
    return routeProviderRecordingSpool({
      pg,
      method,
      profile_id: decodeSegment(recordingCompletionMatch[1]),
      recording_id: decodeSegment(recordingCompletionMatch[2]),
      segment_id: '',
      collection: '',
      part_number: null,
      complete: false,
      body,
      raw_body: rawBody,
      headers,
      options
    });
  }

  const recordingSpoolMatch = routePath.match(
    /^\/api\/ivekit\/voice\/providers\/([^/]+)\/recording-spool\/segments(?:\/([^/]+)(?:\/(parts)(?:\/(\d+))?|\/(complete))?)?$/
  );
  if (recordingSpoolMatch) {
    return routeProviderRecordingSpool({
      pg,
      method,
      profile_id: decodeSegment(recordingSpoolMatch[1]),
      recording_id: '',
      segment_id: recordingSpoolMatch[2] ? decodeSegment(recordingSpoolMatch[2]) : '',
      collection: recordingSpoolMatch[3] || '',
      part_number: recordingSpoolMatch[4] ? Number(recordingSpoolMatch[4]) : null,
      complete: Boolean(recordingSpoolMatch[5]),
      body,
      raw_body: rawBody,
      headers,
      options
    });
  }

  const providerMatch = routePath.match(
    /^\/api\/ivekit\/voice\/providers\/([^/]+)\/(router|inbound-admission|events|cdrs)$/
  );
  if (providerMatch && method === 'POST') {
    return routeProviderWebhook({
      pg, profile_id: decodeSegment(providerMatch[1]), action: providerMatch[2] as ProviderWebhookAction,
      body, raw_body: rawBody, headers, options
    });
  }

  const ctx = requireVoiceAuth(headers);
  rejectTenantOverride(ctx.tenantId, url, body);

  if (routePath === '/api/ivekit/voice/capabilities' && method === 'GET') {
    return {
      data: {
        api_version: 'v1',
        tenant_id: ctx.tenantId,
        capabilities: {
          deployment_profiles: true, sip_trunks: true, dids: true, extensions: true,
          extension_sessions: Boolean(options.extension_sessions || options.module?.extension_sessions),
          routes: true, calls: true, call_control: true, provider_events: true,
          recordings: true, parking_slots: true, livekit_sip_bridge: true, provider_webhooks: true,
          realtime_audio_tap_grants: Boolean(options.realtime_audio_tap_grants)
        }
      }
    };
  }

  const module = await resolveModule(pg, ctx.tenantId, options);

  if (routePath === '/api/ivekit/voice/profiles') {
    if (method === 'GET') return {
      data: await module.configuration.listProfiles(listInput(ctx.tenantId, url))
    };
    if (method === 'POST') {
      requireAdmin(ctx);
      const input = bodyRecord(body);
      return {
        status: 201,
        data: await module.configuration.createProfile({
          tenant_id: ctx.tenantId,
          actor: ctx.userId,
          name: requiredString(input.name),
          adapter: requiredString(input.adapter) as VoiceAdapter,
          base_url: optionalString(input.base_url),
          desired_version: optionalString(input.desired_version),
          config: optionalRecord(input.config),
          secret_refs: stringRecord(input.secret_refs),
          ...(input.status === undefined ? {} : { status: input.status as never })
        })
      };
    }
  }

  const profileMatch = routePath.match(/^\/api\/ivekit\/voice\/profiles\/([^/]+)(?:\/(preflight|capabilities))?$/);
  if (profileMatch) {
    const profileId = decodeSegment(profileMatch[1]);
    const action = profileMatch[2] || '';
    if (!action && method === 'GET') {
      return { data: await module.configuration.getProfile(ctx.tenantId, profileId) };
    }
    if (!action && method === 'PATCH') {
      requireAdmin(ctx);
      const input = bodyRecord(body);
      return {
        data: await module.configuration.updateProfile({
          tenant_id: ctx.tenantId, actor: ctx.userId, profile_id: profileId,
          expected_revision: requiredRevision(input.revision),
          patch: bodyRecord(input.patch) as never
        })
      };
    }
    if (action === 'preflight' && method === 'POST') {
      requireAdmin(ctx);
      return { data: await module.profiles.preflight(ctx.tenantId, profileId) };
    }
    if (action === 'capabilities' && method === 'GET') {
      return { data: await module.profiles.getCapabilities(ctx.tenantId, profileId) };
    }
  }

  if (routePath === '/api/ivekit/voice/trunks') {
    if (method === 'GET') return {
      data: await module.configuration.listTrunks({
        ...listInput(ctx.tenantId, url),
        ...(optionalQuery(url, 'profile_id') ? { profile_id: optionalQuery(url, 'profile_id') } : {})
      })
    };
    if (method === 'POST') {
      requireAdmin(ctx);
      const input = bodyRecord(body);
      return {
        status: 201,
        data: await module.configuration.createTrunk({
          tenant_id: ctx.tenantId, actor: ctx.userId,
          profile_id: requiredString(input.profile_id), name: requiredString(input.name),
          direction: requiredString(input.direction) as VoiceRouteDirection,
          transport: requiredString(input.transport) as VoiceSipTrunk['transport'],
          codecs: stringArray(input.codecs), max_channels: requiredInteger(input.max_channels, 1, 100_000),
          credential_secret_ref: requiredString(input.credential_secret_ref),
          desired_state: optionalRecord(input.desired_state)
        })
      };
    }
  }

  const trunkMatch = routePath.match(/^\/api\/ivekit\/voice\/trunks\/([^/]+)(?:\/(apply|test))?$/);
  if (trunkMatch) {
    const trunkId = decodeSegment(trunkMatch[1]);
    const action = trunkMatch[2] || '';
    if (!action && method === 'GET') return { data: await module.configuration.getTrunk(ctx.tenantId, trunkId) };
    if (!action && method === 'PATCH') {
      requireAdmin(ctx);
      const input = bodyRecord(body);
      return { data: await module.configuration.updateTrunk({
        tenant_id: ctx.tenantId, actor: ctx.userId, trunk_id: trunkId,
        expected_revision: requiredRevision(input.revision), patch: bodyRecord(input.patch) as never
      }) };
    }
    if ((action === 'apply' || action === 'test') && method === 'POST') {
      requireAdmin(ctx);
      const key = requireIdempotencyKey(headers);
      const trunk = await module.configuration.getTrunk(ctx.tenantId, trunkId);
      const command = await module.configuration.enqueueOperation({
        tenant_id: ctx.tenantId, actor: ctx.userId, profile_id: trunk.profile_id,
        resource_type: 'sip_trunk', resource_id: trunk.id, operation: action,
        idempotency_key: key, payload: { source_revision: trunk.revision }
      });
      return { status: 202, data: publicConfigurationCommand(command) };
    }
  }

  if (routePath === '/api/ivekit/voice/dids') {
    if (method === 'GET') return { data: await module.configuration.listDids({
      ...listInput(ctx.tenantId, url),
      ...(optionalQuery(url, 'trunk_id') ? { trunk_id: optionalQuery(url, 'trunk_id') } : {})
    }) };
    if (method === 'POST') {
      requireAdmin(ctx);
      const input = bodyRecord(body);
      return { status: 201, data: await module.configuration.createDid({
        tenant_id: ctx.tenantId, actor: ctx.userId,
        trunk_id: requiredString(input.trunk_id),
        route_id: nullableString(input.route_id), e164: requiredString(input.e164),
        metadata: optionalRecord(input.metadata),
        ...(input.status === undefined ? {} : { status: input.status as never })
      }) };
    }
  }

  const didMatch = routePath.match(/^\/api\/ivekit\/voice\/dids\/([^/]+)(?:\/(apply))?$/);
  if (didMatch) {
    const didId = decodeSegment(didMatch[1]);
    const action = didMatch[2] || '';
    if (!action && method === 'GET') return { data: await module.configuration.getDid(ctx.tenantId, didId) };
    if (!action && method === 'PATCH') {
      requireAdmin(ctx);
      const input = bodyRecord(body);
      return { data: await module.configuration.updateDid({
        tenant_id: ctx.tenantId, actor: ctx.userId, did_id: didId,
        expected_revision: requiredRevision(input.revision), patch: bodyRecord(input.patch) as never
      }) };
    }
    if (action === 'apply' && method === 'POST') {
      requireAdmin(ctx);
      const did = await module.configuration.getDid(ctx.tenantId, didId);
      const trunk = await module.configuration.getTrunk(ctx.tenantId, did.trunk_id);
      const command = await module.configuration.enqueueOperation({
        tenant_id: ctx.tenantId, actor: ctx.userId, profile_id: trunk.profile_id,
        resource_type: 'did', resource_id: did.id, operation: 'apply',
        idempotency_key: requireIdempotencyKey(headers), payload: { source_revision: did.revision }
      });
      return { status: 202, data: publicConfigurationCommand(command) };
    }
  }

  if (routePath === '/api/ivekit/voice/extensions') {
    if (method === 'GET') return { data: await module.configuration.listExtensions({
      ...listInput(ctx.tenantId, url),
      ...(optionalQuery(url, 'profile_id') ? { profile_id: optionalQuery(url, 'profile_id') } : {})
    }) };
    if (method === 'POST') {
      requireAdmin(ctx);
      const input = bodyRecord(body);
      return { status: 201, data: await module.configuration.createExtension({
        tenant_id: ctx.tenantId, actor: ctx.userId,
        profile_id: requiredString(input.profile_id), identity: requiredString(input.identity),
        extension: requiredString(input.extension), display_name: requiredString(input.display_name),
        credential_secret_ref: requiredString(input.credential_secret_ref),
        permissions: optionalRecord(input.permissions), webrtc_enabled: requiredBoolean(input.webrtc_enabled),
        ...(input.status === undefined ? {} : { status: input.status as never })
      }) };
    }
  }

  const extensionMatch = routePath.match(/^\/api\/ivekit\/voice\/extensions\/([^/]+)(?:\/(apply|session))?$/);
  if (extensionMatch) {
    const extensionId = decodeSegment(extensionMatch[1]);
    const action = extensionMatch[2] || '';
    if (!action && method === 'GET') return { data: await module.configuration.getExtension(ctx.tenantId, extensionId) };
    if (!action && method === 'PATCH') {
      requireAdmin(ctx);
      const input = bodyRecord(body);
      return { data: await module.configuration.updateExtension({
        tenant_id: ctx.tenantId, actor: ctx.userId, extension_id: extensionId,
        expected_revision: requiredRevision(input.revision), patch: bodyRecord(input.patch) as never
      }) };
    }
    if (action === 'apply' && method === 'POST') {
      requireAdmin(ctx);
      const extension = await module.configuration.getExtension(ctx.tenantId, extensionId);
      const command = await module.configuration.enqueueOperation({
        tenant_id: ctx.tenantId, actor: ctx.userId, profile_id: extension.profile_id,
        resource_type: 'extension', resource_id: extension.id, operation: 'apply',
        idempotency_key: requireIdempotencyKey(headers), payload: { source_revision: extension.revision }
      });
      return { status: 202, data: publicConfigurationCommand(command) };
    }
    if (action === 'session' && method === 'POST') {
      requireOperator(ctx);
      if (!module.extension_sessions) throw capabilityUnavailable('webrtc_extension');
      const extension = await module.configuration.getExtension(ctx.tenantId, extensionId);
      requireExtensionSessionAccess(ctx, extension);
      const plan = await module.extension_sessions.create({
        tenant_id: ctx.tenantId, extension, actor: ctx.userId,
        idempotency_key: requireIdempotencyKey(headers)
      });
      return { status: 201, data: publicExtensionSessionPlan(plan, extension.id) };
    }
  }

  if (routePath === '/api/ivekit/voice/routes') {
    if (method === 'GET') return { data: await module.configuration.listRoutes({
      ...listInput(ctx.tenantId, url),
      ...(optionalQuery(url, 'profile_id') ? { profile_id: optionalQuery(url, 'profile_id') } : {})
    }) };
    if (method === 'POST') {
      requireAdmin(ctx);
      const input = bodyRecord(body);
      return { status: 201, data: await module.configuration.createRoute({
        tenant_id: ctx.tenantId, actor: ctx.userId,
        profile_id: requiredString(input.profile_id), name: requiredString(input.name),
        direction: requiredString(input.direction) as VoiceRouteDirection,
        draft_rules: validatedRouteRules(input.draft_rules)
      }) };
    }
  }

  const routeMatch = routePath.match(/^\/api\/ivekit\/voice\/routes\/([^/]+)(?:\/(validate|publish|versions))?$/);
  if (routeMatch) {
    const routeId = decodeSegment(routeMatch[1]);
    const action = routeMatch[2] || '';
    if (!action && method === 'GET') return { data: await module.configuration.getRoute(ctx.tenantId, routeId) };
    if (!action && method === 'PATCH') {
      requireAdmin(ctx);
      const input = bodyRecord(body);
      return { data: await module.configuration.updateRoute({
        tenant_id: ctx.tenantId, actor: ctx.userId, route_id: routeId,
        expected_revision: requiredRevision(input.revision), patch: bodyRecord(input.patch) as never
      }) };
    }
    if (action === 'validate' && method === 'POST') {
      const input = bodyRecord(body);
      const route = await module.configuration.getRoute(ctx.tenantId, routeId);
      const rules = input.rules === undefined ? route.draft_rules : validatedRouteRules(input.rules);
      return { data: { valid: true, payload_hash: canonicalVoicePayloadHash(validatedRouteRules(rules)) } };
    }
    if (action === 'versions' && method === 'GET') {
      return { data: { items: await module.configuration_repository.listRouteVersions(ctx.tenantId, routeId), next_cursor: null } };
    }
    if (action === 'publish' && method === 'POST') {
      requireAdmin(ctx);
      const input = bodyRecord(body);
      const published = await module.configuration.publishRoute({
        tenant_id: ctx.tenantId, actor: ctx.userId, route_id: routeId,
        expected_revision: requiredRevision(input.revision),
        idempotency_key: requireIdempotencyKey(headers)
      });
      return { status: 202, data: {
        route: published.route, version: published.version,
        command: publicConfigurationCommand(published.command)
      } };
    }
  }

  if (routePath === '/api/ivekit/voice/parking-slots' && method === 'GET') {
    const profileId = optionalQuery(url, 'profile_id');
    const state = optionalQuery(url, 'state');
    return { data: await module.calls.listParkingSlots({
      ...listInput(ctx.tenantId, url),
      ...(profileId ? { profile_id: profileId } : {}),
      ...(state ? { state: state as never } : {})
    }) };
  }

  if (routePath === '/api/ivekit/voice/calls') {
    if (method === 'GET') {
      const refType = optionalQuery(url, 'business_ref_type');
      const refId = optionalQuery(url, 'business_ref_id');
      if (Boolean(refType) !== Boolean(refId)) throw validationError();
      const state = optionalQuery(url, 'state');
      return { data: await module.calls.listCalls({
        ...listInput(ctx.tenantId, url),
        ...(state ? { state: state as VoiceCallState } : {}),
        ...(refType && refId ? { business_ref: { type: refType, id: refId } } : {})
      }) };
    }
    if (method === 'POST') {
      requireOperator(ctx);
      const input = bodyRecord(body);
      const prepared = options.prepared_call_placement;
      if (prepared && prepared.tenant_id !== ctx.tenantId) throw validationError();
      const created = await module.calls.createOutbound({
        tenant_id: ctx.tenantId, actor: ctx.userId,
        profile_id: requiredString(input.profile_id),
        from: clearAddress(input.from), to: clearAddress(input.to),
        business_ref: businessReference(input.business_ref),
        idempotency_key: requireIdempotencyKey(headers), metadata: optionalRecord(input.metadata),
        call_id: prepared?.call_id,
        placement_reservation: prepared?.reservation || undefined,
        placement_prepared: Boolean(prepared)
      });
      if (prepared && created.call.id !== prepared.call_id) {
        throw new VoiceError({ code: 'protocol_mismatch', status: 502 });
      }
      return {
        status: 202,
        data: { call: created.call, command: publicCallCommand(created.command) },
        afterCommit: () => reconcileVoiceCallPlacement(
          options.placement,
          ctx.tenantId,
          created.call.id
        )
      };
    }
  }

  const audioTapGrantMatch = routePath.match(
    /^\/api\/ivekit\/voice\/calls\/([^/]+)\/realtime-audio-tap-grants(?:\/([^/]+)\/(revoke))?$/
  );
  if (audioTapGrantMatch) {
    requireOperator(ctx);
    const grants = options.realtime_audio_tap_grants;
    if (!grants) throw capabilityUnavailable('realtime_audio_tap_grants');
    const callId = decodeSegment(audioTapGrantMatch[1]);
    await module.calls.getCall(ctx.tenantId, callId);
    const grantId = audioTapGrantMatch[2]
      ? decodeSegment(audioTapGrantMatch[2])
      : '';
    const action = audioTapGrantMatch[3] || '';
    if (!grantId && method === 'POST') {
      const input = bodyRecord(body);
      return {
        status: 201,
        data: await grants.grant({
          tenant_id: ctx.tenantId,
          interaction_id: callId,
          media_session_id: requiredString(input.media_session_id),
          purpose: requiredString(input.purpose) as never,
          consent_ref: requiredString(input.consent_ref),
          source_language: requiredString(input.source_language),
          target_languages: arrayValue(input.target_languages)
            .map((language) => requiredString(language, 64)),
          features: arrayValue(input.features)
            .map((feature) => requiredString(feature, 64)) as never,
          tracks: arrayValue(input.tracks).map((track) => bodyRecord(track)) as never,
          expires_at: requiredString(input.expires_at),
          actor: ctx.userId,
          idempotency_key: requireIdempotencyKey(headers)
        })
      };
    }
    if (!grantId && method === 'GET') {
      const page = listInput(ctx.tenantId, url);
      return {
        data: await grants.list({
          tenant_id: ctx.tenantId,
          interaction_id: callId,
          limit: page.limit,
          cursor: page.cursor
        })
      };
    }
    if (grantId && action === 'revoke' && method === 'POST') {
      const input = bodyRecord(body);
      return {
        data: await grants.revoke({
          tenant_id: ctx.tenantId,
          interaction_id: callId,
          grant_id: grantId,
          expected_revision: requiredRevision(input.revision),
          actor: ctx.userId,
          reason: requiredString(input.reason)
        })
      };
    }
    throw new VoiceError({ code: 'validation_failed', status: 405 });
  }

  const callMatch = routePath.match(
    /^\/api\/ivekit\/voice\/calls\/([^/]+)(?:\/(actions|events|recordings|bridges|participants|livekit-bridge))?$/
  );
  if (callMatch) {
    const callId = decodeSegment(callMatch[1]);
    const section = callMatch[2] || '';
    if (!section && method === 'GET') return { data: await module.calls.getCall(ctx.tenantId, callId) };
    if (section === 'actions' && method === 'POST') {
      requireOperator(ctx);
      const input = bodyRecord(body);
      const command = await module.calls.enqueueAction({
        tenant_id: ctx.tenantId, call_id: callId,
        kind: requiredString(input.action) as never,
        payload: optionalRecord(input.payload), actor: ctx.userId,
        idempotency_key: requireIdempotencyKey(headers)
      });
      return { status: 202, data: publicCallCommand(command) };
    }
    if (section === 'livekit-bridge' && method === 'POST') {
      requireOperator(ctx);
      const input = bodyRecord(body);
      const command = await module.calls.enqueueAction({
        tenant_id: ctx.tenantId, call_id: callId, kind: 'livekit_bridge_create',
        payload: { sip_trunk_id: requiredString(input.sip_trunk_id) }, actor: ctx.userId,
        idempotency_key: requireIdempotencyKey(headers)
      });
      return { status: 202, data: publicCallCommand(command) };
    }
    if (section === 'events' && method === 'GET') return {
      data: await module.provider_event_repository.listForCall({
        ...listInput(ctx.tenantId, url), call_id: callId
      })
    };
    if (section === 'recordings' && method === 'GET') return {
      data: await module.recordings.listRecordings({
        ...listInput(ctx.tenantId, url), call_id: callId,
        ...(optionalQuery(url, 'status') ? { status: optionalQuery(url, 'status') as VoiceRecording['status'] } : {})
      })
    };
    if (section === 'bridges' && method === 'GET') return {
      data: { items: await module.recordings.listBridgesForCall(ctx.tenantId, callId), next_cursor: null }
    };
    if (section === 'participants' && method === 'GET') return {
      data: { items: await module.call_repository.listParticipants(ctx.tenantId, callId), next_cursor: null }
    };
  }

  if (routePath === '/api/ivekit/voice/policy') {
    if (method === 'GET') return { data: await module.configuration.getPolicy(ctx.tenantId) };
    if (method === 'PATCH') {
      requireAdmin(ctx);
      const input = bodyRecord(body);
      return { data: await module.configuration.upsertPolicy({
        tenant_id: ctx.tenantId, actor: ctx.userId,
        require_outbound_consent: requiredBoolean(input.require_outbound_consent),
        recording_mode: requiredString(input.recording_mode) as never,
        recording_retention_days: requiredInteger(input.recording_retention_days, 0, 3_650),
        require_ai_disclosure: requiredBoolean(input.require_ai_disclosure),
        allowed_calling_windows: arrayValue(input.allowed_calling_windows),
        masking_policy: optionalRecord(input.masking_policy),
        status: requiredString(input.status) as never,
        expected_revision: nullableRevision(input.revision)
      }) };
    }
  }

  if (routePath === '/api/ivekit/voice/consents') {
    if (method === 'GET') return { data: await module.configuration.listConsents({
      ...listInput(ctx.tenantId, url),
      ...(optionalQuery(url, 'subject_ref_type') ? { subject_ref_type: optionalQuery(url, 'subject_ref_type') } : {}),
      ...(optionalQuery(url, 'subject_ref_id') ? { subject_ref_id: optionalQuery(url, 'subject_ref_id') } : {})
    }) };
    if (method === 'POST') {
      requireAdmin(ctx);
      const input = bodyRecord(body);
      return { status: 201, data: await module.configuration.createConsent({
        tenant_id: ctx.tenantId, actor: ctx.userId,
        subject_ref_type: requiredString(input.subject_ref_type), subject_ref_id: requiredString(input.subject_ref_id),
        business_ref_type: requiredString(input.business_ref_type), business_ref_id: requiredString(input.business_ref_id),
        consent_type: requiredString(input.consent_type) as never, status: requiredString(input.status) as never,
        evidence_ref: requiredString(input.evidence_ref), granted_by: ctx.userId,
        expires_at: nullableString(input.expires_at)
      }) };
    }
  }

  if (routePath === '/api/ivekit/voice/recordings' && method === 'GET') {
    return { data: await module.recordings.listRecordings({
      ...listInput(ctx.tenantId, url),
      ...(optionalQuery(url, 'call_id') ? { call_id: optionalQuery(url, 'call_id') } : {}),
      ...(optionalQuery(url, 'status') ? { status: optionalQuery(url, 'status') as VoiceRecording['status'] } : {})
    }) };
  }

  return undefined;
}

export function createPostgresVoiceHttpModule(
  pg: PgQueryable,
  options: RouteIveKitVoiceApiOptions = {}
): VoiceHttpModule {
  const configurationRepository = new PostgresVoiceConfigurationStore(pg);
  const callRepository = new PostgresVoiceCallStore(pg);
  const providerEventRepository = new PostgresVoiceProviderEventStore(pg);
  const recordings = new PostgresVoiceRecordingStore(pg);
  const registry = options.provider_registry ?? createIveKitVoiceProviderRegistry();
  const addressProtector = options.address_protector ?? configuredVoiceAddressProtector();
  const eventPort = options.event_port ?? { publish: () => undefined };
  const configuration = new VoiceConfigurationService({
    unit_of_work: new PostgresVoiceConfigurationUnitOfWork(pg),
    address_protector: addressProtector,
    event_port: eventPort
  });
  return {
    configuration,
    profiles: new VoiceDeploymentProfileService({ repository: configurationRepository, registry }),
    calls: new VoiceCallService({
      unit_of_work: new PostgresVoiceCallUnitOfWork(pg),
      address_protector: addressProtector,
      compliance: options.compliance ?? new VoicePolicyComplianceService({
        unit_of_work: new PostgresVoiceCallUnitOfWork(pg)
      }),
      event_port: eventPort,
      placement: options.placement
    }),
    configuration_repository: configurationRepository,
    call_repository: callRepository,
    provider_event_repository: providerEventRepository,
    recordings,
    provider_events: new VoiceProviderEventService({ events: providerEventRepository, calls: callRepository }),
    cdrs: new PostgresVoiceCdrConvergenceStore(pg, {
      region_id: configuredCdrRegionId(options)
    }),
    rustpbx_events: new RustPbxEventsAdapter(),
    router: new VoiceRouterDecisionService({
      configuration: configurationRepository,
      address_protector: addressProtector,
      router_adapter: new RustPbxRouterAdapter(),
      available_dependencies: options.available_route_dependencies
    }),
    extension_sessions: options.extension_sessions
  };
}

function configuredCdrRegionId(
  options: RouteIveKitVoiceApiOptions,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  return options.cdr_region_id?.trim() ||
    resolveFabricEnv(env, 'CDR_REGION_ID')?.trim() ||
    resolveFabricEnv(env, 'PLACEMENT_HOME_REGION_ID')?.trim() ||
    undefined;
}

type ProviderWebhookAction = 'router' | 'inbound-admission' | 'events' | 'cdrs';

async function routeProviderRecordingSpool(input: {
  pg: PgQueryable | null;
  method: string;
  profile_id: string;
  recording_id: string;
  segment_id: string;
  collection: string;
  part_number: number | null;
  complete: boolean;
  body: unknown;
  raw_body: string | Buffer;
  headers: Headers;
  options: RouteIveKitVoiceApiOptions;
}): Promise<unknown> {
  const pg = requiredPg(input.pg);
  const authenticator = input.options.webhook_authenticator ??
    createWebhookAuthenticator(pg, input.options, recordingSpoolHttpPartMaxBytes());
  const authenticated = await authenticator.authenticate({
    profile_id: input.profile_id,
    raw_body: input.raw_body,
    headers: input.headers
  });
  if (authenticated.adapter !== 'rustpbx') throw webhookAuthFailed();
  return withPgTenant(pg, authenticated.tenant_id, async (tenantPg) => {
    const module = await resolveModule(tenantPg, authenticated.tenant_id, input.options);
    await assertAuthenticatedProviderProfile(module, authenticated);
    const spool = input.options.recording_spool_intake ??
      createRecordingSpoolIntake(tenantPg, module, input.options);

    if (input.recording_id) {
      if (input.method !== 'POST') {
        throw new VoiceError({ code: 'validation_failed', status: 405 });
      }
      const body = bodyRecord(input.body);
      if (String(body.recording_id || '') !== input.recording_id) throw validationError();
      return {
        data: await spool.finalize({
          tenant_id: authenticated.tenant_id,
          profile_id: authenticated.profile_id,
          completion: body as never
        })
      };
    }

    if (!input.segment_id && input.method === 'POST') {
      const body = bodyRecord(input.body);
      const result = await spool.initialize({
        ...body,
        tenant_id: authenticated.tenant_id,
        profile_id: authenticated.profile_id
      } as unknown as RecordingSpoolInitializeInput);
      return { status: 201, data: result };
    }
    if (!input.segment_id) throw validationError();
    const identity = recordingSpoolLeaseIdentity(
      authenticated.tenant_id,
      input.segment_id,
      input.headers
    );
    if (input.collection === 'parts' && input.part_number === null && input.method === 'GET') {
      return { data: { items: await spool.listParts(identity) } };
    }
    if (input.collection === 'parts' && input.part_number !== null && input.method === 'PUT') {
      if (!Buffer.isBuffer(input.raw_body)) throw validationError();
      return {
        data: await spool.uploadPart({
          ...identity,
          part_number: input.part_number,
          content: input.raw_body,
          sha256: headerValue(input.headers, 'x-ivekit-content-sha256')
        })
      };
    }
    if (input.complete && input.method === 'POST') {
      return { data: await spool.complete(identity) };
    }
    throw new VoiceError({ code: 'validation_failed', status: 405 });
  });
}

async function routeProviderWebhook(input: {
  pg: PgQueryable | null;
  profile_id: string;
  action: ProviderWebhookAction;
  body: unknown;
  raw_body: string | Buffer;
  headers: Headers;
  options: RouteIveKitVoiceApiOptions;
}): Promise<unknown> {
  const pg = requiredPg(input.pg);
  const prepared = input.options.prepared_call_placement;
  const preparedAuthentication = prepared?.source === 'rustpbx_inbound' &&
    prepared.provider_authentication?.profile_id === input.profile_id
    ? prepared.provider_authentication
    : null;
  const authenticator = input.options.webhook_authenticator ??
    createWebhookAuthenticator(pg, input.options);
  const authenticated = preparedAuthentication ?? await authenticator.authenticate({
      profile_id: input.profile_id,
      raw_body: input.raw_body,
      headers: input.headers
    });
  if (authenticated.adapter !== 'rustpbx') throw webhookAuthFailed();
  return withPgTenant(pg, authenticated.tenant_id, async (tenantPg) => {
    const module = await resolveModule(tenantPg, authenticated.tenant_id, input.options);
    const profile = await assertAuthenticatedProviderProfile(
      module,
      authenticated
    );

    if (input.action === 'router' || input.action === 'inbound-admission') {
      const request = new RustPbxRouterAdapter().normalizeRequest(input.body as never);
      const inboundPlacement = prepared?.source === 'rustpbx_inbound'
        ? prepared
        : null;
      if (input.action === 'inbound-admission') {
        if (request.direction !== 'inbound' || request.method !== 'INVITE') {
          throw validationError();
        }
        if (!input.options.placement || !inboundPlacement) {
          throw new VoiceError({
            code: 'capability_unavailable',
            status: 503,
            retryable: true
          });
        }
        const routeSnapshotRevision = await assertRouteSnapshotRevision(
          tenantPg,
          authenticated.tenant_id,
          authenticated.profile_id,
          request.route_snapshot_revision
        );
        const availability = availabilityProfile(profile);
        const mediaControlProfile = resolveRustPbxMediaControlProfile(profile);
        const authContextRef = availability === 'VOICE-HA-T1'
          ? authenticationContextReference(authenticated, profile)
          : null;
        const authoritativeCall = await createAuthoritativeInboundCall({
          module,
          authenticated,
          request,
          placement: inboundPlacement,
          source: 'rustpbx_snapshot_admission',
          provider_runtime_profile: profile,
          owner_contract_facts: {
            route_snapshot_revision: routeSnapshotRevision,
            availability_profile: availability,
            auth_context_ref: authContextRef,
            media_control_profile: mediaControlProfile
          }
        });
        const [owner, audioTapToken] = await Promise.all([
          input.options.placement.resolveOwner(tenantPg, {
            tenant_id: authenticated.tenant_id,
            interaction_id: inboundPlacement.call_id,
            require_active: false
          }),
          authorizeRealtimeAudioTap(input.options, {
            tenant_id: authenticated.tenant_id,
            interaction_id: authoritativeCall.id,
            media_session_id: request.call_id
          })
        ]);
        return {
          status: 201,
          data: {
            accepted: true,
            call_id: inboundPlacement.call_id,
            provider_call_id: request.call_id,
            reservation_id: owner.reservation_id,
            owner_epoch: owner.owner_epoch,
            cell_id: owner.cell_id,
            owner_node_id: owner.owner_node_id,
            tenant_id: authenticated.tenant_id,
            media_control_profile: mediaControlProfile,
            route_snapshot_revision: routeSnapshotRevision,
            availability_profile: availability,
            ...(authContextRef
              ? { auth_context_ref: authContextRef }
              : {}),
            ...(audioTapToken ? { audio_tap_token: audioTapToken } : {})
          },
          afterCommit: () => reconcileVoiceCallPlacement(
            input.options.placement,
            authenticated.tenant_id,
            inboundPlacement.call_id
          )
        };
      }
      let authoritativeCall: Awaited<ReturnType<VoiceCallService['createInbound']>> | null = null;
      if (request.direction === 'inbound' && request.method === 'INVITE') {
        authoritativeCall = await createAuthoritativeInboundCall({
          module,
          authenticated,
          request,
          placement: inboundPlacement,
          source: 'rustpbx_router',
          provider_runtime_profile: profile
        });
      }
      const [decision, audioTapToken] = await Promise.all([
        module.router.decide({
          tenant_id: authenticated.tenant_id,
          profile_id: authenticated.profile_id,
          request
        }),
        authoritativeCall
          ? authorizeRealtimeAudioTap(input.options, {
              tenant_id: authenticated.tenant_id,
              interaction_id: authoritativeCall.id,
              media_session_id: request.call_id
            })
          : Promise.resolve('')
      ]);
      const response = decision.action === 'forward' && audioTapToken
        ? {
            ...decision,
            headers: {
              ...decision.headers,
              [RUSTPBX_AUDIO_TAP_TOKEN_HEADER]: audioTapToken
            }
          }
        : decision;
      return {
        data: response,
        ...(prepared?.source === 'rustpbx_inbound'
          ? {
              afterCommit: () => reconcileVoiceCallPlacement(
                input.options.placement,
                authenticated.tenant_id,
                prepared.call_id
              )
            }
          : {})
      };
    }
    if (input.action === 'cdrs') {
      const receipt = await module.cdrs.converge({
        tenant_id: authenticated.tenant_id,
        profile_id: authenticated.profile_id,
        authoritative_availability_profile: availabilityProfile(profile),
        envelope: parseVoiceDualLegCdr(input.body)
      });
      return {
        status: receipt.state === 'committed' ? 200 : 202,
        data: receipt
      };
    }
    const normalized = module.rustpbx_events.normalize('http', input.body);
    const result = await module.provider_events.ingest({
      tenant_id: authenticated.tenant_id,
      profile_id: authenticated.profile_id,
      event: normalized
    });
    return {
      status: 202,
      data: {
        event_id: result.event.id,
        state: result.event.processing_state,
        replayed: result.replayed
      }
    };
  });
}

async function assertAuthenticatedProviderProfile(
  module: VoiceHttpModule,
  authenticated: VoiceWebhookAuthentication
): Promise<VoiceDeploymentProfile> {
  const profile = await module.configuration_repository.getProfile(
    authenticated.tenant_id,
    authenticated.profile_id
  );
  if (!profile || profile.tenant_id !== authenticated.tenant_id
    || profile.id !== authenticated.profile_id || profile.adapter !== authenticated.adapter
    || profile.status === 'archived') throw webhookAuthFailed();
  return profile;
}

function availabilityProfile(
  profile: VoiceDeploymentProfile
): 'VOICE-ORDINARY' | 'VOICE-HA-T1' {
  const value = profile.config?.availability_profile;
  if (value === undefined || value === 'VOICE-ORDINARY') {
    return 'VOICE-ORDINARY';
  }
  if (value === 'VOICE-HA-T1') return value;
  throw new VoiceError({
    code: 'capability_unavailable',
    status: 503,
    retryable: false
  });
}

function authenticationContextReference(
  authenticated: VoiceWebhookAuthentication,
  profile: VoiceDeploymentProfile
): string {
  if (!Number.isSafeInteger(profile.revision) || profile.revision < 1) {
    throw new VoiceError({
      code: 'capability_unavailable',
      status: 503,
      retryable: false
    });
  }
  const digest = createHash('sha256')
    .update([
      authenticated.tenant_id,
      authenticated.profile_id,
      authenticated.adapter,
      authenticated.method,
      String(profile.revision)
    ].join('\0'))
    .digest('hex');
  return `auth-context:${digest}`;
}

function createRecordingSpoolIntake(
  pg: PgQueryable,
  module: VoiceHttpModule,
  options: RouteIveKitVoiceApiOptions
): RecordingSpoolIntakeService {
  const store = new PostgresRecordingManifestStore(pg);
  return new RecordingSpoolIntakeService({
    authorizer: new RustPbxRecordingSpoolAuthorizer({
      calls: module.call_repository,
      configuration: module.configuration_repository,
      placements: new PostgresRecordingSpoolPlacementStore(pg)
    }),
    store,
    uploads: new RecordingSegmentUploadService({
      store,
      storage: options.recording_object_storage ?? createObjectStorage()
    })
  });
}

function recordingSpoolLeaseIdentity(
  tenantId: string,
  segmentId: string,
  headers: Headers
): {
  tenant_id: string;
  segment_id: string;
  owner_epoch: string;
  worker_id: string;
  lease_token_hash: string;
} {
  const ownerEpoch = headerValue(headers, 'x-ivekit-recording-owner-epoch');
  const workerId = headerValue(headers, 'x-ivekit-recording-worker-id');
  const leaseToken = headerValue(headers, 'x-ivekit-recording-lease-token');
  if (!/^(0|[1-9][0-9]{0,19})$/.test(ownerEpoch)
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(workerId)
    || !/^[A-Za-z0-9_-]{32,256}$/.test(leaseToken)) {
    throw validationError();
  }
  return {
    tenant_id: tenantId,
    segment_id: segmentId,
    owner_epoch: ownerEpoch,
    worker_id: workerId,
    lease_token_hash: createHash('sha256').update(leaseToken).digest('hex')
  };
}

async function createAuthoritativeInboundCall(input: {
  module: VoiceHttpModule;
  authenticated: VoiceWebhookAuthentication;
  request: ReturnType<RustPbxRouterAdapter['normalizeRequest']>;
  placement: PreparedVoiceCallPlacement | null;
  source: 'rustpbx_router' | 'rustpbx_snapshot_admission';
  provider_runtime_profile: VoiceDeploymentProfile;
  owner_contract_facts?: VoiceCallOwnerContractFacts;
}) {
  return input.module.calls.createInbound({
    tenant_id: input.authenticated.tenant_id,
    profile_id: input.authenticated.profile_id,
    provider_call_id: input.request.call_id,
    external_event_id: `router:${input.request.call_id}`,
    from: providerInboundAddress(input.request.from),
    to: providerInboundAddress(input.request.to),
    business_ref: {
      type: 'inbound_sip',
      id: input.request.call_id
    },
    metadata: {
      source: input.source,
      ...(input.request.route_snapshot_revision === null
        ? {}
        : { route_snapshot_revision: input.request.route_snapshot_revision })
    },
    provider_runtime_profile: input.provider_runtime_profile,
    ...(input.owner_contract_facts
      ? { owner_contract_facts: input.owner_contract_facts }
      : {}),
    ...(input.placement
      ? {
          call_id: input.placement.call_id,
          placement_reservation: input.placement.reservation || undefined,
          placement_prepared: true
        }
      : {})
  });
}

async function assertRouteSnapshotRevision(
  pg: PgQueryable,
  tenantId: string,
  profileId: string,
  requestedRevision: number | null
): Promise<number> {
  if (requestedRevision === null) throw validationError();
  const result = await pg.query<{ revision: unknown }>(
    `/* ivekit-voice:assert-route-snapshot-revision */
     SELECT revision
     FROM ivekit_voice_route_snapshot_revisions
     WHERE tenant_id = $1 AND profile_id = $2
     FOR SHARE`,
    [tenantId, profileId]
  );
  const revision = Number(result.rows[0]?.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new VoiceError({
      code: 'capability_unavailable',
      status: 503,
      retryable: true
    });
  }
  if (revision !== requestedRevision) {
    throw new VoiceError({
      code: 'revision_conflict',
      status: 409,
      retryable: false
    });
  }
  return revision;
}

async function authorizeRealtimeAudioTap(
  options: RouteIveKitVoiceApiOptions,
  input: RealtimeAudioTapRouteAuthorizationInput
): Promise<string> {
  if (!options.realtime_audio_tap_authorizer) return '';
  const timeoutMs = boundedAuthorizationTimeout(
    options.realtime_audio_tap_authorization_timeout_ms ?? 50
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    const token = await Promise.race([
      options.realtime_audio_tap_authorizer.authorize(input),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        timer.unref?.();
      })
    ]);
    return typeof token === 'string' && token.length >= 32 && token.length <= 2_048
      ? token
      : '';
  } catch {
    return '';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function boundedAuthorizationTimeout(value: unknown): number {
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 5 || timeout > 500) {
    throw validationError();
  }
  return timeout;
}

function providerInboundAddress(
  value: string
): { kind: VoiceAddressKind; value: string } {
  const input = String(value || '').trim();
  const sip = input.match(/<?(sips?:[^\s<>]+@[^\s<>]+)>?/i)?.[1];
  if (sip) return { kind: 'sip_uri', value: sip };
  const telephone = input.replace(/^tel:/i, '').replace(/[\s().-]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(telephone)) {
    return { kind: 'e164', value: telephone };
  }
  if (/^\d{1,20}$/.test(input)) {
    return { kind: 'extension', value: input };
  }
  throw validationError();
}

async function resolveModule(
  pg: PgQueryable | null,
  tenantId: string,
  options: RouteIveKitVoiceApiOptions
): Promise<VoiceHttpModule> {
  if (options.module) return options.module;
  const required = requiredPg(pg);
  if (options.create_module) return options.create_module(required, tenantId);
  return createPostgresVoiceHttpModule(required, options);
}

function createWebhookAuthenticator(
  pg: PgQueryable,
  options: RouteIveKitVoiceApiOptions,
  maxBodyBytes?: number
): VoiceWebhookAuthenticator {
  return new VoiceWebhookAuthenticator({
    context_resolver: new PostgresVoiceProfileContextResolver(pg),
    secret_resolver: options.secret_resolver ?? configuredWebhookSecretResolver(),
    ...(maxBodyBytes === undefined ? {} : { max_body_bytes: maxBodyBytes })
  });
}

function configuredWebhookSecretResolver(): VoiceSecretResolver {
  const configured = String(resolveFabricEnv(process.env, 'VOICE_WEBHOOK_SECRET_ENV_NAMES') || '')
    .split(',').map((value) => value.trim()).filter((value) => /^[A-Z][A-Z0-9_]*$/.test(value));
  const names = [...new Set([
    'RUSTPBX_WEBHOOK_HMAC', 'RUSTPBX_WEBHOOK_SERVICE_KEY',
    'CONVERACT_FABRIC_VOICE_WEBHOOK_HMAC', 'CONVERACT_FABRIC_VOICE_WEBHOOK_SERVICE_KEY',
    ...configured
  ])];
  return new EnvVoiceSecretResolver({
    allowlist: { webhook_hmac: names, webhook_service_key: names }
  });
}

function requireVoiceAuth(headers: Headers): AuthContext {
  let ctx: AuthContext;
  try {
    ctx = resolveAuthContext(headers);
  } catch {
    throw new VoiceError({ code: 'validation_failed', status: 401 });
  }
  if (!ctx.authenticated || !ctx.tenantId || !ctx.userId
    || (ctx.role === 'system' && ctx.tenantId === 'system')) {
    throw new VoiceError({ code: 'validation_failed', status: 401 });
  }
  return ctx;
}

async function reconcileVoiceCallPlacement(
  placement: VoiceCallPlacementPort | undefined,
  tenantId: string,
  callId: string
): Promise<void> {
  if (!placement) return;
  await placement.reconcileOne({
    tenant_id: tenantId,
    interaction_id: callId,
    worker_id: voicePlacementWorkerId()
  });
}

function voicePlacementWorkerId(): string {
  const instance = String(
    resolveFabricEnv(process.env, 'INSTANCE_ID') || process.env.HOSTNAME || process.pid
  );
  return `voice:${createHash('sha256').update(instance).digest('hex').slice(0, 32)}`;
}

function stableVoiceCallId(tenantId: string, idempotencyKey: string): string {
  return `vcall_${createHash('sha256')
    .update(`${tenantId}\u0000${idempotencyKey}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function stableInboundVoiceCallId(
  tenantId: string,
  profileId: string,
  providerCallId: string
): string {
  return `vcall_${createHash('sha256')
    .update(`${tenantId}\u0000${profileId}\u0000${providerCallId}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function rejectTenantOverride(tenantId: string, url: URL, body: unknown): void {
  const queryTenant = url.searchParams.get('tenant_id');
  const input = isRecord(body) ? body : {};
  const bodyTenant = typeof input.tenant_id === 'string' ? input.tenant_id.trim() : '';
  if ((queryTenant && queryTenant !== tenantId) || (bodyTenant && bodyTenant !== tenantId)) {
    throw validationError();
  }
}

function requireAdmin(ctx: AuthContext): void {
  if (ctx.role !== 'owner' && ctx.role !== 'admin' && ctx.role !== 'system') {
    throw new VoiceError({ code: 'compliance_denied', status: 403 });
  }
}

function requireOperator(ctx: AuthContext): void {
  if (ctx.role === 'viewer') throw new VoiceError({ code: 'compliance_denied', status: 403 });
}

function requireExtensionSessionAccess(ctx: AuthContext, extension: VoiceExtension): void {
  if (extension.status !== 'active' || !extension.webrtc_enabled) {
    throw capabilityUnavailable('webrtc_extension');
  }
  if (ctx.role !== 'owner' && ctx.role !== 'admin' && ctx.role !== 'system'
    && extension.identity !== ctx.userId) {
    throw new VoiceError({ code: 'compliance_denied', status: 403 });
  }
}

function publicExtensionSessionPlan(
  plan: VoiceExtensionSessionPlan,
  extensionId: string
): VoiceExtensionSessionPlan {
  try {
    const websocket = new URL(plan.websocket_url);
    const expiresAt = Date.parse(plan.expires_at);
    const remainingSeconds = Math.floor((expiresAt - Date.now()) / 1_000);
    if (plan.transport !== 'wss' || websocket.protocol !== 'wss:'
      || websocket.username || websocket.password || websocket.hash
      || plan.extension_id !== extensionId || !Number.isFinite(expiresAt) || expiresAt <= Date.now()
      || !Number.isInteger(plan.register_expires_seconds)
      || plan.register_expires_seconds < 30 || plan.register_expires_seconds > 3_600
      || plan.register_expires_seconds > remainingSeconds
      || !/^sips?:[^\s@]+@[^\s@]+$/i.test(plan.address_of_record)
      || !Array.isArray(plan.ice_servers) || plan.ice_servers.length > 16) {
      throw new Error('invalid session plan');
    }
    const capabilities = plan.capabilities;
    const capabilityKeys = [
      'incoming', 'outgoing', 'dtmf', 'hold', 'transfer', 'audio_input', 'audio_output'
    ] as const;
    if (!capabilities || capabilityKeys.some((key) => typeof capabilities[key] !== 'boolean')) {
      throw new Error('invalid capabilities');
    }
    const iceServers = plan.ice_servers.map((server) => {
      const urls = Array.isArray(server.urls)
        ? server.urls.map((url) => safeIceUrl(url))
        : safeIceUrl(server.urls);
      if (Array.isArray(urls) && !urls.length) throw new Error('invalid ICE server');
      return {
        urls,
        ...(server.username === undefined ? {} : { username: safeProviderString(server.username, 512) }),
        ...(server.credential === undefined ? {} : { credential: safeProviderString(server.credential, 2_048) })
      };
    });
    return {
      session_id: safeProviderString(plan.session_id),
      extension_id: safeProviderString(plan.extension_id),
      transport: 'wss', websocket_url: websocket.toString(),
      address_of_record: safeProviderString(plan.address_of_record, 1_024),
      authorization_username: safeProviderString(plan.authorization_username, 512),
      authorization_password: safeProviderString(plan.authorization_password, 4_096),
      ...(plan.display_name === undefined ? {} : { display_name: safeProviderString(plan.display_name, 256) }),
      expires_at: new Date(expiresAt).toISOString(),
      register_expires_seconds: plan.register_expires_seconds,
      ice_servers: iceServers,
      capabilities: Object.fromEntries(
        capabilityKeys.map((key) => [key, capabilities[key]])
      ) as VoiceExtensionSessionPlan['capabilities']
    };
  } catch (cause) {
    if (cause instanceof VoiceError) throw cause;
    throw new VoiceError({ code: 'protocol_mismatch', status: 502 });
  }
}

function safeProviderString(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value || value.length > max
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('invalid provider value');
  }
  return value;
}

function safeIceUrl(value: unknown): string {
  const result = safeProviderString(value, 2_048);
  if (!/^(?:stun|stuns|turn|turns):[^\s]+$/i.test(result)) {
    throw new Error('invalid ICE server URL');
  }
  return result;
}

function listInput(tenantId: string, url: URL): { tenant_id: string; limit: number; cursor?: string } {
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw === null || limitRaw === '' ? 50 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw validationError();
  const cursor = url.searchParams.get('cursor') || '';
  if (cursor.length > 2_048 || /[\u0000-\u001f\u007f]/.test(cursor)) throw validationError();
  return { tenant_id: tenantId, limit, ...(cursor ? { cursor } : {}) };
}

function publicCallCommand(command: VoiceCallCommand): Record<string, unknown> {
  return {
    id: command.id, tenant_id: command.tenant_id, call_id: command.call_id,
    kind: command.kind, state: command.state, idempotency_key: command.idempotency_key,
    attempt_count: command.attempt_count, max_attempts: command.max_attempts,
    next_attempt_at: command.next_attempt_at, provider_command_id: command.provider_command_id,
    result: command.result, error_code: command.error_code,
    created_at: command.created_at, updated_at: command.updated_at, completed_at: command.completed_at
  };
}

function publicConfigurationCommand(command: VoiceConfigurationCommand): Record<string, unknown> {
  return {
    id: command.id, tenant_id: command.tenant_id, profile_id: command.profile_id,
    resource_type: command.resource_type, resource_id: command.resource_id,
    operation: command.operation, state: command.state, idempotency_key: command.idempotency_key,
    attempt_count: command.attempt_count, max_attempts: command.max_attempts,
    next_attempt_at: command.next_attempt_at, provider_command_id: command.provider_command_id,
    result: command.result, error_code: command.error_code,
    created_at: command.created_at, updated_at: command.updated_at, completed_at: command.completed_at
  };
}

function validatedRouteRules(value: unknown): Record<string, unknown> {
  const rules = bodyRecord(value);
  if (!Object.keys(rules).length || Buffer.byteLength(JSON.stringify(rules), 'utf8') > 256 * 1024) {
    throw validationError();
  }
  assertVoiceConfigContainsNoSecrets(rules);
  canonicalVoicePayloadHash(rules);
  return rules;
}

function clearAddress(value: unknown): { kind: VoiceAddressKind; value: string } {
  const input = bodyRecord(value);
  return {
    kind: requiredString(input.kind) as VoiceAddressKind,
    value: requiredString(input.value, 1_024)
  };
}

function businessReference(value: unknown): { type: string; id: string } {
  const input = bodyRecord(value);
  return { type: requiredString(input.type), id: requiredString(input.id) };
}

function requireIdempotencyKey(headers: Headers): string {
  const value = headerValue(headers, 'idempotency-key');
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw validationError();
  return value;
}

function headerValue(headers: Headers, name: string): string {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  const value = Array.isArray(entry?.[1]) ? entry?.[1][0] : entry?.[1];
  return String(value || '').trim();
}

function optionalQuery(url: URL, name: string): string {
  const value = (url.searchParams.get(name) || '').trim();
  if (value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw validationError();
  return value;
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw validationError();
  return value;
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return value === undefined || value === null ? {} : bodyRecord(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  const input = bodyRecord(value);
  if (Object.keys(input).length > 50) throw validationError();
  return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, requiredString(item, 512)]));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 32) throw validationError();
  return value.map((item) => requiredString(item, 64));
}

function arrayValue(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 100) throw validationError();
  canonicalVoicePayloadHash(value);
  return [...value];
}

function requiredString(value: unknown, max = 256): string {
  if (typeof value !== 'string') throw validationError();
  const result = value.trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) throw validationError();
  return result;
}

function optionalString(value: unknown, max = 2_048): string {
  if (value === undefined || value === null || value === '') return '';
  return requiredString(value, max);
}

function nullableString(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requiredString(value, 2_048);
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw validationError();
  return value;
}

function requiredInteger(value: unknown, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw validationError();
  return Number(value);
}

function requiredRevision(value: unknown): number {
  return requiredInteger(value, 1, Number.MAX_SAFE_INTEGER);
}

function nullableRevision(value: unknown): number | null {
  return value === undefined || value === null ? null : requiredRevision(value);
}

function decodeSegment(value: string): string {
  try {
    return requiredString(decodeURIComponent(value));
  } catch {
    throw validationError();
  }
}

function requiredPg(pg: PgQueryable | null): PgQueryable {
  if (!pg) throw new VoiceError({ code: 'provider_unavailable', retryable: true, status: 503 });
  return pg;
}

function capabilityUnavailable(capability: string): VoiceError {
  return new VoiceError({ code: 'capability_unavailable', status: 501, details: { capability } });
}

function webhookAuthFailed(): VoiceError {
  return new VoiceError({ code: 'webhook_auth_failed', status: 401 });
}

function validationError(): VoiceError {
  return new VoiceError({ code: 'validation_failed', status: 422 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
