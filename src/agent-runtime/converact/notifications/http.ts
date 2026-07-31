import { createHash, randomUUID } from 'node:crypto';
import { resolveAuthContext, type AuthContext } from '../../../middleware/auth.js';
import type { PgQueryable } from '../../../db-pg.js';
import { NotificationEndpointService } from './endpoint-service.js';
import { NotificationAdministrationService } from './administration-service.js';
import { NotificationOperationsService } from './operations-service.js';
import { NotificationReceiptService } from './receipt-service.js';
import { NotificationTemplateRenderer } from './template-renderer.js';
import { NotificationPreferencePolicy } from './preference-policy.js';
import { NotificationError } from './errors.js';
import type {
  CreateNotificationEndpointInput,
  CreateNotificationTemplateInput,
  CreateNotificationInput,
  NotificationCreateResult,
  NotificationEndpoint,
  NotificationEndpointListInput,
  NotificationDeliveryListInput,
  NotificationDeliveryRecord,
  NotificationEndpointCreateResult,
  NotificationInboxItem,
  NotificationInboxListInput,
  NotificationInboxMutationInput,
  NotificationPage,
  NotificationRecord,
  NotificationReceiptPayload,
  NotificationReceiptResult,
  NotificationPreference,
  NotificationTemplateSnapshot,
  NotificationTemplate,
  NotificationTemplateListInput,
  NotificationTemplateVersion,
  NotificationTemplateVersionListInput,
  PublishNotificationTemplateInput,
  PutNotificationPreferenceInput,
  ReceiveNotificationReceiptInput,
  UpdateNotificationTemplateInput,
  UpdateNotificationEndpointInput
} from './types.js';
import { configuredNotificationProtector } from './protector.js';
import { NotificationService } from './service.js';
import { PostgresNotificationStore } from './postgres/store.js';
import { publishNotificationTenantEvent } from './realtime.js';
import { configuredNotificationSecretResolver } from './secret-resolver.js';
import { iveKitCapabilityAllowed, type IveKitCapability } from '../authorization.js';
import {
  createPostgresIveKitAuditService,
  type IveKitAuditRequest,
  type IveKitAuditService
} from '../operations/audit/index.js';
import {
  configuredIveKitRateLimiter,
  iveKitRateLimitConfiguration,
  type IveKitRateLimiter
} from '../operations/rate-limit/index.js';

export interface NotificationHttpModule {
  createNotification(input: CreateNotificationInput): Promise<NotificationCreateResult>;
  getNotification(tenantId: string, notificationId: string): Promise<NotificationRecord | null>;
  listInbox(input: NotificationInboxListInput): Promise<NotificationPage<NotificationInboxItem>>;
  countUnread(tenantId: string, userId: string): Promise<number>;
  mutateInbox(input: NotificationInboxMutationInput): Promise<NotificationInboxItem | null>;
  createEndpoint(input: CreateNotificationEndpointInput): Promise<NotificationEndpointCreateResult>;
  getEndpoint(tenantId: string, endpointId: string): Promise<NotificationEndpoint | null>;
  listEndpoints(input: NotificationEndpointListInput): Promise<NotificationPage<NotificationEndpoint>>;
  updateEndpoint(input: UpdateNotificationEndpointInput): Promise<NotificationEndpoint>;
  createTemplate(input: CreateNotificationTemplateInput): Promise<NotificationTemplateSnapshot>;
  updateTemplate(input: UpdateNotificationTemplateInput): Promise<NotificationTemplateSnapshot>;
  publishTemplate(input: PublishNotificationTemplateInput): Promise<NotificationTemplateSnapshot>;
  getTemplate(tenantId: string, templateId: string): Promise<NotificationTemplate | null>;
  listTemplates(input: NotificationTemplateListInput): Promise<NotificationPage<NotificationTemplate>>;
  listTemplateVersions(
    input: NotificationTemplateVersionListInput
  ): Promise<NotificationPage<NotificationTemplateVersion>>;
  archiveTemplate(input: {
    tenant_id: string; template_id: string; actor: string; expected_revision: number;
  }): Promise<NotificationTemplate>;
  getDelivery(tenantId: string, deliveryId: string): Promise<NotificationDeliveryRecord | null>;
  listDeliveries(
    input: NotificationDeliveryListInput
  ): Promise<NotificationPage<NotificationDeliveryRecord>>;
  retryDelivery(input: {
    tenant_id: string;
    delivery_id: string;
    actor: string;
    expected_state: 'failed' | 'dead_letter' | 'uncertain';
    allow_uncertain: boolean;
    now: Date;
  }): Promise<NotificationDeliveryRecord>;
  listPreferences(tenantId: string, userId: string): Promise<NotificationPreference[]>;
  putPreference(input: PutNotificationPreferenceInput): Promise<NotificationPreference>;
  receiveReceipt(input: ReceiveNotificationReceiptInput): Promise<NotificationReceiptResult>;
}

export interface RouteIveKitNotificationApiOptions {
  module?: NotificationHttpModule;
  env?: NodeJS.ProcessEnv;
  audit?: Pick<IveKitAuditService, 'append'> | null;
  rateLimiter?: Pick<IveKitRateLimiter, 'check'> | null;
}

