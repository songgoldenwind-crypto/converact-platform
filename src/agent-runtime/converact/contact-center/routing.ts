import { ContactCenterError } from './errors.js';
import { canAcceptVoiceWork } from './state-machine.js';
import type {
  ContactCenterQueueEstimateInput,
  ContactCenterRoutingCandidate,
  ContactCenterRoutingStrategy
} from './types.js';

export function rankContactCenterAgents(
  input: readonly ContactCenterRoutingCandidate[],
  options: {
    strategy: ContactCenterRoutingStrategy;
    required_skills?: Record<string, number>;
    round_robin_after?: string;
  }
): ContactCenterRoutingCandidate[] {
  const requirements = Object.entries(options.required_skills || {});
  const candidates = input.filter((candidate) =>
    canAcceptVoiceWork({
      state: candidate.presence_state,
      active_voice_count: candidate.active_voice_count,
      voice_capacity: candidate.voice_capacity
    }) && requirements.every(([skill, minimum]) =>
      Number.isFinite(minimum) && minimum >= 0 && (candidate.skills[skill] ?? -1) >= minimum
    )
  );
  const strategy = options.strategy;
  if (strategy === 'round_robin') return roundRobin(candidates, options.round_robin_after);
  return [...candidates].sort((left, right) => compare(left, right, strategy, requirements));
}

export function estimateQueueWaitSeconds(input: ContactCenterQueueEstimateInput): number {
  if (!Number.isInteger(input.position) || input.position < 1) {
    throw new ContactCenterError({ code: 'validation_failed', status: 422, message: 'position must be a positive integer' });
  }
  const handleSeconds = Number.isFinite(input.average_handle_seconds) && input.average_handle_seconds > 0
    ? input.average_handle_seconds
    : 60;
  const capacity = Number.isInteger(input.available_agents) && input.available_agents > 0
    ? input.available_agents
    : 1;
  return Math.min(86_400, Math.max(1, Math.ceil((input.position * handleSeconds) / capacity)));
}

function compare(
  left: ContactCenterRoutingCandidate,
  right: ContactCenterRoutingCandidate,
  strategy: Exclude<ContactCenterRoutingStrategy, 'round_robin'>,
  requirements: Array<[string, number]>
): number {
  if (strategy === 'least_calls') {
    return left.handled_count - right.handled_count || idle(left, right) || left.agent_id.localeCompare(right.agent_id);
  }
  if (strategy === 'skill_priority') {
    return right.member_priority - left.member_priority ||
      requiredSkillScore(right, requirements) - requiredSkillScore(left, requirements) ||
      idle(left, right) || left.agent_id.localeCompare(right.agent_id);
  }
  return idle(left, right) || left.agent_id.localeCompare(right.agent_id);
}

function idle(left: ContactCenterRoutingCandidate, right: ContactCenterRoutingCandidate): number {
  return timestamp(left.idle_since) - timestamp(right.idle_since);
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function requiredSkillScore(
  candidate: ContactCenterRoutingCandidate,
  requirements: Array<[string, number]>
): number {
  if (!requirements.length) return 0;
  return requirements.reduce((total, [skill]) => total + (candidate.skills[skill] || 0), 0);
}

function roundRobin(
  candidates: readonly ContactCenterRoutingCandidate[],
  after: string | undefined
): ContactCenterRoutingCandidate[] {
  const sorted = [...candidates].sort((left, right) => left.agent_id.localeCompare(right.agent_id));
  if (!after || !sorted.length) return sorted;
  const index = sorted.findIndex((candidate) => candidate.agent_id === after);
  if (index < 0) return sorted;
  const start = (index + 1) % sorted.length;
  return [...sorted.slice(start), ...sorted.slice(0, start)];
}
