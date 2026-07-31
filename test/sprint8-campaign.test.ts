import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { useMemoryRedisForTests } from '../src/agent-runtime/call-center/call-center-runtime.js';
import { AgentSeatStore } from '../src/agent-runtime/call-center/seat-store.js';
import { OutboundTaskStore } from '../src/agent-runtime/call-center/outbound-task-store.js';
import { VoiceStore } from '../src/agent-runtime/voice/voice-store.js';
import {
  OutboundCampaignStore,
  resolveCampaignSpecId
} from '../src/agent-runtime/call-center/dialer/campaign-store.js';
import { CampaignLauncher } from '../src/agent-runtime/call-center/dialer/campaign-service.js';
import {
  PostCallSurveyStore,
  buildPostCallSurveyIvrPrompt
} from '../src/agent-runtime/call-center/dialer/post-call-survey.js';
import {
  computePredictiveDialPlan,
  computeProgressiveDialCap,
  isPreviewReady,
  isPreviewStrategy,
  isProgressiveStrategy,
  isPredictiveStrategy
} from '../src/agent-runtime/call-center/dialer/predictive-engine.js';
import { routeCampaignApi } from '../src/agent-runtime/call-center/dialer/campaign-http.js';
import {
  computeScheduleAdherence,
  createShiftSwapRequest,
  listShiftSwapRequests,
  resolveShiftSwapRequest
} from '../src/agent-runtime/call-center/wfm/adherence.js';
import { WfmStore } from '../src/agent-runtime/call-center/wfm/wfm-store.js';
import { routeWfmApi } from '../src/agent-runtime/call-center/wfm/wfm-http.js';

const API_KEY = 'test-sprint8-key';

function authHeaders(tenantId: string): Record<string, string> {
  return { 'X-API-Key': API_KEY, 'X-Tenant-Id': tenantId };
}

before(() => {
  useMemoryRedisForTests();
  process.env.OPC_API_KEY = API_KEY;
});

describe('Sprint 8 campaign store & launcher', () => {
  it('creates campaign, adds contacts, and computes stats', () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'Campaign Store' });
    const store = new OutboundCampaignStore(db);

    const campaign = store.createCampaign({
      tenant_id: tenant.id,
      name: 'June Outreach',
      dial_mode: 'predictive',
      agent_spec_id_a: 'spec-a',
      agent_spec_id_b: 'spec-b',
      ab_enabled: true
    });
    assert.ok(campaign.id.startsWith('ocamp_'));
    assert.equal(campaign.status, 'draft');

    const contacts = store.addContacts(campaign.id, tenant.id, [
      { phone_number: '+8613800000001', display_name: 'Alice' },
      { phone_number: '+8613800000002', display_name: 'Bob' }
    ]);
    assert.equal(contacts.length, 2);
    assert.ok(['A', 'B'].includes(contacts[0].ab_variant));

    const stats = store.getStats(campaign.id);
    assert.equal(stats.total_contacts, 2);
    assert.equal(stats.pending, 2);
    assert.equal(stats.completed, 0);
  });

  it('launches campaign and creates outbound tasks', () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'Launch' });
    const campaignStore = new OutboundCampaignStore(db);
    const taskStore = new OutboundTaskStore(db);
    const launcher = new CampaignLauncher(db, campaignStore, taskStore);

    const campaign = campaignStore.createCampaign({
      tenant_id: tenant.id,
      name: 'Launch Test',
      dial_mode: 'progressive',
      agent_spec_id_a: 'spec-a'
    });
    campaignStore.addContacts(campaign.id, tenant.id, [
      { phone_number: '+8613900000001' },
      { phone_number: '+8613900000002' }
    ]);

    const result = launcher.launch(campaign.id, tenant.id, { limit: 10 });
    assert.equal(result.tasks_created, 2);
    assert.equal(result.tasks[0].campaign_id, campaign.id);
    assert.equal(isProgressiveStrategy(result.tasks[0].strategy), true);

    const updated = campaignStore.getCampaign(campaign.id)!;
    assert.equal(updated.status, 'active');

    const contacts = campaignStore.listContacts(campaign.id, 'dialed');
    assert.equal(contacts.length, 2);
  });

  it('resolveCampaignSpecId picks A/B variant', () => {
    const campaign = {
      ab_enabled: true,
      agent_spec_id_a: 'spec-a',
      agent_spec_id_b: 'spec-b'
    } as Parameters<typeof resolveCampaignSpecId>[0];
    assert.equal(resolveCampaignSpecId(campaign, 'A'), 'spec-a');
    assert.equal(resolveCampaignSpecId(campaign, 'B'), 'spec-b');
  });

  it('reportOutcome updates contact and stats', () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'Outcome' });
    const campaignStore = new OutboundCampaignStore(db);
    const taskStore = new OutboundTaskStore(db);
    const launcher = new CampaignLauncher(db, campaignStore, taskStore);

    const campaign = campaignStore.createCampaign({
      tenant_id: tenant.id,
      name: 'Outcome',
      agent_spec_id_a: 'spec-a'
    });
    const [contact] = campaignStore.addContacts(campaign.id, tenant.id, [
      { phone_number: '+8613700000001' }
    ]);
    launcher.launch(campaign.id, tenant.id);

    launcher.reportOutcome({
      campaign_id: campaign.id,
      campaign_contact_id: contact.id,
      disposition: 'interested',
      success: true
    });

    const updated = campaignStore.getContact(contact.id)!;
    assert.equal(updated.status, 'completed');
    assert.equal(updated.disposition, 'interested');
    const stats = campaignStore.getStats(campaign.id);
    assert.equal(stats.completed, 1);
  });
});

