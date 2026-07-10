import { all, id, json, one, parseJson, run } from '../../db.js';
import type { JsonRecord } from '../integrations/provider-runtime-types.js';
import type { AuditStoreLike } from '../runtime-domain-types.js';

interface GeoStoreLike {
  getPlace: (tenantId: string, placeId: string) => JsonRecord | null;
  getInsight: (tenantId: string, insightId: string) => JsonRecord | null;
  getLatestInsight: (tenantId: string, placeId: string) => JsonRecord | null;
}

interface ArtifactStoreLike {
  commit?: (input: JsonRecord) => JsonRecord;
}

function ensureTenant(input: JsonRecord): void {
  if (!input?.tenant_id) {
    throw new Error('tenant_id is required');
  }
}

function normalizeWorkspaceId(input: JsonRecord): string {
  return input.workspace_id || 'default';
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map((entry) => String(entry || '').trim()).filter(Boolean)));
  }
  if (typeof value === 'string') {
    return Array.from(new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean)));
  }
  return [];
}

function decodeTerritory(row: JsonRecord | null | undefined): JsonRecord | null {
  if (!row) {
    return null;
  }
  return {
    ...row,
    metadata: parseJson(row.metadata, {})
  };
}

function decodeCoverage(row: JsonRecord | null | undefined): JsonRecord | null {
  if (!row) {
    return null;
  }
  return {
    ...row,
    metadata: parseJson(row.metadata, {})
  };
}

function decodeRoutingPolicy(row: JsonRecord | null | undefined): JsonRecord | null {
  if (!row) {
    return null;
  }
  return {
    ...row,
    dry_run: Boolean(row.dry_run),
    auto_bootstrap: Boolean(row.auto_bootstrap),
    territory_include_ids: normalizeStringList(parseJson(row.territory_include_ids, [])),
    territory_exclude_ids: normalizeStringList(parseJson(row.territory_exclude_ids, [])),
    paused_until: row.paused_until || null,
    pause_reason: row.pause_reason || '',
    last_rollout_at: row.last_rollout_at || null,
    last_rollout_snapshot: parseJson(row.last_rollout_snapshot, {}),
    metadata: parseJson(row.metadata, {})
  };
}

function decodeRoutingPolicyOverride(row: JsonRecord | null | undefined): JsonRecord | null {
  if (!row) {
    return null;
  }
  return {
    ...row,
    requested_patch: parseJson(row.requested_patch, {}),
    before_policy: parseJson(row.before_policy, {}),
    after_policy: parseJson(row.after_policy, {}),
    before_preview: parseJson(row.before_preview, {}),
    after_preview: parseJson(row.after_preview, {}),
    diff_summary: parseJson(row.diff_summary, {}),
    rollout_result: parseJson(row.rollout_result, {})
  };
}

function decodeRoutingPolicyReviewState(row: JsonRecord | null | undefined): JsonRecord | null {
  if (!row) {
    return null;
  }
  return {
    ...row,
    metadata: parseJson(row.metadata, {})
  };
}

function decodeRoutingPolicyActionHistory(row: JsonRecord | null | undefined): JsonRecord | null {
  if (!row) {
    return null;
  }
  return {
    ...row,
    result: parseJson(row.result, {}),
    item_snapshot: parseJson(row.item_snapshot, {}),
    metadata: parseJson(row.metadata, {})
  };
}

function decodeRoutingPolicyBatchPlan(row: JsonRecord | null | undefined): JsonRecord | null {
  if (!row) {
    return null;
  }
  return {
    ...row,
    items: parseJson(row.items, []),
    selection_summary: parseJson(row.selection_summary, {}),
    preview: parseJson(row.preview, {}),
    metadata: parseJson(row.metadata, {})
  };
}

function decodeDraft(row: JsonRecord | null | undefined): JsonRecord | null {
  if (!row) {
    return null;
  }
  return {
    ...row,
    personalization_points: parseJson(row.personalization_points, [])
  };
}

function decodeHandoff(row: JsonRecord | null | undefined): JsonRecord | null {
  if (!row) {
    return null;
  }
  return {
    ...row,
    payload: parseJson(row.payload, {})
  };
}

function decodeApproval(row: JsonRecord | null | undefined): JsonRecord | null {
  if (!row) {
    return null;
  }
  return {
    ...row,
    payload: parseJson(row.payload, {})
  };
}

function decodeToolCall(row: JsonRecord | null | undefined): JsonRecord | null {
  if (!row) {
    return null;
  }
  return {
    ...row,
    input: parseJson(row.input, {}),
    output: parseJson(row.output, {}),
    error: parseJson(row.error, null)
  };
}

function decodeCallLog(row: JsonRecord | null | undefined): JsonRecord | null {
  if (!row) {
    return null;
  }
  return {
    ...row,
    result: parseJson(row.result, {})
  };
}

function decodeCallSession(row: JsonRecord | null | undefined): JsonRecord | null {
  if (!row) {
    return null;
  }
  return {
    ...row,
    metadata: parseJson(row.metadata, {})
  };
}

function normalizeChannel(input: JsonRecord, draft: JsonRecord | null, coverage: JsonRecord | null, territory: JsonRecord | null): string {
  return input.channel
    || draft?.channel
    || (coverage?.channel && coverage.channel !== 'any' ? coverage.channel : null)
    || territory?.default_channel
    || 'call_script';
}

function urgencyRank(urgency: unknown): number {
  if (urgency === 'critical') return 4;
  if (urgency === 'high') return 3;
  if (urgency === 'medium') return 2;
  return 1;
}

function determinePriorityTier(input: JsonRecord, territory: JsonRecord | null, insight: JsonRecord | null): string {
  if (input.priority_tier) {
    return input.priority_tier;
  }
  const maxUrgency = Array.isArray(insight?.pain_signals)
    ? Math.max(0, ...insight.pain_signals.map((signal: JsonRecord) => urgencyRank(signal?.urgency)))
    : 0;
  if (maxUrgency >= 3) return 'P0';
  if (maxUrgency === 2) return 'P1';
  return territory?.priority_tier || 'P1';
}

function buildSummary(place: JsonRecord, territory: JsonRecord | null, coverage: JsonRecord | null, insight: JsonRecord | null): string {
  const placeLabel = [place.name, place.city].filter(Boolean).join(' / ');
  const territoryLabel = territory?.name || 'default territory';
  const ownerLabel = coverage?.owner_name || coverage?.owner_user_id || territory?.default_owner_user_id || 'unassigned owner';
  const painSummary = insight?.summary || 'No structured pain insight yet.';
  return `${placeLabel} -> ${territoryLabel} -> ${ownerLabel}. ${painSummary}`;
}

function territoryScore(place: JsonRecord, territory: JsonRecord): number {
  let score = 0;
  if (!territory) return score;
  if (territory.city && territory.city === place.city) score += 4;
  if (territory.region && territory.region === place.region) score += 2;
  if (territory.country_code && territory.country_code === place.country_code) score += 1;
  if (territory.business_type && territory.business_type === place.business_type) score += 3;
  return score;
}

function coverageScore(coverage: JsonRecord, requestedChannel: string): number {
  let score = Number(coverage.priority_weight || 0);
  if (!coverage.channel || coverage.channel === 'any') score += 1;
  if (coverage.channel === requestedChannel) score += 4;
  const dailyCapacity = Number(coverage.daily_capacity || 0);
  const activeAssignments = Number(coverage.active_assignments || 0);
  if (dailyCapacity > 0) {
    score += Math.max(0, dailyCapacity - activeAssignments);
  } else {
    score += 3;
  }
  return score;
}

function priorityTierRank(priorityTier: unknown): number {
  if (priorityTier === 'P0') return 0;
  if (priorityTier === 'P1') return 1;
  if (priorityTier === 'P2') return 2;
  return 3;
}

function hasHandoffExecution(handoff: JsonRecord | null | undefined): boolean {
  return Boolean(
    handoff
    && typeof handoff.payload?.execution === 'object'
    && handoff.payload.execution
    && Object.keys(handoff.payload.execution).length
  );
}

function balanceScore(coverage: JsonRecord, requestedChannel: string, pendingAssignments: number): number {
  let score = Number(coverage.priority_weight || 0);
  if (!coverage.channel || coverage.channel === 'any') score += 1;
  if (coverage.channel === requestedChannel) score += 4;
  const dailyCapacity = Number(coverage.daily_capacity || 0);
  const activeAssignments = Number(coverage.active_assignments || 0);
  const effectiveAssignments = activeAssignments + pendingAssignments;
  if (dailyCapacity > 0) {
    const remainingCapacity = dailyCapacity - effectiveAssignments;
    score += remainingCapacity * 4;
    if (remainingCapacity <= 0) {
      score -= 200;
    }
  } else {
    score += 6;
  }
  return score;
}

