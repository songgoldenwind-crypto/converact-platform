import type { PgQueryable } from '../../../db-pg.js';
import { VoiceError } from '../voice/errors.js';
import type { VoiceSecretResolver } from '../voice/ports.js';
import { EnvVoiceSecretResolver } from '../voice/secret-resolver.js';
import {
  PostgresVoiceProfileContextResolver,
  VoiceWebhookAuthenticator
} from '../voice/webhook-auth.js';
import { PostgresRustPbxStepIvrBindingResolver } from './postgres/rustpbx-step-binding.js';
import { PostgresIvrSessionUnitOfWork } from './postgres/unit-of-work.js';
import {
  RustPbxStepIvrService,
  type RustPbxStepIvrHandleInput,
  type RustPbxStepIvrHandleResult
} from './rustpbx-step-service.js';
import { IvrSessionService } from './session-service.js';

type Headers = Record<string, string | string[] | undefined>;

export interface RustPbxStepIvrHttpService {
  handle(input: RustPbxStepIvrHandleInput): Promise<RustPbxStepIvrHandleResult>;
}

export interface RouteIveKitIvrApiOptions {
  step_service?: RustPbxStepIvrHttpService;
  create_step_service?: (pg: PgQueryable, tenantId: string) => RustPbxStepIvrHttpService;
  webhook_authenticator?: Pick<VoiceWebhookAuthenticator, 'authenticate'>;
  secret_resolver?: VoiceSecretResolver;
  worker_poll_interval_ms?: number;
}

export async function routeIveKitIvrApi(
  pg: PgQueryable | null,
  method: string,
  path: string,
  _url: URL,
  body: unknown,
  rawBody: string | Buffer = '',
  headers: Headers = {},
  options: RouteIveKitIvrApiOptions = {}
): Promise<unknown | undefined> {
  if (!path.startsWith('/api/ivekit/ivr/')) return undefined;
  const match = path.match(
    /^\/api\/ivekit\/ivr\/provider-webhooks\/rustpbx\/([^/]+)\/step$/
  );
  if (!match || method !== 'POST') return undefined;
  const required = requiredPg(pg);
  const profileId = decodeSegment(match[1]!);
  const authenticator = options.webhook_authenticator ?? new VoiceWebhookAuthenticator({
    context_resolver: new PostgresVoiceProfileContextResolver(required),
    secret_resolver: options.secret_resolver ?? configuredSecretResolver()
  });
  const authenticated = await authenticator.authenticate({
    profile_id: profileId, raw_body: rawBody, headers
  });
  if (authenticated.adapter !== 'rustpbx' || authenticated.profile_id !== profileId) {
    throw new VoiceError({ code: 'webhook_auth_failed', status: 401 });
  }
  const service = options.step_service
    ?? options.create_step_service?.(required, authenticated.tenant_id)
    ?? new RustPbxStepIvrService({
      sessions: new IvrSessionService({
        unit_of_work: new PostgresIvrSessionUnitOfWork(required)
      }),
      bindings: new PostgresRustPbxStepIvrBindingResolver(required),
      worker_poll_interval_ms: options.worker_poll_interval_ms
    });
  const result = await service.handle({
    tenant_id: authenticated.tenant_id,
    profile_id: authenticated.profile_id,
    request: body
  });
  return {
    data: result.action_node,
    headers: {
      'x-ivekit-ivr-session-id': result.session_id,
      'x-ivekit-ivr-session-state': result.session_state,
      'x-ivekit-ivr-replayed': String(result.replayed),
      'x-ivekit-ivr-event-sequence': String(result.event_sequence),
      'x-ivekit-ivr-action-revision': String(result.action_revision)
    }
  };
}

function configuredSecretResolver(): VoiceSecretResolver {
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

function requiredPg(pg: PgQueryable | null): PgQueryable {
  if (!pg) throw new VoiceError({ code: 'provider_unavailable', retryable: true, status: 503 });
  return pg;
}

function decodeSegment(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(decoded)) throw new Error();
    return decoded;
  } catch {
    throw new VoiceError({ code: 'validation_failed', status: 422 });
  }
}
