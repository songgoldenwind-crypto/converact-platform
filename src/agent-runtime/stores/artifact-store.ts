import { all, id, json, one, parseJson, run } from '../../db.js';
import type { HookManagerLike } from '../context/runtime-types.js';
import type {
  ArtifactCommitInput,
  ArtifactListInput,
  ArtifactRecord,
  ArtifactReviewDecision,
  ArtifactReviewInput,
  ArtifactReviewRecord,
  AuditStoreLike
} from '../runtime-domain-types.js';

export class ArtifactStore {
  db: unknown;
  runStore: AuditStoreLike | null;
  hookManager: HookManagerLike | null;

  constructor(db: unknown, runStore: AuditStoreLike | null, hookManager: HookManagerLike | null = null) {
    this.db = db;
    this.runStore = runStore;
    this.hookManager = hookManager;
  }

  commit(input: ArtifactCommitInput): ArtifactRecord | null {
    this.hookManager?.runSync?.('before_artifact_commit', { input });
    const artifact = {
      id: id('art'),
      tenant_id: input.tenant_id,
      workflow_run_id: input.workflow_run_id || null,
      agent_run_id: input.agent_run_id || null,
      type: input.type,
      status: input.status || 'draft',
      version: input.version || 1,
      payload: input.payload || {},
      quality_score: input.quality_score ?? null,
      parent_artifact_id: input.parent_artifact_id || null
    };
    run(
      this.db,
      `INSERT INTO agent_artifacts
        (id, tenant_id, workflow_run_id, agent_run_id, type, status, version, payload, quality_score, parent_artifact_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        artifact.id,
        artifact.tenant_id,
        artifact.workflow_run_id,
        artifact.agent_run_id,
        artifact.type,
        artifact.status,
        artifact.version,
        json(artifact.payload),
        artifact.quality_score,
        artifact.parent_artifact_id
      ]
    );
    this.runStore?.audit(artifact.tenant_id, 'artifact.committed', 'agent_artifact', artifact.id, artifact);
    const committed = this.get(artifact.tenant_id, artifact.id);
    this.hookManager?.runSync?.('after_artifact_commit', { artifact: committed });
    return committed;
  }

  get(tenantId: string, artifactId: string): ArtifactRecord | null {
    const row = one(this.db, 'SELECT * FROM agent_artifacts WHERE tenant_id = ? AND id = ?', [tenantId, artifactId]);
    return row ? ({ ...row, payload: parseJson(row.payload) } as ArtifactRecord) : null;
  }

  list(input: ArtifactListInput): ArtifactRecord[] {
    const clauses = ['tenant_id = ?'];
    const params: Array<string | number> = [input.tenant_id];
    if (input.status) {
      clauses.push('status = ?');
      params.push(input.status);
    }
    if (input.type) {
      clauses.push('type = ?');
      params.push(input.type);
    }
    if (input.workflow_run_id) {
      clauses.push('workflow_run_id = ?');
      params.push(input.workflow_run_id);
    }
    if (input.agent_run_id) {
      clauses.push('agent_run_id = ?');
      params.push(input.agent_run_id);
    }
    if (input.parent_artifact_id) {
      clauses.push('parent_artifact_id = ?');
      params.push(input.parent_artifact_id);
    }
    params.push(input.limit || 100);
    return all(
      this.db,
      `SELECT * FROM agent_artifacts
       WHERE ${clauses.join(' AND ')}
       ORDER BY updated_at DESC, created_at DESC
        LIMIT ?`,
      params
    ).map((row) => ({ ...row, payload: parseJson(row.payload) } as ArtifactRecord));
  }

  listForAgentRun(tenantId: string, agentRunId: string): ArtifactRecord[] {
    return all(this.db, 'SELECT * FROM agent_artifacts WHERE tenant_id = ? AND agent_run_id = ? ORDER BY created_at ASC', [
      tenantId,
      agentRunId
    ]).map((row) => ({ ...row, payload: parseJson(row.payload) } as ArtifactRecord));
  }

  listReviews(tenantId: string, artifactId: string): ArtifactReviewRecord[] {
    return all(
      this.db,
      'SELECT * FROM artifact_reviews WHERE tenant_id = ? AND artifact_id = ? ORDER BY created_at DESC',
      [tenantId, artifactId]
    ).map((row) => ({ ...row, metadata: parseJson(row.metadata) } as ArtifactReviewRecord));
  }

  review(input: ArtifactReviewInput): { artifact: ArtifactRecord | null; review: ArtifactReviewRecord } {
    if (!input.tenant_id) throw new Error('tenant_id is required');
    if (!input.artifact_id) throw new Error('artifact_id is required');
    if (!input.decision) throw new Error('decision is required');
    const artifact = this.get(input.tenant_id, input.artifact_id);
    if (!artifact) throw new Error(`artifact not found: ${input.artifact_id}`);
    const nextStatus = resolveReviewStatus(input.decision, input.to_status);
    run(
      this.db,
      `UPDATE agent_artifacts
       SET status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ? AND id = ?`,
      [nextStatus, input.tenant_id, input.artifact_id]
    );
    const review = {
      id: id('artrev'),
      tenant_id: input.tenant_id,
      artifact_id: input.artifact_id,
      decision: input.decision,
      from_status: artifact.status,
      to_status: nextStatus,
      review_notes: input.review_notes || '',
      metadata: input.metadata || {},
      created_by: input.actor_id || 'system'
    };
    run(
      this.db,
      `INSERT INTO artifact_reviews
        (id, tenant_id, artifact_id, decision, from_status, to_status, review_notes, metadata, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        review.id,
        review.tenant_id,
        review.artifact_id,
        review.decision,
        review.from_status,
        review.to_status,
        review.review_notes,
        json(review.metadata),
        review.created_by
      ]
    );
    this.runStore?.audit(input.tenant_id, 'artifact.reviewed', 'agent_artifact', input.artifact_id, {
      decision: review.decision,
      from_status: review.from_status,
      to_status: review.to_status,
      review_notes: review.review_notes
    }, review.created_by);
    return {
      artifact: this.get(input.tenant_id, input.artifact_id),
      review: {
        ...review,
        metadata: review.metadata
      }
    };
  }
}

function resolveReviewStatus(decision: ArtifactReviewDecision, explicitStatus?: string | null): string {
  if (explicitStatus) return explicitStatus;
  if (decision === 'approve') return 'approved';
  if (decision === 'reject') return 'rejected';
  if (decision === 'publish') return 'published';
  if (decision === 'archive') return 'archived';
  if (decision === 'request_changes') return 'draft';
  throw new Error(`unsupported artifact review decision: ${decision}`);
}