export async function routeIveKitNotificationApi(
  pg: PgQueryable | null,
  method: string,
  path: string,
  url: URL,
  body: unknown,
  headers: Record<string, string | string[] | undefined>,
  options: RouteIveKitNotificationApiOptions = {}
): Promise<Record<string, unknown> | undefined> {
  const routePath = path.split('?')[0];
  if (!routePath.startsWith('/api/ivekit/notifications')) return undefined;
  const module = options.module || createPostgresNotificationHttpModule(requiredPg(pg), options.env);

  const receiptMatch = routePath.match(
    /^\/api\/ivekit\/notifications\/provider-receipts\/([^/]+)$/
  );
  if (receiptMatch && method === 'POST') {
    const receiptTenantId = requiredString(headerValue(headers, 'x-tenant-id'), 255);
    const endpointId = decodeSegment(receiptMatch[1]);
    await checkProviderReceiptRateLimit(pg, headers, options, receiptTenantId, endpointId);
    const result = await module.receiveReceipt({
      tenant_id: receiptTenantId,
      endpoint_id: endpointId,
      timestamp: requiredString(headerValue(headers, 'x-opc-timestamp'), 32),
      signature: requiredString(headerValue(headers, 'x-opc-signature'), 128),
      body: receiptPayloadInput(body)
    });
    await appendNotificationAudit(pg, headers, options, {
      tenant_id: receiptTenantId,
      actor_id: endpointId,
      actor_role: 'provider',
      action: 'notification.provider_receipt.receive',
      resource_type: 'notification_delivery',
      resource_id: result.receipt.delivery_id,
      business_ref: { type: 'notification_delivery', id: result.receipt.delivery_id },
      metadata: {
        provider_kind: result.receipt.provider_kind,
        receipt_status: result.receipt.receipt_status,
        created: result.created,
        reconciliation: result.reconciliation
      }
    });
    return {
      status: result.created ? 201 : 200,
      data: {
        receipt: {
          id: result.receipt.id,
          delivery_id: result.receipt.delivery_id,
          provider_event_id: result.receipt.provider_event_id,
          receipt_status: result.receipt.receipt_status,
          occurred_at: result.receipt.occurred_at,
          received_at: result.receipt.received_at
        },
        created: result.created,
        reconciliation: result.reconciliation
      }
    };
  }

  const auth = notificationAuth(headers);

  if (routePath === '/api/ivekit/notifications/capabilities' && method === 'GET') {
    return {
      data: {
        schema_version: 1,
        channels: { in_app: true, webhook: true, email: true, sms: true, mobile_push: false },
        inbox: true,
        templates: true,
        preferences: true,
        provider_receipts: true,
        durable_delivery: true,
        administration: true,
        delivery_operations: true,
        active_health_checks: true
      }
    };
  }

  if (routePath === '/api/ivekit/notifications' && method === 'POST') {
    requireWriter(auth);
    const input = record(body);
    if (input.force_delivery === true) requireCapability(auth, 'notifications.force_delivery');
    const recipient = recipientInput(input.recipient);
    const targets = targetInputs(input.targets);
    await checkNotificationCreateRateLimit(
      pg, headers, options, auth, recipient.ref, targets.map((target) => target.recipient)
    );
    const result = await module.createNotification({
      tenant_id: auth.tenantId,
      event_type: requiredString(input.event_type, 255),
      recipient,
      targets,
      content: input.content,
      content_projection: optionalRecord(input.content_projection),
      priority: optionalString(input.priority) as CreateNotificationInput['priority'],
      force_delivery: input.force_delivery === true,
      locale: optionalString(input.locale),
      template: templateInput(input.template),
      business_ref: businessRefInput(input.business_ref),
      requested_by: auth.userId,
      correlation_id: optionalString(input.correlation_id),
      idempotency_key: requireIdempotencyKey(headers),
      policy: optionalRecord(input.policy),
      scheduled_at: optionalString(input.scheduled_at),
      retention_until: nullableString(input.retention_until),
      max_attempts: optionalInteger(input.max_attempts)
    });
    await appendNotificationAudit(pg, headers, options, {
      auth,
      action: 'notification.create',
      resource_type: 'notification',
      resource_id: result.notification.id,
      business_ref: {
        type: result.notification.business_ref_type,
        id: result.notification.business_ref_id
      },
      metadata: {
        event_type: result.notification.event_type,
        channels: result.notification.channels,
        priority: result.notification.priority,
        force_delivery: result.notification.force_delivery,
        created: result.created
      }
    });
    return {
      status: result.created ? 201 : 200,
      data: projectCreateResult(result)
    };
  }

  if (routePath === '/api/ivekit/notifications/inbox' && method === 'GET') {
    const userId = inboxUser(auth, url);
    return {
      data: await module.listInbox({
        tenant_id: auth.tenantId,
        user_id: userId,
        limit: queryInteger(url, 'limit'),
        cursor: url.searchParams.get('cursor') || undefined,
        include_archived: url.searchParams.get('include_archived') === 'true'
      })
    };
  }

  if (routePath === '/api/ivekit/notifications/inbox/unread-count' && method === 'GET') {
    return { data: { unread_count: await module.countUnread(auth.tenantId, inboxUser(auth, url)) } };
  }

  const inboxMatch = routePath.match(
    /^\/api\/ivekit\/notifications\/inbox\/([^/]+)\/(read|unread|archive|unarchive)$/
  );
  if (inboxMatch && method === 'POST') {
    const item = await module.mutateInbox({
      tenant_id: auth.tenantId,
      user_id: inboxUser(auth, url),
      item_id: decodeSegment(inboxMatch[1]),
      action: inboxMatch[2] as NotificationInboxMutationInput['action'],
      now: new Date()
    });
    if (!item) throw new NotificationError({ code: 'not_found', status: 404 });
    await appendNotificationAudit(pg, headers, options, {
      auth,
      action: `notification.inbox.${inboxMatch[2]}`,
      resource_type: 'notification_inbox_item',
      resource_id: item.id,
      business_ref: { type: 'notification', id: item.notification_id },
      metadata: { inbox_action: inboxMatch[2] }
    });
    return { data: item };
  }

  if (routePath === '/api/ivekit/notifications/endpoints' && method === 'GET') {
    requireAdmin(auth);
    const page = await module.listEndpoints({
      tenant_id: auth.tenantId,
      channel: endpointChannelQuery(url.searchParams.get('channel')),
      status: endpointStatusQuery(url.searchParams.get('status')),
      limit: queryInteger(url, 'limit'),
      cursor: url.searchParams.get('cursor') || undefined
    });
    return {
      data: {
        items: page.items.map(projectEndpoint),
        next_cursor: page.next_cursor
      }
    };
  }

  if (routePath === '/api/ivekit/notifications/endpoints' && method === 'POST') {
    requireAdmin(auth);
    const input = record(body);
    const result = await module.createEndpoint({
      tenant_id: auth.tenantId,
      actor: auth.userId,
      name: requiredString(input.name, 255),
      channel: requiredString(input.channel, 20) as CreateNotificationEndpointInput['channel'],
      provider_kind: requiredString(input.provider_kind, 50) as CreateNotificationEndpointInput['provider_kind'],
      status: optionalString(input.status) as CreateNotificationEndpointInput['status'],
      endpoint_url: optionalString(input.endpoint_url),
      secret_ref: optionalString(input.secret_ref),
      signing_secret_ref: optionalString(input.signing_secret_ref),
      event_allowlist: stringArray(input.event_allowlist),
      config: optionalRecord(input.config),
      failover_group: optionalString(input.failover_group),
      priority: optionalInteger(input.priority),
      quota_per_minute: optionalNullableInteger(input.quota_per_minute),
      quota_per_day: optionalNullableInteger(input.quota_per_day),
      idempotency_key: requireIdempotencyKey(headers)
    });
    await appendNotificationAudit(pg, headers, options, {
      auth,
      action: 'notification.endpoint.create',
      resource_type: 'notification_endpoint',
      resource_id: result.endpoint.id,
      business_ref: { type: 'notification_endpoint', id: result.endpoint.id },
      metadata: {
        channel: result.endpoint.channel,
        provider_kind: result.endpoint.provider_kind,
        status: result.endpoint.status,
        created: result.created
      }
    });
    return {
      status: result.created ? 201 : 200,
      data: { endpoint: projectEndpoint(result.endpoint), created: result.created }
    };
  }

  if (routePath === '/api/ivekit/notifications/templates' && method === 'GET') {
    requireAdmin(auth);
    const page = await module.listTemplates({
      tenant_id: auth.tenantId,
      status: templateStatusQuery(url.searchParams.get('status')),
      limit: queryInteger(url, 'limit'),
      cursor: url.searchParams.get('cursor') || undefined
    });
    return { data: page };
  }

  if (routePath === '/api/ivekit/notifications/templates' && method === 'POST') {
    requireAdmin(auth);
    const input = record(body);
    const snapshot = await module.createTemplate({
      tenant_id: auth.tenantId,
      actor: auth.userId,
      template_key: requiredString(input.template_key, 128),
      description: optionalString(input.description),
      locale: requiredString(input.locale, 35),
      channels: channelArray(input.channels),
      content: record(input.content)
    });
    await appendTemplateAudit(pg, headers, options, auth, 'create', snapshot);
    return { status: 201, data: projectTemplateSnapshot(snapshot) };
  }

  const templateVersionsMatch = routePath.match(
    /^\/api\/ivekit\/notifications\/templates\/([^/]+)\/versions$/
  );
  if (templateVersionsMatch && method === 'GET') {
    requireAdmin(auth);
    const page = await module.listTemplateVersions({
      tenant_id: auth.tenantId,
      template_id: decodeSegment(templateVersionsMatch[1]),
      locale: url.searchParams.get('locale') || undefined,
      limit: queryInteger(url, 'limit'),
      cursor: url.searchParams.get('cursor') || undefined
    });
    return { data: page };
  }

  const templateArchiveMatch = routePath.match(
    /^\/api\/ivekit\/notifications\/templates\/([^/]+)\/archive$/
  );
  if (templateArchiveMatch && method === 'POST') {
    requireAdmin(auth);
    const input = record(body);
    const template = await module.archiveTemplate({
      tenant_id: auth.tenantId,
      template_id: decodeSegment(templateArchiveMatch[1]),
      actor: auth.userId,
      expected_revision: requiredInteger(input.expected_revision)
    });
    await appendNotificationAudit(pg, headers, options, {
      auth,
      action: 'notification.template.archive',
      resource_type: 'notification_template',
      resource_id: template.id,
      business_ref: { type: 'notification_template', id: template.id },
      metadata: { template_key: template.template_key, status: template.status }
    });
    return { data: { template } };
  }

  const templatePublishMatch = routePath.match(
    /^\/api\/ivekit\/notifications\/templates\/([^/]+)\/publish$/
  );
  if (templatePublishMatch && method === 'POST') {
    requireAdmin(auth);
    const input = record(body);
    const snapshot = await module.publishTemplate({
      tenant_id: auth.tenantId,
      actor: auth.userId,
      template_id: decodeSegment(templatePublishMatch[1]),
      expected_revision: requiredInteger(input.expected_revision),
      locale: requiredString(input.locale, 35)
    });
    await appendTemplateAudit(pg, headers, options, auth, 'publish', snapshot);
    return { data: projectTemplateSnapshot(snapshot) };
  }

  const templateMatch = routePath.match(/^\/api\/ivekit\/notifications\/templates\/([^/]+)$/);
  if (templateMatch) {
    requireAdmin(auth);
    const templateId = decodeSegment(templateMatch[1]);
    if (method === 'GET') {
      const template = await module.getTemplate(auth.tenantId, templateId);
      if (!template) throw new NotificationError({ code: 'not_found', status: 404 });
      return { data: { template } };
    }
    if (method === 'PUT') {
      const input = record(body);
      const snapshot = await module.updateTemplate({
        tenant_id: auth.tenantId,
        actor: auth.userId,
        template_id: templateId,
        expected_revision: requiredInteger(input.expected_revision),
        description: optionalString(input.description),
        locale: requiredString(input.locale, 35),
        channels: channelArray(input.channels),
        content: record(input.content)
      });
      await appendTemplateAudit(pg, headers, options, auth, 'update', snapshot);
      return { data: projectTemplateSnapshot(snapshot) };
    }
  }

  if (routePath === '/api/ivekit/notifications/preferences' && method === 'GET') {
    return { data: { preferences: await module.listPreferences(auth.tenantId, inboxUser(auth, url)) } };
  }

  const preferenceMatch = routePath.match(
    /^\/api\/ivekit\/notifications\/preferences\/([^/]+)\/([^/]+)$/
  );
  if (preferenceMatch && method === 'PUT') {
    const input = record(body);
    const preference = await module.putPreference({
      tenant_id: auth.tenantId,
      user_id: inboxUser(auth, url),
      event_type: decodeSegment(preferenceMatch[1]),
      channel: notificationChannel(decodeSegment(preferenceMatch[2])),
      enabled: requiredBoolean(input.enabled),
      locale: optionalString(input.locale),
      quiet_hours: optionalRecord(input.quiet_hours),
      expected_revision: requiredInteger(input.expected_revision)
    });
    await appendNotificationAudit(pg, headers, options, {
      auth,
      action: 'notification.preference.update',
      resource_type: 'notification_preference',
      resource_id: `${preference.event_type}:${preference.channel}`,
      business_ref: { type: 'notification_preference', id: preference.user_id },
      metadata: {
        event_type: preference.event_type,
        channel: preference.channel,
        enabled: preference.enabled,
        revision: preference.revision
      }
    });
    return { data: { preference } };
  }

  if (routePath === '/api/ivekit/notifications/deliveries' && method === 'GET') {
    requireAdmin(auth);
    const page = await module.listDeliveries({
      tenant_id: auth.tenantId,
      notification_id: url.searchParams.get('notification_id') || undefined,
      endpoint_id: url.searchParams.get('endpoint_id') || undefined,
      channel: channelQuery(url.searchParams.get('channel')),
      state: deliveryStateQuery(url.searchParams.get('state')),
      limit: queryInteger(url, 'limit'),
      cursor: url.searchParams.get('cursor') || undefined
    });
    return {
      data: {
        items: page.items.map(projectDelivery),
        next_cursor: page.next_cursor
      }
    };
  }

  const deliveryRetryMatch = routePath.match(
    /^\/api\/ivekit\/notifications\/deliveries\/([^/]+)\/retry$/
  );
  if (deliveryRetryMatch && method === 'POST') {
    requireAdmin(auth);
    const input = record(body);
    const allowUncertain = input.allow_uncertain === true;
    if (allowUncertain) requireCapability(auth, 'notifications.force_delivery');
    const expectedState = retryableDeliveryState(input.expected_state);
    const delivery = await module.retryDelivery({
      tenant_id: auth.tenantId,
      delivery_id: decodeSegment(deliveryRetryMatch[1]),
      actor: auth.userId,
      expected_state: expectedState,
      allow_uncertain: allowUncertain,
      now: new Date()
    });
    await appendNotificationAudit(pg, headers, options, {
      auth,
      action: 'notification.delivery.retry',
      resource_type: 'notification_delivery',
      resource_id: delivery.id,
      business_ref: { type: 'notification', id: delivery.notification_id },
      metadata: {
        previous_state: expectedState,
        next_state: delivery.state,
        allow_uncertain: allowUncertain,
        attempt_count: delivery.attempt_count
      }
    });
    return { data: { delivery: projectDelivery(delivery) } };
  }

  const deliveryMatch = routePath.match(
    /^\/api\/ivekit\/notifications\/deliveries\/([^/]+)$/
  );
  if (deliveryMatch && method === 'GET') {
    requireAdmin(auth);
    const delivery = await module.getDelivery(auth.tenantId, decodeSegment(deliveryMatch[1]));
    if (!delivery) throw new NotificationError({ code: 'not_found', status: 404 });
    return { data: { delivery: projectDelivery(delivery) } };
  }

  const endpointTestMatch = routePath.match(
    /^\/api\/ivekit\/notifications\/endpoints\/([^/]+)\/test$/
  );
  if (endpointTestMatch && method === 'POST') {
    requireAdmin(auth);
    const endpointId = decodeSegment(endpointTestMatch[1]);
    const endpoint = await module.getEndpoint(auth.tenantId, endpointId);
    if (!endpoint) throw new NotificationError({ code: 'not_found', status: 404 });
    if (endpoint.status !== 'active') {
      throw new NotificationError({ code: 'provider_unavailable', status: 409 });
    }
    const input = record(body);
    const recipient = requiredString(input.recipient, 2048);
    const result = await module.createNotification({
      tenant_id: auth.tenantId,
      event_type: requiredString(input.event_type, 255),
      recipient: { kind: 'endpoint', ref: endpoint.id },
      targets: [{ channel: endpoint.channel, recipient, endpoint_id: endpoint.id }],
      content: input.content,
      content_projection: optionalRecord(input.content_projection),
      priority: 'normal',
      force_delivery: true,
      business_ref: input.business_ref === undefined
        ? { type: 'notification_endpoint_test', id: endpoint.id }
        : businessRefInput(input.business_ref),
      requested_by: auth.userId,
      correlation_id: optionalString(input.correlation_id),
      idempotency_key: requireIdempotencyKey(headers),
      policy: { endpoint_test: true },
      max_attempts: 1
    });
    await appendNotificationAudit(pg, headers, options, {
      auth,
      action: 'notification.endpoint.test',
      resource_type: 'notification_endpoint',
      resource_id: endpoint.id,
      business_ref: { type: 'notification', id: result.notification.id },
      metadata: {
        channel: endpoint.channel,
        provider_kind: endpoint.provider_kind,
        notification_id: result.notification.id,
        created: result.created
      }
    });
    return { status: result.created ? 201 : 200, data: projectCreateResult(result) };
  }

  const endpointArchiveMatch = routePath.match(
    /^\/api\/ivekit\/notifications\/endpoints\/([^/]+)\/archive$/
  );
  if (endpointArchiveMatch && method === 'POST') {
    requireAdmin(auth);
    const input = record(body);
    const endpoint = await module.updateEndpoint({
      tenant_id: auth.tenantId,
      endpoint_id: decodeSegment(endpointArchiveMatch[1]),
      actor: auth.userId,
      expected_revision: requiredInteger(input.expected_revision),
      patch: { status: 'archived' }
    });
    await appendNotificationAudit(pg, headers, options, {
      auth,
      action: 'notification.endpoint.archive',
      resource_type: 'notification_endpoint',
      resource_id: endpoint.id,
      business_ref: { type: 'notification_endpoint', id: endpoint.id },
      metadata: { channel: endpoint.channel, provider_kind: endpoint.provider_kind, status: endpoint.status }
    });
    return { data: { endpoint: projectEndpoint(endpoint) } };
  }

  const endpointMatch = routePath.match(/^\/api\/ivekit\/notifications\/endpoints\/([^/]+)$/);
  if (endpointMatch) {
    requireAdmin(auth);
    const endpointId = decodeSegment(endpointMatch[1]);
    if (method === 'GET') {
      const endpoint = await module.getEndpoint(auth.tenantId, endpointId);
      if (!endpoint) throw new NotificationError({ code: 'not_found', status: 404 });
      return { data: { endpoint: projectEndpoint(endpoint) } };
    }
    if (method === 'PUT') {
      const input = record(body);
      const endpoint = await module.updateEndpoint({
        tenant_id: auth.tenantId,
        endpoint_id: endpointId,
        actor: auth.userId,
        expected_revision: requiredInteger(input.expected_revision),
        patch: endpointPatch(input.patch)
      });
      await appendNotificationAudit(pg, headers, options, {
        auth,
        action: 'notification.endpoint.update',
        resource_type: 'notification_endpoint',
        resource_id: endpoint.id,
        business_ref: { type: 'notification_endpoint', id: endpoint.id },
        metadata: {
          channel: endpoint.channel,
          provider_kind: endpoint.provider_kind,
          status: endpoint.status,
          revision: endpoint.revision
        }
      });
      return { data: { endpoint: projectEndpoint(endpoint) } };
    }
  }

  const notificationMatch = routePath.match(/^\/api\/ivekit\/notifications\/([^/]+)$/);
  if (notificationMatch && method === 'GET') {
    requireWriter(auth);
    const notification = await module.getNotification(auth.tenantId, decodeSegment(notificationMatch[1]));
    if (!notification) throw new NotificationError({ code: 'not_found', status: 404 });
    return { data: { notification: projectNotification(notification) } };
  }

  return undefined;
}

