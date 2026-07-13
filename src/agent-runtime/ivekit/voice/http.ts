import type { PgQueryable } from '../../../db-pg.js';
import { withPgTenant } from '../../../db-pg-tenant.js';
import { resolveAuthContext, type AuthContext } from '../../../middleware/auth.js';
import { EncryptedVoiceAddressProtector } from './address-protector.js';
import { RustPbxEventsAdapter } from './adapters/rustpbx-events.js';
import { RustPbxRouterAdapter } from './adapters/rustpbx-routing.js';
import { VoiceCallService } from './call-service.js';
import { VoicePolicyComplianceService } from './compliance-service.js';
import { canonicalVoicePayloadHash } from './canonical.js';
import { VoiceConfigurationService } from './configuration-service.js';
import {
  assertVoiceConfigContainsNoSecrets,
  VoiceDeploymentProfileService
} from './deployment-profile-service.js';
import { VoiceError } from './errors.js';
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
import { EnvVoiceSecretResolver } from './secret-resolver.js';
import type {
  VoiceAdapter,
  VoiceAddressKind,
  VoiceCallCommand,
  VoiceCallState,
  VoiceConfigurationCommand,
  VoiceExtension,
  VoiceRecording,
  VoiceRouteDirection,
  VoiceSipTrunk
} from './types.js';
import {
  PostgresVoiceProfileContextResolver,
  VoiceWebhookAuthenticator
} from './webhook-auth.js';

export interface VoiceExtensionSessionPort {
  create(input: {
    tenant_id: string;
    extension: VoiceExtension;
    actor: string;
    idempotency_key: string;
  }): Promise<Record<string, unknown>>;
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
  rustpbx_events: RustPbxEventsAdapter;
  router: VoiceRouterDecisionService;
  extension_sessions?: VoiceExtensionSessionPort;
}

export interface RouteIveKitVoiceApiOptions {
  module?: VoiceHttpModule;
  create_module?: (pg: PgQueryable, tenantId: string) => VoiceHttpModule | Promise<VoiceHttpModule>;
  webhook_authenticator?: VoiceWebhookAuthenticator;
  provider_registry?: VoiceProviderRegistry;
  address_protector?: VoiceAddressProtector;
  compliance?: VoiceCompliancePort;
  event_port?: VoiceEventPort;
  secret_resolver?: VoiceSecretResolver;
  extension_sessions?: VoiceExtensionSessionPort;
  available_route_dependencies?: readonly ('start_ivr' | 'enqueue' | 'bridge_livekit' | 'voicemail')[];
}

