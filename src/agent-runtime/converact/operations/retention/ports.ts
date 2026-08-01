import type {
  ConveractFabricRetentionClaim,
  ConveractFabricRetentionDeletionSummary,
  ConveractFabricRetentionPolicy,
  ConveractFabricRetentionPolicyWrite,
  ConveractFabricLegalHold,
  ConveractFabricLegalHoldCreateInput
} from './types.js';

export interface ConveractFabricRetentionRepository {
  listDueTenantIds(limit: number): Promise<string[]>;
  claimDue(input: {
    tenant_id: string;
    worker_id: string;
    lease_ms: number;
    limit: number;
    now: string;
  }): Promise<ConveractFabricRetentionClaim[]>;
  deleteExpired(claim: ConveractFabricRetentionClaim): Promise<ConveractFabricRetentionDeletionSummary>;
  completeRun(input: {
    claim: ConveractFabricRetentionClaim;
    outcome: 'completed' | 'failed';
    summary: ConveractFabricRetentionDeletionSummary;
    error_code: string;
    now: string;
  }): Promise<void>;
}

export interface ConveractFabricRetentionCategoryHandler {
  deleteExpired(claim: ConveractFabricRetentionClaim): Promise<ConveractFabricRetentionDeletionSummary>;
}

export interface ConveractFabricRetentionPolicyRepository {
  listPolicies(tenantId: string): Promise<ConveractFabricRetentionPolicy[]>;
  putPolicy(input: ConveractFabricRetentionPolicyWrite): Promise<ConveractFabricRetentionPolicy>;
  listLegalHolds(input: {
    tenant_id: string;
    category?: string;
    status?: 'active' | 'released';
  }): Promise<ConveractFabricLegalHold[]>;
  placeLegalHold(input: ConveractFabricLegalHoldCreateInput): Promise<{ hold: ConveractFabricLegalHold; created: boolean }>;
  releaseLegalHold(input: {
    tenant_id: string;
    hold_id: string;
    actor: string;
    now: string;
  }): Promise<ConveractFabricLegalHold>;
}
