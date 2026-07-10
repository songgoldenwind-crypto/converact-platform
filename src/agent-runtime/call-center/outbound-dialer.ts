import { randomUUID } from 'node:crypto';
import { one } from '../../db.js';
import { broadcastOutboundTaskUpdated } from '../../call-center-events.js';
import { initCallSessionCache } from '../../redis-session-cache.js';
import type { VoiceStore } from '../voice/voice-store.js';
import { createLiveKitMediaModule } from '../livekit/index.js';
import { readLiveKitConfig } from '../livekit/config.js';
import type { LiveKitRoomStore } from '../livekit/room-store.js';
import { dialerWaitRegistry } from './dialer-wait-registry.js';
import type { OutboundTaskRow, OutboundTaskStore } from './outbound-task-store.js';
import { isInDialingWindow, isTaskReadyForRetry, retryDelayForCause } from './retry-policy.js';
import type { RWIClientLike } from './rwi-client.js';
import { RWIClient as RWIClientImpl, readRWIConfig } from './rwi-client.js';
import type { SMSSender } from './sms-sender.js';
import { beginDisclosure } from './compliance/disclosure-enforcer.js';
import { buildVideoInviteSms, createSMSSender } from './sms-sender.js';
import type { TaskLockStore } from './task-lock.js';
import { createTaskLockStore } from './task-lock.js';
import { attachRwiSessionSync } from './rwi-session-handler.js';
import { VoiceAgentSpecStore } from './voice-agent-spec-store.js';
import { getRootNodeId } from './voice-agent-navigator.js';
import { AgentSeatStore } from './seat-store.js';
import { computePredictiveDialPlan, isPredictiveStrategy, isProgressiveStrategy, computeProgressiveDialCap } from './dialer/predictive-engine.js';

function buildCustomerH5Url(baseUrl: string, joinPath: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  return `${normalizedBase}${joinPath.startsWith('/') ? joinPath : `/${joinPath}`}`;
}

export interface OutboundDialerDeps {
  db: unknown;
  voiceStore: VoiceStore;
  outboundTaskStore: OutboundTaskStore;
  roomStore: LiveKitRoomStore;
  taskLock: TaskLockStore;
  rwiClient: RWIClientLike | null;
  smsSender: SMSSender;
  voiceAgentSpecStore?: VoiceAgentSpecStore;
  instanceId: string;
  sipBridgeTarget: string;
  defaultTrunk: string;
  h5BaseUrl: string;
  /** Optional billing store for quota enforcement. When provided, dialer
   * checks quota before each call and increments ai_minutes_used after. */
  billingStore?: { checkQuota: (tenantId: string) => { allowed: boolean; reason?: string }; incrementUsage: (tenantId: string, field: 'ai_minutes_used' | 'tool_calls_used' | 'seats_used', amount: number) => void };
}

export class OutboundDialer {
  private ticker: ReturnType<typeof setInterval> | null = null;
  private globalPausedUntil = 0;
  private readonly activeCalls = new Map<string, number>();
  private readonly specStore: VoiceAgentSpecStore;

  constructor(private readonly deps: OutboundDialerDeps) {
    this.specStore = deps.voiceAgentSpecStore ?? new VoiceAgentSpecStore(deps.db);
    if (deps.rwiClient) {
      attachRwiSessionSync(deps.rwiClient, {
        db: deps.db,
        voiceStore: deps.voiceStore,
        outboundTaskStore: deps.outboundTaskStore,
        taskLock: deps.taskLock
      });
    }
  }

