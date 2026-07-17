import type { NotificationDeliveryProvider, NotificationProviderResolver } from './ports.js';
import type {
  NotificationEndpoint,
  NotificationEndpointProviderKind
} from './types.js';
import { NotificationError } from './errors.js';
import { InAppNotificationProvider } from './providers/in-app.js';
import { HttpNotificationProvider } from './providers/http.js';
import type { NotificationAddressResolver } from './providers/http-destination.js';
import { SmtpNotificationProvider } from './providers/smtp.js';
import { WebhookNotificationProvider } from './providers/webhook.js';
import type {
  NotificationEndpointRepository,
  NotificationEndpointGovernanceRepository,
  NotificationInboxRepository,
  NotificationSecretResolver
} from './ports.js';
import {
  observeNotificationProviderReservation,
  observeNotificationProviderResult
} from './metrics.js';

export interface NotificationProviderResolverInput {
  endpoints: NotificationEndpointRepository;
  inbox: Pick<NotificationInboxRepository, 'upsertInboxItem'>;
  secrets: NotificationSecretResolver;
  resolveAddress?: NotificationAddressResolver;
  fetch?: typeof globalThis.fetch;
  smtpFactory?: (
    endpoint: NotificationEndpoint,
    credential: string
  ) => Promise<NotificationDeliveryProvider>;
  controlledFactory?: (
    endpoint: NotificationEndpoint
  ) => Promise<NotificationDeliveryProvider>;
  governance?: NotificationEndpointGovernanceRepository;
  now?: () => Date;
}

export function createNotificationProviderResolver(
  input: NotificationProviderResolverInput
): NotificationProviderResolver {
  const inApp = new InAppNotificationProvider({ repository: input.inbox });
  return async (delivery, notification) => {
    if (delivery.channel === 'in_app') {
      if (delivery.endpoint_id) throw validationError();
      return inApp;
    }
    const candidates = delivery.endpoint_id
      ? [await input.endpoints.getEndpoint(delivery.tenant_id, delivery.endpoint_id)].filter(Boolean)
      : await input.endpoints.listActiveEndpoints(delivery.tenant_id, delivery.channel);
    if (!candidates.length) throw unavailable();
    let quotaRetryAt: string | null = null;
    for (const endpoint of candidates as NotificationEndpoint[]) {
      if (endpoint.tenant_id !== delivery.tenant_id || endpoint.channel !== delivery.channel) {
        if (delivery.endpoint_id) throw validationError();
        continue;
      }
      if (endpoint.status !== 'active'
        || (!input.governance && endpoint.health_status === 'unhealthy')) {
        if (delivery.endpoint_id) throw unavailable();
        continue;
      }
      if (endpoint.event_allowlist.length && !endpoint.event_allowlist.includes(notification.event_type)) {
        if (delivery.endpoint_id) {
          throw new NotificationError({ code: 'compliance_denied', status: 403 });
        }
        continue;
      }
      ensureProviderChannel(endpoint);
      if (input.governance) {
        const reservation = await input.governance.reserveEndpoint({
          endpoint, now: input.now?.() || new Date()
        });
        observeNotificationProviderReservation({
          channel: endpoint.channel,
          allowed: reservation.allowed,
          reason: reservation.reason
        });
        if (!reservation.allowed) {
          if (reservation.reason === 'quota_exhausted') quotaRetryAt = reservation.retry_at;
          if (delivery.endpoint_id && reservation.reason === 'quota_exhausted') {
            throw quotaExhausted(reservation.retry_at);
          }
          if (delivery.endpoint_id) throw unavailable();
          continue;
        }
      }
      try {
        const provider = await providerFromEndpoint(endpoint, input);
        return input.governance ? governedProvider(provider, endpoint, input) : provider;
      } catch (error) {
        await recordGovernance(input, endpoint, 'failure');
        if (delivery.endpoint_id) throw error;
      }
    }
    if (quotaRetryAt) throw quotaExhausted(quotaRetryAt);
    throw unavailable();
  };
}

function governedProvider(
  provider: NotificationDeliveryProvider,
  endpoint: NotificationEndpoint,
  input: NotificationProviderResolverInput
): NotificationDeliveryProvider {
  return {
    ...provider,
    profile_id: provider.profile_id || endpoint.id,
    async deliver(deliveryInput) {
      try {
        const result = await provider.deliver(deliveryInput);
        const unhealthy = result.status === 'retryable_failure' || result.status === 'uncertain'
          || (result.status === 'terminal_failure'
            && ['provider_auth_failed', 'provider_unavailable', 'provider_timeout']
              .includes(String(result.error_code || '')));
        await recordGovernance(input, endpoint, unhealthy ? 'failure' : 'success');
        return result;
      } catch (error) {
        await recordGovernance(input, endpoint, 'failure');
        throw error;
      }
    }
  };
}

async function recordGovernance(
  input: NotificationProviderResolverInput,
  endpoint: NotificationEndpoint,
  outcome: 'success' | 'failure'
): Promise<void> {
  try {
    await input.governance?.recordEndpointResult({
      endpoint, outcome, now: input.now?.() || new Date()
    });
    if (input.governance) {
      observeNotificationProviderResult({
        channel: endpoint.channel, provider: endpoint.provider_kind, outcome
      });
    }
  } catch {
    // Provider results remain authoritative when health telemetry persistence is unavailable.
  }
}

