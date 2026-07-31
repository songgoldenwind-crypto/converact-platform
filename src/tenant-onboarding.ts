import { one, run } from './db.js';
import { AgentSeatStore } from './agent-runtime/call-center/seat-store.js';
import { CallQueueStore } from './agent-runtime/call-center/inbound/call-queue.js';
import { DidStore } from './agent-runtime/call-center/inbound/did-store.js';
import { DispositionStore } from './agent-runtime/call-center/agent-tools/disposition.js';
import { AgentScriptStore } from './agent-runtime/call-center/agent-tools/agent-script.js';
import { VoiceAgentSpecStore } from './agent-runtime/call-center/voice-agent-spec-store.js';

export interface TenantOnboardingInput {
  tenantId: string;
  tenantName: string;
  userId: string;
  userName: string | null;
}

export interface TenantOnboardingResult {
  sqlite_tenant_id: string;
  default_spec_id: string;
  seat_id: string;
  default_queue_id: string;
  default_did_id?: string;
}

/**
 * Seed call-center defaults for a new tenant (spec, seat, queue, DID).
 * Idempotent — safe to call if tenant already exists.
 */
export function onboardCallCenterTenant(
  db: unknown,
  input: TenantOnboardingInput
): TenantOnboardingResult {
  const existing = one(db, 'SELECT id FROM tenants WHERE id = ?', [input.tenantId]);
  if (!existing) {
    run(db, 'INSERT INTO tenants (id, name, plan_code) VALUES (?, ?, ?)', [
      input.tenantId,
      input.tenantName,
      'free'
    ]);
  }

  const specStore = new VoiceAgentSpecStore(db);
  const template = specStore.getSpec('default-outbound-zh', input.tenantId);

  const published = specStore
    .listSpecs(input.tenantId, 'published')
    .filter((spec) => spec.tenant_id === input.tenantId);

  let defaultSpecId = published[0]?.id;
  if (!defaultSpecId) {
    const created = specStore.createSpec({
      tenant_id: input.tenantId,
      language: template?.language || 'zh',
      goal: template?.goal || '了解客户需求并促成下一步行动',
      status: 'published',
      version: 1,
      tools: template?.tools || [
        'check_compliance',
        'disclosure_complete',
        'check_intent',
        'transfer_human',
        'schedule_callback'
      ],
      compliance: template?.compliance || { ai_disclosure: '本次为 AI 智能外呼服务' },
      runtime: template?.runtime || {
        system_prompt: '你是一位专业、礼貌的中文外呼 AI 助手。',
        greeting: '您好，我是智能客服助手。本次为 AI 外呼服务。请问您现在方便接听吗？'
      },
      nodes: template?.nodes || []
    });
    defaultSpecId = created.id;
  }

  const seatStore = new AgentSeatStore(db);
  const seats = seatStore.listSeats(input.tenantId);
  let seatId = seats.find((seat) => seat.user_id === input.userId)?.id;
  if (!seatId) {
    const seat = seatStore.upsertSeat({
      tenant_id: input.tenantId,
      user_id: input.userId,
      display_name: input.userName || 'Owner',
      skills: ['sales', 'support']
    });
    seatId = seat.id;
  }

  const queueStore = new CallQueueStore(db);
  let defaultQueue = queueStore.getQueueByName(input.tenantId, 'default');
  if (!defaultQueue) {
    defaultQueue = queueStore.createQueue({
      tenant_id: input.tenantId,
      name: 'default',
      strategy: 'longest_idle',
      overflow_target: 'ai'
    });
  }
  queueStore.addMember(defaultQueue.id, seatId, 2);

  new DispositionStore(db).seedDefaults(input.tenantId);
  new AgentScriptStore(db).seedDefault(input.tenantId);

  const didStore = new DidStore(db);
  const placeholderDid = `+86138${input.tenantId.replace(/\D/g, '').slice(-8).padStart(8, '0')}`;
  let defaultDid = didStore.listDids(input.tenantId)[0];
  if (!defaultDid) {
    defaultDid = didStore.createDid({
      tenant_id: input.tenantId,
      number: placeholderDid,
      label: '默认呼入号码',
      route_type: 'queue',
      route_target: defaultQueue.id
    });
  }

  return {
    sqlite_tenant_id: input.tenantId,
    default_spec_id: defaultSpecId,
    seat_id: seatId,
    default_queue_id: defaultQueue.id,
    default_did_id: defaultDid.id
  };
}