  start(intervalMs = Number(process.env.OPC_DIALER_INTERVAL_MS || 3000)): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      void this.pickAndExecute().catch((error) => {
        console.error('[dialer] pickAndExecute failed:', error);
      });
    }, intervalMs);
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  getRwiClient(): RWIClientLike | null {
    return this.deps.rwiClient;
  }

  async pickAndExecute(): Promise<void> {
    if (Date.now() < this.globalPausedUntil) return;

    try {
      const { QueueCallbackProcessor } = await import('./queue-callback-processor.js');
      new QueueCallbackProcessor(this.deps.db, this.deps.outboundTaskStore).processPending(3);
    } catch (error) {
      console.warn('[dialer] queue callback processor failed:', error);
    }

    const maxGlobal = Number(process.env.MAX_CONCURRENT_OUTBOUND || 20);
    const totalActive = [...this.activeCalls.values()].reduce((a, b) => a + b, 0);
    if (totalActive >= maxGlobal) return;

    const candidates = this.deps.outboundTaskStore
      .pickPendingTasks(20)
      .filter((task) => isTaskReadyForRetry(task));

    const seatStore = new AgentSeatStore(this.deps.db);
    const tenantDialBudget = new Map<string, number>();

    for (const task of candidates) {
      if (!isInDialingWindow(task.tenant_id)) continue;
      if (await this.deps.taskLock.isDialerPaused(task.tenant_id)) continue;

      if (isPredictiveStrategy(task.strategy)) {
        if (!tenantDialBudget.has(task.tenant_id)) {
          const idle = seatStore.countIdleSeats(task.tenant_id);
          const plan = computePredictiveDialPlan({
            idleAgents: idle,
            busyAgents: Math.max(0, this.activeCalls.get(task.tenant_id) || 0),
            ringingCalls: 0,
            answerRate: Number(process.env.OPC_PREDICTIVE_ANSWER_RATE || 0.35),
            abandonRate: Number(process.env.OPC_PREDICTIVE_ABANDON_RATE || 0.02)
          });
          tenantDialBudget.set(task.tenant_id, plan.concurrentDials);
        }
        const budget = tenantDialBudget.get(task.tenant_id) || 1;
        const activeForTenant = this.activeCalls.get(task.tenant_id) || 0;
        if (activeForTenant >= budget) continue;
      }

      if (isProgressiveStrategy(task.strategy)) {
        const idle = seatStore.countIdleSeats(task.tenant_id);
        const cap = computeProgressiveDialCap(idle, this.activeCalls.get(task.tenant_id) || 0);
        if (cap <= 0) continue;
      }

      if (!this.canDialForTenant(task.tenant_id)) break;

      const locked = await this.deps.taskLock.lockTask(task.id, this.deps.instanceId);
      if (!locked) continue;
      if (!this.canDialForTenant(task.tenant_id)) {
        await this.deps.taskLock.unlockTask(task.id, this.deps.instanceId);
        break;
      }

      this.bumpActive(task.tenant_id, 1);
      void this.runLockedTask(task);
    }
  }

  private async runLockedTask(task: OutboundTaskRow): Promise<void> {
    try {
      await this.executeTask(task);
    } catch (error) {
      const err = error as Error & { code?: string };
      console.error(`[dialer] task ${task.id} failed:`, error);
      await this.failTask(task, err.message, err.code || 'dialer_error');
      // Cleanup side effects: mark any orphaned call session as failed
      // to prevent zombie 'ringing'/'queued' records that pollute wallboard.
      // LiveKit rooms are left for idle timeout auto-cleanup (LiveKit
      // closes empty rooms after a configurable timeout).
      if (task.call_session_id) {
        try {
          this.deps.voiceStore.updateCallSession(task.tenant_id, task.call_session_id, {
            status: 'failed',
            ended_at: new Date().toISOString()
          });
        } catch { /* best-effort cleanup */ }
      }
    } finally {
      this.bumpActive(task.tenant_id, -1);
      await this.deps.taskLock.unlockTask(task.id, this.deps.instanceId);
    }
  }

  async executeTask(task: OutboundTaskRow): Promise<void> {
    // Quota check: reject call if tenant has exceeded AI minutes limit.
    if (this.deps.billingStore) {
      const quota = this.deps.billingStore.checkQuota(task.tenant_id);
      if (!quota.allowed) {
        await this.failTask(task, `quota_exceeded: ${quota.reason || ''}`, 'quota_exceeded');
        return;
      }
    }

    const callStartedAt = Date.now();
    if (task.channel === 'video_link_sms') {
      await this.executeVideoLinkTask(task);
    } else {
      await this.executePstnVoiceTask(task);
    }

    // Increment AI minutes usage after call completes.
    if (this.deps.billingStore) {
      const durationMinutes = Math.ceil((Date.now() - callStartedAt) / 60_000);
      if (durationMinutes > 0) {
        try {
          this.deps.billingStore.incrementUsage(task.tenant_id, 'ai_minutes_used', durationMinutes);
        } catch (error) {
          console.warn(`[dialer] usage increment failed for tenant ${task.tenant_id}:`, error);
        }
      }
    }
  }

  private resolveAgentConfig(task: OutboundTaskRow) {
    const strategy = task.strategy || {};
    const agentSpecId = String(strategy.agent_spec_id || '');
    const spec = agentSpecId ? this.specStore.getSpec(agentSpecId, task.tenant_id) : null;
    const language = String(strategy.language || spec?.language || 'zh');
    const scriptId = String(strategy.script_id || 'default');
    return {
      language,
      scriptId,
      agentSpecId: spec ? agentSpecId : '',
      tools: spec?.tools,
      specGoal: spec?.goal,
      rootNodeId: spec?.nodes?.length ? getRootNodeId(spec) : null
    };
  }

  private async executePstnVoiceTask(task: OutboundTaskRow): Promise<void> {
    const compliance = await (
      await import('./compliance/outbound-compliance.js')
    ).checkOutboundCompliance(task.tenant_id, task.phone_number);
    if (!compliance.allowed) {
      await this.failTask(
        task,
        `compliance blocked: ${compliance.reason || 'unknown'}`,
        compliance.reason || 'compliance_blocked'
      );
      return;
    }

    const agentConfig = this.resolveAgentConfig(task);
    const language = agentConfig.language;
    const scriptId = agentConfig.scriptId;

    const session = this.deps.voiceStore.createCallSession({
        tenant_id: task.tenant_id,
        provider: 'rustpbx',
        direction: 'outbound',
        route_id: 'ai-outbound',
        status: 'queued',
        phone: task.phone_number,
        lead_id: task.lead_id,
        metadata: {
          outbound_task_id: task.id,
          channel: task.channel,
          script_id: scriptId,
          agent_spec_id: agentConfig.agentSpecId || undefined,
          language,
          goal: agentConfig.specGoal,
          current_node_id: agentConfig.rootNodeId || undefined,
          campaign_id: task.strategy?.campaign_id,
          campaign_contact_id: task.strategy?.campaign_contact_id,
          ab_variant: task.strategy?.ab_variant,
          dial_mode: task.strategy?.dial_mode,
          enable_post_call_survey: task.strategy?.campaign_id ? true : undefined
        }
      });

      void initCallSessionCache(session.id, task.tenant_id, {
        state: 'queued',
        current_node: agentConfig.rootNodeId || '',
        variables: {
          outbound_task_id: task.id,
          phone_number: task.phone_number,
          agent_spec_id: agentConfig.agentSpecId || ''
        }
      }).catch((error) => {
        console.warn('[session-cache] init failed:', error);
      });

      this.deps.outboundTaskStore.updateTask(task.id, {
        status: 'dialing',
        started_at: new Date().toISOString(),
        call_session_id: session.id
      });

      void (await import('./compliance/outbound-compliance.js')).recordOutboundDialCompliance(
        task.tenant_id,
        task.phone_number,
        session.id
      ).catch((error) => {
        // Compliance logging is best-effort — a DB hiccup here must not crash
        // the dialer (which is mid-call). The call itself already passed the
        // pre-dial compliance gate; this only records the attempt for audit.
        console.warn('[dialer] recordOutboundDialCompliance failed:', error instanceof Error ? error.message : error);
      });

      const room = await this.deps.roomStore.createRoom({
        tenant_id: task.tenant_id,
        purpose: 'pstn_bridge',
        call_session_id: session.id,
        metadata: {
          outbound_task_id: task.id,
          call_session_id: session.id,
          tenant_id: task.tenant_id,
          script_id: scriptId,
          agent_spec_id: agentConfig.agentSpecId || undefined,
          language,
          media_type: 'audio',
          tools: agentConfig.tools,
          current_node_id: agentConfig.rootNodeId || undefined
        }
      });

      // Begin AI disclosure before dispatching agent — compliance requires
      // the AI to play a disclosure announcement before conversing.
      const disclosure = beginDisclosure(session.id, task.tenant_id, language);

      const media = createLiveKitMediaModule({ db: this.deps.db });
      const dispatched = await media.dispatch.dispatchAiAgent(room.room_name, {
        outbound_task_id: task.id,
        call_session_id: session.id,
        tenant_id: task.tenant_id,
        script_id: scriptId,
        agent_spec_id: agentConfig.agentSpecId || undefined,
        language,
        tools: agentConfig.tools,
        disclosure_config: disclosure
      });

      if (dispatched) {
        const agentJoinMs = Number(process.env.OPC_DIALER_AGENT_JOIN_TIMEOUT_MS || 10_000);
        const agentJoined = await dialerWaitRegistry.waitForAgentJoin(room.room_name, agentJoinMs);
        if (!agentJoined) {
          console.warn(`[dialer] AI agent did not join room ${room.room_name} within ${agentJoinMs}ms; continuing`);
        }
      }

      if (!this.deps.rwiClient?.isConnected()) {
        throw Object.assign(new Error('RWI not connected'), { code: 'rwi_not_connected' });
      }

      const originate = await this.deps.rwiClient.originate({
        to: `sip:${task.phone_number}@trunk`,
        trunk: this.deps.defaultTrunk,
        timeout_sec: 30,
        metadata: {
          tenant_id: task.tenant_id,
          outbound_task_id: task.id,
          call_session_id: session.id
        }
      });

      this.deps.voiceStore.updateCallSession(task.tenant_id, session.id, {
        rustpbx_call_id: originate.call_id,
        status: 'ringing'
      });
      this.deps.outboundTaskStore.updateTask(task.id, {
        result: { rustpbx_call_id: originate.call_id }
      });

      const answerTimeoutMs = Number(process.env.OPC_DIALER_ANSWER_TIMEOUT_MS || 30_000);
      const answered = await dialerWaitRegistry.waitForCallAnswered(originate.call_id, answerTimeoutMs);
      if (!answered) {
        // Hangup the unanswered PSTN call to prevent orphan calls where
        // the callee picks up after we've already given up.
        try {
          await this.deps.rwiClient.hangup(originate.call_id);
        } catch { /* best-effort — call may have already ended */ }
        await this.failTask(task, 'no_answer', 'no_answer');
        return;
      }

      await this.deps.rwiClient.bridge(originate.call_id, this.deps.sipBridgeTarget);
      this.deps.outboundTaskStore.updateTask(task.id, { status: 'connected' });
  }

  private async executeVideoLinkTask(task: OutboundTaskRow): Promise<void> {
    const agentConfig = this.resolveAgentConfig(task);
    const language = agentConfig.language;
    const scriptId = agentConfig.scriptId;

    const session = this.deps.voiceStore.createCallSession({
        tenant_id: task.tenant_id,
        provider: 'livekit',
        direction: 'outbound',
        route_id: 'video-link',
        status: 'queued',
        phone: task.phone_number,
        lead_id: task.lead_id,
        metadata: { outbound_task_id: task.id, channel: task.channel, media_type: 'video' }
      });
      this.deps.voiceStore.updateCallSession(task.tenant_id, session.id, { media_type: 'video' });

      this.deps.outboundTaskStore.updateTask(task.id, {
        status: 'dialing',
        started_at: new Date().toISOString(),
        call_session_id: session.id
      });

      const room = await this.deps.roomStore.createRoom({
        tenant_id: task.tenant_id,
        purpose: 'ai_outbound',
        call_session_id: session.id,
        metadata: {
          outbound_task_id: task.id,
          call_session_id: session.id,
          tenant_id: task.tenant_id,
          script_id: scriptId,
          agent_spec_id: agentConfig.agentSpecId || undefined,
          language,
          media_type: 'video',
          video_enabled: true,
          // Enable AI video avatar (digital human) for video-link calls.
          // The Python Agent reads this to publish a MuseTalk video track.
          avatar_enabled: true,
          tools: agentConfig.tools
        }
      });

      // Begin AI disclosure before dispatching agent — compliance requires
      // the AI to play a disclosure announcement before conversing.
      const disclosure = beginDisclosure(session.id, task.tenant_id, language);

      const media = createLiveKitMediaModule({ db: this.deps.db });
      await media.dispatch.dispatchAiAgent(room.room_name, {
        outbound_task_id: task.id,
        call_session_id: session.id,
        tenant_id: task.tenant_id,
        script_id: scriptId,
        agent_spec_id: agentConfig.agentSpecId || undefined,
        language,
        video_enabled: true,
        tools: agentConfig.tools,
        disclosure_config: disclosure
      });

      const customerPlan = await media.joins.prepareJoin('webrtc', {
        tenantId: task.tenant_id,
        roomName: room.room_name,
        identity: `customer-${task.id}`,
        role: 'customer',
        media: 'video',
        contact: { phone: task.phone_number }
      });
      if (customerPlan.mode !== 'webrtc' || !customerPlan.joinPath) {
        throw Object.assign(new Error('customer video join path unavailable'), { status: 500 });
      }
      const h5Url = buildCustomerH5Url(this.deps.h5BaseUrl, customerPlan.joinPath);
      const smsBody = buildVideoInviteSms({ url: h5Url, language });
      const smsResult = await this.deps.smsSender.send({
        to: task.phone_number,
        body: smsBody,
        tenant_id: task.tenant_id
      });
      if (!smsResult.success) {
        await this.failTask(task, smsResult.error || 'sms_failed', 'sms_failed');
        return;
      }

      const customerJoinMs = Number(process.env.OPC_DIALER_CUSTOMER_JOIN_TIMEOUT_MS || 120_000);
      const customerJoined = await dialerWaitRegistry.waitForCustomerJoin(room.room_name, customerJoinMs);
      if (!customerJoined) {
        await this.failTask(task, 'customer_no_show', 'no_answer');
        return;
      }

      this.deps.outboundTaskStore.updateTask(task.id, { status: 'connected' });
  }

  private async failTask(task: OutboundTaskRow, reason: string, hangupCause: string): Promise<void> {
    // Previously: const code = String((reason as any)?.code || hangupCause)
    // reason is always a string, so .code was always undefined → fell back to hangupCause.
    // This worked by accident but masked the intent. Now explicit:
    const code = hangupCause;
    if (code === 'call_limit_exceeded') {
      this.globalPausedUntil = Date.now() + 30_000;
      await this.deps.taskLock.setDialerPause(task.tenant_id, true);
    }
    if (code === 'trunk_unavailable' || code === 'no_trunk') {
      this.deps.outboundTaskStore.updateTask(task.id, {
        status: 'failed',
        completed_at: new Date().toISOString(),
        result: { hangup_cause: 'no_trunk', reason }
      });
      return;
    }

    const delay = retryDelayForCause(hangupCause);
    const nextAttempts = task.attempt_count + 1;
    const permanent = delay === null || nextAttempts >= task.max_attempts;
    const updated = this.deps.outboundTaskStore.updateTask(task.id, {
      status: permanent ? 'failed' : 'pending',
      attempt_count: nextAttempts,
      completed_at: permanent ? new Date().toISOString() : null,
      result: { hangup_cause: hangupCause, reason, answered: false }
    });
    if (updated) {
      broadcastOutboundTaskUpdated(task.tenant_id, updated as unknown as Record<string, unknown>);
    }
  }

  private canDialForTenant(tenantId: string): boolean {
    const maxPerTenant = Number(process.env.MAX_CONCURRENT_OUTBOUND_PER_TENANT || 5);
    const maxGlobal = Number(process.env.MAX_CONCURRENT_OUTBOUND || 20);
    const totalActive = [...this.activeCalls.values()].reduce((a, b) => a + b, 0);
    if (totalActive >= maxGlobal) return false;
    return (this.activeCalls.get(tenantId) || 0) < maxPerTenant;
  }

  private bumpActive(tenantId: string, delta: number): void {
    const next = Math.max(0, (this.activeCalls.get(tenantId) || 0) + delta);
    if (next === 0) this.activeCalls.delete(tenantId);
    else this.activeCalls.set(tenantId, next);
  }
}

