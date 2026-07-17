import type {
  IveKitRetentionClaim,
  IveKitRetentionDeletionSummary,
  IveKitRetentionPolicy,
  IveKitRetentionPolicyWrite,
  IveKitLegalHold,
  IveKitLegalHoldCreateInput
} from './types.js';

export interface IveKitRetentionRepository {
  listDueTenantIds(limit: number): Promise<string[]>;
  claimDue(input: {
    tenant_id: string;
    worker_id: string;
    lease_ms: number;
    limit: number;
    now: string;
  }): Promise<IveKitRetentionClaim[]>;
  deleteExpired(claim: IveKitRetentionClaim): Promise<IveKitRetentionDeletionSummary>;
  completeRun(input: {
    claim: IveKitRetentionClaim;
    outcome: 'completed' | 'failed';
    summary: IveKitRetentionDeletionSummary;
    error_code: string;
    now: string;
  }): Promise<void>;
}

export interface IveKitRetentionCategoryHandler {
  deleteExpired(claim: IveKitRetentionClaim): Promise<IveKitRetentionDeletionSummary>;
}

export interface IveKitRetentionPolicyRepository {
  listPolicies(tenantId: string): Promise<IveKitRetentionPolicy[]>;
  putPolicy(input: IveKitRetentionPolicyWrite): Promise<IveKitRetentionPolicy>;
  listLegalHolds(input: {
    tenant_id: string;
    category?: string;
    status?: 'active' | 'released';
  }): Promise<IveKitLegalHold[]>;
  placeLegalHold(input: IveKitLegalHoldCreateInput): Promise<{ hold: IveKitLegalHold; created: boolean }>;
  releaseLegalHold(input: {
    tenant_id: string;
    hold_id: string;
    actor: string;
    now: string;
  }): Promise<IveKitLegalHold>;
}
