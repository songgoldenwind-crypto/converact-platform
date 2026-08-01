import type { NotificationSecretResolver } from './ports.js';
import type { NotificationEndpoint } from './types.js';
import type { NotificationEndpointProbeResult } from './health-types.js';
import {
  parseNotificationHttpUrl,
  pinnedNotificationHttpRequest,
  resolveNotificationHttpDestination,
  type NotificationAddressResolver,
  type NotificationHttpRequest
} from './providers/http-destination.js';

export interface NotificationEndpointHealthProbeOptions {
  secrets: NotificationSecretResolver;
  fetch?: typeof globalThis.fetch;
  request?: NotificationHttpRequest;
  resolveAddress?: NotificationAddressResolver;
  allowControlled?: boolean;
  now?: () => number;
  smtpVerify?: (endpoint: NotificationEndpoint, credential: string) => Promise<boolean>;
}

export async function probeNotificationEndpoint(
  endpoint: NotificationEndpoint,
  options: NotificationEndpointHealthProbeOptions
): Promise<NotificationEndpointProbeResult> {
  const started = (options.now || Date.now)();
  let result: Omit<NotificationEndpointProbeResult, 'latency_ms'>;
  try {
    if (endpoint.provider_kind === 'smtp') {
      result = await probeSmtp(endpoint, options.secrets, options.smtpVerify);
    }
    else if (endpoint.provider_kind === 'controlled') {
      result = options.allowControlled
        ? { outcome: 'healthy', code: 'controlled_healthy' }
        : { outcome: 'unhealthy', code: 'controlled_forbidden' };
    } else result = await probeHttp(endpoint, options);
  } catch (error) {
    result = classifyProbeError(error);
  }
  return {
    ...result,
    latency_ms: Math.max(0, Math.min((options.now || Date.now)() - started, 3_600_000))
  };
}

async function probeHttp(
  endpoint: NotificationEndpoint,
  options: NotificationEndpointHealthProbeOptions
): Promise<Omit<NotificationEndpointProbeResult, 'latency_ms'>> {
  const healthUrl = stringConfig(endpoint, 'health_url') || endpoint.endpoint_url;
  const url = parseNotificationHttpUrl(healthUrl, booleanConfig(endpoint, 'allow_http'));
  if (!allowedPort(endpoint, url)) return { outcome: 'unhealthy', code: 'health_port_forbidden' };
  const destination = await resolveNotificationHttpDestination({
    url,
    allow_private_networks: booleanConfig(endpoint, 'allow_private_networks'),
    ...(options.resolveAddress ? { resolve: options.resolveAddress } : {})
  });
  if (destination.status === 'unsafe') return { outcome: 'unhealthy', code: 'health_destination_unsafe' };
  if (destination.status === 'unavailable') return { outcome: 'degraded', code: 'health_dns_unavailable' };

  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': 'converact-notification-health/1'
  };
  if (endpoint.provider_kind === 'email_http' || endpoint.provider_kind === 'sms_http') {
    const credential = await options.secrets.resolve(endpoint.secret_ref, 'provider_credential');
    headers.authorization = `Bearer ${credential}`;
  }
  let response: Response;
  try {
    const request = options.request || (options.fetch
      ? ((requestUrl: URL, init: RequestInit) => options.fetch!(requestUrl, init))
      : pinnedNotificationHttpRequest);
    response = await request(url, {
      method: healthMethod(endpoint),
      redirect: 'manual',
      headers,
      signal: AbortSignal.timeout(integerConfig(endpoint, 'health_timeout_ms', 10_000, 1_000, 60_000))
    }, destination.addresses);
  } catch {
    return { outcome: 'degraded', code: 'health_request_failed' };
  }
  if (response.status >= 200 && response.status < 300) {
    return { outcome: 'healthy', code: 'health_ok' };
  }
  if (response.status === 401 || response.status === 403) {
    return { outcome: 'unhealthy', code: 'health_auth_failed' };
  }
  if (response.status === 429) return { outcome: 'degraded', code: 'health_rate_limited' };
  if (response.status === 405) return { outcome: 'degraded', code: 'health_method_not_allowed' };
  if (response.status >= 500) return { outcome: 'unhealthy', code: 'health_provider_5xx' };
  return { outcome: 'degraded', code: 'health_provider_rejected' };
}

