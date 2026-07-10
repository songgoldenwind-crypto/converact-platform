/**
 * Platform task lifecycle commands.
 * Implementations live in task-commands.ts.
 */
export {
  defaultNextStepType,
  defaultDueHoursForStep,
  normalizeTaskDueAt,
  normalizeRescheduleDueAt,
  normalizeTaskOutcomeInput,
  resolveLeadForTask,
  updateLeadAfterTaskCompletion,
  updateOpportunityAfterTaskCompletion,
  buildFollowupTaskTitle,
  followupPriority,
  opportunityStatusFromCompletion,
  nextActionFromCompletion,
  humanNextStepLabel,
  formatTaskDueText,
  createTask,
  completeTask,
  rescheduleTask,
  wireTaskCompletionHooks
} from './task-commands.js';
export type { TaskCompletionHooks } from './task-commands.js';