async function checkNotificationCreateRateLimit(
  pg: PgQueryable | null,
  headers: Record<string, string | string[] | undefined>,
  options: RouteIveKitNotificationApiOptions,
  auth: AuthContext,
  recipientRef: string,
  targetRecipients: string[]
): Promise<void> {
  const configured = iveKitRateLimitConfiguration(options.env);
  if (!configured.enabled || options.rateLimiter === null) return;
  const limiter = options.rateLimiter || (pg
    ? configuredIveKitRateLimiter(pg, options.env)
    : null);
  if (!limiter) return;
  const recipients = [...new Set([recipientRef, ...targetRecipients])];
  await limiter.check({
    tenant_id: auth.tenantId,
    route_group: 'notification.create',
    dimensions: [
      {
        scope_type: 'tenant', key: auth.tenantId,
        limit: configured.notification_create.tenant_per_minute, window_seconds: 60
      },
      {
        scope_type: 'actor', key: auth.userId,
        limit: configured.notification_create.actor_per_minute, window_seconds: 60
      },
      {
        scope_type: 'source_ip', key: internalSourceIp(headers),
        limit: configured.notification_create.source_ip_per_minute, window_seconds: 60
      },
      ...recipients.map((recipient) => ({
        scope_type: 'recipient' as const,
        key: recipient,
        limit: configured.notification_create.recipient_per_minute,
        window_seconds: 60
      }))
    ]
  });
}

