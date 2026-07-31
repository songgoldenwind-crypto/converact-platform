import { resolveBrandEnv, resolveFabricEnv } from '../../../config/converact-env.js';
import { createHmac } from 'node:crypto';

import type { PgQueryable } from '../../../db-pg.js';
import {
  createIntelligenceProviderRegistry
} from '../../collaboration/intelligence-provider-registry.js';
import {
  IntelligenceProviderGovernanceStore
} from '../../collaboration/intelligence-provider-governance-store.js';
import {
  LiveKitRealtimeAudioTapGrantAuthorizer,
  PostgresRealtimeAudioTapGrantRepository,
  RealtimeAudioTapGrantAuthorizer,
  RealtimeAudioTapGrantService
} from './realtime-audio-tap-grant.js';
import {
  createLiveKitRealtimeAudioTapTokenCodec
} from './livekit-realtime-audio-tap-token.js';
import {
  LiveKitRealtimeAudioTapGateway,
  type LiveKitRealtimeAudioTapGatewayEvent,
  type LiveKitRealtimeSpeechEventContext
} from './livekit-realtime-audio-tap-gateway.js';
import { observeRealtimeAudioTapGatewayEvent } from './metrics.js';
import { createRealtimeAudioTapTokenCodec } from './realtime-audio-tap-token.js';
import type { RealtimeSpeechProjection } from './realtime-speech-projection.js';
import {
  RealtimeSpeechProjectionDispatcher
} from './realtime-speech-projection-dispatcher.js';
import {
  createPolicyRealtimeSpeechRouter,
  type PolicyRealtimeSpeechRouter
} from './realtime-speech-routing.js';
import type {
  RealtimeSpeechTranslationEvent
} from './realtime-speech-translation.js';
import {
  InMemoryRealtimeAudioTapNonceStore,
  RustPbxRealtimeAudioTapGateway,
  type RustPbxRealtimeAudioTapGatewayEvent,
  type RustPbxRealtimeSpeechEventContext
} from './rustpbx-realtime-audio-tap-gateway.js';

