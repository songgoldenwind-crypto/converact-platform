import { all, id, json, one, parseJson, run } from '../../db.js';
import { policyError } from '../contracts.js';
import type { HookManager } from '../hooks/hook-manager.js';
import type { JsonRecord } from '../integrations/provider-runtime-types.js';
import type { AuditStoreLike, ToolDefinition, ToolExecutionContext } from '../runtime-domain-types.js';

const DEFAULT_ROLE_PERMISSIONS = [
  ['owner', '*', 'Full tenant control'],
  ['admin', '*:read', 'Read all tenant resources'],
  ['admin', '*:write', 'Write tenant business resources'],
  ['admin', '*:external', 'Approve and run external tenant actions'],
  ['admin', 'admin:manage', 'Manage tenant settings, secrets and permissions'],
  ['admin', 'billing:manage', 'Manage billing and quotas'],
  ['operator', '*:read', 'Read tenant resources'],
  ['operator', 'channel:write', 'Manage channels'],
  ['operator', 'landing:write', 'Manage landing pages'],
  ['operator', 'lead:write', 'Capture and normalize leads'],
  ['operator', 'crm:write', 'Manage CRM tasks'],
  ['operator', 'analytics:write', 'Write product events'],
  ['operator', 'content:write', 'Create content drafts'],
  ['operator', 'content:external', 'Submit external content for approval'],
  ['operator', 'voice:write', 'Manage voice sessions'],
  ['operator', 'voice:external', 'Submit calls for approval'],
  ['operator', 'artifact:read', 'Read tenant artifacts'],
  ['operator', 'artifact:write', 'Review tenant artifacts'],
  ['operator', 'knowledge:write', 'Maintain knowledge base'],
  ['operator', 'memory:write', 'Maintain approved memory candidates'],
  ['operator', 'search:read', 'Read tenant search sessions and runs'],
  ['operator', 'search:write', 'Run tenant search queries'],
  ['operator', 'notebook:read', 'Read tenant notebooks'],
  ['operator', 'notebook:write', 'Maintain tenant notebooks'],
  ['operator', 'skill:read', 'Read tenant skills'],
  ['operator', 'skill:write', 'Propose tenant skill candidates'],
  ['admin', 'search:manage', 'Manage tenant search settings'],
  ['admin', 'notebook:manage', 'Manage tenant notebooks'],
  ['admin', 'skill:manage', 'Manage tenant skills'],
  ['admin', 'mcp:manage', 'Manage tenant MCP servers'],
  ['admin', 'mcp:read', 'Read tenant MCP servers'],
  ['operator', 'mcp:read', 'Read tenant MCP servers'],
  ['viewer', 'search:read', 'Read tenant search sessions and runs'],
  ['viewer', 'artifact:read', 'Read tenant artifacts'],
  ['viewer', 'notebook:read', 'Read tenant notebooks'],
  ['viewer', 'skill:read', 'Read tenant skills'],
  ['viewer', 'mcp:read', 'Read tenant MCP servers'],
  ['viewer', '*:read', 'Read tenant resources']
];

export class RbacStore {
  db: unknown;
  runStore: AuditStoreLike | null;

  constructor(db: unknown, runStore: AuditStoreLike | null = null) {
    this.db = db;
    this.runStore = runStore;
    this.ensureDefaultPermissions();
  }

  ensureDefaultPermissions(): void {
    for (const [roleCode, permission, description] of DEFAULT_ROLE_PERMISSIONS) {
      run(
        this.db,
        `INSERT OR IGNORE INTO role_permissions (role_code, permission, description)
         VALUES (?, ?, ?)`,
        [roleCode, permission, description]
      );
    }
  }

  upsertMember(input: JsonRecord): JsonRecord | null {
    const member = {
      id: input.id || id('member'),
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      role_code: input.role_code || input.role || 'viewer',
      status: input.status || 'active',
      created_by: input.created_by || input.actor_id || 'system'
    };
    run(
      this.db,
      `INSERT INTO tenant_members (id, tenant_id, user_id, role_code, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, user_id) DO UPDATE SET
         role_code = excluded.role_code,
         status = excluded.status,
         updated_at = CURRENT_TIMESTAMP`,
      [member.id, member.tenant_id, member.user_id, member.role_code, member.status, member.created_by]
    );
    this.runStore?.audit?.(member.tenant_id, 'rbac.member_upserted', 'tenant_member', member.user_id, {
      role_code: member.role_code,
      status: member.status
    }, member.created_by);
    return this.getMember(member.tenant_id, member.user_id);
  }

  getMember(tenantId: string, userId: string): JsonRecord | null {
    return one(this.db, 'SELECT * FROM tenant_members WHERE tenant_id = ? AND user_id = ?', [tenantId, userId]);
  }

  listMembers(tenantId: string): JsonRecord[] {
    return all(this.db, 'SELECT * FROM tenant_members WHERE tenant_id = ? ORDER BY created_at ASC', [tenantId]);
  }

  listPermissions(roleCode: string): string[] {
    return all(this.db, 'SELECT permission FROM role_permissions WHERE role_code = ? ORDER BY permission ASC', [roleCode]).map(
      (row) => row.permission
    );
  }

