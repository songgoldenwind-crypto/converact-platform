import { policyError } from '../contracts.js';
import type { BusinessContext, BusinessObjectRef, DmScope, SandboxScope, SessionPolicy, SessionPolicyInput } from './runtime-types.js';

export function buildSessionPolicy({
  tenantId,
  workspaceId = 'default',
  channel = 'web_app',
  userId = 'system',
  agentId,
  workflowRunId = null,
  businessContext = {}
}: SessionPolicyInput): SessionPolicy {
  if (!tenantId) throw policyError('tenantId is required for session isolation');
  assertTenantBoundary(tenantId, businessContext);

  const businessObject = resolveBusinessObject({ tenantId, workflowRunId, businessContext });
  const sandboxScope = businessContext.sandbox_scope || defaultSandboxScope(agentId, businessObject.type);
  const dmScope = businessContext.dm_scope || defaultDmScope(channel, businessObject.type);
  const scope = resolveSessionScope({
    tenantId,
    workspaceId,
    userId,
    agentId,
    workflowRunId,
    sandboxScope,
    businessObject
  });

  return {
    tenantId,
    workspaceId,
    channel,
    agentId,
    sandboxScope,
    dmScope,
    businessObjectType: businessObject.type,
    businessObjectId: businessObject.id,
    sessionKey: `session:${tenantId}:${workspaceId}:${channel}:${scope.type}:${scope.id}:${agentId || 'agent'}`
  };
}

export function assertTenantBoundary(tenantId: string, value: unknown, path = 'businessContext'): void {
  if (!isRecord(value)) return;
  if (typeof value.tenant_id === 'string' && value.tenant_id !== tenantId) {
    throw policyError(`${path}.tenant_id crosses tenant boundary`);
  }
  if (typeof value.tenantId === 'string' && value.tenantId !== tenantId) {
    throw policyError(`${path}.tenantId crosses tenant boundary`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (isRecord(item)) assertTenantBoundary(tenantId, item, `${path}.${key}`);
  }
}

function defaultSandboxScope(agentId?: string, businessObjectType?: string): SandboxScope {
  if (agentId === 'tenant_admin_agent') return 'session';
  if (agentId === 'analytics_agent') return 'workflow';
  if (agentId === 'voice_agent') return 'business_object';
  if (businessObjectType && businessObjectType !== 'tenant') return 'business_object';
  return 'workflow';
}

function defaultDmScope(channel: string, businessObjectType?: string): DmScope {
  if (businessObjectType && businessObjectType !== 'tenant') return 'per_business_object';
  if (['slack', 'telegram', 'wechat'].includes(channel)) return 'per_channel_thread';
  return 'per_user';
}

function resolveBusinessObject({
  tenantId,
  workflowRunId,
  businessContext
}: {
  tenantId: string;
  workflowRunId?: string | null;
  businessContext: BusinessContext;
}): BusinessObjectRef {
  const type =
    businessContext.business_object_type ||
    businessContext.businessObjectType ||
    businessContext.object_type ||
    businessContext.objectType ||
    inferObjectType(businessContext);
  const id =
    businessContext.business_object_id ||
    businessContext.businessObjectId ||
    businessContext.object_id ||
    businessContext.objectId ||
    inferObjectId(businessContext);

  if (type && id) return { type, id };
  if (workflowRunId) return { type: 'workflow', id: workflowRunId };
  return { type: 'tenant', id: tenantId };
}

function inferObjectType(businessContext: BusinessContext): string {
  if (businessContext.campaign_id) return 'campaign';
  if (businessContext.lead_id) return 'lead';
  if (businessContext.customer_id) return 'customer';
  if (businessContext.workflow_run_id) return 'workflow';
  return 'tenant';
}

function inferObjectId(businessContext: BusinessContext): string {
  return (
    businessContext.campaign_id ||
    businessContext.lead_id ||
    businessContext.customer_id ||
    businessContext.workflow_run_id ||
    ''
  );
}

function resolveSessionScope({
  tenantId,
  workspaceId,
  userId,
  agentId,
  workflowRunId,
  sandboxScope,
  businessObject
}: {
  tenantId: string;
  workspaceId: string;
  userId: string;
  agentId?: string;
  workflowRunId?: string | null;
  sandboxScope: SandboxScope;
  businessObject: BusinessObjectRef;
}): BusinessObjectRef {
  if (sandboxScope === 'tenant') return { type: 'tenant', id: tenantId };
  if (sandboxScope === 'workspace') return { type: 'workspace', id: workspaceId };
  if (sandboxScope === 'agent') return { type: 'agent', id: agentId || 'agent' };
  if (sandboxScope === 'workflow') return { type: 'workflow', id: workflowRunId || businessObject.id || 'adhoc' };
  if (sandboxScope === 'session') return { type: 'user', id: userId || 'system' };
  return { type: businessObject.type || 'tenant', id: businessObject.id || tenantId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}
