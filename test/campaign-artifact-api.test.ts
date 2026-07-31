import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createServer } from '../src/http.js';
import { listenOnRandomPort } from './test-helpers.js';

const db = createDatabase(':memory:');
const server = createServer(db);
let baseUrl = '';

before(async () => {
  const port = await listenOnRandomPort(server);
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('campaign artifact API persists and returns the latest weekly campaign snapshot', async () => {
  const tenant = await post('/api/tenants', { name: 'Campaign Artifact 公司' });

  const created = await post('/api/campaign-artifacts', {
    tenant_id: tenant.id,
    snapshot: {
      goal: '本周多拿 10 个高质量咨询',
      recipeId: 'ten-consultations',
      metrics: [{ label: '线索', value: 3 }],
      steps: [{ label: '目标', title: '本周多拿 10 个高质量咨询', status: 'done' }]
    }
  });

  assert.equal(created.artifact.type, 'marketing_campaign_snapshot');
  assert.equal(created.artifact.payload.goal, '本周多拿 10 个高质量咨询');

  const latest = await get(`/api/campaign-artifacts/latest?tenant_id=${encodeURIComponent(tenant.id)}`);
  assert.equal(latest.artifact.type, 'marketing_campaign_snapshot');
  assert.equal(latest.artifact.payload.recipeId, 'ten-consultations');
});

async function post<T = any>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = (await response.json()) as T;
  assert.equal(response.ok, true, JSON.stringify(data));
  return data;
}

async function get<T = any>(path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`);
  const data = (await response.json()) as T;
  assert.equal(response.ok, true, JSON.stringify(data));
  return data;
}
