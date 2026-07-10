import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, id, json, one, parseJson, run, type SqliteParams } from '../../db.js';
import type { CreateVoiceAgentSpecInput, VoiceAgentSpec, VoiceAgentSpecStatus } from './types.js';

const BUILTIN_SPECS: Record<string, VoiceAgentSpec> = {};

function loadBuiltinSpecs(): void {
  if (Object.keys(BUILTIN_SPECS).length) return;
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'data');
  for (const name of ['default-outbound-zh.json']) {
    const raw = readFileSync(join(dir, name), 'utf8');
    const spec = decodeSpec(parseJson(raw, {}));
    BUILTIN_SPECS[spec.id] = spec;
  }
}

export class VoiceAgentSpecStore {
  constructor(private readonly db: unknown) {
    loadBuiltinSpecs();
  }

  getSpec(specId: string, tenantId?: string | null): VoiceAgentSpec | null {
    const row = one(this.db, 'SELECT * FROM voice_agent_specs WHERE id = ?', [specId]);
    if (row) return decodeSpec(row);
    const builtin = BUILTIN_SPECS[specId];
    if (builtin) return { ...builtin, tenant_id: tenantId || builtin.tenant_id };
    return null;
  }

  listSpecs(tenantId: string, status: VoiceAgentSpecStatus | null = null): VoiceAgentSpec[] {
    const conditions = ['tenant_id = ?'];
    const params: SqliteParams = [tenantId];
    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    const rows = all(
      this.db,
      `SELECT * FROM voice_agent_specs WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC`,
      params
    ).map(decodeSpec);

    const builtins = Object.values(BUILTIN_SPECS).filter(
      (spec) => !rows.some((row) => row.id === spec.id)
    );
    return [...builtins, ...rows];
  }

  createSpec(input: CreateVoiceAgentSpecInput): VoiceAgentSpec {
    const specId = input.id || id('vaspec');
    const spec: VoiceAgentSpec = {
      id: specId,
      tenant_id: input.tenant_id,
      language: input.language || 'zh',
      goal: input.goal || '',
      status: input.status || 'draft',
      version: input.version ?? 1,
      tools: input.tools || ['check_intent', 'transfer_human', 'schedule_callback'],
      compliance: input.compliance || {},
      runtime: input.runtime,
      nodes: input.nodes || []
    };
    run(
      this.db,
      `INSERT INTO voice_agent_specs
        (id, tenant_id, language, goal, status, version, tools, compliance, runtime, nodes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        spec.id,
        spec.tenant_id,
        spec.language,
        spec.goal,
        spec.status,
        spec.version,
        json(spec.tools),
        json(spec.compliance),
        json(spec.runtime),
        json(spec.nodes)
      ]
    );
    return this.getSpec(spec.id, spec.tenant_id)!;
  }

  publishSpec(specId: string, tenantId: string): VoiceAgentSpec | null {
    const existing = this.getSpec(specId, tenantId);
    if (!existing || existing.tenant_id !== tenantId) return null;
    if (existing.tenant_id === '') return null;
    run(
      this.db,
      `UPDATE voice_agent_specs SET status = 'published', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?`,
      [specId, tenantId]
    );
    return this.getSpec(specId, tenantId);
  }
}

function parseJsonField<T>(value: unknown, fallback: T): T {
  if (value !== null && value !== undefined && typeof value === 'object') {
    return value as T;
  }
  return parseJson(String(value || '{}'), fallback) as T;
}

function decodeSpec(row: Record<string, unknown>): VoiceAgentSpec {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id || ''),
    language: String(row.language || 'zh') as VoiceAgentSpec['language'],
    goal: String(row.goal || ''),
    status: String(row.status || 'draft') as VoiceAgentSpecStatus,
    version: Number(row.version || 1),
    tools: parseJsonField<string[]>(row.tools, []),
    compliance: parseJsonField(row.compliance, {}),
    runtime: parseJsonField(row.runtime, { system_prompt: '', greeting: '' }),
    nodes: parseJsonField(row.nodes, [])
  };
}