async function checkProviderReceiptRateLimit(
  pg: PgQueryable | null,
  headers: Record<string, string | string[] | undefined>,
  options: RouteIveKitNotificationApiOptions,
  tenantId: string,
  endpointId: string
): Promise<void> {
  const configured = iveKitRateLimitConfiguration(options.env);
  if (!configured.enabled || options.rateLimiter === null) return;
  const limiter = options.rateLimiter || (pg
    ? configuredIveKitRateLimiter(pg, options.env)
    : null);
  if (!limiter) return;
  await limiter.check({
    tenant_id: tenantId,
    route_group: 'notification.provider_receipt',
    dimensions: [
      {
        scope_type: 'tenant', key: tenantId,
        limit: configured.notification_provider_receipt.tenant_per_minute,
        window_seconds: 60
      },
      {
        scope_type: 'provider', key: endpointId,
        limit: configured.notification_provider_receipt.provider_per_minute,
        window_seconds: 60
      },
      {
        scope_type: 'source_ip', key: internalSourceIp(headers),
        limit: configured.notification_provider_receipt.source_ip_per_minute,
        window_seconds: 60
      }
    ]
  });
}

function internalSourceIp(
  headers: Record<string, string | string[] | undefined>
): string {
  return headerValue(headers, 'x-opc-source-ip') || 'unknown';
}