function buildCoverageSnapshot(coverage: JsonRecord, currentPendingHandoffs: number, plannedPendingHandoffs: number): JsonRecord {
  const activeAssignments = Number(coverage.active_assignments || 0);
  const dailyCapacity = Number(coverage.daily_capacity || 0);
  const currentEffectiveAssignments = activeAssignments + currentPendingHandoffs;
  const plannedEffectiveAssignments = activeAssignments + plannedPendingHandoffs;
  const currentAvailableCapacity = dailyCapacity > 0 ? dailyCapacity - currentEffectiveAssignments : null;
  const plannedAvailableCapacity = dailyCapacity > 0 ? dailyCapacity - plannedEffectiveAssignments : null;
  return {
    ...coverage,
    active_assignments: activeAssignments,
    daily_capacity: dailyCapacity,
    current_pending_handoffs: currentPendingHandoffs,
    planned_pending_handoffs: plannedPendingHandoffs,
    current_effective_assignments: currentEffectiveAssignments,
    planned_effective_assignments: plannedEffectiveAssignments,
    current_available_capacity: currentAvailableCapacity,
    planned_available_capacity: plannedAvailableCapacity,
    current_load_ratio: dailyCapacity > 0 ? Number((currentEffectiveAssignments / dailyCapacity).toFixed(4)) : null,
    planned_load_ratio: dailyCapacity > 0 ? Number((plannedEffectiveAssignments / dailyCapacity).toFixed(4)) : null,
    current_over_capacity: dailyCapacity > 0 ? currentEffectiveAssignments > dailyCapacity : false,
    planned_over_capacity: dailyCapacity > 0 ? plannedEffectiveAssignments > dailyCapacity : false
  };
}

function incrementCount(counter: Map<string, number>, key: string): void {
  counter.set(key, (counter.get(key) || 0) + 1);
}

function isCoverageFeedbackActive(feedback: JsonRecord | null | undefined): boolean {
  return Boolean(feedback?.active_assignment);
}

function defaultRoutingPolicy(tenantId: string, workspaceId = 'default', policyId = 'default'): JsonRecord {
  return {
    id: null,
    tenant_id: tenantId,
    workspace_id: workspaceId,
    policy_id: policyId,
    maintenance_scope: 'tenant',
    interval_seconds: 3600,
    dry_run: false,
    territory_status: 'active',
    territory_include_ids: [],
    territory_exclude_ids: [],
    auto_bootstrap: true,
    status: 'active',
    paused_until: null,
    pause_reason: '',
    last_rollout_at: null,
    last_rollout_snapshot: {},
    notes: '',
    metadata: {}
  };
}

export class GeoRoutingStore {
  db: unknown;
  geoStore: GeoStoreLike | null;
  artifactStore: ArtifactStoreLike | null;
  runStore: AuditStoreLike | null;

  constructor({
    db,
    geoStore = null,
    artifactStore = null,
    runStore = null
  }: {
    db: unknown;
    geoStore?: GeoStoreLike | null;
    artifactStore?: ArtifactStoreLike | null;
    runStore?: AuditStoreLike | null;
  }) {
    this.db = db;
    this.geoStore = geoStore;
    this.artifactStore = artifactStore;
    this.runStore = runStore;
  }

  listTerritories(input: JsonRecord): JsonRecord[] {
    ensureTenant(input);
    const workspaceId = normalizeWorkspaceId(input);
    const clauses = ['tenant_id = ?', 'workspace_id = ?'];
    const params: Array<string | number | null> = [input.tenant_id, workspaceId];
    if (input.status) {
      clauses.push('status = ?');
      params.push(input.status);
    }
    if (input.city) {
      clauses.push('city = ?');
      params.push(input.city);
    }
    if (input.business_type) {
      clauses.push('business_type = ?');
      params.push(input.business_type);
    }
    return all(
      this.db,
      `SELECT * FROM tenant_geo_territories
       WHERE ${clauses.join(' AND ')}
       ORDER BY updated_at DESC
       LIMIT ?`,
      [...params, Number(input.limit || 50)]
    ).map(decodeTerritory);
  }

  getTerritory(tenantId: string, workspaceId: string, territoryId: string): JsonRecord | null {
    return decodeTerritory(
      one(
        this.db,
        `SELECT * FROM tenant_geo_territories
         WHERE tenant_id = ? AND workspace_id = ? AND territory_id = ?`,
        [tenantId, workspaceId, territoryId]
      )
    );
  }

  upsertTerritory(input: JsonRecord): JsonRecord | null {
    ensureTenant(input);
    const workspaceId = normalizeWorkspaceId(input);
    const territoryId = input.territory_id || id('geo_territory');
    const actor = input.updated_by || input.created_by || 'system';
    run(
      this.db,
      `INSERT INTO tenant_geo_territories (
        id, tenant_id, workspace_id, territory_id, name, city, region, country_code, business_type,
        priority_tier, queue_route_id, voice_route_id, default_channel, default_owner_user_id,
        status, notes, metadata, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, workspace_id, territory_id) DO UPDATE SET
        name = excluded.name,
        city = excluded.city,
        region = excluded.region,
        country_code = excluded.country_code,
        business_type = excluded.business_type,
        priority_tier = excluded.priority_tier,
        queue_route_id = excluded.queue_route_id,
        voice_route_id = excluded.voice_route_id,
        default_channel = excluded.default_channel,
        default_owner_user_id = excluded.default_owner_user_id,
        status = excluded.status,
        notes = excluded.notes,
        metadata = excluded.metadata,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP`,
      [
        input.id || territoryId,
        input.tenant_id,
        workspaceId,
        territoryId,
        input.name || territoryId,
        input.city || '',
        input.region || '',
        input.country_code || '',
        input.business_type || '',
        input.priority_tier || 'P1',
        input.queue_route_id || 'geo-followup',
        input.voice_route_id || 'default',
        input.default_channel || 'call_script',
        input.default_owner_user_id || '',
        input.status || 'active',
        input.notes || '',
        json(input.metadata || {}),
        input.created_by || actor,
        actor
      ]
    );
    const territory = this.getTerritory(input.tenant_id, workspaceId, territoryId);
    if (territory) {
      this.runStore?.audit(
        input.tenant_id,
        'geo.territory.upserted',
        'tenant_geo_territory',
        territory.id,
        { territory_id: territory.territory_id },
        actor
      );
    }
    return territory;
  }

  upsertRoutingPolicy(input: JsonRecord): JsonRecord {
    ensureTenant(input);
    const workspaceId = normalizeWorkspaceId(input);
    const policyId = input.policy_id || 'default';
    const actor = input.actor_id || input.updated_by || input.created_by || 'system';
    const prior = this.getRoutingPolicy(input.tenant_id, workspaceId, policyId);
    const has = (field: string): boolean => Object.prototype.hasOwnProperty.call(input, field);
    run(
      this.db,
      `INSERT INTO tenant_geo_routing_policies (
        id, tenant_id, workspace_id, policy_id, maintenance_scope, interval_seconds, dry_run,
        territory_status, territory_include_ids, territory_exclude_ids, auto_bootstrap, status,
        paused_until, pause_reason, last_rollout_at, last_rollout_snapshot, notes, metadata, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, workspace_id, policy_id) DO UPDATE SET
        maintenance_scope = excluded.maintenance_scope,
        interval_seconds = excluded.interval_seconds,
        dry_run = excluded.dry_run,
        territory_status = excluded.territory_status,
        territory_include_ids = excluded.territory_include_ids,
        territory_exclude_ids = excluded.territory_exclude_ids,
        auto_bootstrap = excluded.auto_bootstrap,
        status = excluded.status,
        paused_until = excluded.paused_until,
        pause_reason = excluded.pause_reason,
        last_rollout_at = excluded.last_rollout_at,
        last_rollout_snapshot = excluded.last_rollout_snapshot,
        notes = excluded.notes,
        metadata = excluded.metadata,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP`,
      [
        input.id || id('geo_policy'),
        input.tenant_id,
        workspaceId,
        policyId,
        has('maintenance_scope') ? (input.maintenance_scope || 'tenant') : prior.maintenance_scope,
        has('interval_seconds') ? Number(input.interval_seconds || 3600) : Number(prior.interval_seconds || 3600),
        (has('dry_run') ? Boolean(input.dry_run) : Boolean(prior.dry_run)) ? 1 : 0,
        has('territory_status') ? (input.territory_status || 'active') : prior.territory_status,
        json(has('territory_include_ids') ? normalizeStringList(input.territory_include_ids) : normalizeStringList(prior.territory_include_ids)),
        json(has('territory_exclude_ids') ? normalizeStringList(input.territory_exclude_ids) : normalizeStringList(prior.territory_exclude_ids)),
        (has('auto_bootstrap') ? input.auto_bootstrap !== false : prior.auto_bootstrap !== false) ? 1 : 0,
        has('status') ? (input.status || 'active') : prior.status,
        has('paused_until') ? (input.paused_until || null) : (prior.paused_until || null),
        has('pause_reason') ? (input.pause_reason || '') : (prior.pause_reason || ''),
        has('last_rollout_at') ? (input.last_rollout_at || null) : (prior.last_rollout_at || null),
        json(has('last_rollout_snapshot') ? (input.last_rollout_snapshot || {}) : (prior.last_rollout_snapshot || {})),
        has('notes') ? (input.notes || '') : (prior.notes || ''),
        json(has('metadata') ? (input.metadata || {}) : (prior.metadata || {})),
        input.created_by || actor,
        actor
      ]
    );
    const policy = this.getRoutingPolicy(input.tenant_id, workspaceId, policyId);
    if (policy) {
      this.runStore?.audit(
        input.tenant_id,
        'geo.routing_policy.upserted',
        'tenant_geo_routing_policy',
        policy.id || policy.policy_id,
        {
          policy_id: policy.policy_id,
          maintenance_scope: policy.maintenance_scope,
          interval_seconds: policy.interval_seconds,
          auto_bootstrap: policy.auto_bootstrap,
          territory_include_ids: policy.territory_include_ids,
          territory_exclude_ids: policy.territory_exclude_ids,
          paused_until: policy.paused_until
        },
        actor
      );
    }
    return policy;
  }

