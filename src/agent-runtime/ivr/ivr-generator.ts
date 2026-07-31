/**
 * AI IVR Generator — generates IvrFlowGraph from natural language or CSV.
 *
 * Uses dual-stack LLM (primary 27B → fallback DeepSeek) to produce structured
 * IvrFlowGraph JSON. Post-processing applies completeFlowMissingEdges and
 * publishBlockingIssues gate — no silent template fallback.
 */

import { readPrimaryLlmConfig, readFallbackLlmConfig } from '../integrations/llm-config.js';
import { completeWithLlmFallback } from '../integrations/llm-provider.js';
import { completeFlowMissingEdges } from './ivr-complete-menu-edges.js';
import { FEW_SHOT_M1, FEW_SHOT_TIME_CONDITION } from './ivr-generator-seeds.js';
import type { FlowValidationReport, IvrFlowGraph } from './ivr-types.js';
import { validateFlowGraphDetailed } from './ivr-types.js';
import { publishBlockingIssues } from './ivr-validation-policy.js';

const SYSTEM_PROMPT = `You are an IVR flow designer. Given a business requirement or table, generate a JSON IVR flow graph.

The graph has this structure:
{
  "version": 1,
  "entryNodeId": "<start node id>",
  "nodes": [{ "id": "...", "type": "...", "name": "...", "position": {"x":0,"y":0}, "data": {...} }],
  "edges": [{ "id": "...", "source": "...", "target": "...", "sourceHandle": "out|true|false|digit_1|digit_2|...|timeout|invalid|max_retries|success|fail" }],
  "variables": []
}

Available node types and their data (25 types — use only these):
- start: { pushParams: [] }
- play: { contents: [{ playType: "tts", ttsEngine: "ali", text: "..." }] }
- menu: { prompt: [{playType:"tts",ttsEngine:"ali",text:"..."}], options: [{digit:"1",label:"...",routeType:"node",routeTarget:""}], timeoutSec:5, maxRetries:3 }
- collect: { prompt:[...], minDigits:1, maxDigits:6, endMode:"hash_key", inputWaitSec:5, timeoutSec:10, maxRetries:1, storeVariable:"..." }
- set_var: { variableName:"...", valueType:"string", value:"..." }
- condition: { logic:"and", rules:[{field:"...",op:"eq",value:"..."}] }
- time_condition: { scheduleId:"..." }
- queue: { queueName:"...", strategy:"fifo", timeoutSec:300, timeoutAction:"voicemail" }
- http: { method:"GET", url:"...", timeoutSec:10 }
- transfer: { targetType:"agent_ring_all|agent_random|extension|queue|group_call|phone", targetValue:"..." }
- voicemail: { maxDurationSec:60 }
- sip: { sipUri:"sip:..." }
- disconnect: { farewellPrompt: [{ playType:"tts", text:"..." }], endReason: "completed" }
- flush_audio: { }
- ai_dialogue: { role:"outbound|inbound_support", maxTurns:10, timeoutSec:30 }
- intent: { dimension:"score|keyword|emotion", threshold:0.7 }
- knowledge_qa: { knowledgeBaseId:"...", maxResults:3, noAnswerAction:"transfer" }
- avatar_switch: { direction:"voice_to_video|video_to_voice" }
- compliance: { complianceType:"ai_disclosure|recording_consent|privacy_notice", language:"zh" }
- video_play: { sourceType:"prerecorded", loop:false, skippable:true }
- screen_share: { source:"agent|ai", allowRemoteControl:false }
- visual_menu: { title:"...", items:[] }
- subflow: { flowId:"..." }
- recording: { action:"start|stop", format:"wav" }
- webhook: { url:"...", eventType:"...", method:"POST" }

ADR-4 audio queue (MANDATORY):
- ONE play node with multiple contents[] for multi-segment welcome — NEVER play→play→menu
- menu/collect/transfer/disconnect flush audioQueue at sync points
- Do NOT insert flush_audio between play and menu unless user explicitly requests
- menu: edges for each digit_N AND timeout, invalid, max_retries
- Terminal: transfer | voicemail | sip | disconnect

Rules:
- Always start with a "start" node as entryNodeId
- Always end with at least one terminal node (transfer/voicemail/sip/disconnect)
- Position nodes left-to-right (x increments by 200-250, y varies)
- Menu options use sourceHandle "digit_1", "digit_2", etc.
- Condition nodes use "true" and "false" handles
- Keep node names in Chinese (user's language)
- Respond with ONLY the JSON, no markdown fences`;