type NotificationAuditInput = Omit<
  IveKitAuditRequest,
  'tenant_id' | 'actor_id' | 'actor_role' | 'request_id' | 'idempotency_key'
  | 'result' | 'policy_decision' | 'source_ip'
> & ({ auth: AuthContext } | {
  tenant_id: string;
  actor_id: string;
  actor_role: 'provider';
});

async function appendNotificationAudit(
  pg: PgQueryable | null,
  headers: Record<string, string | string[] | undefined>,
  options: RouteIveKitNotificationApiOptions,
  input: NotificationAuditInput
): Promise<void> {
  const audit = options.audit === undefined
    ? (pg ? createPostgresIveKitAuditService(pg, options.env) : null)
    : options.audit;
  if (!audit) return;
  const actor = 'auth' in input
    ? {
        tenant_id: input.auth.tenantId,
        actor_id: input.auth.userId,
        actor_role: input.auth.role
      }
    : {
        tenant_id: input.tenant_id,
        actor_id: input.actor_id,
        actor_role: input.actor_role
      };
  const requestId = internalRequestId(headers);
  await audit.append({
    ...actor,
    action: input.action,
    resource_type: input.resource_type,
    resource_id: input.resource_id,
    business_ref: input.business_ref,
    metadata: input.metadata,
    request_id: requestId,
    idempotency_key: auditIdempotencyKey(actor.tenant_id, requestId, input.action, input.resource_id),
    result: 'succeeded',
    policy_decision: 'allow',
    source_ip: headerValue(headers, 'x-opc-source-ip') || undefined
  });
}