  getRoutingPolicy(tenantId: string, workspaceId = 'default', policyId = 'default'): JsonRecord {
    const row = one(
      this.db,
      `SELECT * FROM tenant_geo_routing_policies
       WHERE tenant_id = ? AND workspace_id = ? AND policy_id = ?`,
      [tenantId, workspaceId, policyId]
    );
    return decodeRoutingPolicy(row) || defaultRoutingPolicy(tenantId, workspaceId, policyId);
  }

  listRoutingPolicies({ tenant_id, workspace_id = null, status = null, limit = 50 }: JsonRecord): JsonRecord[] {
    ensureTenant({ tenant_id });
    const clauses = ['tenant_id = ?'];
    const params: Array<string | number> = [tenant_id];
    if (workspace_id) {
      clauses.push('workspace_id = ?');
      params.push(workspace_id);
    }
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    return all(
      this.db,
      `SELECT * FROM tenant_geo_routing_policies
       WHERE ${clauses.join(' AND ')}
       ORDER BY updated_at DESC
       LIMIT ?`,
      [...params, Number(limit || 50)]
    ).map(decodeRoutingPolicy);
  }

  recordRoutingPolicyRolloutSnapshot(input: JsonRecord): JsonRecord {
    ensureTenant(input);
    const workspaceId = normalizeWorkspaceId(input);
    const policyId = input.policy_id || 'default';
    const actor = input.actor_id || input.updated_by || 'system';
    const existing = one(
      this.db,
      `SELECT id FROM tenant_geo_routing_policies
       WHERE tenant_id = ? AND workspace_id = ? AND policy_id = ?`,
      [input.tenant_id, workspaceId, policyId]
    );
    if (!existing) {
      this.upsertRoutingPolicy({
        tenant_id: input.tenant_id,
        workspace_id: workspaceId,
        policy_id: policyId,
        actor_id: actor
      });
    }
    const rolloutAt = input.last_rollout_at || new Date().toISOString();
    run(
      this.db,
      `UPDATE tenant_geo_routing_policies
       SET last_rollout_at = ?, last_rollout_snapshot = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ? AND workspace_id = ? AND policy_id = ?`,
      [
        rolloutAt,
        json(input.last_rollout_snapshot || {}),
        actor,
        input.tenant_id,
        workspaceId,
        policyId
      ]
    );
    const policy = this.getRoutingPolicy(input.tenant_id, workspaceId, policyId);
    this.runStore?.audit(
      input.tenant_id,
      'geo.routing_policy.rollout_recorded',
      'tenant_geo_routing_policy',
      policy.id || policy.policy_id,
      {
        policy_id: policy.policy_id,
        last_rollout_at: policy.last_rollout_at,
        rollout_status: policy.last_rollout_snapshot?.status || null
      },
      actor
    );
    return policy;
  }

  getRoutingPolicyOverride(tenantId: string, overrideId: string): JsonRecord | null {
    return decodeRoutingPolicyOverride(
      one(
        this.db,
        `SELECT * FROM tenant_geo_routing_policy_overrides
         WHERE tenant_id = ? AND id = ?`,
        [tenantId, overrideId]
      )
    );
  }

  listRoutingPolicyOverrides({
    tenant_id,
    workspace_id = null,
    policy_id = null,
    status = null,
    override_kind = null,
    limit = 50
  }: JsonRecord): JsonRecord[] {
    ensureTenant({ tenant_id });
    const clauses = ['tenant_id = ?'];
    const params: Array<string | number> = [tenant_id];
    if (workspace_id) {
      clauses.push('workspace_id = ?');
      params.push(workspace_id);
    }
    if (policy_id) {
      clauses.push('policy_id = ?');
      params.push(policy_id);
    }
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    if (override_kind) {
      clauses.push('override_kind = ?');
      params.push(override_kind);
    }
    return all(
      this.db,
      `SELECT * FROM tenant_geo_routing_policy_overrides
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ?`,
      [...params, Number(limit || 50)]
    ).map(decodeRoutingPolicyOverride);
  }