describe('Sprint 8 preview dial & predictive engine', () => {
  it('preview launch assigns seat and requires confirmation', () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'Preview' });
    const seatStore = new AgentSeatStore(db);
    const seat = seatStore.upsertSeat({
      tenant_id: tenant.id,
      user_id: 'u-preview',
      display_name: 'Preview Agent'
    });

    const campaignStore = new OutboundCampaignStore(db);
    const taskStore = new OutboundTaskStore(db);
    const launcher = new CampaignLauncher(db, campaignStore, taskStore);

    const campaign = campaignStore.createCampaign({
      tenant_id: tenant.id,
      name: 'Preview Camp',
      dial_mode: 'preview',
      agent_spec_id_a: 'spec-a'
    });
    campaignStore.addContacts(campaign.id, tenant.id, [{ phone_number: '+8613600000001' }]);
    const launched = launcher.launch(campaign.id, tenant.id, {
      limit: 5,
      assigned_seat_id: seat.id
    });
    const task = launched.tasks[0];
    assert.equal(isPreviewStrategy(task.strategy), true);
    assert.equal(isPreviewReady(task.strategy), false);

    const queue = taskStore.listPreviewTasksForSeat(tenant.id, seat.id);
    assert.equal(queue.length, 1);

    const confirmed = taskStore.confirmPreviewDial(task.id)!;
    assert.equal(isPreviewReady(confirmed.strategy), true);
    assert.equal(taskStore.listPreviewTasksForSeat(tenant.id, seat.id).length, 0);
  });

  it('predictive and progressive helpers behave', () => {
    assert.equal(isPredictiveStrategy({ dial_mode: 'predictive' }), true);
    assert.equal(computeProgressiveDialCap(3, 1), 2);

    const plan = computePredictiveDialPlan({
      idleAgents: 4,
      busyAgents: 1,
      ringingCalls: 0,
      answerRate: 0.35,
      abandonRate: 0.01
    });
    assert.ok(plan.concurrentDials >= 1);
    assert.ok(plan.dialLevel >= 1);
  });
});

