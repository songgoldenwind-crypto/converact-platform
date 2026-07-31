import { all, id, one, run } from '../../db.js';

export type ConversationRole = 'customer' | 'ai' | 'system' | 'agent';

export interface ConversationTurnRow {
  id: string;
  call_session_id: string;
  turn_index: number;
  role: ConversationRole;
  content: string;
  stt_confidence: number | null;
  intent_score: number | null;
  latency_ms: number | null;
  created_at: string;
}

export class ConversationTurnStore {
  constructor(private readonly db: unknown) {}

  appendTurn(
    callSessionId: string,
    input: {
      role: ConversationRole;
      content: string;
      stt_confidence?: number;
      latency_ms?: number;
    }
  ): { id: string; turn_index: number } {
    const latest = one(
      this.db,
      'SELECT MAX(turn_index) AS max_index FROM ai_conversation_turns WHERE call_session_id = ?',
      [callSessionId]
    );
    const turnIndex = Number(latest?.max_index || 0) + 1;
    const turnId = id('turn');
    run(
      this.db,
      `INSERT INTO ai_conversation_turns
        (id, call_session_id, turn_index, role, content, stt_confidence, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        turnId,
        callSessionId,
        turnIndex,
        input.role,
        input.content,
        input.stt_confidence ?? null,
        input.latency_ms ?? null
      ]
    );
    return { id: turnId, turn_index: turnIndex };
  }

  listTurns(callSessionId: string): ConversationTurnRow[] {
    return all(
      this.db,
      `SELECT * FROM ai_conversation_turns WHERE call_session_id = ? ORDER BY turn_index ASC`,
      [callSessionId]
    ).map(decodeTurn);
  }

  updateLatestIntent(callSessionId: string, intentScore: number): void {
    const latest = one(
      this.db,
      `SELECT id FROM ai_conversation_turns
       WHERE call_session_id = ?
       ORDER BY turn_index DESC LIMIT 1`,
      [callSessionId]
    );
    if (!latest?.id) return;
    run(this.db, 'UPDATE ai_conversation_turns SET intent_score = ? WHERE id = ?', [
      intentScore,
      latest.id
    ]);
  }
}

function decodeTurn(row: Record<string, unknown>): ConversationTurnRow {
  return {
    id: String(row.id),
    call_session_id: String(row.call_session_id),
    turn_index: Number(row.turn_index),
    role: String(row.role) as ConversationRole,
    content: String(row.content),
    stt_confidence: row.stt_confidence == null ? null : Number(row.stt_confidence),
    intent_score: row.intent_score == null ? null : Number(row.intent_score),
    latency_ms: row.latency_ms == null ? null : Number(row.latency_ms),
    created_at: String(row.created_at)
  };
}
