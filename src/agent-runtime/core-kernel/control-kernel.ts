import type { ControlDecision, ControlDecisionInput, DependencyStatus, TerminalDecision } from './types.js';

const COMPLETED_STATUSES = new Set(['completed', 'ready', 'satisfied']);
const STOPPED_PHASES = new Set(['stopped', 'paused', 'pause_requested']);

export function decideNextStep(input: ControlDecisionInput): ControlDecision {
  const missing = (input.dependencies ?? [])
    .filter((dependency) => !COMPLETED_STATUSES.has(String(dependency.status).toLowerCase()))
    .map((dependency) => dependency.id);

  const dependencyStatus: DependencyStatus = missing.length > 0 ? 'blocked' : 'ready';
  const phase = String(input.phase ?? 'unknown');
  const terminalDecision = pickTerminalDecision(phase, dependencyStatus);

  if (terminalDecision === 'blocked') {
    return {
      phase,
      dependency_status: dependencyStatus,
      terminal_decision: terminalDecision,
      next_action: 'wait_for_dependencies',
      stop_reason: `Missing dependencies: ${missing.join(', ')}`
    };
  }

  if (terminalDecision === 'stopped') {
    return {
      phase,
      dependency_status: dependencyStatus,
      terminal_decision: terminalDecision,
      next_action: input.plannedAction,
      stop_reason: 'Run is stopped/pause state and requires manual resume.'
    };
  }

  return {
    phase,
    dependency_status: dependencyStatus,
    terminal_decision: terminalDecision,
    next_action: input.plannedAction
  };
}

function pickTerminalDecision(phase: string, dependencyStatus: DependencyStatus): TerminalDecision {
  if (dependencyStatus === 'blocked') {
    return 'blocked';
  }

  const normalizedPhase = phase.toLowerCase();
  if (normalizedPhase === 'completed') {
    return 'completed';
  }

  if (STOPPED_PHASES.has(normalizedPhase)) {
    return 'stopped';
  }

  return 'continue';
}
