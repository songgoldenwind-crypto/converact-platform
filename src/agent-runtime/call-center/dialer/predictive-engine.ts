export interface PredictiveMetrics {
  idleAgents: number;
  busyAgents: number;
  ringingCalls: number;
  answerRate: number;
  abandonRate: number;
  targetAbandonRate?: number;
}

export interface PredictiveDialPlan {
  concurrentDials: number;
  dialLevel: number;
  reason: string;
}

const DEFAULT_TARGET_ABANDON = 0.03;
const MIN_DIAL_LEVEL = 1;
const MAX_DIAL_LEVEL = 5;

export function computePredictiveDialPlan(metrics: PredictiveMetrics): PredictiveDialPlan {
  const idle = Math.max(0, metrics.idleAgents);
  const busy = Math.max(0, metrics.busyAgents);
  const ringing = Math.max(0, metrics.ringingCalls);
  const answerRate = clamp(metrics.answerRate, 0.05, 0.95);
  const abandonRate = clamp(metrics.abandonRate, 0, 1);
  const targetAbandon = metrics.targetAbandonRate ?? DEFAULT_TARGET_ABANDON;

  let dialLevel = idle <= 0 ? MIN_DIAL_LEVEL : Math.max(MIN_DIAL_LEVEL, Math.round(idle * (1 / answerRate)));
  dialLevel = Math.min(MAX_DIAL_LEVEL, dialLevel);

  if (abandonRate > targetAbandon) {
    dialLevel = Math.max(MIN_DIAL_LEVEL, dialLevel - 1);
  } else if (abandonRate < targetAbandon / 2 && idle > busy) {
    dialLevel = Math.min(MAX_DIAL_LEVEL, dialLevel + 1);
  }

  const concurrentDials = Math.max(1, dialLevel + ringing);
  const reason =
    abandonRate > targetAbandon
      ? 'abandon_rate_high_slowdown'
      : idle > busy
        ? 'idle_agents_boost'
        : 'steady_state';

  return { concurrentDials, dialLevel, reason };
}

export function isPredictiveStrategy(strategy: Record<string, unknown> | null | undefined): boolean {
  if (!strategy) return false;
  const mode = String(strategy.dial_mode || strategy.mode || '');
  return mode === 'predictive' || strategy.predictive === true;
}

export function isPreviewStrategy(strategy: Record<string, unknown> | null | undefined): boolean {
  if (!strategy) return false;
  return String(strategy.dial_mode || strategy.mode || '') === 'preview';
}

export function isProgressiveStrategy(strategy: Record<string, unknown> | null | undefined): boolean {
  if (!strategy) return false;
  return String(strategy.dial_mode || strategy.mode || '') === 'progressive';
}

export function isPreviewReady(strategy: Record<string, unknown> | null | undefined): boolean {
  if (!isPreviewStrategy(strategy)) return true;
  return strategy?.preview_confirmed === true;
}

export function computeProgressiveDialCap(idleAgents: number, activeDials: number): number {
  if (idleAgents <= 0) return 0;
  return Math.max(0, idleAgents - activeDials);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
