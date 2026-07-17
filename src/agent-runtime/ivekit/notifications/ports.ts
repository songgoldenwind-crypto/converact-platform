import type {
  CreateNotificationRecord,
  NotificationCreateResult,
  NotificationDeliveryClaimInput,
  NotificationDeliveryFinishInput,
  NotificationDeliveryRecord,
  NotificationRecord,
  NotificationChannel,
  NotificationInboxItem,
  NotificationInboxListInput,
  NotificationInboxMutationInput,
  NotificationPage,
  NotificationEndpoint,
  NotificationEndpointChannel,
  NotificationEndpointCreateResult,
  NotificationPreference,
  NotificationReceipt,
  NotificationReceiptReconciliation,
  NotificationEndpointReservation,
  RecordNotificationEndpointResultInput,
  ReserveNotificationEndpointInput,
  NotificationTemplate,
  NotificationTemplateSnapshot,
  NotificationTemplateVersion
} from './types.js';

export interface NotificationRepository {
  create(input: CreateNotificationRecord): Promise<NotificationCreateResult>;
}

export interface NotificationDeliveryRepository extends NotificationRepository {
  listWorkerTenants(
    now: Date,
    limit: number,
    shardIds?: readonly number[]
  ): Promise<string[]>;
  claimDue(input: NotificationDeliveryClaimInput): Promise<NotificationDeliveryRecord[]>;
  getNotification(tenantId: string, notificationId: string): Promise<NotificationRecord | null>;
  finishDelivery(input: NotificationDeliveryFinishInput): Promise<NotificationDeliveryRecord>;
}

export type NotificationProviderDeliveryStatus =
  | 'accepted'
  | 'delivered'
  | 'retryable_failure'
  | 'terminal_failure'
  | 'uncertain';

export interface NotificationProviderDeliveryResult {
  status: NotificationProviderDeliveryStatus;
  provider_request_id?: string;
  provider_message_id?: string;
  receipt?: Readonly<Record<string, unknown>>;
  error_code?: string;
  error?: Readonly<Record<string, unknown>>;
  retry_after_ms?: number;
}

export interface NotificationProviderDeliveryInput {
  notification: NotificationRecord;
  delivery: NotificationDeliveryRecord;
  recipient: string;
  payload: unknown;
}

export interface NotificationDeliveryProvider {
  kind: string;
  profile_id?: string;
  channel: NotificationChannel;
  deliver(input: NotificationProviderDeliveryInput): Promise<NotificationProviderDeliveryResult>;
}

export type NotificationProviderResolver = (
  delivery: NotificationDeliveryRecord,
  notification: NotificationRecord
) => Promise<NotificationDeliveryProvider>;

export interface NotificationInboxRepository {
  upsertInboxItem(item: NotificationInboxItem): Promise<NotificationInboxItem>;
  listInbox(input: NotificationInboxListInput): Promise<NotificationPage<NotificationInboxItem>>;
  countUnread(tenantId: string, userId: string): Promise<number>;
  mutateInbox(input: NotificationInboxMutationInput): Promise<NotificationInboxItem | null>;
}

export interface NotificationEndpointRepository {
  getEndpoint(tenantId: string, endpointId: string): Promise<NotificationEndpoint | null>;
  listActiveEndpoints(
    tenantId: string,
    channel: NotificationEndpointChannel
  ): Promise<NotificationEndpoint[]>;
}

export interface NotificationEndpointAdminRepository extends NotificationEndpointRepository {
  insertEndpoint(endpoint: NotificationEndpoint): Promise<NotificationEndpointCreateResult>;
  updateEndpoint(endpoint: NotificationEndpoint, expectedRevision: number): Promise<NotificationEndpoint>;
}

export interface NotificationAdministrationRepository {
  createTemplate(
    template: NotificationTemplate,
    version: NotificationTemplateVersion
  ): Promise<NotificationTemplateSnapshot | null>;
  getTemplate(tenantId: string, templateId: string): Promise<NotificationTemplate | null>;
  getTemplateByKey(tenantId: string, templateKey: string): Promise<NotificationTemplate | null>;
  getTemplateVersion(
    tenantId: string,
    templateId: string,
    revision: number,
    locale: string
  ): Promise<NotificationTemplateVersion | null>;
  appendTemplateVersion(
    template: NotificationTemplate,
    version: NotificationTemplateVersion,
    expectedRevision: number
  ): Promise<NotificationTemplateSnapshot | null>;
  listPreferences(tenantId: string, userId: string): Promise<NotificationPreference[]>;
  putPreference(
    preference: NotificationPreference,
    expectedRevision: number
  ): Promise<NotificationPreference | null>;
}

export interface NotificationReceiptRepository {
  getEndpoint(tenantId: string, endpointId: string): Promise<NotificationEndpoint | null>;
  getDelivery(tenantId: string, deliveryId: string): Promise<NotificationDeliveryRecord | null>;
  insertReceipt(
    receipt: NotificationReceipt
  ): Promise<{ receipt: NotificationReceipt; created: boolean } | null>;
  reconcileReceipt(receipt: NotificationReceipt): Promise<NotificationReceiptReconciliation>;
}

export interface NotificationReceiptReconciliationRepository {
  listReceiptTenants(limit: number): Promise<string[]>;
  listPendingReceipts(tenantId: string, limit: number): Promise<NotificationReceipt[]>;
  reconcileReceipt(receipt: NotificationReceipt): Promise<NotificationReceiptReconciliation>;
}

export interface NotificationEndpointGovernanceRepository {
  reserveEndpoint(input: ReserveNotificationEndpointInput): Promise<NotificationEndpointReservation>;
  recordEndpointResult(input: RecordNotificationEndpointResultInput): Promise<void>;
}

export interface NotificationSecretResolver {
  resolve(ref: string, purpose: 'webhook_signing' | 'provider_credential'): Promise<string>;
}

export interface NotificationContentProtector {
  protectContent(
    tenantId: string,
    content: unknown
  ): Promise<{ ciphertext: string; hash: string }>;
  revealContent(tenantId: string, ciphertext: string): Promise<unknown>;
  protectRecipient(
    tenantId: string,
    channel: import('./types.js').NotificationChannel,
    recipient: string
  ): Promise<{ ciphertext: string; hmac: string; redacted: string }>;
  revealRecipient(
    tenantId: string,
    channel: import('./types.js').NotificationChannel,
    ciphertext: string
  ): Promise<string>;
}