  recordRoutingPolicyOverride(input: JsonRecord): JsonRecord {
    ensureTenant(input);
    const workspaceId = normalizeWorkspaceId(input);
    const overrideId = input.override_id || input.id || id('geo_policy_override');
    const actor = input.actor_id || input.created_by || 'system';
    run(
      this.db,
      `INSERT INTO tenant_geo_routing_policy_overrides (
        id, tenant_id, workspace_id, policy_id, override_kind, status, source_override_id, reason,
        requested_patch, before_policy, after_policy, before_preview, after_preview, diff_summary,
        rollout_result, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        overrideId,
        input.tenant_id,
        workspaceId,
        input.policy_id || 'default',
        input.override_kind || 'policy_override',
        input.status || 'applied',
        input.source_override_id || null,
        input.reason || '',
        json(input.requested_patch || {}),
        json(input.before_policy || {}),
        json(input.after_policy || {}),
        json(input.before_preview || {}),
        json(input.after_preview || {}),
        json(input.diff_summary || {}),
        json(input.rollout_result || {}),
        actor
      ]
    );
    const override = this.getRoutingPolicyOverride(input.tenant_id, overrideId);
    if (!override) {
      throw new Error(`failed to persist geo routing policy override: ${overrideId}`);
    }
    this.runStore?.audit(
      input.tenant_id,
      'geo.routing_policy.override_recorded',
      'tenant_geo_routing_policy_override',
      override.id,
      {
        policy_id: override.policy_id,
        override_kind: override.override_kind,
        status: override.status,
        source_override_id: override.source_override_id || null
      },
      actor
    );
    return override;
  }

  updateRoutingPolicyOverrideStatus(tenantId: string, overrideId: string, status: string, actorId = 'system'): JsonRecord | null {
    run(
      this.db,
      `UPDATE tenant_geo_routing_policy_overrides
       SET status = ?
       WHERE tenant_id = ? AND id = ?`,
      [status, tenantId, overrideId]
    );
    const override = this.getRoutingPolicyOverride(tenantId, overrideId);
    if (override) {
      this.runStore?.audit(
        tenantId,
        'geo.routing_policy.override_status_updated',
        'tenant_geo_routing_policy_override',
        override.id,
        {
          policy_id: override.policy_id,
          status: override.status
        },
        actorId
      );
    }
    return override;
  }

  listRoutingPolicyApprovalRequests({
    tenant_id,
    workspace_id = null,
    policy_id = null,
    status = null,
    limit = 50
  }: JsonRecord): JsonRecord[] {
    ensureTenant({ tenant_id });
    const clauses = [
      'tenant_id = ?',
      `(action_type = 'geo.override_routing_policy' OR action_type = 'geo.rollback_routing_policy_override')`
    ];
    const params: Array<string | number> = [tenant_id];
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    const approvals = all(
      this.db,
      `SELECT * FROM approval_requests
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ?`,
      [...params, Number(limit || 50)]
    ).map(decodeApproval).filter(Boolean) as JsonRecord[];
    return approvals
      .map((approval) => {
        const payload = approval.payload || {};
        const sourceOverride = payload.override_id
          ? this.getRoutingPolicyOverride(String(tenant_id), String(payload.override_id))
          : null;
        const resolvedPolicyId = String(payload.policy_id || sourceOverride?.policy_id || 'default');
        const resolvedWorkspaceId = String(payload.workspace_id || sourceOverride?.workspace_id || 'default');
        if (workspace_id && resolvedWorkspaceId !== workspace_id) {
          return null;
        }
        if (policy_id && resolvedPolicyId !== policy_id) {
          return null;
        }
        const toolCall = approval.tool_call_id ? this.getToolCall(String(tenant_id), String(approval.tool_call_id)) : null;
        return {
          ...approval,
          policy_id: resolvedPolicyId,
          workspace_id: resolvedWorkspaceId,
          tool_call: toolCall,
          source_override: sourceOverride
        };
      })
      .filter(Boolean) as JsonRecord[];
  }

  getRoutingPolicyReviewState(tenantId: string, workspaceId: string, policyId: string, reviewKey: string): JsonRecord | null {
    return decodeRoutingPolicyReviewState(
      one(
        this.db,
        `SELECT * FROM tenant_geo_routing_policy_review_states
         WHERE tenant_id = ? AND workspace_id = ? AND policy_id = ? AND review_key = ?`,
        [tenantId, workspaceId, policyId, reviewKey]
      )
    );
  }

  listRoutingPolicyReviewStates({
    tenant_id,
    workspace_id = null,
    policy_id = null,
    item_status = null,
    item_type = null,
    limit = 100
  }: JsonRecord): JsonRecord[] {
    ensureTenant({ tenant_id });
    const clauses = ['tenant_id = ?'];
    const params: Array<string | number> = [tenant_id];
    if (workspace_id) {
      clauses.push('workspace_id = ?');
      params.push(workspace_id);
    }
    if (policy_id) {
      clauses.push('policy_id = ?');
      params.push(policy_id);
    }
    if (item_status) {
      clauses.push('item_status = ?');
      params.push(item_status);
    }
    if (item_type) {
      clauses.push('item_type = ?');
      params.push(item_type);
    }
    return all(
      this.db,
      `SELECT * FROM tenant_geo_routing_policy_review_states
       WHERE ${clauses.join(' AND ')}
       ORDER BY updated_at DESC, created_at DESC
       LIMIT ?`,
      [...params, Number(limit || 100)]
    ).map(decodeRoutingPolicyReviewState);
  }

  upsertRoutingPolicyReviewState(input: JsonRecord): JsonRecord {
    ensureTenant(input);
    if (!input.review_key) {
      throw new Error('review_key is required');
    }
    if (!input.item_type) {
      throw new Error('item_type is required');
    }
    const workspaceId = normalizeWorkspaceId(input);
    const policyId = String(input.policy_id || 'default');
    const actor = String(input.actor_id || input.updated_by || input.created_by || 'system');
    const itemStatus = String(input.item_status || 'acknowledged');
    if (itemStatus !== 'open' && itemStatus !== 'acknowledged') {
      throw new Error('item_status must be open or acknowledged');
    }
    run(
      this.db,
      `INSERT INTO tenant_geo_routing_policy_review_states (
        id, tenant_id, workspace_id, policy_id, review_key, item_type, item_status, source_type,
        source_id, note, metadata, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, workspace_id, policy_id, review_key) DO UPDATE SET
        item_type = excluded.item_type,
        item_status = excluded.item_status,
        source_type = excluded.source_type,
        source_id = excluded.source_id,
        note = excluded.note,
        metadata = excluded.metadata,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP`,
      [
        String(input.id || id('geo_policy_review')),
        input.tenant_id,
        workspaceId,
        policyId,
        String(input.review_key),
        String(input.item_type),
        itemStatus,
        String(input.source_type || ''),
        String(input.source_id || ''),
        String(input.note || ''),
        json(input.metadata || {}),
        actor,
        actor
      ]
    );
    const reviewState = this.getRoutingPolicyReviewState(String(input.tenant_id), workspaceId, policyId, String(input.review_key));
    if (!reviewState) {
      throw new Error(`failed to persist geo routing policy review state: ${String(input.review_key)}`);
    }
    this.runStore?.audit(
      String(input.tenant_id),
      'geo.routing_policy.review_state_upserted',
      'tenant_geo_routing_policy_review_state',
      reviewState.id,
      {
        policy_id: reviewState.policy_id,
        review_key: reviewState.review_key,
        item_type: reviewState.item_type,
        item_status: reviewState.item_status,
        source_type: reviewState.source_type,
        source_id: reviewState.source_id
      },
      actor
    );
    return reviewState;
  }

  listRoutingPolicyActionHistory({
    tenant_id,
    workspace_id = null,
    policy_id = null,
    review_key = null,
    action_id = null,
    status = null,
    limit = 100
  }: JsonRecord): JsonRecord[] {
    ensureTenant({ tenant_id });
    const clauses = ['tenant_id = ?'];
    const params: Array<string | number> = [tenant_id];
    if (workspace_id) {
      clauses.push('workspace_id = ?');
      params.push(workspace_id);
    }
    if (policy_id) {
      clauses.push('policy_id = ?');
      params.push(policy_id);
    }
    if (review_key) {
      clauses.push('review_key = ?');
      params.push(review_key);
    }
    if (action_id) {
      clauses.push('action_id = ?');
      params.push(action_id);
    }
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    return all(
      this.db,
      `SELECT * FROM tenant_geo_routing_policy_action_history
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ?`,
      [...params, Number(limit || 100)]
    ).map(decodeRoutingPolicyActionHistory);
  }

  recordRoutingPolicyActionHistory(input: JsonRecord): JsonRecord {
    ensureTenant(input);
    if (!input.review_key) {
      throw new Error('review_key is required');
    }
    if (!input.action_id) {
      throw new Error('action_id is required');
    }
    if (!input.action_type) {
      throw new Error('action_type is required');
    }
    const status = String(input.status || '');
    if (!['succeeded', 'blocked_pending_approval', 'failed'].includes(status)) {
      throw new Error('status must be succeeded, blocked_pending_approval, or failed');
    }
    const workspaceId = normalizeWorkspaceId(input);
    const policyId = String(input.policy_id || 'default');
    const historyId = String(input.id || id('geo_policy_action'));
    run(
      this.db,
      `INSERT INTO tenant_geo_routing_policy_action_history (
        id, tenant_id, workspace_id, policy_id, review_key, action_id, action_type, item_type,
        source_type, source_id, status, executed_by, note, result, item_snapshot, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        historyId,
        input.tenant_id,
        workspaceId,
        policyId,
        String(input.review_key),
        String(input.action_id),
        String(input.action_type),
        String(input.item_type || ''),
        String(input.source_type || ''),
        String(input.source_id || ''),
        status,
        String(input.executed_by || input.actor_id || 'system'),
        String(input.note || ''),
        json(input.result || {}),
        json(input.item_snapshot || {}),
        json(input.metadata || {})
      ]
    );
    const history = decodeRoutingPolicyActionHistory(
      one(this.db, 'SELECT * FROM tenant_geo_routing_policy_action_history WHERE tenant_id = ? AND id = ?', [input.tenant_id, historyId])
    );
    if (!history) {
      throw new Error(`failed to persist geo routing policy action history: ${historyId}`);
    }
    this.runStore?.audit(
      String(input.tenant_id),
      'geo.routing_policy.action_recorded',
      'tenant_geo_routing_policy_action_history',
      history.id,
      {
        policy_id: history.policy_id,
        review_key: history.review_key,
        action_id: history.action_id,
        action_type: history.action_type,
        status: history.status,
        source_type: history.source_type,
        source_id: history.source_id
      },
      String(history.executed_by || 'system')
    );
    return history;
  }

  getRoutingPolicyBatchPlan(tenantId: string, planId: string): JsonRecord | null {
    return decodeRoutingPolicyBatchPlan(
      one(
        this.db,
        `SELECT * FROM tenant_geo_routing_policy_batch_plans
         WHERE tenant_id = ? AND id = ?`,
        [tenantId, planId]
      )
    );
  }

  listRoutingPolicyBatchPlans({
    tenant_id,
    workspace_id = null,
    policy_id = null,
    status = null,
    plan_id = null,
    limit = 100
  }: JsonRecord): JsonRecord[] {
    ensureTenant({ tenant_id });
    const clauses = ['tenant_id = ?'];
    const params: Array<string | number> = [tenant_id];
    if (workspace_id) {
      clauses.push('workspace_id = ?');
      params.push(workspace_id);
    }
    if (policy_id) {
      clauses.push('policy_id = ?');
      params.push(policy_id);
    }
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    if (plan_id) {
      clauses.push('id = ?');
      params.push(plan_id);
    }
    return all(
      this.db,
      `SELECT * FROM tenant_geo_routing_policy_batch_plans
       WHERE ${clauses.join(' AND ')}
       ORDER BY updated_at DESC, created_at DESC
       LIMIT ?`,
      [...params, Number(limit || 100)]
    ).map(decodeRoutingPolicyBatchPlan);
  }

  upsertRoutingPolicyBatchPlan(input: JsonRecord): JsonRecord {
    ensureTenant(input);
    const workspaceId = normalizeWorkspaceId(input);
    const policyId = String(input.policy_id || 'default');
    const actor = String(input.actor_id || input.updated_by || input.created_by || 'system');
    const planId = String(input.plan_id || input.id || id('geo_policy_batch_plan'));
    const status = String(input.status || 'active');
    if (status !== 'active' && status !== 'archived') {
      throw new Error('status must be active or archived');
    }
    run(
      this.db,
      `INSERT INTO tenant_geo_routing_policy_batch_plans (
        id, tenant_id, workspace_id, policy_id, plan_name, status, items, selection_summary,
        preview, notes, metadata, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        plan_name = excluded.plan_name,
        status = excluded.status,
        items = excluded.items,
        selection_summary = excluded.selection_summary,
        preview = excluded.preview,
        notes = excluded.notes,
        metadata = excluded.metadata,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP`,
      [
        planId,
        input.tenant_id,
        workspaceId,
        policyId,
        String(input.plan_name || ''),
        status,
        json(input.items || []),
        json(input.selection_summary || {}),
        json(input.preview || {}),
        String(input.notes || ''),
        json(input.metadata || {}),
        actor,
        actor
      ]
    );
    const plan = this.getRoutingPolicyBatchPlan(String(input.tenant_id), planId);
    if (!plan) {
      throw new Error(`failed to persist geo routing policy batch plan: ${planId}`);
    }
    this.runStore?.audit(
      String(input.tenant_id),
      'geo.routing_policy.batch_plan_upserted',
      'tenant_geo_routing_policy_batch_plan',
      plan.id,
      {
        policy_id: plan.policy_id,
        plan_name: plan.plan_name,
        status: plan.status,
        selected_items: Array.isArray(plan.items) ? plan.items.length : 0
      },
      actor
    );
    return plan;
  }

  listRepCoverages(input: JsonRecord): JsonRecord[] {
    ensureTenant(input);
    const workspaceId = normalizeWorkspaceId(input);
    const clauses = ['tenant_id = ?', 'workspace_id = ?'];
    const params: Array<string | number | null> = [input.tenant_id, workspaceId];
    if (input.territory_id) {
      clauses.push('territory_id = ?');
      params.push(input.territory_id);
    }
    if (input.owner_user_id) {
      clauses.push('owner_user_id = ?');
      params.push(input.owner_user_id);
    }
    if (input.status) {
      clauses.push('status = ?');
      params.push(input.status);
    }
    return all(
      this.db,
      `SELECT * FROM tenant_geo_rep_coverages
       WHERE ${clauses.join(' AND ')}
       ORDER BY updated_at DESC
       LIMIT ?`,
      [...params, Number(input.limit || 50)]
    ).map(decodeCoverage);
  }

