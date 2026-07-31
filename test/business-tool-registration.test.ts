import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createHarness } from '../src/agent-runtime/index.js';

const EXPECTED_BUSINESS_TOOLS = [
  'channel.create',
  'source_tag.create',
  'landing_page.create',
  'event.track',
  'lead.capture_from_form',
  'crm.create_task',
  'crm.complete_task',
  'crm.reschedule_task',
  'analytics.compute_funnel',
  'analytics.channel_report',
  'analytics.page_report',
  'analytics.weekly_report'
];

test('createHarness registers all business tools that HTTP routes depend on', () => {
  const db = createDatabase(':memory:');
  const harness = createHarness(db);
  const registered = new Set(harness.toolRegistry.list().map((t) => t.tool_id));

  const missing = EXPECTED_BUSINESS_TOOLS.filter((id) => !registered.has(id));
  assert.deepEqual(missing, [], `unregistered business tools: ${missing.join(', ')}`);
});
