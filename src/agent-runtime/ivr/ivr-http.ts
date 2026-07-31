/**
 * IVR Flow HTTP API — routes for CRUD + simulate + generate.
 *
 * POST   /api/ivr/flows              — create/save a flow
 * GET    /api/ivr/flows              — list flows
 * GET    /api/ivr/flows/:id          — get a flow
 * GET    /api/ivr/flows/validation-report — tenant validation report (6-MIG.2)
 * POST   /api/ivr/flows/complete-missing-edges — auto-complete safe menu edges
 * DELETE /api/ivr/flows/:id          — delete
 * POST   /api/ivr/simulate           — simulate DTMF sequence
 */

import { resolveAuthContext } from '../../middleware/auth.js';
import { IvrFlowStore } from './ivr-flow-store.js';
import { simulateIvrFlow, type IvrSimulationInput } from './ivr-executor.js';
import { validateFlowGraph, validateFlowGraphDetailed, type IvrFlowGraph } from './ivr-types.js';
import { publishBlockingIssues, saveBlockingIssues } from './ivr-validation-policy.js';
import { completeFlowMissingEdges } from './ivr-complete-menu-edges.js';
import { buildFlowValidationEntry, buildTenantValidationReport } from './ivr-flow-validation-report.js';
import { refreshFlowRepairStatuses } from './ivr-flow-repair-status.js';
import { httpStatusFromError } from '../integrations/llm-provider.js';
import { generateIvrFromText, generateIvrFromCsv } from './ivr-generator.js';
import { IvrSessionStore } from './ivr-session-store.js';
import { advanceIvrStep, startIvrSession } from './ivr-inbound-routing.js';
import { actionToPromptText, shouldAutoWalkAfterAdvance, walkToPromptableAction } from './ivr-runtime.js';
import { ivrActionToRwi } from './ivr-rwi-bridge.js';
import { buildLiveIvrStepInput } from './ivr-live-input.js';
import { parseIvrAdvanceBody, parseAiDialogueResultBody } from './ivr-advance-input.js';
import type { IvrAction } from './ivr-executor.js';
import { parseJson } from '../../db.js';

function mapIvrStoreError(err: unknown): { status: number; data: { error: string } } {
  const status =
    err && typeof err === 'object' && 'status' in err ? Number((err as { status: number }).status) : 500;
  return {
    status: Number.isFinite(status) && status >= 400 ? status : 500,
    data: { error: err instanceof Error ? err.message : String(err) },
  };
}