async function probeSmtp(
  endpoint: NotificationEndpoint,
  secrets: NotificationSecretResolver,
  verifyOverride?: (endpoint: NotificationEndpoint, credential: string) => Promise<boolean>
): Promise<Omit<NotificationEndpointProbeResult, 'latency_ms'>> {
  const credential = await secrets.resolve(endpoint.secret_ref, 'provider_credential');
  if (verifyOverride) {
    return await verifyOverride(endpoint, credential)
      ? { outcome: 'healthy', code: 'health_ok' }
      : { outcome: 'degraded', code: 'health_smtp_unverified' };
  }
  const nodemailer = await import('nodemailer');
  const port = integerConfig(endpoint, 'port', 587, 1, 65_535);
  const transport = nodemailer.createTransport({
    host: requiredStringConfig(endpoint, 'host'),
    port,
    secure: booleanConfig(endpoint, 'secure') || port === 465,
    requireTLS: booleanConfig(endpoint, 'require_tls'),
    auth: { user: requiredStringConfig(endpoint, 'user'), pass: credential },
    connectionTimeout: integerConfig(endpoint, 'health_timeout_ms', 10_000, 1_000, 60_000),
    socketTimeout: integerConfig(endpoint, 'health_timeout_ms', 10_000, 1_000, 60_000)
  });
  try {
    const verified = await transport.verify();
    return verified
      ? { outcome: 'healthy', code: 'health_ok' }
      : { outcome: 'degraded', code: 'health_smtp_unverified' };
  } catch (error) {
    const responseCode = Number((error as { responseCode?: unknown }).responseCode || 0);
    if ([530, 534, 535, 538].includes(responseCode)) {
      return { outcome: 'unhealthy', code: 'health_auth_failed' };
    }
    return { outcome: 'degraded', code: 'health_smtp_unavailable' };
  } finally {
    transport.close();
  }
}

function classifyProbeError(error: unknown): Omit<NotificationEndpointProbeResult, 'latency_ms'> {
  const code = String((error as { code?: unknown }).code || '');
  if (code === 'secret_ref_invalid' || code === 'validation_failed') {
    return { outcome: 'unhealthy', code: 'health_configuration_invalid' };
  }
  if (code === 'secret_unavailable') {
    return { outcome: 'degraded', code: 'health_secret_unavailable' };
  }
  return { outcome: 'degraded', code: 'health_probe_failed' };
}

function healthMethod(endpoint: NotificationEndpoint): 'HEAD' | 'GET' {
  const method = String(endpoint.config.health_method || 'HEAD').toUpperCase();
  if (method !== 'HEAD' && method !== 'GET') throw new Error('validation_failed');
  return method;
}

function allowedPort(endpoint: NotificationEndpoint, url: URL): boolean {
  const configured = endpoint.config.allowed_ports;
  if (configured === undefined) return !url.port || ['80', '443'].includes(url.port);
  if (!Array.isArray(configured) || configured.some((value) => !Number.isInteger(value))) return false;
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  return configured.includes(port);
}

function requiredStringConfig(endpoint: NotificationEndpoint, key: string): string {
  const value = stringConfig(endpoint, key);
  if (!value) throw new Error('validation_failed');
  return value;
}

function stringConfig(endpoint: NotificationEndpoint, key: string): string {
  const value = endpoint.config[key];
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) {
    throw new Error('validation_failed');
  }
  return value.trim();
}

function integerConfig(
  endpoint: NotificationEndpoint,
  key: string,
  fallback: number,
  min: number,
  max: number
): number {
  const value = endpoint.config[key];
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error('validation_failed');
  return number;
}

function booleanConfig(endpoint: NotificationEndpoint, key: string): boolean {
  const value = endpoint.config[key];
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new Error('validation_failed');
  return value;
}