export interface ConfiguredRealtimeAudioTapRuntime {
  enabled: boolean;
  grants: RealtimeAudioTapGrantService;
  authorizer: RealtimeAudioTapGrantAuthorizer | null;
  livekit_authorizer: LiveKitRealtimeAudioTapGrantAuthorizer | null;
  gateway: RustPbxRealtimeAudioTapGateway | null;
  livekit_gateway: LiveKitRealtimeAudioTapGateway | null;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface CreateConfiguredRealtimeAudioTapRuntimeOptions {
  pg: PgQueryable;
  env?: NodeJS.ProcessEnv;
  router?: PolicyRealtimeSpeechRouter;
  projection?: Pick<RealtimeSpeechProjection, 'project'>;
  now?: () => Date;
  on_gateway_event?: (
    event: RustPbxRealtimeAudioTapGatewayEvent | LiveKitRealtimeAudioTapGatewayEvent
  ) => void | Promise<void>;
}

export function createConfiguredRealtimeAudioTapRuntime(
  options: CreateConfiguredRealtimeAudioTapRuntimeOptions
): ConfiguredRealtimeAudioTapRuntime {
  if (!options?.pg) throw new Error('audio_tap_runtime_invalid');
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const repository = new PostgresRealtimeAudioTapGrantRepository(options.pg);
  const grants = new RealtimeAudioTapGrantService({ repository, now });
  const enabled = booleanEnv(resolveFabricEnv(env, 'REALTIME_AUDIO_TAP_ENABLED'), false);
  if (!enabled) return {
    enabled: false,
    grants,
    authorizer: null,
    livekit_authorizer: null,
    gateway: null,
    livekit_gateway: null,
    async start() {},
    async stop() {}
  };
  const rustPbxGatewayEnabled = booleanEnv(
    resolveFabricEnv(env, 'RUSTPBX_AUDIO_TAP_GATEWAY_ENABLED'),
    true
  );
  const liveKitGatewayEnabled = booleanEnv(
    resolveFabricEnv(env, 'LIVEKIT_AUDIO_TAP_GATEWAY_ENABLED'),
    true
  );
  if (!rustPbxGatewayEnabled && !liveKitGatewayEnabled) {
    throw new Error('audio_tap_gateway_required');
  }

  const projection = options.projection;
  const secret = base64Secret(
    resolveFabricEnv(env, 'REALTIME_AUDIO_TAP_HMAC_SECRET_B64')
  );
  if (!projection) throw new Error('audio_tap_projection_required');
  const tokenCodec = createRealtimeAudioTapTokenCodec({
    secret,
    now,
    ttl_seconds: integerEnv(
      resolveFabricEnv(env, 'REALTIME_AUDIO_TAP_TOKEN_TTL_SECONDS'),
      60,
      10,
      300,
      'audio_tap_token_ttl_invalid'
    )
  });
  const authorizer = new RealtimeAudioTapGrantAuthorizer({
    repository,
    token_codec: tokenCodec,
    now
  });
  const liveKitTokenCodec = createLiveKitRealtimeAudioTapTokenCodec({
    secret: deriveLiveKitAudioTapInstanceSecret(
      secret,
      resolveFabricEnv(env, 'LIVEKIT_AUDIO_TAP_INSTANCE_ID') || ''
    ),
    now,
    ttl_seconds: integerEnv(
      resolveFabricEnv(env, 'REALTIME_AUDIO_TAP_TOKEN_TTL_SECONDS'),
      60,
      10,
      300,
      'audio_tap_token_ttl_invalid'
    )
  });
  const liveKitAuthorizer = new LiveKitRealtimeAudioTapGrantAuthorizer({
    repository,
    token_codec: liveKitTokenCodec,
    now
  });
  const router = options.router ?? createPolicyRealtimeSpeechRouter({
    pg: options.pg,
    registry: createIntelligenceProviderRegistry(env),
    governance: new IntelligenceProviderGovernanceStore(options.pg),
    env
  });
  const retentionDays = integerEnv(
    resolveBrandEnv(env, 'REALTIME_SPEECH_RETENTION_DAYS'),
    30,
    1,
    3_650,
    'audio_tap_retention_invalid'
  );
  const nonceStore = new InMemoryRealtimeAudioTapNonceStore({ now });
  const projectionDispatcher = new RealtimeSpeechProjectionDispatcher({
    projection,
    max_queue_items: integerEnv(
      resolveFabricEnv(env, 'REALTIME_PROJECTION_QUEUE_MAX_ITEMS'),
      4_096,
      1,
      100_000,
      'audio_tap_projection_queue_invalid'
    ),
    shutdown_timeout_ms: integerEnv(
      resolveFabricEnv(env, 'REALTIME_PROJECTION_SHUTDOWN_TIMEOUT_MS'),
      1_000,
      10,
      30_000,
      'audio_tap_projection_shutdown_invalid'
    ),
    on_event: (event) => {
      if (event.type === 'projection.succeeded') return;
      observeRealtimeAudioTapGatewayEvent({
        media_source: event.media_source,
        event_type: 'tap.projection.failed',
        reason: event.reason
      });
    }
  });
  const projectTranslation = (
    context: RustPbxRealtimeSpeechEventContext | LiveKitRealtimeSpeechEventContext,
    event: RealtimeSpeechTranslationEvent
  ): void => {
    const current = now();
    if (!Number.isFinite(current.getTime())) {
      throw new Error('audio_tap_clock_invalid');
    }
    projectionDispatcher.offer({
      ...context,
      retention_until: new Date(
        current.getTime() + retentionDays * 86_400_000
      ).toISOString(),
      audience_user_ids: [...new Set(context.audience_user_ids)]
    }, event);
  };
  const observeGatewayEvent = (
    mediaSource: 'rustpbx' | 'livekit',
    event: RustPbxRealtimeAudioTapGatewayEvent | LiveKitRealtimeAudioTapGatewayEvent
  ): void | Promise<void> => {
    observeRealtimeAudioTapGatewayEvent({
      media_source: mediaSource,
      event_type: event.type,
      reason: event.reason,
      dropped_duration_ms: event.dropped_duration_ms
    });
    return options.on_gateway_event?.(event);
  };
  const gateway = rustPbxGatewayEnabled ? new RustPbxRealtimeAudioTapGateway({
    socket_path: resolveFabricEnv(env, 'REALTIME_AUDIO_TAP_SOCKET_PATH')
      || '/run/ivekit/realtime-audio-tap.sock',
    token_codec: tokenCodec,
    router,
    nonce_store: nonceStore,
    max_connections: integerEnv(
      resolveFabricEnv(env, 'REALTIME_AUDIO_TAP_MAX_CONNECTIONS'),
      4_096,
      1,
      100_000,
      'audio_tap_connection_limit_invalid'
    ),
    max_prestart_audio_ms: integerEnv(
      resolveFabricEnv(env, 'REALTIME_AUDIO_TAP_PRESTART_BUFFER_MS'),
      1_000,
      20,
      5_000,
      'audio_tap_prestart_buffer_invalid'
    ),
    idle_timeout_ms: integerEnv(
      resolveFabricEnv(env, 'REALTIME_AUDIO_TAP_IDLE_TIMEOUT_MS'),
      60_000,
      1_000,
      300_000,
      'audio_tap_idle_timeout_invalid'
    ),
    shutdown_timeout_ms: integerEnv(
      resolveFabricEnv(env, 'REALTIME_AUDIO_TAP_SHUTDOWN_TIMEOUT_MS'),
      1_000,
      100,
      30_000,
      'audio_tap_shutdown_timeout_invalid'
    ),
    now,
    on_event: (event) => observeGatewayEvent('rustpbx', event),
    on_translation_event: projectTranslation
  }) : null;
  const liveKitGateway = liveKitGatewayEnabled ? new LiveKitRealtimeAudioTapGateway({
    listen_host: resolveFabricEnv(env, 'LIVEKIT_AUDIO_TAP_LISTEN_HOST') || '127.0.0.1',
    listen_port: integerEnv(
      resolveFabricEnv(env, 'LIVEKIT_AUDIO_TAP_LISTEN_PORT'),
      3_010,
      0,
      65_535,
      'livekit_audio_tap_listen_port_invalid'
    ),
    path: resolveFabricEnv(env, 'LIVEKIT_AUDIO_TAP_PATH')
      || '/api/ivekit/realtime-audio-tap/livekit',
    token_codec: liveKitTokenCodec,
    router,
    nonce_store: nonceStore,
    max_connections: integerEnv(
      resolveFabricEnv(env, 'LIVEKIT_AUDIO_TAP_MAX_CONNECTIONS'),
      4_096,
      1,
      100_000,
      'livekit_audio_tap_connection_limit_invalid'
    ),
    max_prestart_audio_ms: integerEnv(
      resolveFabricEnv(env, 'LIVEKIT_AUDIO_TAP_PRESTART_BUFFER_MS'),
      1_000,
      20,
      5_000,
      'livekit_audio_tap_prestart_buffer_invalid'
    ),
    max_payload_bytes: integerEnv(
      resolveFabricEnv(env, 'LIVEKIT_AUDIO_TAP_MAX_PAYLOAD_BYTES'),
      262_144,
      1_024,
      16_777_216,
      'livekit_audio_tap_payload_limit_invalid'
    ),
    idle_timeout_ms: integerEnv(
      resolveFabricEnv(env, 'LIVEKIT_AUDIO_TAP_IDLE_TIMEOUT_MS'),
      60_000,
      1_000,
      300_000,
      'livekit_audio_tap_idle_timeout_invalid'
    ),
    start_timeout_ms: integerEnv(
      resolveFabricEnv(env, 'LIVEKIT_AUDIO_TAP_START_TIMEOUT_MS'),
      5_000,
      100,
      30_000,
      'livekit_audio_tap_start_timeout_invalid'
    ),
    shutdown_timeout_ms: integerEnv(
      resolveFabricEnv(env, 'LIVEKIT_AUDIO_TAP_SHUTDOWN_TIMEOUT_MS'),
      1_000,
      100,
      30_000,
      'livekit_audio_tap_shutdown_timeout_invalid'
    ),
    now,
    on_event: (event) => observeGatewayEvent('livekit', event),
    on_translation_event: projectTranslation
  }) : null;
  const gateways = [gateway, liveKitGateway].filter(
    (candidate): candidate is RustPbxRealtimeAudioTapGateway | LiveKitRealtimeAudioTapGateway =>
      candidate !== null
  );
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  const start = (): Promise<void> => {
    startPromise ??= (async () => {
      try {
        for (const configuredGateway of gateways) {
          await configuredGateway.start();
        }
      } catch (error) {
        await Promise.allSettled(gateways.map((configuredGateway) =>
          configuredGateway.close()
        ));
        await projectionDispatcher.close();
        throw error;
      }
    })();
    return startPromise;
  };
  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      let shutdownError: unknown;
      try {
        await closeGateways(gateways);
      } catch (error) {
        shutdownError = error;
      }
      await projectionDispatcher.close();
      if (shutdownError) throw shutdownError;
    })();
    return stopPromise;
  };
  return {
    enabled: true,
    grants,
    authorizer,
    livekit_authorizer: liveKitAuthorizer,
    gateway,
    livekit_gateway: liveKitGateway,
    start,
    stop
  };
}