describe('Sprint 8 post-call survey', () => {
  it('creates survey and computes average score', () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'Survey' });
    const voiceStore = new VoiceStore(db);
    const session = voiceStore.createCallSession({
      tenant_id: tenant.id,
      direction: 'outbound',
      rustpbx_call_id: 'c-survey',
      phone: '+8613500000001',
      status: 'completed'
    });

    const surveyStore = new PostCallSurveyStore(db);
    surveyStore.createSurvey({
      tenant_id: tenant.id,
      call_session_id: session.id,
      score: 5,
      comment: 'Great'
    });
    surveyStore.createSurvey({
      tenant_id: tenant.id,
      call_session_id: session.id,
      score: 3
    });

    const avg = surveyStore.getAverageScore(tenant.id);
    assert.equal(avg, 4);
    assert.ok(buildPostCallSurveyIvrPrompt().includes('打分'));
  });
});

describe('Sprint 8 campaign HTTP routes', () => {
  it('CRUD campaign, launch, preview-dial, surveys via HTTP', async () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'HTTP Campaign' });
    const seatStore = new AgentSeatStore(db);
    const seat = seatStore.upsertSeat({
      tenant_id: tenant.id,
      user_id: 'u-http',
      display_name: 'HTTP Agent'
    });
    const headers = authHeaders(tenant.id);
    const voiceStore = new VoiceStore(db);
    const session = voiceStore.createCallSession({
      tenant_id: tenant.id,
      direction: 'outbound',
      rustpbx_call_id: 'c-http',
      phone: '+8613400000001',
      status: 'completed'
    });

    const created = (await routeCampaignApi(
      db,
      'POST',
      '/api/call-center/campaigns',
      new URL('http://localhost/api/call-center/campaigns'),
      {
        name: 'HTTP Camp',
        dial_mode: 'preview',
        agent_spec_id_a: 'spec-a'
      },
      headers
    )) as { status: number; data: { id: string } };
    assert.equal(created.status, 201);
    const campaignId = created.data.id;

    const contacts = (await routeCampaignApi(
      db,
      'POST',
      `/api/call-center/campaigns/${campaignId}/contacts`,
      new URL(`http://localhost/api/call-center/campaigns/${campaignId}/contacts`),
      { contacts: [{ phone_number: '+8613411111111', display_name: 'HTTP Lead' }] },
      headers
    )) as { data: unknown[] };
    assert.equal(contacts.data.length, 1);

    await routeCampaignApi(
      db,
      'PUT',
      `/api/call-center/campaigns/${campaignId}/status`,
      new URL(`http://localhost/api/call-center/campaigns/${campaignId}/status`),
      { status: 'active' },
      headers
    );

    const launch = (await routeCampaignApi(
      db,
      'POST',
      `/api/call-center/campaigns/${campaignId}/launch`,
      new URL(`http://localhost/api/call-center/campaigns/${campaignId}/launch`),
      { limit: 5, assigned_seat_id: seat.id },
      headers
    )) as { data: { tasks_created: number; tasks: Array<{ id: string }> } };
    assert.equal(launch.data.tasks_created, 1);

    const previewQueue = (await routeCampaignApi(
      db,
      'GET',
      '/api/call-center/outbound-tasks/preview-queue',
      new URL(`http://localhost/api/call-center/outbound-tasks/preview-queue?seat_id=${seat.id}`),
      null,
      headers
    )) as { data: unknown[] };
    assert.equal(previewQueue.data.length, 1);

    const taskId = launch.data.tasks[0].id;
    const confirmed = (await routeCampaignApi(
      db,
      'POST',
      `/api/call-center/outbound-tasks/${taskId}/preview-dial`,
      new URL(`http://localhost/api/call-center/outbound-tasks/${taskId}/preview-dial`),
      {},
      headers
    )) as { data: { strategy: Record<string, unknown> } };
    assert.equal(confirmed.data.strategy.preview_confirmed, true);

    const survey = (await routeCampaignApi(
      db,
      'POST',
      '/api/call-center/surveys',
      new URL('http://localhost/api/call-center/surveys'),
      {
        tenant_id: tenant.id,
        call_session_id: session.id,
        campaign_id: campaignId,
        score: 4,
        channel: 'ivr'
      },
      headers
    )) as { status: number; data: { score: number } };
    assert.equal(survey.status, 201);
    assert.equal(survey.data.score, 4);

    const ivrSurvey = (await routeCampaignApi(
      db,
      'POST',
      `/api/call-center/surveys/ivr/${session.id}`,
      new URL(`http://localhost/api/call-center/surveys/ivr/${session.id}`),
      { tenant_id: tenant.id, digit: '5', campaign_id: campaignId },
      headers
    )) as { status: number; data: { score: number } };
    assert.equal(ivrSurvey.status, 201);
    assert.equal(ivrSurvey.data.score, 5);

    const list = (await routeCampaignApi(
      db,
      'GET',
      '/api/call-center/surveys',
      new URL('http://localhost/api/call-center/surveys'),
      null,
      headers
    )) as { data: { surveys: unknown[]; average_score: number } };
    assert.ok(list.data.surveys.length >= 2);
    assert.ok(list.data.average_score > 0);
  });
});