export async function createOutboundDialer(deps: {
  db: unknown;
  voiceStore: VoiceStore;
  outboundTaskStore: OutboundTaskStore;
  roomStore: LiveKitRoomStore;
  taskLock?: TaskLockStore;
  rwiClient?: RWIClientLike | null;
  smsSender?: SMSSender;
}): Promise<OutboundDialer> {
  const rwiConfig = readRWIConfig();
  let rwiClient = deps.rwiClient ?? null;
  if (rwiClient === undefined && rwiConfig.url) {
    rwiClient = new RWIClientImpl({ url: rwiConfig.url, authToken: rwiConfig.authToken });
    try {
      await rwiClient.connect();
    } catch (error) {
      console.warn('[dialer] RWI connect failed, outbound PSTN disabled until reconnect:', error);
    }
  }

  const taskLock = deps.taskLock || (await createTaskLockStore());
  const livekit = readLiveKitConfig();
  const dialerDeps: OutboundDialerDeps = {
    db: deps.db,
    voiceStore: deps.voiceStore,
    outboundTaskStore: deps.outboundTaskStore,
    roomStore: deps.roomStore,
    taskLock,
    rwiClient,
    smsSender: deps.smsSender || createSMSSender(),
    instanceId: process.env.OPC_INSTANCE_ID || `dialer-${randomUUID().slice(0, 8)}`,
    sipBridgeTarget: livekit.sipBridgeTarget,
    defaultTrunk: process.env.RUSTPBX_DEFAULT_TRUNK || 'twilio-japan',
    h5BaseUrl: process.env.CUSTOMER_H5_BASE_URL || 'http://localhost:5173'
  };
  const dialer = new OutboundDialer(dialerDeps);

  return dialer;
}

export function findSessionByRustpbxCallId(db: unknown, callId: string) {
  return one(db, 'SELECT * FROM voice_call_sessions WHERE rustpbx_call_id = ? ORDER BY updated_at DESC LIMIT 1', [
    callId
  ]);
}
