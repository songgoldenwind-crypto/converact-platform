import type { ToolRegistry } from './tools/tool-registry.js';
import type { ChannelAdapterRegistry } from './channels/channel-adapter-registry.js';
import type { IntegrationConfigStore } from './integrations/integration-config-store.js';
import { createChannel } from '../platform/tenant-core.js';
import { createSourceTag, createLandingPage, submitInquiry } from '../platform/landing-core.js';
import { trackEvent } from '../platform/events.js';
import { createTask, completeTask, rescheduleTask } from '../platform/task-commands.js';
import { getFunnel, getChannelAnalytics, getLandingPageAnalytics, getWeeklyReport } from '../platform/analytics.js';

/**
 * Business tool registration entry point.
 *
 * Registers platform-level tools (channels, source tags, landing pages,
 * event tracking, CRM task lifecycle, analytics) that HTTP routes in
 * src/http.ts depend on via executeTool(). The lead-acquisition tool
 * surface has been archived out of repo; these platform tools remain.
 */
export function registerBusinessTools(
  toolRegistry: ToolRegistry,
  db: unknown,
  _channelAdapterRegistry?: ChannelAdapterRegistry | null,
  _integrationConfigStore?: IntegrationConfigStore | null
): void {
  toolRegistry.register(
    {
      tool_id: 'channel.create',
      display_name: 'Create channel',
      toolset: 'orchestration',
      category: 'internal_write',
      risk_level: 'R1',
      input_schema: { tenant_id: 'string', platform_code: 'string' },
      output_schema: {},
      side_effect: true,
      idempotency_required: true,
      approval_required: false,
      allowed_agents: ['orchestration_agent'],
      forbidden_agents: [],
      tenant_scope_required: true,
      object_scope_required: false,
      audit_event_name: 'tool.channel_create'
    },
    (input: Record<string, unknown>) => createChannel(db, input)
  );

  toolRegistry.register(
    {
      tool_id: 'source_tag.create',
      display_name: 'Create source tag',
      toolset: 'orchestration',
      category: 'internal_write',
      risk_level: 'R1',
      input_schema: { tenant_id: 'string', channel_id: 'string' },
      output_schema: {},
      side_effect: true,
      idempotency_required: true,
      approval_required: false,
      allowed_agents: ['orchestration_agent'],
      forbidden_agents: [],
      tenant_scope_required: true,
      object_scope_required: false,
      audit_event_name: 'tool.source_tag_create'
    },
    (input: Record<string, unknown>) => createSourceTag(db, input)
  );

  toolRegistry.register(
    {
      tool_id: 'landing_page.create',
      display_name: 'Create landing page',
      toolset: 'orchestration',
      category: 'internal_write',
      risk_level: 'R1',
      input_schema: { tenant_id: 'string', slug: 'string' },
      output_schema: {},
      side_effect: true,
      idempotency_required: true,
      approval_required: false,
      allowed_agents: ['orchestration_agent'],
      forbidden_agents: [],
      tenant_scope_required: true,
      object_scope_required: false,
      audit_event_name: 'tool.landing_page_create'
    },
    (input: Record<string, unknown>) => createLandingPage(db, input)
  );

  toolRegistry.register(
    {
      tool_id: 'event.track',
      display_name: 'Track event',
      toolset: 'orchestration',
      category: 'internal_write',
      risk_level: 'R1',
      input_schema: { tenant_id: 'string', event_name: 'string' },
      output_schema: {},
      side_effect: true,
      idempotency_required: true,
      approval_required: false,
      allowed_agents: ['orchestration_agent'],
      forbidden_agents: [],
      tenant_scope_required: true,
      object_scope_required: false,
      audit_event_name: 'tool.event_track'
    },
    (input: Record<string, unknown>) => {
      trackEvent(
        db,
        String(input.tenant_id),
        String(input.event_name),
        String(input.object_type || ''),
        String(input.object_id || ''),
        (input.source_tag_id as string) || null,
        (input.properties as Record<string, unknown>) || {}
      );
      return { tracked: true };
    }
  );

  toolRegistry.register(
    {
      tool_id: 'lead.capture_from_form',
      display_name: 'Capture lead from form submission',
      toolset: 'lead',
      category: 'internal_write',
      risk_level: 'R2',
      input_schema: { tenant_id: 'string', name: 'string', message: 'string' },
      output_schema: {},
      side_effect: true,
      idempotency_required: true,
      approval_required: false,
      allowed_agents: ['orchestration_agent'],
      forbidden_agents: [],
      tenant_scope_required: true,
      object_scope_required: false,
      audit_event_name: 'tool.lead_capture_from_form'
    },
    (input: Record<string, unknown>) => submitInquiry(db, input)
  );

  toolRegistry.register(
    {
      tool_id: 'crm.create_task',
      display_name: 'Create task',
      toolset: 'crm',
      category: 'internal_write',
      risk_level: 'R1',
      input_schema: { tenant_id: 'string', object_type: 'string', object_id: 'string', title: 'string' },
      output_schema: {},
      side_effect: true,
      idempotency_required: true,
      approval_required: false,
      allowed_agents: ['crm_agent'],
      forbidden_agents: [],
      tenant_scope_required: true,
      object_scope_required: false,
      audit_event_name: 'tool.crm_create_task'
    },
    (input: Record<string, unknown>) => createTask(db, input)
  );

  toolRegistry.register(
    {
      tool_id: 'crm.complete_task',
      display_name: 'Complete task',
      toolset: 'crm',
      category: 'internal_write',
      risk_level: 'R2',
      input_schema: { tenant_id: 'string', task_id: 'string' },
      output_schema: {},
      side_effect: true,
      idempotency_required: true,
      approval_required: false,
      allowed_agents: ['crm_agent'],
      forbidden_agents: [],
      tenant_scope_required: true,
      object_scope_required: false,
      audit_event_name: 'tool.crm_complete_task'
    },
    (input: Record<string, unknown>) =>
      completeTask(db, String(input.tenant_id), String(input.task_id), input)
  );

  toolRegistry.register(
    {
      tool_id: 'crm.reschedule_task',
      display_name: 'Reschedule task',
      toolset: 'crm',
      category: 'internal_write',
      risk_level: 'R1',
      input_schema: { tenant_id: 'string', task_id: 'string', delay_hours: 'number' },
      output_schema: {},
      side_effect: true,
      idempotency_required: true,
      approval_required: false,
      allowed_agents: ['crm_agent'],
      forbidden_agents: [],
      tenant_scope_required: true,
      object_scope_required: false,
      audit_event_name: 'tool.crm_reschedule_task'
    },
    (input: Record<string, unknown>) =>
      rescheduleTask(db, String(input.tenant_id), String(input.task_id), input)
  );

  toolRegistry.register(
    {
      tool_id: 'analytics.compute_funnel',
      display_name: 'Compute funnel report',
      toolset: 'analytics',
      category: 'read',
      risk_level: 'R0',
      input_schema: { tenant_id: 'string' },
      output_schema: {},
      side_effect: false,
      idempotency_required: false,
      approval_required: false,
      allowed_agents: ['analytics_agent', 'orchestration_agent'],
      forbidden_agents: [],
      tenant_scope_required: true,
      object_scope_required: false,
      audit_event_name: 'tool.analytics_compute_funnel'
    },
    (input: Record<string, unknown>) => getFunnel(db, String(input.tenant_id))
  );

  toolRegistry.register(
    {
      tool_id: 'analytics.channel_report',
      display_name: 'Channel analytics report',
      toolset: 'analytics',
      category: 'read',
      risk_level: 'R0',
      input_schema: { tenant_id: 'string' },
      output_schema: {},
      side_effect: false,
      idempotency_required: false,
      approval_required: false,
      allowed_agents: ['analytics_agent', 'orchestration_agent'],
      forbidden_agents: [],
      tenant_scope_required: true,
      object_scope_required: false,
      audit_event_name: 'tool.analytics_channel_report'
    },
    (input: Record<string, unknown>) => getChannelAnalytics(db, String(input.tenant_id))
  );

  toolRegistry.register(
    {
      tool_id: 'analytics.page_report',
      display_name: 'Landing page analytics report',
      toolset: 'analytics',
      category: 'read',
      risk_level: 'R0',
      input_schema: { tenant_id: 'string' },
      output_schema: {},
      side_effect: false,
      idempotency_required: false,
      approval_required: false,
      allowed_agents: ['analytics_agent', 'orchestration_agent'],
      forbidden_agents: [],
      tenant_scope_required: true,
      object_scope_required: false,
      audit_event_name: 'tool.analytics_page_report'
    },
    (input: Record<string, unknown>) => getLandingPageAnalytics(db, String(input.tenant_id))
  );

  toolRegistry.register(
    {
      tool_id: 'analytics.weekly_report',
      display_name: 'Weekly analytics report',
      toolset: 'analytics',
      category: 'read',
      risk_level: 'R0',
      input_schema: { tenant_id: 'string' },
      output_schema: {},
      side_effect: false,
      idempotency_required: false,
      approval_required: false,
      allowed_agents: ['analytics_agent', 'orchestration_agent'],
      forbidden_agents: [],
      tenant_scope_required: true,
      object_scope_required: false,
      audit_event_name: 'tool.analytics_weekly_report'
    },
    (input: Record<string, unknown>) => getWeeklyReport(db, String(input.tenant_id))
  );
}