  getRepCoverage(tenantId: string, workspaceId: string, coverageId: string): JsonRecord | null {
    return decodeCoverage(
      one(
        this.db,
        `SELECT * FROM tenant_geo_rep_coverages
         WHERE tenant_id = ? AND workspace_id = ? AND coverage_id = ?`,
        [tenantId, workspaceId, coverageId]
      )
    );
  }

  upsertRepCoverage(input: JsonRecord): JsonRecord | null {
    ensureTenant(input);
    if (!input.territory_id) {
      throw new Error('territory_id is required');
    }
    const workspaceId = normalizeWorkspaceId(input);
    const coverageId = input.coverage_id || id('geo_coverage');
    const actor = input.updated_by || input.created_by || 'system';
    run(
      this.db,
      `INSERT INTO tenant_geo_rep_coverages (
        id, tenant_id, workspace_id, coverage_id, territory_id, owner_user_id, owner_name, channel,
        queue_route_id, voice_route_id, priority_weight, daily_capacity, active_assignments,
        status, notes, metadata, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, workspace_id, coverage_id) DO UPDATE SET
        territory_id = excluded.territory_id,
        owner_user_id = excluded.owner_user_id,
        owner_name = excluded.owner_name,
        channel = excluded.channel,
        queue_route_id = excluded.queue_route_id,
        voice_route_id = excluded.voice_route_id,
        priority_weight = excluded.priority_weight,
        daily_capacity = excluded.daily_capacity,
        active_assignments = excluded.active_assignments,
        status = excluded.status,
        notes = excluded.notes,
        metadata = excluded.metadata,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP`,
      [
        input.id || coverageId,
        input.tenant_id,
        workspaceId,
        coverageId,
        input.territory_id,
        input.owner_user_id || '',
        input.owner_name || '',
        input.channel || 'any',
        input.queue_route_id || 'geo-followup',
        input.voice_route_id || 'default',
        Number(input.priority_weight || 100),
        Number(input.daily_capacity || 0),
        Number(input.active_assignments || 0),
        input.status || 'active',
        input.notes || '',
        json(input.metadata || {}),
        input.created_by || actor,
        actor
      ]
    );
    const coverage = this.getRepCoverage(input.tenant_id, workspaceId, coverageId);
    if (coverage) {
      this.runStore?.audit(
        input.tenant_id,
        'geo.rep_coverage.upserted',
        'tenant_geo_rep_coverage',
        coverage.id,
        { coverage_id: coverage.coverage_id, territory_id: coverage.territory_id },
        actor
      );
    }
    return coverage;
  }

  listHandoffs(input: JsonRecord): JsonRecord[] {
    ensureTenant(input);
    const workspaceId = normalizeWorkspaceId(input);
    const clauses = ['tenant_id = ?', 'workspace_id = ?'];
    const params: Array<string | number | null> = [input.tenant_id, workspaceId];
    if (input.place_id) {
      clauses.push('place_id = ?');
      params.push(input.place_id);
    }
    if (input.owner_user_id) {
      clauses.push('owner_user_id = ?');
      params.push(input.owner_user_id);
    }
    if (input.status) {
      clauses.push('status = ?');
      params.push(input.status);
    }
    return all(
      this.db,
      `SELECT * FROM tenant_geo_handoff_packets
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ?`,
      [...params, Number(input.limit || 50)]
     ).map(decodeHandoff);
  }

  getHandoff(tenantId: string, handoffId: string): JsonRecord | null {
    return decodeHandoff(
      one(
        this.db,
        'SELECT * FROM tenant_geo_handoff_packets WHERE tenant_id = ? AND id = ?',
        [tenantId, handoffId]
      )
    );
  }

  getTask(tenantId: string, taskId: string): JsonRecord | null {
    return one(this.db, 'SELECT * FROM tasks WHERE tenant_id = ? AND id = ?', [tenantId, taskId]) || null;
  }

  getApprovalRequest(tenantId: string, approvalRequestId: string): JsonRecord | null {
    return decodeApproval(
      one(this.db, 'SELECT * FROM approval_requests WHERE tenant_id = ? AND id = ?', [tenantId, approvalRequestId])
    );
  }

  getToolCall(tenantId: string, toolCallId: string): JsonRecord | null {
    return decodeToolCall(
      one(this.db, 'SELECT * FROM tool_calls WHERE tenant_id = ? AND id = ?', [tenantId, toolCallId])
    );
  }

  getVoiceCallLog(tenantId: string, callLogId: string): JsonRecord | null {
    return decodeCallLog(
      one(this.db, 'SELECT * FROM voice_call_logs WHERE tenant_id = ? AND id = ?', [tenantId, callLogId])
    );
  }

  getVoiceCallSession(tenantId: string, callSessionId: string): JsonRecord | null {
    return decodeCallSession(
      one(this.db, 'SELECT * FROM voice_call_sessions WHERE tenant_id = ? AND id = ?', [tenantId, callSessionId])
    );
  }

  listTerritoryHandoffs(input: JsonRecord): JsonRecord[] {
    ensureTenant(input);
    if (!input.territory_id) {
      throw new Error('territory_id is required');
    }
    const workspaceId = normalizeWorkspaceId(input);
    const territory = this.getTerritory(input.tenant_id, workspaceId, input.territory_id);
    if (!territory) {
      throw new Error(`Geo territory not found: ${input.territory_id}`);
    }
    const clauses = ['tenant_id = ?', 'workspace_id = ?', 'territory_id = ?'];
    const params: Array<string | number | null> = [input.tenant_id, workspaceId, territory.id];
    if (input.status) {
      clauses.push('status = ?');
      params.push(input.status);
    }
    return all(
      this.db,
      `SELECT * FROM tenant_geo_handoff_packets
       WHERE ${clauses.join(' AND ')}
       ORDER BY CASE priority_tier WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END, created_at ASC
       LIMIT ?`,
      [...params, Number(input.limit || 200)]
    ).map(decodeHandoff);
  }

  getTerritoryCapacityReport(input: JsonRecord): JsonRecord {
    ensureTenant(input);
    if (!input.territory_id) {
      throw new Error('territory_id is required');
    }
    const workspaceId = normalizeWorkspaceId(input);
    const territory = this.getTerritory(input.tenant_id, workspaceId, input.territory_id);
    if (!territory) {
      throw new Error(`Geo territory not found: ${input.territory_id}`);
    }
    const coverages = this.listRepCoverages({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      territory_id: input.territory_id,
      status: input.coverage_status || 'active',
      limit: input.coverage_limit || 200
    });
    const territoryHandoffs = this.listTerritoryHandoffs({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      territory_id: input.territory_id,
      limit: input.handoff_limit || 200
    });
    const eligibleHandoffs = territoryHandoffs
      .filter((handoff) => !hasHandoffExecution(handoff) && handoff.status !== 'archived');
    const currentPendingCounts = new Map<string, number>();
    for (const handoff of eligibleHandoffs) {
      if (handoff.coverage_id) {
        incrementCount(currentPendingCounts, String(handoff.coverage_id));
      }
    }

    const plannedPendingCounts = new Map<string, number>();
    const recommendedMoves: JsonRecord[] = [];
    const sortedHandoffs = [...eligibleHandoffs].sort((left, right) =>
      priorityTierRank(left.priority_tier) - priorityTierRank(right.priority_tier)
      || String(left.created_at || '').localeCompare(String(right.created_at || ''))
    );
    for (const handoff of sortedHandoffs) {
      const requestedChannel = handoff.recommended_channel
        || handoff.payload?.voice_followup?.recommended_channel
        || 'call_script';
      const currentCoverageId = handoff.coverage_id ? String(handoff.coverage_id) : null;
      const candidates = coverages.filter((coverage) =>
        !coverage.channel
        || coverage.channel === 'any'
        || coverage.channel === requestedChannel
      );
      const selectedCoverage = candidates
        .map((coverage) => ({
          coverage,
          score: balanceScore(coverage, requestedChannel, plannedPendingCounts.get(String(coverage.id)) || 0)
        }))
        .sort((left, right) =>
          right.score - left.score
          || (currentCoverageId && String(left.coverage.id) === currentCoverageId ? -1 : 0)
          || (currentCoverageId && String(right.coverage.id) === currentCoverageId ? 1 : 0)
          || String(left.coverage.owner_name || left.coverage.owner_user_id).localeCompare(String(right.coverage.owner_name || right.coverage.owner_user_id))
        )[0]?.coverage || null;
      if (!selectedCoverage) {
        continue;
      }
      incrementCount(plannedPendingCounts, String(selectedCoverage.id));
      if (currentCoverageId && String(selectedCoverage.id) === currentCoverageId) {
        continue;
      }
      recommendedMoves.push({
        handoff_id: handoff.id,
        place_id: handoff.place_id,
        priority_tier: handoff.priority_tier,
        recommended_channel: requestedChannel,
        from_coverage_id: currentCoverageId,
        from_owner_user_id: handoff.owner_user_id || handoff.payload?.crm_task?.owner_user_id || null,
        to_coverage_id: selectedCoverage.coverage_id,
        to_coverage_row_id: selectedCoverage.id,
        to_owner_user_id: selectedCoverage.owner_user_id,
        to_owner_name: selectedCoverage.owner_name || selectedCoverage.owner_user_id,
        queue_route_id: selectedCoverage.queue_route_id || territory.queue_route_id,
        voice_route_id: selectedCoverage.voice_route_id || territory.voice_route_id
      });
    }

    const coverageSnapshots = coverages.map((coverage) =>
      buildCoverageSnapshot(
        coverage,
        currentPendingCounts.get(String(coverage.id)) || 0,
        plannedPendingCounts.get(String(coverage.id)) || 0
      )
    );
    return {
      territory,
      coverages: coverageSnapshots,
      eligible_handoffs: eligibleHandoffs.length,
      executed_handoffs: territoryHandoffs.length - eligibleHandoffs.length,
      recommended_moves: recommendedMoves,
      totals: {
        handoffs: territoryHandoffs.length,
        active_coverages: coverages.length,
        overloaded_coverages: coverageSnapshots.filter((coverage) => coverage.current_over_capacity).length,
        planned_overloaded_coverages: coverageSnapshots.filter((coverage) => coverage.planned_over_capacity).length,
        available_coverages: coverageSnapshots.filter((coverage) => coverage.current_available_capacity == null || coverage.current_available_capacity > 0).length
      }
    };
  }

