import assert from 'node:assert/strict';
import test from 'node:test';
import type { QueryResult, QueryResultRow } from 'pg';

import type { PgQueryable } from '../src/db-pg.js';
import {
  PostgresIvrDependencyResolver,
  type IvrDependencyManifest
} from '../src/agent-runtime/converact/ivr/index.js';

test('Postgres IVR dependency resolver blocks missing resources and unbound external capabilities', async () => {
  const pg = new ScriptedPg((sql) => {
    if (sql.includes('ivekit_ivr_audio_assets')) return [{ id: 'audio-ready', status: 'active' }];
    if (sql.includes('FROM ivekit_ivr_settings')) return [{
      allowed_webhook_refs: ['webhook-safe'],
      execution_policy: { dependency_refs: { media_capabilities: ['screen_share'] } },
      max_subflow_depth: 5
    }];
    if (sql.includes('ivekit_voice_deployment_profiles')) return [{
      id: 'voice-main', status: 'enabled', capability_status: 'ready', capabilities: { step_ivr: true }
    }];
    return [];
  });
  const resolver = new PostgresIvrDependencyResolver(pg);
  const issues = await resolver.validate({
    tenant_id: 'tenant-a', flow_id: 'flow-main',
    dependencies: manifest({
      audio_assets: ['audio-ready', 'audio-missing'],
      webhook_refs: ['webhook-safe', 'webhook-missing'],
      media_capabilities: ['screen_share', 'video_play'],
      provider_profile_ids: ['voice-main'],
      voice_capabilities: ['play']
    })
  });

  assert.deepEqual(issues.map((issue) => issue.path), [
    'dependencies.audio_assets',
    'dependencies.webhook_refs',
    'dependencies.media_capabilities'
  ]);
  assert.match(issues[0]!.message, /audio-missing/);
});

test('Postgres IVR dependency resolver detects recursive published subflows', async () => {
  const pg = new ScriptedPg((sql, params) => {
    if (sql.includes('FROM ivekit_ivr_settings')) return [];
    if (sql.includes('ivekit_voice_deployment_profiles')) return [];
    if (sql.includes('JOIN ivekit_ivr_flow_versions')) return [{
      flow_id: String(params[1]), version: 2,
      dependencies: { subflows: [{ flow_id: 'flow-root', version: 1 }] }
    }];
    return [];
  });
  const issues = await new PostgresIvrDependencyResolver(pg).validate({
    tenant_id: 'tenant-a', flow_id: 'flow-root',
    dependencies: manifest({ subflows: [{ flow_id: 'flow-child', version: 2 }] })
  });
  assert.equal(issues.some((issue) => issue.code === 'recursive_subflow'), true);
});

class ScriptedPg implements PgQueryable {
  constructor(private readonly rows: (sql: string, params: unknown[]) => QueryResultRow[]) {}

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = []
  ): Promise<QueryResult<R>> {
    const rows = this.rows(text, params) as R[];
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
  }
}

function manifest(overrides: Partial<IvrDependencyManifest>): IvrDependencyManifest {
  return {
    node_types: [], audio_assets: [], time_groups: [], region_groups: [], ring_groups: [],
    queues: [], subflows: [], webhook_refs: [], knowledge_profiles: [], ai_profiles: [],
    provider_profile_ids: [], media_capabilities: [], voice_capabilities: [],
    ...overrides
  };
}
