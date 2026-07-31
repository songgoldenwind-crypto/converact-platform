/**
 * Shared HTTP route helpers used by extracted domain routers in src/http-api/.
 *
 * These were previously defined at the bottom of src/http.ts; moved here so
 * each route<Domain>Api file can import them without a circular dependency.
 */

export function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) {
    const error = new Error(`${name} is required`);
    (error as any).status = 400;
    throw error;
  }
  return value;
}

export function queryInput(url: URL) {
  return {
    tenant_id: requiredQuery(url, 'tenant_id'),
    workspace_id: url.searchParams.get('workspace_id') || 'default',
    user_id: url.searchParams.get('user_id') || 'user'
  };
}

export async function executeTool(harness: any, input: any, agentId: string, toolId: string): Promise<any> {
  const result = await harness.toolExecutor.execute(toolContext(input, agentId, toolId), toolId, input);
  return result.output;
}

export function toolContext(body: any, agentId: string, stepId?: string) {
  return {
    tenantId: body.tenant_id,
    workspaceId: body.workspace_id || 'default',
    userId: body.user_id || 'user',
    agentId,
    workflowRunId: body.workflow_run_id || null,
    agentRunId: body.agent_run_id || null,
    playbookId: body.playbook_id || 'manual',
    stepId
  };
}
