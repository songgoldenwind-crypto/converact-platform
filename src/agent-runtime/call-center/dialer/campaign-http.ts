import { resolveAuthContext } from '../../../middleware/auth.js';
import { OutboundCampaignStore } from './campaign-store.js';
import { CampaignLauncher } from './campaign-service.js';
import { OutboundTaskStore } from '../outbound-task-store.js';
import { PostCallSurveyStore } from './post-call-survey.js';

function requireAuth(headers: Record<string, string | string[] | undefined>) {
  const ctx = resolveAuthContext(headers);
  if (!ctx.authenticated || !ctx.tenantId) {
    throw Object.assign(new Error('authentication required'), { status: 401 });
  }
  return ctx;
}

export async function routeCampaignApi(
  db: unknown,
  method: string,
  path: string,
  url: URL,
  body: unknown,
  headers: Record<string, string | string[] | undefined>
): Promise<unknown | undefined> {
  const store = new OutboundCampaignStore(db);
  const taskStore = new OutboundTaskStore(db);
  const launcher = new CampaignLauncher(db, store, taskStore);

  if (path === '/api/call-center/campaigns' && method === 'GET') {
    const ctx = requireAuth(headers);
    const status = url.searchParams.get('status') as any;
    return { data: store.listCampaigns(ctx.tenantId!, status || null) };
  }

  if (path === '/api/call-center/campaigns' && method === 'POST') {
    const ctx = requireAuth(headers);
    const input = body as {
      name?: string;
      dial_mode?: string;
      agent_spec_id_a?: string;
      agent_spec_id_b?: string;
      ab_enabled?: boolean;
    };
    if (!input.name || !input.agent_spec_id_a) {
      return { status: 400, data: { error: 'name and agent_spec_id_a are required' } };
    }
    const campaign = store.createCampaign({
      tenant_id: ctx.tenantId!,
      name: input.name,
      dial_mode: input.dial_mode as any,
      agent_spec_id_a: input.agent_spec_id_a,
      agent_spec_id_b: input.agent_spec_id_b,
      ab_enabled: input.ab_enabled
    });
    return { status: 201, data: campaign };
  }

  const campaignMatch = path.match(/^\/api\/call-center\/campaigns\/([^/]+)$/);
  if (campaignMatch && method === 'GET') {
    const ctx = requireAuth(headers);
    const campaign = store.getCampaign(campaignMatch[1]);
    if (!campaign || campaign.tenant_id !== ctx.tenantId) {
      return { status: 404, data: { error: 'campaign not found' } };
    }
    return { data: { campaign, stats: store.getStats(campaign.id) } };
  }

  const contactsMatch = path.match(/^\/api\/call-center\/campaigns\/([^/]+)\/contacts$/);
  if (contactsMatch && method === 'POST') {
    const ctx = requireAuth(headers);
    const input = body as { contacts?: Array<{ phone_number: string; display_name?: string }> };
    if (!input.contacts?.length) return { status: 400, data: { error: 'contacts required' } };
    const created = store.addContacts(contactsMatch[1], ctx.tenantId!, input.contacts);
    return { status: 201, data: created };
  }

  if (contactsMatch && method === 'GET') {
    const ctx = requireAuth(headers);
    const status = url.searchParams.get('status') as any;
    return { data: store.listContacts(contactsMatch[1], status || null) };
  }

  const launchMatch = path.match(/^\/api\/call-center\/campaigns\/([^/]+)\/launch$/);
  if (launchMatch && method === 'POST') {
    const ctx = requireAuth(headers);
    const input = body as { limit?: number; assigned_seat_id?: string };
    const result = launcher.launch(launchMatch[1], ctx.tenantId!, {
      limit: input.limit,
      assigned_seat_id: input.assigned_seat_id
    });
    return { data: result };
  }

  const statusMatch = path.match(/^\/api\/call-center\/campaigns\/([^/]+)\/status$/);
  if (statusMatch && method === 'PUT') {
    const ctx = requireAuth(headers);
    const input = body as { status?: string };
    if (!input.status) return { status: 400, data: { error: 'status required' } };
    const updated = store.updateCampaignStatus(statusMatch[1], ctx.tenantId!, input.status as any);
    if (!updated) return { status: 404, data: { error: 'campaign not found' } };
    return { data: updated };
  }

  if (path === '/api/call-center/campaigns/report-outcome' && method === 'POST') {
    const ctx = requireAuth(headers);
    const input = body as {
      campaign_id?: string;
      campaign_contact_id?: string;
      disposition?: string;
      success?: boolean;
    };
    if (!input.campaign_id || !input.campaign_contact_id || !input.disposition) {
      return { status: 400, data: { error: 'campaign_id, campaign_contact_id, disposition required' } };
    }
    // Verify campaign belongs to caller's tenant.
    const campaign = store.getCampaign(input.campaign_id);
    if (!campaign || campaign.tenant_id !== ctx.tenantId) {
      return { status: 404, data: { error: 'campaign not found' } };
    }
    launcher.reportOutcome({
      campaign_id: input.campaign_id,
      campaign_contact_id: input.campaign_contact_id,
      disposition: input.disposition,
      success: input.success !== false
    });
    return { data: { ok: true } };
  }

  const previewDialMatch = path.match(/^\/api\/call-center\/outbound-tasks\/([^/]+)\/preview-dial$/);
  if (previewDialMatch && method === 'POST') {
    const ctx = requireAuth(headers);
    const task = taskStore.confirmPreviewDial(previewDialMatch[1]);
    if (!task || task.tenant_id !== ctx.tenantId) {
      return { status: 404, data: { error: 'preview task not found' } };
    }
    return { data: task };
  }

  if (path === '/api/call-center/outbound-tasks/preview-queue' && method === 'GET') {
    const ctx = requireAuth(headers);
    const seatId = url.searchParams.get('seat_id');
    if (!seatId) return { status: 400, data: { error: 'seat_id required' } };
    return { data: taskStore.listPreviewTasksForSeat(ctx.tenantId!, seatId) };
  }

  if (path === '/api/call-center/surveys' && method === 'GET') {
    const ctx = requireAuth(headers);
    const surveyStore = new PostCallSurveyStore(db);
    return {
      data: {
        surveys: surveyStore.listSurveys(ctx.tenantId!),
        average_score: surveyStore.getAverageScore(ctx.tenantId!)
      }
    };
  }

  if (path === '/api/call-center/surveys' && method === 'POST') {
    const ctx = requireAuth(headers);
    const input = body as {
      call_session_id?: string;
      campaign_id?: string;
      score?: number;
      comment?: string;
      channel?: string;
    };
    if (!input.call_session_id || input.score == null) {
      return { status: 400, data: { error: 'call_session_id, score required' } };
    }
    const surveyStore = new PostCallSurveyStore(db);
    const survey = surveyStore.createSurvey({
      tenant_id: ctx.tenantId!,
      call_session_id: input.call_session_id,
      campaign_id: input.campaign_id,
      score: input.score,
      comment: input.comment,
      channel: input.channel
    });
    return { status: 201, data: survey };
  }

  const ivrSurveyMatch = path.match(/^\/api\/call-center\/surveys\/ivr\/([^/]+)$/);
  if (ivrSurveyMatch && method === 'POST') {
    const input = body as { tenant_id?: string; digit?: string; campaign_id?: string };
    const score = Number(input.digit);
    if (!input.tenant_id || !Number.isInteger(score) || score < 1 || score > 5) {
      return { status: 400, data: { error: 'tenant_id and digit 1-5 required' } };
    }
    const surveyStore = new PostCallSurveyStore(db);
    const survey = surveyStore.createSurvey({
      tenant_id: input.tenant_id,
      call_session_id: ivrSurveyMatch[1],
      campaign_id: input.campaign_id,
      score,
      channel: 'ivr'
    });
    return { status: 201, data: survey };
  }

  return undefined;
}
