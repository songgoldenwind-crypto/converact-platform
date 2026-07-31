import type { PgQueryable } from '../../../../db-pg.js';
import type { IvrDependencyManifest, IvrSubflowDependency } from '../dependencies.js';
import type { IvrDependencyResolver } from '../ports.js';
import type { IvrValidationIssue } from '../validation.js';
import { jsonRecord, numberValue, type IvrPgRow } from './row-utils.js';

const RESOURCE_TABLES = {
  audio_assets: 'ivekit_ivr_audio_assets',
  time_groups: 'ivekit_ivr_time_groups',
  region_groups: 'ivekit_ivr_region_groups',
  ring_groups: 'ivekit_ivr_ring_groups'
} as const;

type ManagedDependencyKind = keyof typeof RESOURCE_TABLES;

export class PostgresIvrDependencyResolver implements IvrDependencyResolver {
  constructor(private readonly pg: PgQueryable) {}

  async validate(input: {
    tenant_id: string;
    flow_id: string;
    dependencies: IvrDependencyManifest;
  }): Promise<IvrValidationIssue[]> {
    const issues: IvrValidationIssue[] = [];
    for (const kind of Object.keys(RESOURCE_TABLES) as ManagedDependencyKind[]) {
      issues.push(...await this.#validateManaged(input.tenant_id, kind, input.dependencies[kind]));
    }
    const settings = await this.#settings(input.tenant_id);
    issues.push(...validateAllowlist('webhook_refs', input.dependencies.webhook_refs, settings.allowed_webhook_refs));
    for (const kind of ['queues', 'knowledge_profiles', 'ai_profiles', 'media_capabilities'] as const) {
      issues.push(...validateAllowlist(kind, input.dependencies[kind], settings.dependency_refs[kind]));
    }
    issues.push(...await this.#validateProfiles(input.tenant_id, input.dependencies));
    issues.push(...await this.#validateSubflows(
      input.tenant_id,
      input.flow_id,
      input.dependencies.subflows,
      settings.max_subflow_depth
    ));
    return issues;
  }

  async #validateManaged(
    tenantId: string,
    kind: ManagedDependencyKind,
    ids: string[]
  ): Promise<IvrValidationIssue[]> {
    if (ids.length === 0) return [];
    const result = await this.pg.query<IvrPgRow>(
      `SELECT id, status FROM ${RESOURCE_TABLES[kind]}
       WHERE tenant_id = $1 AND id = ANY($2::text[])
       ORDER BY id FOR SHARE`,
      [tenantId, ids]
    );
    const states = new Map(result.rows.map((row) => [String(row.id), String(row.status)]));
    return ids.flatMap((id) => states.get(id) === 'active'
      ? []
      : [unavailable(kind, id, states.has(id) ? 'disabled' : 'missing')]);
  }