  rebalanceTerritoryAssignments(input: JsonRecord, context: JsonRecord = {}): JsonRecord {
    ensureTenant(input);
    const report = this.getTerritoryCapacityReport(input);
    const actor = input.rebalanced_by || context.userId || 'system';
    if (input.dry_run) {
      return {
        ...report,
        dry_run: true,
        applied_moves: [],
        rebalanced_count: 0
      };
    }
    const appliedMoves: JsonRecord[] = [];
    for (const move of report.recommended_moves) {
      const handoff = this.getHandoff(input.tenant_id, move.handoff_id);
      if (!handoff || hasHandoffExecution(handoff) || handoff.status === 'archived') {
        continue;
      }
      const coverage = this.getRepCoverage(input.tenant_id, report.territory.workspace_id, move.to_coverage_id);
      if (!coverage) {
        continue;
      }
      const place = handoff.payload?.place || { name: handoff.place_id, city: '' };
      const insight = handoff.payload?.insight || null;
      const payload = {
        ...handoff.payload,
        territory: report.territory,
        rep_coverage: coverage,
        crm_task: {
          ...(handoff.payload?.crm_task || {}),
          owner_user_id: coverage.owner_user_id || handoff.owner_user_id || null
        },
        voice_followup: {
          ...(handoff.payload?.voice_followup || {}),
          route_id: coverage.voice_route_id || report.territory.voice_route_id || handoff.voice_route_id,
          queue_route_id: coverage.queue_route_id || report.territory.queue_route_id || handoff.queue_route_id,
          recommended_channel: handoff.recommended_channel
        },
        routing_balance: {
          rebalanced_at: new Date().toISOString(),
          rebalanced_by: actor,
          from_coverage_id: move.from_coverage_id,
          to_coverage_id: coverage.coverage_id
        }
      };
      const summary = buildSummary(place, report.territory, coverage, insight);
      run(
        this.db,
        `UPDATE tenant_geo_handoff_packets
         SET coverage_id = ?,
             owner_user_id = ?,
             queue_route_id = ?,
             voice_route_id = ?,
             summary = ?,
             payload = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = ? AND id = ?`,
        [
          coverage.id,
          coverage.owner_user_id || handoff.owner_user_id || null,
          coverage.queue_route_id || report.territory.queue_route_id || handoff.queue_route_id,
          coverage.voice_route_id || report.territory.voice_route_id || handoff.voice_route_id,
          summary,
          json(payload),
          input.tenant_id,
          handoff.id
        ]
      );
      const updated = this.getHandoff(input.tenant_id, handoff.id);
      if (updated) {
        this.runStore?.audit(
          input.tenant_id,
          'geo.handoff.rebalanced',
          'tenant_geo_handoff_packet',
          updated.id,
          {
            from_coverage_id: move.from_coverage_id,
            to_coverage_id: coverage.coverage_id,
            from_owner_user_id: move.from_owner_user_id,
            to_owner_user_id: coverage.owner_user_id
          },
          actor
        );
        appliedMoves.push({
          ...move,
          handoff: updated
        });
      }
    }
    this.runStore?.audit(
      input.tenant_id,
      'geo.territory.rebalanced',
      'tenant_geo_territory',
      report.territory.id,
      {
        territory_id: report.territory.territory_id,
        recommended_moves: report.recommended_moves.length,
        applied_moves: appliedMoves.length
      },
      actor
    );
    return {
      ...this.getTerritoryCapacityReport(input),
      dry_run: false,
      applied_moves: appliedMoves,
      rebalanced_count: appliedMoves.length
    };
  }

  buildHandoffFeedback(handoff: JsonRecord): JsonRecord {
    const execution = typeof handoff.payload?.execution === 'object' && handoff.payload.execution
      ? handoff.payload.execution
      : null;
    if (!execution) {
      return {
        synced_at: new Date().toISOString(),
        execution_present: false,
        active_assignment: false,
        overall_status: 'pending'
      };
    }

    const crmTaskId = execution.crm_task?.output?.id || execution.crm_task?.output?.task?.id || null;
    const crmTask = crmTaskId ? this.getTask(handoff.tenant_id, String(crmTaskId)) : null;
    const approvalRequestId = execution.voice_followup?.approval_request_id
      || execution.voice_followup?.approval_request?.id
      || null;
    const approvalRequest = approvalRequestId
      ? this.getApprovalRequest(handoff.tenant_id, String(approvalRequestId))
      : null;
    const toolCallId = execution.voice_followup?.tool_call_id
      || approvalRequest?.tool_call_id
      || null;
    const toolCall = toolCallId
      ? this.getToolCall(handoff.tenant_id, String(toolCallId))
      : null;
    const callLogId = toolCall?.output?.call_log?.id || execution.voice_followup?.output?.call_log?.id || null;
    const callLog = callLogId ? this.getVoiceCallLog(handoff.tenant_id, String(callLogId)) : null;
    const callSessionId = toolCall?.output?.call_session?.id || execution.voice_followup?.output?.call_session?.id || null;
    const callSession = callSessionId ? this.getVoiceCallSession(handoff.tenant_id, String(callSessionId)) : null;

    const crmTaskStatus = crmTask?.status || null;
    const approvalStatus = approvalRequest?.status || execution.voice_followup?.status || null;
    const toolCallStatus = toolCall?.status || null;
    const callLogStatus = callLog?.status || null;
    const callSessionStatus = callSession?.status || null;

    const crmActive = Boolean(crmTask && crmTask.status !== 'done');
    const terminalVoiceState = callSessionStatus === 'completed'
      || callSessionStatus === 'failed'
      || callSessionStatus === 'cancelled';
    const voiceActive = approvalStatus === 'pending'
      || (approvalStatus === 'approved' && toolCallStatus !== 'success' && !terminalVoiceState)
      || toolCallStatus === 'running'
      || (!terminalVoiceState && (
        callLogStatus === 'queued'
        || callSessionStatus === 'planned'
        || callSessionStatus === 'queued'
        || callSessionStatus === 'active'
      ));
    const overallStatus = crmActive || voiceActive
      ? 'active'
      : execution.voice_followup
        ? 'resolved'
        : crmTaskStatus === 'done'
          ? 'resolved'
          : 'executed';

    return {
      synced_at: new Date().toISOString(),
      execution_present: true,
      active_assignment: crmActive || voiceActive,
      overall_status: overallStatus,
      crm_task: {
        execution_status: execution.crm_task?.status || null,
        task_id: crmTaskId,
        status: crmTaskStatus,
        priority: crmTask?.priority || execution.crm_task?.output?.priority || null,
        due_at: crmTask?.due_at || execution.crm_task?.output?.due_at || null
      },
      voice_followup: {
        execution_status: execution.voice_followup?.status || null,
        approval_request_id: approvalRequestId,
        approval_status: approvalStatus,
        tool_call_id: toolCallId,
        tool_call_status: toolCallStatus,
        call_log_id: callLogId,
        call_log_status: callLogStatus,
        call_session_id: callSessionId,
        call_session_status: callSessionStatus
      }
    };
  }

  syncHandoffFeedback(input: JsonRecord, context: JsonRecord = {}): JsonRecord | null {
    ensureTenant(input);
    if (!input.handoff_id) {
      throw new Error('handoff_id is required');
    }
    const handoff = this.getHandoff(input.tenant_id, input.handoff_id);
    if (!handoff) {
      throw new Error(`Geo handoff not found: ${input.handoff_id}`);
    }
    const actor = input.synced_by || context.userId || 'system';
    const feedback = this.buildHandoffFeedback(handoff);
    const payload = {
      ...handoff.payload,
      feedback
    };
    const terminalVoiceState = feedback.voice_followup?.call_session_status === 'completed'
      || feedback.voice_followup?.call_session_status === 'failed'
      || feedback.voice_followup?.call_session_status === 'cancelled';
    const status = feedback.voice_followup?.approval_status === 'pending'
      || (!terminalVoiceState && feedback.voice_followup?.call_log_status === 'queued')
      || feedback.voice_followup?.call_session_status === 'queued'
      || feedback.voice_followup?.call_session_status === 'active'
      ? 'queued'
      : handoff.status === 'archived'
        ? 'archived'
        : 'reviewed';
    run(
      this.db,
      `UPDATE tenant_geo_handoff_packets
       SET status = ?, payload = ?, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ? AND id = ?`,
      [status, json(payload), input.tenant_id, input.handoff_id]
    );
    const updated = this.getHandoff(input.tenant_id, input.handoff_id);
    if (updated) {
      this.runStore?.audit(
        input.tenant_id,
        'geo.handoff.feedback_synced',
        'tenant_geo_handoff_packet',
        updated.id,
        {
          overall_status: feedback.overall_status,
          active_assignment: feedback.active_assignment
        },
        actor
      );
    }
    return updated;
  }