function appendTemplateAudit(
  pg: PgQueryable | null,
  headers: Record<string, string | string[] | undefined>,
  options: RouteIveKitNotificationApiOptions,
  auth: AuthContext,
  operation: 'create' | 'update' | 'publish',
  snapshot: NotificationTemplateSnapshot
): Promise<void> {
  return appendNotificationAudit(pg, headers, options, {
    auth,
    action: `notification.template.${operation}`,
    resource_type: 'notification_template',
    resource_id: snapshot.template.id,
    business_ref: { type: 'notification_template', id: snapshot.template.id },
    metadata: {
      template_key: snapshot.template.template_key,
      status: snapshot.template.status,
      revision: snapshot.version.revision,
      locale: snapshot.version.locale,
      channels: snapshot.version.channels
    }
  });
}

function internalRequestId(
  headers: Record<string, string | string[] | undefined>
): string {
  const value = headerValue(headers, 'x-opc-request-id') || headerValue(headers, 'x-request-id');
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : randomUUID();
}

function auditIdempotencyKey(
  tenantId: string,
  requestId: string,
  action: string,
  resourceId: string
): string {
  return createHash('sha256')
    .update(`${tenantId}\n${requestId}\n${action}\n${resourceId}`)
    .digest('hex');
}

export function createPostgresNotificationHttpModule(
  pg: PgQueryable,
  env: NodeJS.ProcessEnv = process.env
): NotificationHttpModule {
  const store = new PostgresNotificationStore(pg, {
    publish_event: publishNotificationTenantEvent
  });
  const renderer = new NotificationTemplateRenderer({ repository: store });
  const preferencePolicy = new NotificationPreferencePolicy({ repository: store });
  const notifications = new NotificationService({
    repository: store,
    protector: configuredNotificationProtector(env),
    prepare: async (input) => preferencePolicy.apply(await renderer.apply(input))
  });
  const endpoints = new NotificationEndpointService({ repository: store });
  const administration = new NotificationAdministrationService({ repository: store });
  const operations = new NotificationOperationsService(store);
  const receipts = new NotificationReceiptService({
    repository: store,
    secrets: configuredNotificationSecretResolver(env)
  });
  return {
    createNotification: (input) => notifications.create(input),
    getNotification: (tenantId, notificationId) => store.getNotification(tenantId, notificationId),
    listInbox: (input) => store.listInbox(input),
    countUnread: (tenantId, userId) => store.countUnread(tenantId, userId),
    mutateInbox: (input) => store.mutateInbox(input),
    createEndpoint: (input) => endpoints.create(input),
    getEndpoint: (tenantId, endpointId) => store.getEndpoint(tenantId, endpointId),
    listEndpoints: (input) => operations.listEndpoints(input),
    updateEndpoint: (input) => endpoints.update(input),
    createTemplate: (input) => administration.createTemplate(input),
    updateTemplate: (input) => administration.updateTemplate(input),
    publishTemplate: (input) => administration.publishTemplate(input),
    getTemplate: (tenantId, templateId) => store.getTemplate(tenantId, templateId),
    listTemplates: (input) => operations.listTemplates(input),
    listTemplateVersions: (input) => operations.listTemplateVersions(input),
    archiveTemplate: (input) => operations.archiveTemplate(input),
    getDelivery: (tenantId, deliveryId) => store.getDelivery(tenantId, deliveryId),
    listDeliveries: (input) => operations.listDeliveries(input),
    retryDelivery: (input) => operations.retryDelivery(input),
    listPreferences: (tenantId, userId) => administration.listPreferences(tenantId, userId),
    putPreference: (input) => administration.putPreference(input),
    receiveReceipt: (input) => receipts.receive(input)
  };
}