  async #validateProfiles(
    tenantId: string,
    dependencies: IvrDependencyManifest
  ): Promise<IvrValidationIssue[]> {
    const ids = dependencies.provider_profile_ids;
    const result = await this.pg.query<IvrPgRow>(
      `SELECT profile.id, profile.status,
              COALESCE(snapshot.status, '') AS capability_status,
              COALESCE(snapshot.capabilities, '{}'::jsonb) AS capabilities
       FROM ivekit_voice_deployment_profiles profile
       LEFT JOIN LATERAL (
         SELECT status, capabilities
         FROM ivekit_voice_capability_snapshots candidate
         WHERE candidate.tenant_id = profile.tenant_id
           AND candidate.profile_id = profile.id
         ORDER BY candidate.checked_at DESC, candidate.id DESC LIMIT 1
       ) snapshot ON TRUE
       WHERE profile.tenant_id = $1
         AND ($2::text[] = ARRAY[]::text[] OR profile.id = ANY($2::text[]))
         AND profile.status IN ('enabled', 'degraded')
       ORDER BY profile.id FOR SHARE OF profile`,
      [tenantId, ids]
    );
    const byId = new Map(result.rows.map((row) => [String(row.id), row]));
    const issues = ids.flatMap((id) => byId.has(id)
      ? []
      : [unavailable('provider_profile_ids', id, 'missing_or_disabled')]);
    if (dependencies.voice_capabilities.length === 0) return issues;
    const candidates = ids.length > 0 ? ids.map((id) => byId.get(id)).filter(Boolean) : result.rows;
    const stepReady = candidates.some((row) => {
      const capabilities = jsonRecord(row!.capabilities);
      return row!.capability_status === 'ready' && capabilities.step_ivr === true;
    });
    if (!stepReady) {
      issues.push({
        code: 'dependency_unavailable',
        message: 'voice actions require an enabled profile with a ready step_ivr capability',
        path: 'dependencies.voice_capabilities'
      });
    }
    return issues;
  }

  async #validateSubflows(
    tenantId: string,
    rootFlowId: string,
    dependencies: IvrSubflowDependency[],
    maxDepth: number
  ): Promise<IvrValidationIssue[]> {
    const issues: IvrValidationIssue[] = [];
    const visited = new Set<string>();
    const walk = async (
      entries: IvrSubflowDependency[],
      ancestors: ReadonlySet<string>,
      depth: number
    ): Promise<void> => {
      if (depth > maxDepth) {
        issues.push({
          code: 'subflow_depth_exceeded', message: 'subflow dependency depth exceeds tenant settings',
          path: 'dependencies.subflows'
        });
        return;
      }
      for (const entry of entries) {
        if (entry.flow_id === rootFlowId || ancestors.has(entry.flow_id)) {
          issues.push({
            code: 'recursive_subflow', message: `recursive subflow dependency: ${entry.flow_id}`,
            path: 'dependencies.subflows'
          });
          continue;
        }
        const resolved = await this.#subflow(tenantId, entry);
        if (!resolved) {
          issues.push(unavailable('subflows', entry.flow_id, 'missing_or_unpublished'));
          continue;
        }
        const key = `${resolved.flow_id}:${resolved.version}`;
        if (visited.has(key)) continue;
        visited.add(key);
        await walk(
          subflowsFrom(resolved.dependencies),
          new Set([...ancestors, entry.flow_id]),
          depth + 1
        );
      }
    };
    await walk(dependencies, new Set([rootFlowId]), 1);
    return issues;
  }

  async #subflow(
    tenantId: string,
    dependency: IvrSubflowDependency
  ): Promise<{ flow_id: string; version: number; dependencies: Record<string, unknown> } | null> {
    const result = await this.pg.query<IvrPgRow>(
      `SELECT flow.id AS flow_id, version.version, version.dependencies
       FROM ivekit_ivr_flows flow
       JOIN ivekit_ivr_flow_versions version
         ON version.tenant_id = flow.tenant_id
        AND version.flow_id = flow.id
        AND version.version = COALESCE($3::integer, flow.current_published_version)
       WHERE flow.tenant_id = $1 AND flow.id = $2 AND flow.status = 'published'
       FOR SHARE OF flow`,
      [tenantId, dependency.flow_id, dependency.version ?? null]
    );
    const row = result.rows[0];
    return row ? {
      flow_id: String(row.flow_id),
      version: numberValue(row.version),
      dependencies: jsonRecord(row.dependencies)
    } : null;
  }

  async #settings(tenantId: string): Promise<{
    allowed_webhook_refs: string[];
    dependency_refs: Record<'queues' | 'knowledge_profiles' | 'ai_profiles' | 'media_capabilities', string[]>;
    max_subflow_depth: number;
  }> {
    const result = await this.pg.query<IvrPgRow>(
      `SELECT allowed_webhook_refs, execution_policy, max_subflow_depth
       FROM ivekit_ivr_settings WHERE tenant_id = $1 ORDER BY created_at, id LIMIT 1 FOR SHARE`,
      [tenantId]
    );
    const row = result.rows[0];
    const policy = jsonRecord(row?.execution_policy);
    const refs = jsonRecord(policy.dependency_refs);
    return {
      allowed_webhook_refs: stringList(row?.allowed_webhook_refs),
      dependency_refs: {
        queues: stringList(refs.queues),
        knowledge_profiles: stringList(refs.knowledge_profiles),
        ai_profiles: stringList(refs.ai_profiles),
        media_capabilities: stringList(refs.media_capabilities)
      },
      max_subflow_depth: row ? numberValue(row.max_subflow_depth) : 10
    };
  }
}

function validateAllowlist(
  kind: string,
  required: string[],
  allowed: string[]
): IvrValidationIssue[] {
  const allowlist = new Set(allowed);
  return required.flatMap((id) => allowlist.has(id)
    ? []
    : [unavailable(kind, id, 'not_bound')]);
}

function unavailable(kind: string, id: string, reason: string): IvrValidationIssue {
  return {
    code: 'dependency_unavailable',
    message: `${kind} dependency ${id} is unavailable (${reason})`,
    path: `dependencies.${kind}`
  };
}

function subflowsFrom(value: Record<string, unknown>): IvrSubflowDependency[] {
  const entries = value.subflows;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.flow_id !== 'string') return [];
    return [{
      flow_id: record.flow_id,
      ...(Number.isInteger(record.version) ? { version: Number(record.version) } : {})
    }];
  });
}

function stringList(value: unknown): string[] {
  const parsed = typeof value === 'string' ? parse(value) : value;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
}

function parse(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { return []; }
}