  syncTerritoryFeedback(input: JsonRecord, context: JsonRecord = {}): JsonRecord {
    ensureTenant(input);
    if (!input.territory_id) {
      throw new Error('territory_id is required');
    }
    const actor = input.synced_by || context.userId || 'system';
    const workspaceId = normalizeWorkspaceId(input);
    const territory = this.getTerritory(input.tenant_id, workspaceId, input.territory_id);
    if (!territory) {
      throw new Error(`Geo territory not found: ${input.territory_id}`);
    }
    const coverages = this.listRepCoverages({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      territory_id: input.territory_id,
      status: input.coverage_status || 'active',
      limit: input.coverage_limit || 200
    });
    const handoffs = this.listTerritoryHandoffs({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      territory_id: input.territory_id,
      limit: input.handoff_limit || 200
    });
    const syncedHandoffs = handoffs
      .filter((handoff) => hasHandoffExecution(handoff) && handoff.status !== 'archived')
      .map((handoff) => this.syncHandoffFeedback({ tenant_id: input.tenant_id, handoff_id: handoff.id, synced_by: actor }, context))
      .filter(Boolean) as JsonRecord[];
    const territoryHandoffs = this.listTerritoryHandoffs({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      territory_id: input.territory_id,
      limit: input.handoff_limit || 200
    });

    const pendingCounts = new Map<string, number>();
    const executedCounts = new Map<string, number>();
    const activeGeoCounts = new Map<string, number>();
    const completedCounts = new Map<string, number>();
    const openTaskCounts = new Map<string, number>();
    const pendingApprovalCounts = new Map<string, number>();
    const queuedCallCounts = new Map<string, number>();

    for (const handoff of territoryHandoffs) {
      if (!handoff.coverage_id || handoff.status === 'archived') {
        continue;
      }
      const coverageKey = String(handoff.coverage_id);
      if (!hasHandoffExecution(handoff)) {
        incrementCount(pendingCounts, coverageKey);
        continue;
      }
      incrementCount(executedCounts, coverageKey);
      const feedback = handoff.payload?.feedback || null;
      if (feedback?.crm_task?.status && feedback.crm_task.status !== 'done') {
        incrementCount(openTaskCounts, coverageKey);
      }
      if (feedback?.voice_followup?.approval_status === 'pending') {
        incrementCount(pendingApprovalCounts, coverageKey);
      }
      if (feedback?.voice_followup?.call_session_status === 'queued' || feedback?.voice_followup?.call_log_status === 'queued') {
        incrementCount(queuedCallCounts, coverageKey);
      }
      if (isCoverageFeedbackActive(feedback)) {
        incrementCount(activeGeoCounts, coverageKey);
      } else {
        incrementCount(completedCounts, coverageKey);
      }
    }

    const coverageUpdates = coverages.map((coverage) => {
      const coverageKey = String(coverage.id);
      const metadata = typeof coverage.metadata === 'object' && coverage.metadata ? coverage.metadata : {};
      const priorFeedback = typeof metadata.geo_feedback === 'object' && metadata.geo_feedback ? metadata.geo_feedback : {};
      const baselineActiveAssignments = priorFeedback.baseline_active_assignments != null
        ? Number(priorFeedback.baseline_active_assignments)
        : Math.max(0, Number(coverage.active_assignments || 0) - (executedCounts.get(coverageKey) || 0));
      const activeGeoAssignments = activeGeoCounts.get(coverageKey) || 0;
      const updatedActiveAssignments = baselineActiveAssignments + activeGeoAssignments;
      const geoFeedback = {
        baseline_active_assignments: baselineActiveAssignments,
        pending_handoffs: pendingCounts.get(coverageKey) || 0,
        executed_handoffs: executedCounts.get(coverageKey) || 0,
        active_geo_assignments: activeGeoAssignments,
        completed_handoffs: completedCounts.get(coverageKey) || 0,
        open_crm_tasks: openTaskCounts.get(coverageKey) || 0,
        pending_voice_approvals: pendingApprovalCounts.get(coverageKey) || 0,
        queued_voice_calls: queuedCallCounts.get(coverageKey) || 0,
        synced_at: new Date().toISOString(),
      };
      const nextMetadata = {
        ...metadata,
        geo_feedback: geoFeedback
      };
      run(
        this.db,
        `UPDATE tenant_geo_rep_coverages
         SET active_assignments = ?,
             metadata = ?,
             updated_at = CURRENT_TIMESTAMP,
             updated_by = ?
         WHERE tenant_id = ? AND workspace_id = ? AND coverage_id = ?`,
        [
          updatedActiveAssignments,
          json(nextMetadata),
          actor,
          input.tenant_id,
          workspaceId,
          coverage.coverage_id
        ]
      );
      return this.getRepCoverage(input.tenant_id, workspaceId, coverage.coverage_id);
    }).filter(Boolean) as JsonRecord[];

    this.runStore?.audit(
      input.tenant_id,
      'geo.territory.feedback_synced',
      'tenant_geo_territory',
      territory.id,
      {
        territory_id: territory.territory_id,
        synced_handoffs: syncedHandoffs.length,
        updated_coverages: coverageUpdates.length
      },
      actor
    );

    return {
      territory,
      synced_handoffs: syncedHandoffs,
      coverage_updates: coverageUpdates,
      totals: {
        handoffs: territoryHandoffs.length,
        synced_handoffs: syncedHandoffs.length,
        active_geo_assignments: coverageUpdates.reduce((sum, coverage) => sum + Number(coverage.metadata?.geo_feedback?.active_geo_assignments || 0), 0),
        open_crm_tasks: coverageUpdates.reduce((sum, coverage) => sum + Number(coverage.metadata?.geo_feedback?.open_crm_tasks || 0), 0),
        pending_voice_approvals: coverageUpdates.reduce((sum, coverage) => sum + Number(coverage.metadata?.geo_feedback?.pending_voice_approvals || 0), 0)
      }
    };
  }

  runRoutingMaintenance(input: JsonRecord, context: JsonRecord = {}): JsonRecord {
    ensureTenant(input);
    const workspaceId = normalizeWorkspaceId(input);
    const actor = input.maintained_by || context.userId || 'system';
    const territories = input.territory_id
      ? [this.getTerritory(input.tenant_id, workspaceId, input.territory_id)].filter(Boolean) as JsonRecord[]
      : this.listTerritories({
          tenant_id: input.tenant_id,
          workspace_id: workspaceId,
          status: input.territory_status || 'active',
          limit: input.limit || 200
        });
    const results = territories.map((territory) => {
      const syncBefore = this.syncTerritoryFeedback(
        {
          tenant_id: input.tenant_id,
          workspace_id: workspaceId,
          territory_id: territory.territory_id,
          synced_by: actor
        },
        context
      );
      const rebalance = this.rebalanceTerritoryAssignments(
        {
          tenant_id: input.tenant_id,
          workspace_id: workspaceId,
          territory_id: territory.territory_id,
          dry_run: Boolean(input.dry_run),
          rebalanced_by: actor
        },
        context
      );
      const syncAfter = input.dry_run
        ? syncBefore
        : this.syncTerritoryFeedback(
            {
              tenant_id: input.tenant_id,
              workspace_id: workspaceId,
              territory_id: territory.territory_id,
              synced_by: actor
            },
            context
          );
      return {
        territory,
        sync_before: syncBefore,
        rebalance,
        sync_after: syncAfter
      };
    });
    const totals = results.reduce((summary, item) => {
      summary.territories_processed += 1;
      summary.synced_handoffs += Number(item.sync_after?.totals?.synced_handoffs || 0);
      summary.applied_rebalances += Number(item.rebalance?.rebalanced_count || 0);
      summary.active_geo_assignments += Number(item.sync_after?.totals?.active_geo_assignments || 0);
      summary.pending_voice_approvals += Number(item.sync_after?.totals?.pending_voice_approvals || 0);
      return summary;
    }, {
      territories_processed: 0,
      synced_handoffs: 0,
      applied_rebalances: 0,
      active_geo_assignments: 0,
      pending_voice_approvals: 0
    });
    this.runStore?.audit(
      input.tenant_id,
      'geo.routing_maintenance.ran',
      'tenant',
      input.tenant_id,
      {
        dry_run: Boolean(input.dry_run),
        territory_count: totals.territories_processed,
        applied_rebalances: totals.applied_rebalances
      },
      actor
    );
    return {
      dry_run: Boolean(input.dry_run),
      results,
      totals
    };
  }