describe('Sprint 8 WFM adherence & shift swap', () => {
  it('computes adherence rows for scheduled seats', () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'Adherence' });
    const wfmStore = new WfmStore(db);
    const seatStore = new AgentSeatStore(db);
    const seat = seatStore.upsertSeat({
      tenant_id: tenant.id,
      user_id: 'u-adh',
      display_name: 'Adh Agent'
    });
    seatStore.updateStatus(tenant.id, seat.id, 'idle');

    const today = new Date().toISOString().slice(0, 10);
    wfmStore.createSchedule({
      tenant_id: tenant.id,
      agent_seat_id: seat.id,
      date: today,
      shift_start: '00:00',
      shift_end: '23:59'
    });

    const rows = computeScheduleAdherence(db, seatStore, wfmStore, tenant.id, today);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].scheduled, true);
    assert.equal(rows[0].seat_id, seat.id);
  });

  it('shift swap request lifecycle via HTTP', async () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'Swap' });
    const wfmStore = new WfmStore(db);
    const seatStore = new AgentSeatStore(db);
    const requester = seatStore.upsertSeat({
      tenant_id: tenant.id,
      user_id: 'u-req',
      display_name: 'Requester'
    });
    const target = seatStore.upsertSeat({
      tenant_id: tenant.id,
      user_id: 'u-tgt',
      display_name: 'Target'
    });
    const sched = wfmStore.createSchedule({
      tenant_id: tenant.id,
      agent_seat_id: requester.id,
      date: '2026-06-25',
      shift_start: '09:00',
      shift_end: '17:00'
    });

    const created = createShiftSwapRequest(db, {
      tenant_id: tenant.id,
      requester_seat_id: requester.id,
      target_seat_id: target.id,
      schedule_id: sched.id,
      reason: 'family event'
    });
    assert.equal(created.status, 'pending');

    const listed = listShiftSwapRequests(db, tenant.id, 'pending');
    assert.equal(listed.length, 1);

    const httpCreated = (await routeWfmApi(
      db,
      'POST',
      '/api/wfm/shift-swaps',
      new URL('http://localhost/api/wfm/shift-swaps'),
      {
        tenant_id: tenant.id,
        requester_seat_id: requester.id,
        schedule_id: sched.id,
        reason: 'via http'
      },
      authHeaders(tenant.id)
    )) as { status: number; data: { id: string } };
    assert.equal(httpCreated.status, 201);
    assert.ok(httpCreated.data.id);

    const adherenceResult = (await routeWfmApi(
      db,
      'GET',
      '/api/wfm/adherence',
      new URL(`http://localhost/api/wfm/adherence?tenant_id=&date=2026-06-25`),
      null,
      authHeaders(tenant.id)
    )) as { data: unknown[] };
    assert.ok(Array.isArray(adherenceResult.data));
    assert.ok(adherenceResult.data.length >= 2);

    const resolved = resolveShiftSwapRequest(
      db,
      created.id,
      tenant.id,
      'reviewer-1',
      'approved',
      'ok'
    );
    assert.equal(resolved?.status, 'approved');
  });
});