type Headers = Record<string, string | string[] | undefined>;

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

  const providerMatch = routePath.match(
    /^\/api\/ivekit\/voice\/providers\/([^/]+)\/(router|events|cdrs)$/
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
          recordings: true, livekit_sip_bridge: true, provider_webhooks: true
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

  const profileMatch = routePath.match(/^\/api\/ivekit\/voice\/profiles\/([^/]+)(?:\/(preflight))?$/);
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

  const didMatch = routePath.match(/^\/api\/ivekit\/voice\/dids\/([^/]+)$/);
  if (didMatch) {
    const didId = decodeSegment(didMatch[1]);
    if (method === 'GET') return { data: await module.configuration.getDid(ctx.tenantId, didId) };
    if (method === 'PATCH') {
      requireAdmin(ctx);
      const input = bodyRecord(body);
      return { data: await module.configuration.updateDid({
        tenant_id: ctx.tenantId, actor: ctx.userId, did_id: didId,
        expected_revision: requiredRevision(input.revision), patch: bodyRecord(input.patch) as never
      }) };
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

  const extensionMatch = routePath.match(/^\/api\/ivekit\/voice\/extensions\/([^/]+)(?:\/(session))?$/);
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
    if (action === 'session' && method === 'POST') {
      requireOperator(ctx);
      if (!module.extension_sessions) throw capabilityUnavailable('webrtc_extension');
      const extension = await module.configuration.getExtension(ctx.tenantId, extensionId);
      return { status: 201, data: await module.extension_sessions.create({
        tenant_id: ctx.tenantId, extension, actor: ctx.userId,
        idempotency_key: requireIdempotencyKey(headers)
      }) };
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
      const created = await module.calls.createOutbound({
        tenant_id: ctx.tenantId, actor: ctx.userId,
        profile_id: requiredString(input.profile_id),
        from: clearAddress(input.from), to: clearAddress(input.to),
        business_ref: businessReference(input.business_ref),
        idempotency_key: requireIdempotencyKey(headers), metadata: optionalRecord(input.metadata)
      });
      return { status: 202, data: { call: created.call, command: publicCallCommand(created.command) } };
    }
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
  const registry = options.provider_registry ?? new VoiceProviderRegistry();
  const addressProtector = options.address_protector ?? configuredAddressProtector();
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
      event_port: eventPort
    }),
    configuration_repository: configurationRepository,
    call_repository: callRepository,
    provider_event_repository: providerEventRepository,
    recordings,
    provider_events: new VoiceProviderEventService({ events: providerEventRepository, calls: callRepository }),
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

type ProviderWebhookAction = 'router' | 'events' | 'cdrs';

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
  const authenticator = input.options.webhook_authenticator ?? createWebhookAuthenticator(pg, input.options);
  const authenticated = await authenticator.authenticate({
    profile_id: input.profile_id,
    raw_body: input.raw_body,
    headers: input.headers
  });
  if (authenticated.adapter !== 'rustpbx') throw webhookAuthFailed();
  return withPgTenant(pg, authenticated.tenant_id, async (tenantPg) => {
    const module = await resolveModule(tenantPg, authenticated.tenant_id, input.options);
    const profile = await module.configuration_repository.getProfile(
      authenticated.tenant_id,
      authenticated.profile_id
    );
    if (!profile || profile.tenant_id !== authenticated.tenant_id
      || profile.id !== authenticated.profile_id || profile.adapter !== authenticated.adapter
      || profile.status === 'archived') throw webhookAuthFailed();

    if (input.action === 'router') {
      const request = new RustPbxRouterAdapter().normalizeRequest(input.body as never);
      return { data: await module.router.decide({
        tenant_id: authenticated.tenant_id,
        profile_id: authenticated.profile_id,
        request
      }) };
    }
    const normalized = module.rustpbx_events.normalize(
      input.action === 'cdrs' ? 'cdr' : 'http',
      input.body
    );
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
  options: RouteIveKitVoiceApiOptions
): VoiceWebhookAuthenticator {
  return new VoiceWebhookAuthenticator({
    context_resolver: new PostgresVoiceProfileContextResolver(pg),
    secret_resolver: options.secret_resolver ?? configuredWebhookSecretResolver()
  });
}

function configuredWebhookSecretResolver(): VoiceSecretResolver {
  const configured = String(process.env.OPC_IVEKIT_VOICE_WEBHOOK_SECRET_ENV_NAMES || '')
    .split(',').map((value) => value.trim()).filter((value) => /^[A-Z][A-Z0-9_]*$/.test(value));
  const names = [...new Set([
    'RUSTPBX_WEBHOOK_HMAC', 'RUSTPBX_WEBHOOK_SERVICE_KEY',
    'OPC_IVEKIT_VOICE_WEBHOOK_HMAC', 'OPC_IVEKIT_VOICE_WEBHOOK_SERVICE_KEY',
    ...configured
  ])];
  return new EnvVoiceSecretResolver({
    allowlist: { webhook_hmac: names, webhook_service_key: names }
  });
}

function configuredAddressProtector(): VoiceAddressProtector {
  const encryptionKey = String(process.env.OPC_IVEKIT_VOICE_ADDRESS_ENCRYPTION_KEY || '');
  const hmacKey = String(process.env.OPC_IVEKIT_VOICE_ADDRESS_HMAC_KEY || '');
  if (encryptionKey && hmacKey) {
    return new EncryptedVoiceAddressProtector({ encryption_key: encryptionKey, hmac_key: hmacKey });
  }
  const unavailable = async (): Promise<never> => {
    throw new VoiceError({ code: 'secret_unavailable', retryable: true, status: 503 });
  };
  return { protect: unavailable, reveal: unavailable };
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