export function deriveLiveKitAudioTapInstanceSecret(
  clusterSecret: Uint8Array,
  instanceId: string
): Buffer {
  const secret = Buffer.from(clusterSecret);
  if (secret.length < 32 || secret.length > 128) {
    throw new Error('audio_tap_secret_invalid');
  }
  const instance = String(instanceId || '').trim();
  if (!instance) return secret;
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(instance)) {
    throw new Error('livekit_audio_tap_instance_id_invalid');
  }
  return createHmac('sha256', secret)
    .update('ivekit.livekit-audio-tap.instance.v1\0', 'utf8')
    .update(instance, 'utf8')
    .digest();
}

async function closeGateways(
  gateways: Array<LiveKitRealtimeAudioTapGateway | RustPbxRealtimeAudioTapGateway>
): Promise<void> {
  const results = await Promise.allSettled(
    gateways.map((gateway) => gateway.close())
  );
  const errors = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (errors.length) throw new AggregateError(errors, 'audio_tap_gateway_shutdown_failed');
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw new Error('audio_tap_enabled_invalid');
}

function integerEnv(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  code: string
): number {
  const number = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(code);
  }
  return number;
}

function base64Secret(value: string | undefined): Buffer {
  const encoded = String(value || '');
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('audio_tap_secret_invalid');
  }
  const secret = Buffer.from(encoded, 'base64');
  if (secret.length < 32 || secret.length > 128 ||
      secret.toString('base64') !== encoded) {
    throw new Error('audio_tap_secret_invalid');
  }
  return secret;
}
