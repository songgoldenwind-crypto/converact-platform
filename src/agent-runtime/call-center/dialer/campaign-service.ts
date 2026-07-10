import type { OutboundTaskStore } from '../outbound-task-store.js';
import {
  OutboundCampaignStore,
  resolveCampaignSpecId,
  type OutboundCampaign
} from './campaign-store.js';

export class CampaignLauncher {
  constructor(
    private readonly db: unknown,
    private readonly campaignStore: OutboundCampaignStore,
    private readonly taskStore: OutboundTaskStore
  ) {}

  launch(campaignId: string, tenantId: string, opts: { limit?: number; assigned_seat_id?: string } = {}) {
    const campaign = this.campaignStore.getCampaign(campaignId);
    if (!campaign || campaign.tenant_id !== tenantId) {
      throw Object.assign(new Error('campaign not found'), { status: 404 });
    }
    if (campaign.status !== 'active' && campaign.status !== 'draft') {
      throw Object.assign(new Error('campaign is not launchable'), { status: 409 });
    }

    if (campaign.status === 'draft') {
      this.campaignStore.updateCampaignStatus(campaignId, tenantId, 'active');
    }

    const limit = opts.limit || 50;
    const contacts = this.campaignStore.pickPendingContacts(campaignId, limit);
    const tasks = contacts.map((contact) => {
      const specId = resolveCampaignSpecId(campaign, contact.ab_variant);
      const strategy = buildStrategy(campaign, contact.id, specId, contact.ab_variant, opts.assigned_seat_id);
      const task = this.taskStore.createTask({
        tenant_id: tenantId,
        phone_number: contact.phone_number,
        channel: 'pstn_voice',
        campaign_id: campaignId,
        campaign_contact_id: contact.id,
        priority: 7,
        strategy
      });
      this.campaignStore.updateContact(contact.id, {
        status: 'dialed',
        outbound_task_id: task.id
      });
      return task;
    });

    this.campaignStore.mergeStats(campaignId, {
      last_launched_at: new Date().toISOString(),
      tasks_created: tasks.length
    });

    return { campaign_id: campaignId, tasks_created: tasks.length, tasks };
  }

  reportOutcome(input: {
    campaign_id: string;
    campaign_contact_id: string;
    disposition: string;
    success: boolean;
  }): void {
    this.campaignStore.updateContact(input.campaign_contact_id, {
      status: input.success ? 'completed' : 'failed',
      disposition: input.disposition
    });
    const stats = this.campaignStore.getStats(input.campaign_id);
    this.campaignStore.mergeStats(input.campaign_id, {
      last_outcome_at: new Date().toISOString(),
      completed: stats.completed,
      failed: stats.failed
    });
  }
}

function buildStrategy(
  campaign: OutboundCampaign,
  contactId: string,
  specId: string,
  variant: 'A' | 'B',
  assignedSeatId?: string
) {
  return {
    agent_spec_id: specId,
    language: 'zh' as const,
    dial_mode: campaign.dial_mode,
    campaign_id: campaign.id,
    campaign_contact_id: contactId,
    ab_variant: variant,
    source: 'campaign',
    ...(campaign.dial_mode === 'preview' && assignedSeatId
      ? { assigned_seat_id: assignedSeatId, preview_confirmed: false }
      : {})
  };
}
