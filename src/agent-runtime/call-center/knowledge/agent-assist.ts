import { retrieveAndAnswer } from './knowledge-retriever.js';
import type { RetrieverDeps } from './knowledge-retriever.js';

export interface AgentAssistSuggestion {
  type: 'knowledge' | 'script' | 'warning';
  content: string;
  source?: string;
  confidence: number;
  timestamp: string;
}

const COMPLIANCE_KEYWORDS = [
  '保证收益', '稳赚不赔', '绝对安全', '100%',
  '承诺回报', '无风险', '一定赚', '必赚'
];

export async function generateAssistSuggestion(
  latestTurn: string,
  conversationContext: string[],
  documents: { id: string; title: string; content: string }[],
  _deps?: RetrieverDeps
): Promise<AgentAssistSuggestion | null> {
  const now = new Date().toISOString();

  for (const keyword of COMPLIANCE_KEYWORDS) {
    if (latestTurn.includes(keyword)) {
      return {
        type: 'warning',
        content: `检测到合规风险用语"${keyword}"，请避免使用此类表述。`,
        confidence: 0.95,
        timestamp: now
      };
    }
  }

  const isQuestion = /[？?]/.test(latestTurn) ||
    ['什么', '怎么', '如何', '为什么', '哪', '多少', '能不能', '可以吗'].some((q) => latestTurn.includes(q));

  if (!isQuestion || !documents.length) return null;

  const result = await retrieveAndAnswer(latestTurn, documents);

  if (result.confidence < 0.3 || result.answer === '我没有找到相关信息' || result.answer === '无法回答') {
    return null;
  }

  return {
    type: 'knowledge',
    content: result.answer,
    source: result.sources[0]?.title,
    confidence: result.confidence,
    timestamp: now
  };
}
