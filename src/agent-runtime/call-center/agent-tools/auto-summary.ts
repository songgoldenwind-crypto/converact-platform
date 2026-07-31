import { all, run } from '../../../db.js';
import { chatCompletionsWithFallback, isEnvLlmConfigured } from '../../integrations/llm-env-client.js';

export interface CallSummaryResult {
  call_session_id: string;
  summary: string;
  source: 'llm' | 'fallback';
}

export async function generateCallSummary(
  db: unknown,
  tenantId: string,
  callSessionId: string
): Promise<CallSummaryResult | null> {
  const existing = all(
    db,
    'SELECT summary FROM call_summaries WHERE call_session_id = ?',
    [callSessionId]
  );
  if (existing.length) {
    return {
      call_session_id: callSessionId,
      summary: String((existing[0] as { summary: string }).summary),
      source: 'llm'
    };
  }

  const turns = all(
    db,
    'SELECT role, content FROM ai_conversation_turns WHERE call_session_id = ? ORDER BY turn_index ASC',
    [callSessionId]
  );
  if (!turns.length) return null;

  const transcript = turns
    .map((t) => `${String((t as { role: string }).role)}: ${String((t as { content: string }).content)}`)
    .join('\n');

  let summary = '通话已结束。';
  let source: CallSummaryResult['source'] = 'fallback';

  if (isEnvLlmConfigured()) {
    try {
      const result = await chatCompletionsWithFallback({
        messages: [
          {
            role: 'system',
            content: '你是呼叫中心助手。用 2-3 句中文总结通话要点、客户意向与下一步。'
          },
          { role: 'user', content: transcript }
        ],
        temperature: 0.2
      });
      if (result.text) {
        summary = result.text;
        source = 'llm';
      }
    } catch (error) {
      console.warn('[auto-summary] LLM failed:', error);
    }
  }

  run(
    db,
    `INSERT INTO call_summaries (call_session_id, tenant_id, summary, source)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(call_session_id) DO UPDATE SET summary = excluded.summary, source = excluded.source`,
    [callSessionId, tenantId, summary, source]
  );

  return { call_session_id: callSessionId, summary, source };
}
