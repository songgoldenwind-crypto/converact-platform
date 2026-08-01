import { resolveBrandEnv, resolveFabricEnv } from './config/converact-env.js';
export interface TelemetryConfig {
  enabled: boolean;
  service_name: string;
  endpoint: string;
  sample_ratio: number;
  max_queue_size: number;
  max_export_batch_size: number;
  scheduled_delay_ms: number;
  export_timeout_ms: number;
}

interface TelemetrySdk {
  shutdown(): Promise<void>;
}

let activeSdk: TelemetrySdk | null = null;
let startupPromise: Promise<TelemetrySdk | null> | null = null;

export function resolveTelemetryConfig(
  env: NodeJS.ProcessEnv = process.env,
  defaultServiceName = 'converact'
): TelemetryConfig {
  const flag = String(resolveBrandEnv(env, 'OTEL_ENABLED') || '0').trim();
  if (flag !== '0' && flag !== '1') {
    throw new Error('CONVERACT_OTEL_ENABLED must be 0 or 1');
  }
  const serviceName = String(
    resolveBrandEnv(env, 'OTEL_SERVICE_NAME') || env.OTEL_SERVICE_NAME || defaultServiceName
  ).trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(serviceName)) {
    throw new Error('CONVERACT_OTEL_SERVICE_NAME is invalid');
  }
  const endpoint = String(resolveBrandEnv(env, 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT') || '').trim();
  if (flag === '1') validateEndpoint(endpoint);
  const maxQueueSize = integer(
    resolveBrandEnv(env, 'OTEL_MAX_QUEUE_SIZE'),
    2_048,
    128,
    65_536,
    'CONVERACT_OTEL_MAX_QUEUE_SIZE'
  );
  const maxExportBatchSize = integer(
    resolveBrandEnv(env, 'OTEL_MAX_EXPORT_BATCH_SIZE'),
    256,
    1,
    8_192,
    'CONVERACT_OTEL_MAX_EXPORT_BATCH_SIZE'
  );
  if (maxExportBatchSize > maxQueueSize) {
    throw new Error('CONVERACT_OTEL_MAX_EXPORT_BATCH_SIZE batch size must not exceed queue size');
  }
  return {
    enabled: flag === '1',
    service_name: serviceName,
    endpoint,
    sample_ratio: ratio(resolveBrandEnv(env, 'OTEL_TRACE_SAMPLE_RATIO'), 0.1),
    max_queue_size: maxQueueSize,
    max_export_batch_size: maxExportBatchSize,
    scheduled_delay_ms: integer(
      resolveBrandEnv(env, 'OTEL_SCHEDULED_DELAY_MS'),
      5_000,
      100,
      60_000,
      'CONVERACT_OTEL_SCHEDULED_DELAY_MS'
    ),
    export_timeout_ms: integer(
      resolveBrandEnv(env, 'OTEL_EXPORT_TIMEOUT_MS'),
      3_000,
      100,
      30_000,
      'CONVERACT_OTEL_EXPORT_TIMEOUT_MS'
    )
  };
}

export function initializeOpenTelemetry(
  env: NodeJS.ProcessEnv = process.env,
  defaultServiceName = 'converact'
): Promise<TelemetrySdk | null> {
  if (startupPromise) return startupPromise;
  startupPromise = initialize(resolveTelemetryConfig(env, defaultServiceName), env)
    .then((sdk) => {
      activeSdk = sdk;
      return sdk;
    });
  return startupPromise;
}

export async function shutdownOpenTelemetry(): Promise<void> {
  const sdk = activeSdk || await startupPromise;
  activeSdk = null;
  startupPromise = null;
  if (sdk) await sdk.shutdown();
}

async function initialize(
  config: TelemetryConfig,
  env: NodeJS.ProcessEnv
): Promise<TelemetrySdk | null> {
  if (!config.enabled) return null;
  const [
    { NodeSDK },
    { OTLPTraceExporter },
    { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler },
    { defaultResource, resourceFromAttributes },
    { HttpInstrumentation },
    { PgInstrumentation },
    { UndiciInstrumentation }
  ] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/sdk-trace-base'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/instrumentation-http'),
    import('@opentelemetry/instrumentation-pg'),
    import('@opentelemetry/instrumentation-undici')
  ]);

  const exporter = new OTLPTraceExporter({
    url: config.endpoint,
    timeoutMillis: config.export_timeout_ms
  });
  const processor = new BatchSpanProcessor(exporter, {
    maxQueueSize: config.max_queue_size,
    maxExportBatchSize: config.max_export_batch_size,
    scheduledDelayMillis: config.scheduled_delay_ms,
    exportTimeoutMillis: config.export_timeout_ms
  });
  const resource = defaultResource().merge(resourceFromAttributes({
    'service.name': config.service_name,
    'service.namespace': 'converact',
    'deployment.environment.name': String(env.NODE_ENV || 'production'),
    'ivekit.region': boundedResourceValue(resolveFabricEnv(env, 'REGION_ID')),
    'ivekit.zone': boundedResourceValue(resolveFabricEnv(env, 'ZONE_ID')),
    'ivekit.cell': boundedResourceValue(resolveFabricEnv(env, 'CELL_ID'))
  }));
  const sdk = new NodeSDK({
    resource,
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(config.sample_ratio)
    }),
    spanProcessors: [processor],
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) => {
          const path = String(request.url || '').split('?', 1)[0];
          return path === '/livez' || path === '/readyz' || path === '/metrics';
        }
      }),
      new PgInstrumentation({ requireParentSpan: true }),
      new UndiciInstrumentation()
    ]
  });
  sdk.start();
  return sdk;
}

function validateEndpoint(value: string): void {
  if (!value) throw new Error('CONVERACT_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is required');
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error('CONVERACT_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT must be an HTTP URL');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new Error('CONVERACT_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT must be an HTTP URL');
  }
  if (endpoint.username || endpoint.password) {
    throw new Error('CONVERACT_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT must not contain credentials');
  }
  if (endpoint.hash || endpoint.search || !endpoint.pathname.endsWith('/v1/traces')) {
    throw new Error('CONVERACT_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT must end with /v1/traces');
  }
}

function ratio(value: string | undefined, fallback: number): number {
  if (!String(value || '').trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error('CONVERACT_OTEL_TRACE_SAMPLE_RATIO must be between 0 and 1');
  }
  return parsed;
}

function integer(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string
): number {
  if (!String(value || '').trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function boundedResourceValue(value: string | undefined): string {
  const normalized = String(value || 'unspecified').trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(normalized)
    ? normalized
    : 'invalid';
}

if (process.env.NODE_ENV !== 'test') {
  await initializeOpenTelemetry(process.env, resolveBrandEnv(process.env, 'OTEL_SERVICE_NAME') || 'converact');
}