function notificationAuth(headers: Record<string, string | string[] | undefined>): AuthContext {
  let auth: AuthContext;
  try {
    auth = resolveAuthContext(headers);
  } catch {
    throw new NotificationError({ code: 'compliance_denied', status: 401 });
  }
  if (!auth.tenantId || !auth.userId || (auth.role === 'system' && auth.tenantId === 'system')) {
    throw new NotificationError({ code: 'compliance_denied', status: 403 });
  }
  return auth;
}

function requireWriter(auth: AuthContext): void {
  requireCapability(auth, 'notifications.create');
}

function requireAdmin(auth: AuthContext): void {
  requireCapability(auth, 'notifications.manage');
}

function requireCapability(auth: AuthContext, capability: IveKitCapability): void {
  if (!iveKitCapabilityAllowed(auth, capability)) {
    throw new NotificationError({ code: 'compliance_denied', status: 403 });
  }
}

function inboxUser(auth: AuthContext, url: URL): string {
  if (iveKitCapabilityAllowed(auth, 'notifications.inbox.other')) {
    return url.searchParams.get('user_id')?.trim() || auth.userId;
  }
  return auth.userId;
}

function projectCreateResult(result: NotificationCreateResult): Record<string, unknown> {
  return {
    created: result.created,
    notification: projectNotification(result.notification),
    deliveries: result.deliveries.map(projectDelivery)
  };
}

function projectDelivery(delivery: NotificationDeliveryRecord): Record<string, unknown> {
  return {
    id: delivery.id,
    notification_id: delivery.notification_id,
    channel: delivery.channel,
    endpoint_id: delivery.endpoint_id,
    provider_kind: delivery.provider_kind,
    provider_profile_id: delivery.provider_profile_id,
    recipient_redacted: delivery.recipient_redacted,
    state: delivery.state,
    attempt_count: delivery.attempt_count,
    max_attempts: delivery.max_attempts,
    next_attempt_at: delivery.next_attempt_at,
    provider_request_id: delivery.provider_request_id,
    provider_message_id: delivery.provider_message_id,
    provider_receipt_projection: delivery.provider_receipt_projection,
    error_code: delivery.error_code,
    error_projection: delivery.error_projection,
    created_at: delivery.created_at,
    updated_at: delivery.updated_at,
    accepted_at: delivery.accepted_at,
    delivered_at: delivery.delivered_at,
    completed_at: delivery.completed_at
  };
}

function projectNotification(notification: NotificationRecord): Record<string, unknown> {
  return {
    id: notification.id,
    tenant_id: notification.tenant_id,
    event_type: notification.event_type,
    recipient_kind: notification.recipient_kind,
    recipient_ref: notification.recipient_ref,
    channels: notification.channels,
    locale: notification.locale,
    template_id: notification.template_id,
    template_revision: notification.template_revision,
    content_projection: notification.content_projection,
    priority: notification.priority,
    force_delivery: notification.force_delivery,
    business_ref: { type: notification.business_ref_type, id: notification.business_ref_id },
    requested_by: notification.requested_by,
    correlation_id: notification.correlation_id,
    state: notification.state,
    scheduled_at: notification.scheduled_at,
    retention_until: notification.retention_until,
    created_at: notification.created_at,
    updated_at: notification.updated_at,
    completed_at: notification.completed_at
  };
}

function projectEndpoint(endpoint: NotificationEndpoint): Record<string, unknown> {
  return {
    id: endpoint.id,
    tenant_id: endpoint.tenant_id,
    name: endpoint.name,
    channel: endpoint.channel,
    provider_kind: endpoint.provider_kind,
    status: endpoint.status,
    endpoint_url: endpoint.endpoint_url,
    secret_configured: Boolean(endpoint.secret_ref),
    signing_secret_configured: Boolean(endpoint.signing_secret_ref),
    event_allowlist: endpoint.event_allowlist,
    config: endpoint.config,
    failover_group: endpoint.failover_group,
    priority: endpoint.priority,
    quota_per_minute: endpoint.quota_per_minute,
    quota_per_day: endpoint.quota_per_day,
    health_status: endpoint.health_status,
    last_health_at: endpoint.last_health_at,
    revision: endpoint.revision,
    created_by: endpoint.created_by,
    updated_by: endpoint.updated_by,
    created_at: endpoint.created_at,
    updated_at: endpoint.updated_at
  };
}

function projectTemplateSnapshot(snapshot: NotificationTemplateSnapshot): Record<string, unknown> {
  return { template: snapshot.template, version: snapshot.version };
}

function recipientInput(value: unknown): CreateNotificationInput['recipient'] {
  const input = record(value);
  return {
    kind: requiredString(input.kind, 20) as CreateNotificationInput['recipient']['kind'],
    ref: requiredString(input.ref, 255)
  };
}

function receiptPayloadInput(value: unknown): NotificationReceiptPayload {
  const input = record(value);
  const allowed = new Set(['provider_event_id', 'delivery_id', 'status', 'occurred_at', 'projection']);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw validationError();
  return {
    provider_event_id: requiredString(input.provider_event_id, 255),
    delivery_id: requiredString(input.delivery_id, 255),
    status: requiredString(input.status, 20) as NotificationReceiptPayload['status'],
    ...(input.occurred_at === undefined
      ? {}
      : { occurred_at: requiredString(input.occurred_at, 64) }),
    ...(input.projection === undefined ? {} : { projection: record(input.projection) })
  };
}

