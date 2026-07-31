import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('Commander HTTP API routes and executes a CRM task playbook', async () => {
  const tenant = await post('/api/tenants', { name: 'Commander API 公司' });
  const route = await post('/api/commander/route', {
    tenant_id: tenant.id,
    goal: '创建一个跟进任务',
    object_type: 'lead',
    object_id: 'lead_api',
    title: '跟进 lead_api'
  });

  assert.equal(route.playbook_id, 'crm_agent.create_followup_task.v1');

  const run = await post('/api/commander/run', {
    tenant_id: tenant.id,
    goal: '创建一个跟进任务',
    object_type: 'lead',
    object_id: 'lead_api',
    title: '跟进 lead_api',
    priority: 'P1'
  });

  assert.equal(run.status, 'completed');
  assert.equal(run.artifacts[0].type, 'crm_task_plan');
});

test('Commander and Today home keep mainline mounts', async () => {
  const response = await fetch(baseUrl);
  const html = await response.text();
  const appJs = readFileSync(new URL('../public/assets/app.js', import.meta.url), 'utf8');

  assert.equal(response.ok, true);
  assert.match(html, /Commander \/ Today \/ Result/);
  assert.match(html, /support shell|支撑 shell/);
  assert.match(appJs, /support shell|支撑 shell/);
  assert.match(html, /id="commander-hero-shell"/);
  assert.match(html, /id="commander-command-deck"/);
  assert.match(html, /id="commander-summary-rail"/);
  assert.match(html, /id="commander-workflow-rail"/);
  assert.match(html, /id="commander-goal-guard"/);
  assert.match(html, /id="commander-run-brief"/);
  assert.match(html, /id="commander-priority-entry"/);
  assert.match(html, /id="today-mainline-strip"/);
  assert.match(html, /id="today-inline-writeback-panel"/);
  assert.match(html, /id="today-next-step-timer-card"/);
  assert.match(html, /id="lead-run-result-summary-strip"/);
  assert.match(html, /id="mobile-mainline-dock"/);
  assert.match(appJs, /renderLeadWorkOrderCard/);
  assert.match(appJs, /renderLeadAutonomyPolicyCard/);
  assert.match(appJs, /renderLeadRunProgressCard/);
  assert.match(appJs, /renderCrossSourceCapturePlanCard/);
  assert.match(appJs, /renderSourceCaptureAttemptPacketCard/);
  assert.match(appJs, /renderLeadEvidenceBundleCard/);
  assert.match(appJs, /lead-mainline-control-rail/);
  assert.match(appJs, /agent_work_order/);
  assert.match(appJs, /run_autonomy_policy/);
  assert.match(appJs, /agent_run_progress_packet/);
  assert.match(appJs, /source_mission_autopilot_packet/);
  assert.match(appJs, /cross_source_capture_plan/);
  assert.match(appJs, /source_capture_attempt_packet/);
  assert.match(appJs, /candidate_verification_packet/);
  assert.match(appJs, /lead_evidence_bundle/);
  assert.match(appJs, /non_phone_execution_pack/);
  assert.match(appJs, /channel_receipt_packet/);
  assert.match(appJs, /autonomous_import_decision_packet/);
  assert.match(appJs, /first_touch_action_pack/);
  assert.match(appJs, /channel_action_risk_packet/);
  assert.match(appJs, /agent_delivery_result_pack/);
  assert.match(appJs, /commander_goal_summary/);
  assert.match(appJs, /commander_progress_strip/);
  assert.match(appJs, /commander_pending_confirmations/);
  assert.match(appJs, /commander_today_primary_action/);
  assert.match(appJs, /today_lead_context/);
  assert.match(appJs, /today_channel_decision/);
  assert.match(appJs, /today_action_bar/);
  assert.match(appJs, /result_delivery_summary/);
  assert.match(appJs, /result_handoff_pack/);
  assert.match(appJs, /run_autonomous_loop_packet/);
  assert.match(appJs, /autonomous_stop_reason_card/);
  assert.match(appJs, /founder_intervention_resume_pack/);
  assert.match(appJs, /service_delivery_readiness_gate/);
  assert.match(appJs, /autonomous_step_trigger_bridge/);
  assert.match(appJs, /reply_intent_packet/);
  assert.match(appJs, /non_phone_outcome_proof_packet/);
  assert.match(appJs, /renderReplyIntentCard/);
  assert.match(appJs, /renderNonPhoneOutcomeProofCard/);
  assert.match(appJs, /!runAutoLoop && !autoStopReason && !founderIntervention && !deliveryGate && !stepTriggerBridge && !replyIntent && !nonPhoneOutcomeProof\) return '';/);
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