export interface GenerateIvrResult {
  graph: IvrFlowGraph;
  llmTier: 'primary' | 'fallback';
  model: string;
  warnings: string[];
  publishReady: boolean;
  validation: FlowValidationReport;
}

async function generateGraphFromLlm(userContent: string, language: string): Promise<GenerateIvrResult> {
  const completion = await completeWithLlmFallback(
    {
      messages: [
        {
          role: 'system',
          content: `${SYSTEM_PROMPT}\n\n## Examples\n${FEW_SHOT_M1}\n${FEW_SHOT_TIME_CONDITION}`,
        },
        { role: 'user', content: `Language: ${language}\n\n${userContent}` },
      ],
      temperature: 0.3,
      max_tokens: 8192,
    },
    { primary: readPrimaryLlmConfig(), fallback: readFallbackLlmConfig() }
  );

  let graph: IvrFlowGraph;
  try {
    graph = JSON.parse(extractJson(completion.text)) as IvrFlowGraph;
  } catch (err) {
    const e = new Error(
      `IVR graph JSON parse failed: ${err instanceof Error ? err.message : String(err)}`
    );
    (e as Error & { statusCode?: number }).statusCode = 422;
    throw e;
  }

  const repaired = completeFlowMissingEdges(graph);
  const validation = validateFlowGraphDetailed(repaired.graph);
  const blocking = publishBlockingIssues(validation);
  const warnings = [
    ...completion.warnings,
    ...repaired.applied.map((a) => `auto-complete: ${a.nodeId} +${a.handles.join(',')}`),
  ];

  if (blocking.length > 0) {
    const e = new Error(
      `IVR graph not publish-ready: ${blocking.map((x) => x.message).join('; ')}`
    );
    (e as Error & { statusCode?: number; validation?: FlowValidationReport }).statusCode = 422;
    (e as Error & { validation?: FlowValidationReport }).validation = validation;
    throw e;
  }

  return {
    graph: repaired.graph,
    llmTier: completion.llmTier,
    model: completion.model,
    warnings,
    publishReady: true,
    validation,
  };
}

/**
 * Generate an IVR flow graph from a natural language description.
 */
export async function generateIvrFromText(
  description: string,
  language: string = 'zh'
): Promise<GenerateIvrResult> {
  return generateGraphFromLlm(`Generate an IVR flow for: ${description}`, language);
}

/**
 * Generate an IVR flow graph from CSV content.
 * Expected columns: digit (or key), description (or label), target (or route)
 */
export async function generateIvrFromCsv(
  csvContent: string,
  language: string = 'zh'
): Promise<GenerateIvrResult> {
  const rows = parseCsv(csvContent);
  if (rows.length === 0) {
    const e = new Error('No valid rows in CSV');
    (e as Error & { statusCode?: number }).statusCode = 400;
    throw e;
  }
  const csvSummary = rows
    .map((r) => `按键${r.digit}: ${r.description} → ${r.target || r.label}`)
    .join('\n');
  return generateGraphFromLlm(
    `Generate an IVR flow from this menu table (add play/menu/transfer, ADR-4 multi-segment play in ONE node):\n${csvSummary}`,
    language
  );
}

function extractJson(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return cleaned.slice(start, end + 1);
  }
  return cleaned;
}

interface CsvRow {
  digit: string;
  description: string;
  label: string;
  target: string;
}

function parseCsv(csv: string): CsvRow[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const header = lines[0].toLowerCase();
  const hasHeader = /digit|key|按键|描述|description|label|target|目标|route/.test(header);

  const dataLines = hasHeader ? lines.slice(1) : lines;
  return dataLines
    .map((line) => {
      const cols = line.split(/[,;\t]/).map((c) => c.trim());
      if (hasHeader) {
        const headers = header.split(/[,;\t]/).map((h) => h.trim());
        const digitIdx = headers.findIndex((h) => /digit|key|按键/.test(h));
        const descIdx = headers.findIndex((h) => /描述|description|label/.test(h));
        const targetIdx = headers.findIndex((h) => /target|目标|route/.test(h));
        return {
          digit: digitIdx >= 0 ? cols[digitIdx] : cols[0],
          description: descIdx >= 0 ? cols[descIdx] : cols[1] || '',
          label: descIdx >= 0 ? cols[descIdx] : cols[1] || '',
          target: targetIdx >= 0 ? cols[targetIdx] : cols[2] || '',
        };
      }
      return {
        digit: cols[0],
        description: cols[1] || '',
        label: cols[1] || '',
        target: cols[2] || '',
      };
    })
    .filter((r) => r.digit);
}