  recordHandoffExecution(input: JsonRecord, context: JsonRecord = {}): JsonRecord | null {
    ensureTenant(input);
    if (!input.handoff_id) {
      throw new Error('handoff_id is required');
    }
    const handoff = this.getHandoff(input.tenant_id, input.handoff_id);
    if (!handoff) {
      throw new Error(`Geo handoff not found: ${input.handoff_id}`);
    }
    const actor = input.executed_by || context.userId || 'system';
    const previousExecution = typeof handoff.payload?.execution === 'object' && handoff.payload.execution
      ? handoff.payload.execution
      : null;
    const execution = {
      ...(previousExecution || {}),
      ...(typeof input.execution === 'object' && input.execution ? input.execution : {}),
      executed_at: input.executed_at || new Date().toISOString(),
      executed_by: actor
    };
    const executionArtifact = this.artifactStore?.commit?.({
      tenant_id: handoff.tenant_id,
      workspace_id: handoff.workspace_id,
      workflow_run_id: context.workflowRunId || null,
      agent_run_id: context.agentRunId || null,
      type: 'geo_handoff_execution',
      status: 'draft',
      parent_artifact_id: handoff.artifact_id || null,
      payload: {
        handoff_id: handoff.id,
        place_id: handoff.place_id,
        execution
      }
    }) || null;
    const payload = {
      ...handoff.payload,
      execution: {
        ...execution,
        execution_artifact_id: executionArtifact?.id || execution.execution_artifact_id || null
      }
    };
    run(
      this.db,
      `UPDATE tenant_geo_handoff_packets
       SET status = ?, payload = ?, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ? AND id = ?`,
      [
        input.status || handoff.status || 'reviewed',
        json(payload),
        input.tenant_id,
        input.handoff_id
      ]
    );
    if (!previousExecution && handoff.coverage_id && input.increment_assignment !== false) {
      run(
        this.db,
        `UPDATE tenant_geo_rep_coverages
         SET active_assignments = active_assignments + 1,
             updated_at = CURRENT_TIMESTAMP,
             updated_by = ?
         WHERE tenant_id = ? AND workspace_id = ? AND coverage_id = ?`,
        [
          actor,
          handoff.tenant_id,
          handoff.workspace_id,
          handoff.coverage_id
        ]
      );
    }
    const updated = this.getHandoff(input.tenant_id, input.handoff_id);
    if (updated) {
      this.runStore?.audit(
        input.tenant_id,
        'geo.handoff.executed',
        'tenant_geo_handoff_packet',
        updated.id,
        {
          status: updated.status,
          place_id: updated.place_id,
          coverage_id: updated.coverage_id,
          execution_artifact_id: executionArtifact?.id || null
        },
        actor
      );
    }
    return updated;
  }

  getLatestDraft(tenantId: string, placeId: string, channel?: string | null): JsonRecord | null {
    const clauses = ['tenant_id = ?', 'place_id = ?'];
    const params: Array<string | number | null> = [tenantId, placeId];
    if (channel) {
      clauses.push('channel = ?');
      params.push(channel);
    }
    return decodeDraft(
      one(
        this.db,
        `SELECT * FROM tenant_geo_outreach_drafts
         WHERE ${clauses.join(' AND ')}
         ORDER BY created_at DESC
         LIMIT 1`,
        params
      )
    );
  }

  getDraft(tenantId: string, draftId: string): JsonRecord | null {
    return decodeDraft(
      one(
        this.db,
        'SELECT * FROM tenant_geo_outreach_drafts WHERE tenant_id = ? AND id = ?',
        [tenantId, draftId]
      )
    );
  }

  chooseTerritory(place: JsonRecord, workspaceId: string, preferredTerritoryId?: string | null): JsonRecord | null {
    if (preferredTerritoryId) {
      return this.getTerritory(place.tenant_id, workspaceId, preferredTerritoryId);
    }
    const candidates = this.listTerritories({
      tenant_id: place.tenant_id,
      workspace_id: workspaceId,
      status: 'active',
      limit: 200
    });
    return candidates
      .map((territory) => ({ territory, score: territoryScore(place, territory) }))
      .sort((left, right) => right.score - left.score || String(left.territory.name).localeCompare(String(right.territory.name)))[0]?.territory || null;
  }

  chooseCoverage(input: JsonRecord, territory: JsonRecord | null, requestedChannel: string): JsonRecord | null {
    if (!territory) {
      return null;
    }
    if (input.coverage_id) {
      return this.getRepCoverage(input.tenant_id, territory.workspace_id, input.coverage_id);
    }
    const candidates = this.listRepCoverages({
      tenant_id: input.tenant_id,
      workspace_id: territory.workspace_id,
      territory_id: territory.territory_id,
      status: 'active',
      limit: 100
    }).filter((coverage) => !coverage.channel || coverage.channel === 'any' || coverage.channel === requestedChannel);
    return candidates
      .map((coverage) => ({ coverage, score: coverageScore(coverage, requestedChannel) }))
      .sort((left, right) => right.score - left.score || String(left.coverage.owner_name || left.coverage.owner_user_id).localeCompare(String(right.coverage.owner_name || right.coverage.owner_user_id)))[0]?.coverage || null;
  }

  generateHandoffPacket(input: JsonRecord, context: JsonRecord = {}): JsonRecord {
    ensureTenant(input);
    if (!input.place_id) {
      throw new Error('place_id is required');
    }
    if (!this.geoStore) {
      throw new Error('Geo store is not configured');
    }
    const place = this.geoStore.getPlace(input.tenant_id, input.place_id);
    if (!place) {
      throw new Error(`Geo place not found: ${input.place_id}`);
    }
    const workspaceId = place.workspace_id || normalizeWorkspaceId(input);
    const territory = this.chooseTerritory(place, workspaceId, input.territory_id);
    const draft = input.draft_id
      ? this.getDraft(input.tenant_id, input.draft_id)
      : this.getLatestDraft(input.tenant_id, place.id, input.channel || null);
    const insight = input.insight_id
      ? this.geoStore.getInsight(input.tenant_id, input.insight_id)
      : this.geoStore.getLatestInsight(input.tenant_id, place.id);
    const requestedChannel = normalizeChannel(input, draft, null, territory);
    const coverage = this.chooseCoverage(input, territory, requestedChannel);
    const recommendedChannel = normalizeChannel(input, draft, coverage, territory);
    const priorityTier = determinePriorityTier(input, territory, insight);
    const queueRouteId = input.queue_route_id || coverage?.queue_route_id || territory?.queue_route_id || 'geo-followup';
    const voiceRouteId = input.voice_route_id || coverage?.voice_route_id || territory?.voice_route_id || 'default';
    const ownerUserId = input.owner_user_id || coverage?.owner_user_id || territory?.default_owner_user_id || null;
    const handoffId = input.handoff_id || id('geo_handoff');
    const recommendedNextAction = input.recommended_next_action
      || (recommendedChannel === 'call_script' ? 'queue_voice_followup' : 'create_crm_task');
    const summary = buildSummary(place, territory, coverage, insight);
    const payload = {
      place,
      insight,
      draft,
      territory,
      rep_coverage: coverage,
      crm_task: {
        title: input.crm_task_title || `Follow up ${place.name}`,
        priority_tier: priorityTier,
        owner_user_id: ownerUserId,
        notes: summary,
      },
      voice_followup: {
        route_id: voiceRouteId,
        queue_route_id: queueRouteId,
        recommended_channel: recommendedChannel,
        script: draft?.message || insight?.summary || `Follow up ${place.name} based on latest geo research.`,
      },
      source_refs: [place.id, insight?.id, draft?.id].filter(Boolean),
    };
    run(
      this.db,
      `INSERT INTO tenant_geo_handoff_packets (
        id, tenant_id, workspace_id, place_id, insight_id, draft_id, territory_id, coverage_id, handoff_type,
        priority_tier, recommended_channel, recommended_next_action, owner_user_id, queue_route_id,
        voice_route_id, summary, payload, status, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        handoffId,
        input.tenant_id,
        workspaceId,
        place.id,
        insight?.id || null,
        draft?.id || null,
        territory?.id || null,
        coverage?.id || null,
        input.handoff_type || 'crm_voice_followup',
        priorityTier,
        recommendedChannel,
        recommendedNextAction,
        ownerUserId,
        queueRouteId,
        voiceRouteId,
        summary,
        json(payload),
        input.status || 'draft',
        input.created_by || context.userId || 'system'
      ]
    );
    const handoff = decodeHandoff(
      one(this.db, 'SELECT * FROM tenant_geo_handoff_packets WHERE tenant_id = ? AND id = ?', [input.tenant_id, handoffId])
    );
    const artifact = this.artifactStore?.commit?.({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      workflow_run_id: context.workflowRunId || null,
      agent_run_id: context.agentRunId || null,
      type: 'geo_handoff_packet',
      status: 'draft',
      payload: {
        handoff,
        territory,
        rep_coverage: coverage,
        place,
        insight,
        draft,
      }
    }) || null;
    if (artifact && handoff) {
      run(
        this.db,
        'UPDATE tenant_geo_handoff_packets SET artifact_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [artifact.id, handoff.id]
      );
    }
    if (handoff) {
      this.runStore?.audit(
        input.tenant_id,
        'geo.handoff.generated',
        'tenant_geo_handoff_packet',
        handoff.id,
        {
          place_id: place.id,
          territory_id: territory?.territory_id || null,
          coverage_id: coverage?.coverage_id || null,
          artifact_id: artifact?.id || null,
          recommended_next_action: recommendedNextAction,
        },
        input.created_by || context.userId || 'system'
      );
    }
    return {
      handoff: decodeHandoff(
        one(this.db, 'SELECT * FROM tenant_geo_handoff_packets WHERE tenant_id = ? AND id = ?', [input.tenant_id, handoffId])
      ),
      territory,
      rep_coverage: coverage,
      artifact,
    };
  }
}
