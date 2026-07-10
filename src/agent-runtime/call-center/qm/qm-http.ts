import { all } from '../../../db.js';
import { QmStore } from './qm-store.js';
import { evaluateCallQuality } from './qm-evaluator.js';
import { DEFAULT_QM_POLICY } from './qm-policy.js';
import { isEnvLlmConfigured } from '../../integrations/llm-env-client.js';
import { resolveAuthContext } from '../../../middleware/auth.js';

function requireAuth(headers: Record<string, string | string[] | undefined>) {
  const ctx = resolveAuthContext(headers);
  if (!ctx.authenticated || !ctx.tenantId) {
    throw Object.assign(new Error('authentication required'), { status: 401 });
  }
  return ctx;
}

export async function routeQmApi(
  db: unknown,
  method: string,
  path: string,
  url: URL,
  body: unknown,
  headers: Record<string, string | string[] | undefined>
): Promise<unknown | undefined> {
  const store = new QmStore(db);

  if (path === '/api/qm/evaluations' && method === 'GET') {
    const ctx = requireAuth(headers);
    const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined;
    const minScore = url.searchParams.get('min_score') ? Number(url.searchParams.get('min_score')) : undefined;
    const maxScore = url.searchParams.get('max_score') ? Number(url.searchParams.get('max_score')) : undefined;
    return store.listEvaluations(ctx.tenantId!, { limit, minScore, maxScore });
  }

  const evalMatch = path.match(/^\/api\/qm\/evaluations\/([^/]+)$/);
  if (evalMatch && method === 'GET') {
    const ctx = requireAuth(headers);
    const evaluation = store.getEvaluation(evalMatch[1]);
    if (!evaluation || evaluation.tenant_id !== ctx.tenantId) {
      return { status: 404, data: { error: 'evaluation not found' } };
    }
    return evaluation;
  }

  if (path === '/api/qm/evaluate' && method === 'POST') {
    const ctx = requireAuth(headers);
    const input = body as { call_session_id?: string };
    if (!input?.call_session_id) {
      return { status: 400, data: { error: 'call_session_id is required' } };
    }

    const turns = all(
      db,
      'SELECT role, content FROM ai_conversation_turns WHERE call_session_id = ? ORDER BY turn_index ASC',
      [input.call_session_id]
    );

    if (!turns.length) {
      return { status: 404, data: { error: 'no conversation turns found for session' } };
    }

    const conversationText = turns
      .map((t) => `[${String(t.role)}]: ${String(t.content)}`)
      .join('\n');

    const result = await evaluateCallQuality(conversationText, {
      deps: {},
      policyRules: DEFAULT_QM_POLICY.rules
    });

    const evaluation = store.createEvaluation({
      tenant_id: ctx.tenantId!,
      call_session_id: input.call_session_id,
      evaluator: isEnvLlmConfigured() ? 'llm' : 'fallback',
      scores: result.scores,
      violations: result.violations,
      summary: result.summary,
      recommendation: result.recommendation,
      overall_score: result.overall_score
    });

    return { status: 201, data: evaluation };
  }

  if (path === '/api/qm/evaluations/manual' && method === 'POST') {
    const ctx = requireAuth(headers);
    const input = body as {
      call_session_id?: string;
      evaluator?: string;
      politeness?: number;
      compliance?: number;
      problem_resolution?: number;
      upsell_effectiveness?: number;
      script_adherence?: number;
      violations?: string[];
      summary?: string;
      recommendation?: string;
      overall_score?: number;
    };
    if (!input.call_session_id) {
      return { status: 400, data: { error: 'call_session_id is required' } };
    }
    const evaluation = store.createEvaluation({
      tenant_id: ctx.tenantId!,
      call_session_id: input.call_session_id,
      evaluator: input.evaluator || 'manual',
      scores: {
        politeness: Number(input.politeness ?? 0.8),
        compliance: Number(input.compliance ?? 0.8),
        problem_resolution: Number(input.problem_resolution ?? 0.8),
        upsell_effectiveness: Number(input.upsell_effectiveness ?? 0.7),
        script_adherence: Number(input.script_adherence ?? 0.8)
      },
      violations: input.violations ?? [],
      summary: input.summary || '人工质检',
      recommendation: input.recommendation || '',
      overall_score: Number(input.overall_score ?? 0.8)
    });
    return { status: 201, data: evaluation };
  }

  if (path === '/api/qm/dashboard' && method === 'GET') {
    const ctx = requireAuth(headers);
    return { data: store.getDashboardViewModel(ctx.tenantId!) };
  }

  if (path === '/api/qm/appeals' && method === 'GET') {
    const ctx = requireAuth(headers);
    const status = url.searchParams.get('status') as 'pending' | 'approved' | 'rejected' | null;
    return { data: store.listAppeals(ctx.tenantId!, status) };
  }

  if (path === '/api/qm/appeals' && method === 'POST') {
    const ctx = requireAuth(headers);
    const input = body as {
      evaluation_id?: string;
      call_session_id?: string;
      appellant_user_id?: string;
      reason?: string;
    };
    if (!input.evaluation_id || !input.call_session_id || !input.appellant_user_id || !input.reason) {
      return { status: 400, data: { error: 'missing required appeal fields' } };
    }
    // Verify evaluation belongs to caller's tenant.
    const evaluation = store.getEvaluation(input.evaluation_id);
    if (!evaluation || evaluation.tenant_id !== ctx.tenantId) {
      return { status: 404, data: { error: 'evaluation not found' } };
    }
    const appeal = store.createAppeal({
      tenant_id: ctx.tenantId!,
      evaluation_id: input.evaluation_id,
      call_session_id: input.call_session_id,
      appellant_user_id: input.appellant_user_id,
      reason: input.reason
    });
    return { status: 201, data: appeal };
  }

  const appealResolveMatch = path.match(/^\/api\/qm\/appeals\/([^/]+)\/resolve$/);
  if (appealResolveMatch && method === 'POST') {
    const ctx = requireAuth(headers);
    const input = body as {
      reviewer_user_id?: string;
      status?: 'approved' | 'rejected';
      resolution_notes?: string;
    };
    if (!input.reviewer_user_id || !input.status) {
      return { status: 400, data: { error: 'reviewer_user_id, status required' } };
    }
    const appeal = store.resolveAppeal(
      appealResolveMatch[1],
      ctx.tenantId!,
      input.reviewer_user_id,
      input.status,
      input.resolution_notes || null
    );
    if (!appeal) return { status: 404, data: { error: 'appeal not found' } };
    return { data: appeal };
  }

  return undefined;
}