function targetInputs(value: unknown): CreateNotificationInput['targets'] {
  if (!Array.isArray(value)) throw validationError();
  return value.map((item) => {
    const input = record(item);
    return {
      channel: requiredString(input.channel, 20) as CreateNotificationInput['targets'][number]['channel'],
      recipient: requiredString(input.recipient, 2048),
      ...(input.endpoint_id === undefined ? {} : { endpoint_id: requiredString(input.endpoint_id, 255) })
    };
  });
}

function businessRefInput(value: unknown): CreateNotificationInput['business_ref'] {
  const input = record(value);
  return { type: requiredString(input.type, 100), id: requiredString(input.id, 255) };
}

function templateInput(value: unknown): CreateNotificationInput['template'] {
  if (value === undefined || value === null) return undefined;
  const input = record(value);
  return { id: requiredString(input.id, 255), revision: requiredInteger(input.revision) };
}

function endpointPatch(value: unknown): UpdateNotificationEndpointInput['patch'] {
  const input = record(value);
  const output: Record<string, unknown> = {};
  for (const key of [
    'name', 'status', 'endpoint_url', 'secret_ref', 'signing_secret_ref',
    'event_allowlist', 'config', 'failover_group', 'priority',
    'quota_per_minute', 'quota_per_day'
  ]) {
    if (Object.prototype.hasOwnProperty.call(input, key)) output[key] = input[key];
  }
  return output as UpdateNotificationEndpointInput['patch'];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validationError();
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value === undefined ? undefined : record(value);
}

function requiredString(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw validationError();
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : String(value);
}

function nullableString(value: unknown): string | null | undefined {
  return value === undefined ? undefined : value === null ? null : String(value);
}

function requiredInteger(value: unknown): number {
  const number = Number(value);
  if (!Number.isInteger(number)) throw validationError();
  return number;
}

function optionalInteger(value: unknown): number | undefined {
  return value === undefined ? undefined : requiredInteger(value);
}

function optionalNullableInteger(value: unknown): number | null | undefined {
  return value === undefined ? undefined : value === null ? null : requiredInteger(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw validationError();
  return value.map(String);
}

function channelArray(value: unknown): CreateNotificationTemplateInput['channels'] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw validationError();
  return value.map((item) => notificationChannel(item));
}

function notificationChannel(value: string): PutNotificationPreferenceInput['channel'] {
  if (!['in_app', 'webhook', 'email', 'sms'].includes(value)) throw validationError();
  return value as PutNotificationPreferenceInput['channel'];
}

function endpointChannelQuery(value: string | null): NotificationEndpointListInput['channel'] {
  if (!value) return undefined;
  if (!['webhook', 'email', 'sms'].includes(value)) throw validationError();
  return value as NotificationEndpointListInput['channel'];
}

function endpointStatusQuery(value: string | null): NotificationEndpointListInput['status'] {
  if (!value) return undefined;
  if (!['active', 'paused', 'degraded', 'disabled', 'archived'].includes(value)) {
    throw validationError();
  }
  return value as NotificationEndpointListInput['status'];
}

function templateStatusQuery(value: string | null): NotificationTemplateListInput['status'] {
  if (!value) return undefined;
  if (!['draft', 'published', 'archived'].includes(value)) throw validationError();
  return value as NotificationTemplateListInput['status'];
}

function channelQuery(value: string | null): NotificationDeliveryListInput['channel'] {
  if (!value) return undefined;
  if (!['in_app', 'webhook', 'email', 'sms'].includes(value)) throw validationError();
  return value as NotificationDeliveryListInput['channel'];
}

function deliveryStateQuery(value: string | null): NotificationDeliveryListInput['state'] {
  if (!value) return undefined;
  if (![
    'pending', 'processing', 'accepted', 'retry_wait', 'uncertain',
    'delivered', 'failed', 'cancelled', 'dead_letter'
  ].includes(value)) throw validationError();
  return value as NotificationDeliveryListInput['state'];
}

function retryableDeliveryState(value: unknown): 'failed' | 'dead_letter' | 'uncertain' {
  if (!['failed', 'dead_letter', 'uncertain'].includes(String(value))) throw validationError();
  return value as 'failed' | 'dead_letter' | 'uncertain';
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw validationError();
  return value;
}

function queryInteger(url: URL, key: string): number | undefined {
  const value = url.searchParams.get(key);
  return value === null ? undefined : requiredInteger(value);
}

function requireIdempotencyKey(headers: Record<string, string | string[] | undefined>): string {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === 'idempotency-key');
  const value = Array.isArray(found?.[1]) ? found?.[1][0] : found?.[1];
  return requiredString(value, 128);
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  key: string
): string {
  const found = Object.entries(headers).find(([name]) => name.toLowerCase() === key.toLowerCase());
  return String(Array.isArray(found?.[1]) ? found?.[1][0] : found?.[1] || '');
}

function decodeSegment(value: string | undefined): string {
  try {
    const decoded = decodeURIComponent(String(value || ''));
    return requiredString(decoded, 255);
  } catch {
    throw validationError();
  }
}

function requiredPg(pg: PgQueryable | null): PgQueryable {
  if (!pg) throw new NotificationError({ code: 'provider_unavailable', retryable: true, status: 503 });
  return pg;
}

function validationError(): NotificationError {
  return new NotificationError({ code: 'validation_failed', status: 422 });
}