  hasConfiguredMembers(tenantId: string): boolean {
    return one(this.db, 'SELECT COUNT(*) AS count FROM tenant_members WHERE tenant_id = ?', [tenantId]).count > 0;
  }

  evaluateToolAccess(context: ToolExecutionContext, tool: ToolDefinition): JsonRecord {
    const requiredPermissions = deriveToolPermissions(tool);
    if (!context?.tenantId) {
      return deny('tenant context is required', requiredPermissions);
    }
    if (!context.userId || context.userId === 'system') {
      return allow('system actor allowed', requiredPermissions, { role_code: 'system', permissions: ['*'] });
    }
    if (!this.hasConfiguredMembers(context.tenantId)) {
      return allow('bootstrap tenant without configured members', requiredPermissions, {
        role_code: 'bootstrap',
        permissions: ['*']
      });
    }

    const member = this.getMember(context.tenantId, context.userId);
    if (!member || member.status !== 'active') {
      return deny(`user ${context.userId} is not an active tenant member`, requiredPermissions);
    }

    const permissions = this.listPermissions(member.role_code);
    const missing = requiredPermissions.filter((permission) => !matchesAnyPermission(permission, permissions));
    if (missing.length) {
      return deny(`missing permission: ${missing.join(', ')}`, requiredPermissions, { member, permissions, missing });
    }

    return allow(`allowed by ${member.role_code} role`, requiredPermissions, { member, permissions });
  }

  assertToolAccess(context: ToolExecutionContext, tool: ToolDefinition, toolCall: JsonRecord | null = null): JsonRecord {
    const decision = this.evaluateToolAccess(context, tool);
    this.recordDecision({
      tenant_id: context.tenantId,
      actor_id: context.userId || 'system',
      decision_type: 'rbac',
      decision: decision.decision,
      reason: decision.reason,
      tool_id: tool.tool_id,
      risk_level: tool.risk_level,
      required_permissions: decision.required_permissions,
      workflow_run_id: context.workflowRunId || null,
      agent_run_id: context.agentRunId || null,
      tool_call_id: toolCall?.id || null,
      metadata: decision.metadata
    });
    if (decision.decision !== 'allow') throw policyError(decision.reason);
    return decision;
  }

  recordDecision(input: JsonRecord): void {
    run(
      this.db,
      `INSERT INTO policy_decisions
        (id, tenant_id, actor_id, decision_type, decision, reason, tool_id, risk_level, required_permissions,
         workflow_run_id, agent_run_id, tool_call_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id('policy'),
        input.tenant_id,
        input.actor_id || 'system',
        input.decision_type,
        input.decision,
        input.reason || '',
        input.tool_id || '',
        input.risk_level || '',
        json(input.required_permissions || []),
        input.workflow_run_id || null,
        input.agent_run_id || null,
        input.tool_call_id || null,
        json(input.metadata || {})
      ]
    );
  }

  listPolicyDecisions({ tenant_id, actor_id = null, decision_type = null, limit = 50 }: JsonRecord): JsonRecord[] {
    const clauses = ['tenant_id = ?'];
    const params = [tenant_id];
    if (actor_id) {
      clauses.push('actor_id = ?');
      params.push(actor_id);
    }
    if (decision_type) {
      clauses.push('decision_type = ?');
      params.push(decision_type);
    }
    params.push(limit);
    return all(
      this.db,
      `SELECT * FROM policy_decisions WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
      params
    ).map((row) => ({ ...row, required_permissions: parseJson(row.required_permissions, []), metadata: parseJson(row.metadata) }));
  }
}

export function registerRbacHooks(hookManager: HookManager, rbacStore: RbacStore): void {
  hookManager.on('before_tool_call', (payload) => {
    rbacStore.assertToolAccess(payload.context, payload.tool, payload.toolCall);
  });
}

export function deriveToolPermissions(tool: ToolDefinition): string[] {
  if (tool.required_scopes?.length) return tool.required_scopes;
  if (tool.category === 'admin_action' || tool.risk_level === 'R5') return ['admin:manage'];
  if (tool.category === 'financial_action' || tool.risk_level === 'R4') return ['billing:manage'];
  if (tool.category === 'external_action') return [`${tool.toolset}:external`];
  if (tool.category === 'read' || tool.risk_level === 'R0') return [`${tool.toolset}:read`];
  return [`${tool.toolset}:write`];
}

function matchesAnyPermission(required: string, permissions: string[]): boolean {
  const [domain] = required.split(':');
  return permissions.some((permission) => {
    if (permission === '*') return true;
    if (permission === required) return true;
    if (permission === '*:read' && required.endsWith(':read')) return true;
    if (permission === '*:write' && required.endsWith(':write')) return true;
    if (permission === '*:external' && required.endsWith(':external')) return true;
    return permission === `${domain}:*`;
  });
}

function allow(reason: string, requiredPermissions: string[], metadata: JsonRecord = {}): JsonRecord {
  return { decision: 'allow', reason, required_permissions: requiredPermissions, metadata };
}

function deny(reason: string, requiredPermissions: string[], metadata: JsonRecord = {}): JsonRecord {
  return { decision: 'deny', reason, required_permissions: requiredPermissions, metadata };
}