async function providerFromEndpoint(
  endpoint: NotificationEndpoint,
  input: NotificationProviderResolverInput
): Promise<NotificationDeliveryProvider> {
  if (endpoint.provider_kind === 'webhook') {
    const secret = await input.secrets.resolve(endpoint.signing_secret_ref, 'webhook_signing');
    return new WebhookNotificationProvider({
      profile_id: endpoint.id,
      url: endpoint.endpoint_url,
      signing_secret: secret,
      timeout_ms: integerConfig(endpoint, 'timeout_ms', 10_000),
      allow_http: booleanConfig(endpoint, 'allow_http'),
      allowed_ports: numberArrayConfig(endpoint, 'allowed_ports'),
      ...(input.resolveAddress ? { resolve: input.resolveAddress } : {}),
      ...(input.fetch ? { fetch: input.fetch } : {})
    });
  }
  if (endpoint.provider_kind === 'email_http' || endpoint.provider_kind === 'sms_http') {
    const token = await input.secrets.resolve(endpoint.secret_ref, 'provider_credential');
    return new HttpNotificationProvider({
      kind: endpoint.provider_kind,
      channel: endpoint.channel as 'email' | 'sms',
      profile_id: endpoint.id,
      url: endpoint.endpoint_url,
      token,
      timeout_ms: integerConfig(endpoint, 'timeout_ms', 10_000),
      allow_http: booleanConfig(endpoint, 'allow_http'),
      allow_private_networks: booleanConfig(endpoint, 'allow_private_networks'),
      ...(input.resolveAddress ? { resolve: input.resolveAddress } : {}),
      ...(input.fetch ? { fetch: input.fetch } : {})
    });
  }
  if (endpoint.provider_kind === 'smtp') {
    const credential = await input.secrets.resolve(endpoint.secret_ref, 'provider_credential');
    return input.smtpFactory
      ? input.smtpFactory(endpoint, credential)
      : defaultSmtpProvider(endpoint, credential);
  }
  if (endpoint.provider_kind === 'controlled' && input.controlledFactory) {
    return input.controlledFactory(endpoint);
  }
  throw unavailable();
}

async function defaultSmtpProvider(
  endpoint: NotificationEndpoint,
  credential: string
): Promise<NotificationDeliveryProvider> {
  const host = stringConfig(endpoint, 'host');
  const user = stringConfig(endpoint, 'user');
  const from = stringConfig(endpoint, 'from');
  const replyTo = optionalStringConfig(endpoint, 'reply_to');
  const port = integerConfig(endpoint, 'port', 587);
  if (!host || !user || !from || port < 1 || port > 65535) throw validationError();
  const nodemailer = await import('nodemailer');
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: booleanConfig(endpoint, 'secure') || port === 465,
    requireTLS: booleanConfig(endpoint, 'require_tls'),
    auth: { user, pass: credential },
    connectionTimeout: integerConfig(endpoint, 'timeout_ms', 10_000),
    socketTimeout: integerConfig(endpoint, 'timeout_ms', 10_000)
  });
  return new SmtpNotificationProvider({
    profile_id: endpoint.id,
    from,
    ...(replyTo ? { reply_to: replyTo } : {}),
    transport: {
      sendMail: (mail) => transport.sendMail(mail)
    }
  });
}

function ensureProviderChannel(endpoint: NotificationEndpoint): void {
  const expected: Record<NotificationEndpointProviderKind, NotificationEndpoint['channel'] | null> = {
    webhook: 'webhook', smtp: 'email', email_http: 'email', sms_http: 'sms', controlled: null
  };
  const channel = expected[endpoint.provider_kind];
  if (channel && channel !== endpoint.channel) throw validationError();
}

function stringConfig(endpoint: NotificationEndpoint, key: string): string {
  const value = endpoint.config[key];
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw validationError();
  return value.trim();
}

function optionalStringConfig(endpoint: NotificationEndpoint, key: string): string {
  const value = endpoint.config[key];
  if (value === undefined || value === null || value === '') return '';
  return stringConfig(endpoint, key);
}

function integerConfig(endpoint: NotificationEndpoint, key: string, fallback: number): number {
  const value = endpoint.config[key];
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 300_000) throw validationError();
  return number;
}

function booleanConfig(endpoint: NotificationEndpoint, key: string): boolean {
  const value = endpoint.config[key];
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw validationError();
  return value;
}

function numberArrayConfig(endpoint: NotificationEndpoint, key: string): number[] | undefined {
  const value = endpoint.config[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || value.length > 16
    || value.some((item) => !Number.isInteger(item) || Number(item) < 1 || Number(item) > 65535)) {
    throw validationError();
  }
  return value.map(Number);
}

function validationError(): NotificationError {
  return new NotificationError({ code: 'validation_failed', status: 422 });
}

function unavailable(): NotificationError {
  return new NotificationError({ code: 'provider_unavailable', retryable: true, status: 503 });
}

function quotaExhausted(retryAt: string | null): NotificationError {
  return new NotificationError({
    code: 'quota_exhausted', retryable: true, status: 429,
    details: retryAt ? { retry_at: retryAt } : {}
  });
}
