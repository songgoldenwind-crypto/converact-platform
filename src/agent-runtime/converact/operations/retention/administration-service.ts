import type { ConveractFabricRetentionPolicyRepository } from './ports.js';
import { ConveractFabricRetentionError } from './errors.js';
import type {
  ConveractFabricLegalHold,
  ConveractFabricLegalHoldCreateInput,
  ConveractFabricRetentionCategory,
  ConveractFabricRetentionPolicy,
  ConveractFabricRetentionPolicyWrite
} from './types.js';

export class ConveractFabricRetentionAdministrationService {
  constructor(
    private readonly repository: ConveractFabricRetentionPolicyRepository,
    private readonly now: () => Date = () => new Date()
  ) {}

  listPolicies(tenantId: string): Promise<ConveractFabricRetentionPolicy[]> {
    return this.repository.listPolicies(requiredText(tenantId, 255));
  }

  putPolicy(input: Omit<ConveractFabricRetentionPolicyWrite, 'now'>): Promise<ConveractFabricRetentionPolicy> {
    return this.repository.putPolicy({
      tenant_id: requiredText(input.tenant_id, 255),
      category: category(input.category),
      enabled: boolean(input.enabled),
      retention_days: integer(input.retention_days, 1, 3650),
      batch_size: integer(input.batch_size, 1, 1000),
      interval_seconds: integer(input.interval_seconds, 60, 86400),
      expected_revision: integer(input.expected_revision, 0, 1_000_000_000),
      actor: requiredText(input.actor, 255),
      now: this.now().toISOString()
    });
  }

  listLegalHolds(input: {
    tenant_id: string;
    category?: string;
    status?: 'active' | 'released';
  }): Promise<ConveractFabricLegalHold[]> {
    return this.repository.listLegalHolds({
      tenant_id: requiredText(input.tenant_id, 255),
      category: input.category === undefined ? undefined : category(input.category),
      status: input.status === undefined ? undefined : holdStatus(input.status)
    });
  }

  placeLegalHold(
    input: Omit<ConveractFabricLegalHoldCreateInput, 'now'>
  ): Promise<{ hold: ConveractFabricLegalHold; created: boolean }> {
    return this.repository.placeLegalHold({
      tenant_id: requiredText(input.tenant_id, 255),
      category: category(input.category),
      resource_type: requiredText(input.resource_type, 100),
      resource_id: requiredText(input.resource_id, 255),
      reason_code: safeCode(input.reason_code),
      idempotency_key: requiredText(input.idempotency_key, 255),
      actor: requiredText(input.actor, 255),
      now: this.now().toISOString()
    });
  }

  releaseLegalHold(input: {
    tenant_id: string;
    hold_id: string;
    actor: string;
  }): Promise<ConveractFabricLegalHold> {
    return this.repository.releaseLegalHold({
      tenant_id: requiredText(input.tenant_id, 255),
      hold_id: requiredText(input.hold_id, 255),
      actor: requiredText(input.actor, 255),
      now: this.now().toISOString()
    });
  }
}

const CATEGORIES = new Set([
  'notifications', 'audit', 'rate_limit_buckets', 'secure_files',
  'media_recordings', 'tenant_events'
]);

function category(value: unknown): ConveractFabricRetentionCategory {
  if (!CATEGORIES.has(String(value))) throw validationError();
  return value as ConveractFabricRetentionCategory;
}

function holdStatus(value: unknown): 'active' | 'released' {
  if (value !== 'active' && value !== 'released') throw validationError();
  return value;
}

function requiredText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) {
    throw validationError();
  }
  return value.trim();
}

function safeCode(value: unknown): string {
  const result = requiredText(value, 100);
  if (!/^[a-z0-9_.-]+$/.test(result)) throw validationError();
  return result;
}

function integer(value: unknown, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw validationError();
  return number;
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw validationError();
  return value;
}

function validationError(): Error {
  return new ConveractFabricRetentionError('validation_failed', 422);
}