function pgId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function routeIvrApi(
  db: unknown,
  method: string,
  path: string,
  _url: URL,
  body: unknown,
  headers: Record<string, string | string[] | undefined>
): Promise<unknown> {
  // IVR routes all live under /api/ivr/*; bail out early for unrelated paths so the
  // auth gate below doesn't reject requests meant for other routers (e.g. /api/tenants,
  // /api/voice/*). Returning undefined lets the caller continue dispatching.
  if (!path.startsWith('/api/ivr/')) return undefined;

  const ctx = resolveAuthContext(headers);
  if (!ctx.authenticated || !ctx.tenantId) {
    throw Object.assign(new Error('authentication required'), { status: 401 });
  }
  const tenantId = ctx.tenantId;
  const store = new IvrFlowStore(db);
  const input = (body || {}) as Record<string, unknown>;

  // POST /api/ivr/flows — create or update
  if (path === '/api/ivr/flows' && method === 'POST') {
    const graph = input.graph as IvrFlowGraph;
    if (!graph || !graph.nodes) {
      return { status: 400, data: { error: 'graph is required' } };
    }
    const validation = validateFlowGraphDetailed(graph);
    const blocking = saveBlockingIssues(validation);
    if (blocking.length > 0) {
      return {
        status: 400,
        data: {
          error: 'validation failed',
          valid: false,
          errors: blocking,
          warnings: validation.warnings,
        },
      };
    }
    const id = (input.id as string) || pgId('ivr');
    const name = (input.name as string) || '未命名 IVR 流程';
    try {
      const saved = store.saveFlow(tenantId, id, name, graph);
      return {
        data: {
          ...saved,
          validation: {
            valid: validation.warnings.length === 0,
            warnings: validation.warnings,
            errors: validation.errors,
          },
        },
      };
    } catch (err) {
      const status = err && typeof err === 'object' && 'status' in err ? Number((err as { status: number }).status) : 500;
      return {
        status: Number.isFinite(status) && status >= 400 ? status : 500,
        data: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  // GET /api/ivr/flows/validation-report — tenant-wide validation (6-MIG.2)
  if (path === '/api/ivr/flows/validation-report' && method === 'GET') {
    const repair = refreshFlowRepairStatuses(store, tenantId);
    const flowId = _url.searchParams.get('flowId');
    if (flowId) {
      const flow = store.getFlow(tenantId, flowId);
      if (!flow) return { status: 404, data: { error: 'flow not found' } };
      return { data: { ...buildFlowValidationEntry(flow), repair } };
    }
    return { data: { ...buildTenantValidationReport(store.listFlows(tenantId)), repair } };
  }

  // POST /api/ivr/flows/complete-missing-edges — safe auto-fix (6-MIG.3 API)
  if (path === '/api/ivr/flows/complete-missing-edges' && method === 'POST') {
    const graph = input.graph as IvrFlowGraph;
    if (!graph?.nodes) {
      return { status: 400, data: { error: 'graph is required' } };
    }
    const result = completeFlowMissingEdges(graph);
    const validation = validateFlowGraphDetailed(result.graph);
    return {
      data: {
        ...result,
        validation: {
          valid: validation.errors.length === 0 && validation.warnings.length === 0,
          errors: validation.errors,
          warnings: validation.warnings,
        },
      },
    };
  }

  // GET /api/ivr/flows — list
  if (path === '/api/ivr/flows' && method === 'GET') {
    return { data: store.listFlows(tenantId) };
  }

  // GET /api/ivr/flows/:id
  const getMatch = path.match(/^\/api\/ivr\/flows\/([^/]+)$/);
  if (getMatch && method === 'GET') {
    const flow = store.getFlow(tenantId, getMatch[1]);
    if (!flow) return { status: 404, data: { error: 'flow not found' } };
    return { data: flow };
  }

  // POST /api/ivr/flows/:id/publish
  const publishMatch = path.match(/^\/api\/ivr\/flows\/([^/]+)\/publish$/);
  if (publishMatch && method === 'POST') {
    const flow = store.getFlow(tenantId, publishMatch[1]);
    if (!flow) return { status: 404, data: { error: 'flow not found' } };
    const validation = validateFlowGraphDetailed(flow.graph);
    const blocking = publishBlockingIssues(validation);
    if (blocking.length > 0) {
      return {
        status: 400,
        data: {
          error: 'validation failed',
          valid: false,
          errors: blocking,
          warnings: validation.warnings,
        },
      };
    }
    store.publishFlow(tenantId, publishMatch[1]);
    return { data: { ok: true, id: publishMatch[1] } };
  }

  // DELETE /api/ivr/flows/:id
  const deleteMatch = path.match(/^\/api\/ivr\/flows\/([^/]+)$/);
  if (deleteMatch && method === 'DELETE') {
    const deleted = store.deleteFlow(tenantId, deleteMatch[1]);
    if (!deleted) return { status: 404, data: { error: 'flow not found' } };
    return { data: { ok: true } };
  }

  // POST /api/ivr/generate-from-text — AI generates flow from natural language
  if (path === '/api/ivr/generate-from-text' && method === 'POST') {
    const description = input.description as string;
    const language = (input.language as string) || 'zh';
    if (!description) {
      return { status: 400, data: { error: 'description is required' } };
    }
    try {
      const result = await generateIvrFromText(description, language);
      return { data: result };
    } catch (err) {
      return {
        status: httpStatusFromError(err),
        data: {
          error: err instanceof Error ? err.message : String(err),
          validation: (err as Error & { validation?: unknown }).validation,
        },
      };
    }
  }

  // POST /api/ivr/generate-from-csv — AI generates flow from CSV content
  if (path === '/api/ivr/generate-from-csv' && method === 'POST') {
    const csv = input.csv as string;
    const language = (input.language as string) || 'zh';
    if (!csv) {
      return { status: 400, data: { error: 'csv is required' } };
    }
    try {
      const result = await generateIvrFromCsv(csv, language);
      return { data: result };
    } catch (err) {
      return {
        status: httpStatusFromError(err),
        data: {
          error: err instanceof Error ? err.message : String(err),
          validation: (err as Error & { validation?: unknown }).validation,
        },
      };
    }
  }

  // GET /api/ivr/flows/:id/history — version history
  const historyMatch = path.match(/^\/api\/ivr\/flows\/([^/]+)\/history$/);
  if (historyMatch && method === 'GET') {
    return { data: store.listFlowHistory(tenantId, historyMatch[1]) };
  }

  // POST /api/ivr/flows/:id/rollback — rollback to a version
  const rollbackMatch = path.match(/^\/api\/ivr\/flows\/([^/]+)\/rollback$/);
  if (rollbackMatch && method === 'POST') {
    const version = (input.version as number) ?? 0;
    if (!version) return { status: 400, data: { error: 'version is required' } };
    const restored = store.rollbackFlow(tenantId, rollbackMatch[1], version);
    if (!restored) return { status: 404, data: { error: 'version not found' } };
    return { data: restored };
  }

  // POST /api/ivr/simulate — run DTMF simulation
  if (path === '/api/ivr/simulate' && method === 'POST') {
    const graph = input.graph as IvrFlowGraph;
    const simInput = input.input as IvrSimulationInput;
    if (!graph || !graph.nodes) {
      return { status: 400, data: { error: 'graph is required' } };
    }
    if (!simInput || !Array.isArray(simInput.dtmfSequence)) {
      return { status: 400, data: { error: 'input.dtmfSequence is required' } };
    }
    const result = await simulateIvrFlow(graph, simInput);
    return {
      data: {
        ...result,
        simulationNote:
          'Simulation does not execute live transfer/recording side effects; transfer waiting is auto-completed for the trace.',
      },
    };
  }

  // POST /api/ivr/flows/validate — validate graph without saving
  if (path === '/api/ivr/flows/validate' && method === 'POST') {
    const graph = input.graph as IvrFlowGraph;
    if (!graph?.nodes) {
      return { status: 400, data: { error: 'graph is required' } };
    }
    const validation = validateFlowGraphDetailed(graph);
    return {
      data: {
        valid: validation.errors.length === 0 && validation.warnings.length === 0,
        errors: validation.errors,
        warnings: validation.warnings,
        saveBlocked: saveBlockingIssues(validation).length > 0,
        publishBlocked: publishBlockingIssues(validation).length > 0,
      },
    };
  }

  // POST /api/ivr/flows/:id/validate — validate graph without saving
  const validateMatch = path.match(/^\/api\/ivr\/flows\/([^/]+)\/validate$/);
  if (validateMatch && method === 'POST') {
    const graph = (input.graph as IvrFlowGraph) || store.getFlow(tenantId, validateMatch[1])?.graph;
    if (!graph) return { status: 404, data: { error: 'flow not found' } };
    const validation = validateFlowGraphDetailed(graph);
    return {
      data: {
        valid: validation.errors.length === 0 && validation.warnings.length === 0,
        errors: validation.errors,
        warnings: validation.warnings,
      },
    };
  }

  const sessionStore = new IvrSessionStore(db);

  function logSessionAction(
    callSessionId: string,
    stepIndex: number,
    action: IvrAction | undefined,
    branchTaken?: string | null
  ) {
    if (!action) return;
    sessionStore.appendStep({
      callSessionId,
      tenantId,
      stepIndex,
      nodeId: 'node' in action ? action.node : null,
      action,
      branchTaken,
    });
  }

  // GET /api/ivr/sessions — list sessions
  if (path === '/api/ivr/sessions' && method === 'GET') {
    const activeOnly = _url.searchParams.get('active') === '1';
    const sessions = activeOnly ? sessionStore.listActive(tenantId) : sessionStore.listAll(tenantId);
    return {
      data: sessions.map((s) => ({
        callSessionId: s.call_session_id,
        flowId: s.flow_id,
        terminated: s.terminated === 1,
        stepCount: s.step_count,
        currentNodeId: s.context.currentNodeId,
        updatedAt: s.updated_at,
      })),
    };
  }

  // POST /api/ivr/sessions — create session for a call
  if (path === '/api/ivr/sessions' && method === 'POST') {
    const callSessionId = input.callSessionId as string;
    const flowId = input.flowId as string | undefined;
    const roomName = input.roomName as string | undefined;
    const variables = (input.variables as Record<string, string>) || {};
    const channelVariables = input.channelVariables as Record<string, string> | undefined;
    const mediaType = input.mediaType as import('./ivr-video-handlers.js').IvrMediaType | undefined;
    if (!callSessionId) {
      return { status: 400, data: { error: 'callSessionId is required' } };
    }
    const session = startIvrSession(db, tenantId, callSessionId, flowId, variables, {
      channelVariables,
      mediaType,
    });
    if (!session) return { status: 404, data: { error: 'no ivr flow available' } };

    const walked = await walkToPromptableAction(
      session.context,
      buildLiveIvrStepInput(db, tenantId, { callSessionId, roomName, channelVariables, mediaType })
    );
    const ready = {
      ...session,
      context: walked.context,
      terminated: walked.terminated,
      stepCount: 1,
    };
    try {
      sessionStore.upsert({
        callSessionId,
        tenantId,
        flowId: ready.flowId,
        context: ready.context,
        stepCount: ready.stepCount,
        terminated: ready.terminated,
        lastAction: walked.action,
      });
    } catch (err) {
      return mapIvrStoreError(err);
    }
    logSessionAction(callSessionId, ready.stepCount, walked.action, walked.context.variables.last_branch_handle);
    const rwi = walked.action ? ivrActionToRwi(walked.action, callSessionId) : null;
    return {
      data: {
        session: {
          callSessionId,
          flowId: ready.flowId,
          terminated: ready.terminated,
          stepCount: ready.stepCount,
          prompt: actionToPromptText(walked.action),
          action: walked.action,
        },
        rwi,
      },
    };
  }

  // GET /api/ivr/sessions/:callSessionId/steps
  const stepsMatch = path.match(/^\/api\/ivr\/sessions\/([^/]+)\/steps$/);
  if (stepsMatch && method === 'GET') {
    const stored = sessionStore.get(stepsMatch[1], tenantId);
    if (!stored) return { status: 404, data: { error: 'session not found' } };
    const steps = sessionStore.listSteps(stepsMatch[1], tenantId).map((s) => ({
      stepIndex: s.step_index,
      nodeId: s.node_id,
      actionKind: s.action_kind,
      branchTaken: s.branch_taken,
      action: parseJson(s.action_json, {}),
      createdAt: s.created_at,
    }));
    return { data: steps };
  }

  // DELETE /api/ivr/sessions/:callSessionId
  const sessionDeleteMatch = path.match(/^\/api\/ivr\/sessions\/([^/]+)$/);
  if (sessionDeleteMatch && method === 'DELETE') {
    const deleted = sessionStore.delete(sessionDeleteMatch[1], tenantId);
    if (!deleted) return { status: 404, data: { error: 'session not found' } };
    return { data: { ok: true } };
  }

  // GET /api/ivr/sessions/:callSessionId
  const sessionGetMatch = path.match(/^\/api\/ivr\/sessions\/([^/]+)$/);
  if (sessionGetMatch && method === 'GET') {
    const stored = sessionStore.get(sessionGetMatch[1], tenantId);
    if (!stored) return { status: 404, data: { error: 'session not found' } };
    return {
      data: {
        callSessionId: stored.call_session_id,
        flowId: stored.flow_id,
        terminated: stored.terminated === 1,
        stepCount: stored.step_count,
        currentNodeId: stored.context.currentNodeId,
        variables: stored.context.variables,
      },
    };
  }

  // POST /api/ivr/sessions/:callSessionId/ai-result
  const aiResultMatch = path.match(/^\/api\/ivr\/sessions\/([^/]+)\/ai-result$/);
  if (aiResultMatch && method === 'POST') {
    const callSessionId = aiResultMatch[1];
    const stored = sessionStore.get(callSessionId, tenantId);
    if (!stored) return { status: 404, data: { error: 'session not found' } };
    if (stored.terminated) {
      return { status: 409, data: { error: 'session already terminated' } };
    }
    if (stored.context.waiting?.kind !== 'ai_dialogue') {
      return { status: 409, data: { error: 'session not waiting for ai_dialogue' } };
    }

    const aiDialogueResult = parseAiDialogueResultBody(input);
    if (!aiDialogueResult) {
      return { status: 400, data: { error: 'invalid ai dialogue result' } };
    }

    const state = {
      callSessionId: stored.call_session_id,
      tenantId: stored.tenant_id,
      flowId: stored.flow_id,
      context: stored.context,
      stepCount: stored.step_count,
      terminated: stored.terminated === 1,
      lastAction: stored.last_action,
    };

    const step = await advanceIvrStep(state, db, { aiDialogueResult, callSessionId });
    let context = step.state.context;
    let terminated = step.state.terminated;
    let action = step.action;
    let stepCount = step.state.stepCount;

    if (action) logSessionAction(callSessionId, stepCount, action, context.variables.last_branch_handle);

    if (!terminated && shouldAutoWalkAfterAdvance(context)) {
      const walked = await walkToPromptableAction(
        context,
        buildLiveIvrStepInput(db, tenantId, { callSessionId })
      );
      context = walked.context;
      terminated = walked.terminated;
      if (walked.action && walked.action !== action) {
        action = walked.action;
        stepCount += 1;
        logSessionAction(callSessionId, stepCount, action, context.variables.last_branch_handle);
      }
    }

    try {
      sessionStore.upsert({
        callSessionId,
        tenantId,
        flowId: step.state.flowId,
        context,
        stepCount,
        terminated,
        lastAction: action,
        expectedRevision: stored.revision,
      });
    } catch (err) {
      return mapIvrStoreError(err);
    }

    const rwi = action ? ivrActionToRwi(action, callSessionId) : null;
    return {
      data: {
        terminated,
        prompt: actionToPromptText(action),
        action,
        rwi,
      },
    };
  }

  // POST /api/ivr/sessions/:callSessionId/advance
  const advanceMatch = path.match(/^\/api\/ivr\/sessions\/([^/]+)\/advance$/);
  if (advanceMatch && method === 'POST') {
    const callSessionId = advanceMatch[1];
    const stored = sessionStore.get(callSessionId, tenantId);
    if (!stored) return { status: 404, data: { error: 'session not found' } };
    if (stored.terminated) {
      return { status: 409, data: { error: 'session already terminated' } };
    }

    const state = {
      callSessionId: stored.call_session_id,
      tenantId: stored.tenant_id,
      flowId: stored.flow_id,
      context: stored.context,
      stepCount: stored.step_count,
      terminated: stored.terminated === 1,
      lastAction: stored.last_action,
    };
    const advanceFields = parseIvrAdvanceBody(input);
    const roomName = advanceFields.roomName;
    const step = await advanceIvrStep(state, db, {
      ...advanceFields,
      callSessionId,
    });
    let context = step.state.context;
    let terminated = step.state.terminated;
    let action = step.action;
    let stepCount = step.state.stepCount;

    if (action) logSessionAction(callSessionId, stepCount, action, context.variables.last_branch_handle);

    if (!terminated && shouldAutoWalkAfterAdvance(context)) {
      const walked = await walkToPromptableAction(
        context,
        buildLiveIvrStepInput(db, tenantId, { callSessionId, roomName })
      );
      context = walked.context;
      terminated = walked.terminated;
      if (walked.action && walked.action !== action) {
        action = walked.action;
        stepCount += 1;
        logSessionAction(callSessionId, stepCount, action, context.variables.last_branch_handle);
      }
    }

    try {
      sessionStore.upsert({
        callSessionId,
        tenantId,
        flowId: step.state.flowId,
        context,
        stepCount,
        terminated,
        lastAction: action,
        expectedRevision: stored.revision,
      });
    } catch (err) {
      return mapIvrStoreError(err);
    }

    const rwi = action ? ivrActionToRwi(action, callSessionId) : null;
    return {
      data: {
        terminated,
        prompt: actionToPromptText(action),
        action,
        rwi,
      },
    };
  }

  return undefined;
}
