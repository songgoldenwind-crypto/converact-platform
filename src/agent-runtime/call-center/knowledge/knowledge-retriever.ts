import { chatCompletionsWithFallback } from '../../integrations/llm-env-client.js';

export interface RetrieverDeps {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface RetrievalResult {
  answer: string;
  sources: { document_id: string; title: string; snippet: string }[];
  confidence: number;
}

const SYSTEM_PROMPT = `你是企业知识库助手。根据以下参考文档回答用户问题。
如果文档中没有相关信息，回答"我没有找到相关信息"。
必须引用信息来源的文档标题。

参考文档：
{documents}

返回 JSON：{"answer":"回答内容","sources":[{"document_id":"id","title":"标题","snippet":"引用片段"}],"confidence":0.9}`;

export async function retrieveAndAnswer(
  question: string,
  documents: { id: string; title: string; content: string }[],
  _deps?: RetrieverDeps
): Promise<RetrievalResult> {
  if (!documents.length) {
    return { answer: '我没有找到相关信息', sources: [], confidence: 0 };
  }

  const docsText = documents
    .map((d) => `【文档: ${d.title}】(id: ${d.id})\n${d.content}`)
    .join('\n\n---\n\n');

  const systemMessage = SYSTEM_PROMPT.replace('{documents}', docsText);

  try {
    const result = await chatCompletionsWithFallback({
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: question }
      ],
      temperature: 0.1,
      extraBody: { response_format: { type: 'json_object' } }
    });

    const parsed = JSON.parse(result.text) as Partial<RetrievalResult>;
    return validateResult(parsed);
  } catch (error) {
    console.warn('[knowledge-retriever] LLM retrieval failed:', error);
    return { answer: '无法回答', sources: [], confidence: 0 };
  }
}

function validateResult(raw: Partial<RetrievalResult>): RetrievalResult {
  const sources = Array.isArray(raw.sources)
    ? raw.sources
        .filter((s) => s && typeof s.document_id === 'string')
        .map((s) => ({
          document_id: String(s.document_id),
          title: String(s.title ?? ''),
          snippet: String(s.snippet ?? '')
        }))
    : [];

  const confidence = typeof raw.confidence === 'number'
    ? Math.max(0, Math.min(1, raw.confidence))
    : 0.5;

  return {
    answer: typeof raw.answer === 'string' ? raw.answer : '无法回答',
    sources,
    confidence
  };
}
