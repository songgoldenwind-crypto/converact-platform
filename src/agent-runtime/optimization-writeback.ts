/**
 * Result Writeback Integration - Simplified
 * 
 * Hooks into task completion to feed results to optimization modules.
 * Graceful failure - if optimization fails, main task completion still succeeds.
 */

import { run, one } from '../db.js';
import { autoCompleteIfSignificant } from './statistical-testing.js';
import { recordPromptEfficacy } from './prompt-version-mgmt.js';

export interface TaskCompletionOutcome {
  status: 'contacted' | 'reached' | 'interested' | 'declined' | 'callback' | 'no_answer' | 'wrong_number' | string;
  notes?: string;
  next_follow_up_date?: string;
}

function parseScriptMetadata(task: any): Record<string, any> | null {
  if (!task?.script_metadata) return null;
  try {
    return typeof task.script_metadata === 'string'
      ? JSON.parse(task.script_metadata)
      : task.script_metadata;
  } catch {
    return null;
  }
}

function isPositiveOutcome(status: string): boolean {
  return [
    'interested',
    'callback',
    'callback_requested',
    'appointment_booked',
    'reached',
  ].includes(status);
}

function mapOutcomeToABResult(status: string): 'connected' | 'converted' | 'no_answer' | 'rejected' | 'not_converted' {
  if (['interested', 'callback', 'callback_requested', 'appointment_booked'].includes(status)) {
    return 'converted';
  }
  if (['no_answer'].includes(status)) {
    return 'no_answer';
  }
  if (['wrong_number', 'declined', 'rejected'].includes(status)) {
    return 'rejected';
  }
  if (['reached', 'contacted'].includes(status)) {
    return 'connected';
  }
  return 'not_converted';
}

function ensurePromptUsageTracked(db: any, runId: string, versionHash: string): void {
  const promptVersion = one(
    db,
    'SELECT version_hash FROM prompt_versions WHERE version_hash = ? OR prompt_hash = ? LIMIT 1',
    [versionHash, versionHash]
  ) as any;

  if (!promptVersion) return;

  run(
    db,
    `INSERT OR IGNORE INTO prompt_usage_log (run_id, version_hash, used_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)`,
    [runId, promptVersion.version_hash]
  );
}

function updateVariantStatsForTest(db: any, abTestId: string): void {
  const test = one(
    db,
    `SELECT variant_a_id, variant_b_id
     FROM ab_tests
     WHERE id = ?`,
    [abTestId]
  ) as any;

  if (!test) return;

  const variantMappings = [
    { variantId: test.variant_a_id, slot: 'variant_a' },
    { variantId: test.variant_b_id, slot: 'variant_b' },
  ];

  for (const mapping of variantMappings) {
    const stats = one(
      db,
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN outcome = 'converted' THEN 1 ELSE 0 END) AS conversions
       FROM ab_test_outcomes
       WHERE COALESCE(ab_test_id, test_id) = ?
         AND assigned_variant IN (?, ?)`,
      [abTestId, mapping.slot, mapping.variantId]
    ) as any;

    const total = stats?.total || 0;
    const conversions = stats?.conversions || 0;
    const rate = total > 0 ? conversions / total : 0;

    run(
      db,
      `UPDATE script_variants
       SET avg_conversion_rate = ?, efficacy_conversion_rate = ?, sample_count = ?
       WHERE id = ?`,
      [rate, rate, total, mapping.variantId]
    );
  }
}

/**
 * Process optimization writeback after a task completes
 */
export async function processOptimizationWriteback(
  db: any,
  tenantId: string,
  taskId: string,
  task: any,
  outcome: TaskCompletionOutcome
): Promise<void> {
  try {
    // Check if this task was part of a script generation with optimization tracking
    const scriptMetadata = parseScriptMetadata(task);

    if (!scriptMetadata) {
      // No optimization metadata, skip writeback
      return;
    }

    // Record optimization-relevant facts to stats for later analysis
    const outcomeStatus = String(outcome.status);
    const positive = isPositiveOutcome(outcomeStatus);
    
    // Store in stats table for later processing by scheduler
    const statId = `opt_writeback_${taskId}_${outcomeStatus}`;
    run(db, 
      `INSERT OR REPLACE INTO optimization_stats (id, tenant_id, stat_type, metric_name, metric_value, note, context_json) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        statId,
        tenantId,
        'ab_test',
        `task_outcome_${outcomeStatus}`,
        positive ? 1 : 0,
        outcome.notes || null,
        JSON.stringify({
          task_id: taskId,
          ab_test_id: scriptMetadata.ab_test_id || null,
          assigned_variant: scriptMetadata.assigned_variant || null,
          prompt_version_hash: scriptMetadata.prompt_version_hash || scriptMetadata.version_hash || scriptMetadata.prompt_hash || null,
        }),
      ]
    );

    const runId = scriptMetadata.run_id || scriptMetadata.lead_run_id || scriptMetadata.workflow_run_id || task.lead_run_id || task.run_id;
    const versionHash = scriptMetadata.prompt_version_hash || scriptMetadata.version_hash || scriptMetadata.prompt_hash;

    if (runId && versionHash) {
      ensurePromptUsageTracked(db, runId, versionHash);
      recordPromptEfficacy(db, runId, positive);
    }

    if (scriptMetadata.ab_test_id && scriptMetadata.assigned_variant) {
      run(
        db,
        `INSERT OR IGNORE INTO ab_test_outcomes (
          id, ab_test_id, test_id, run_id, assigned_variant, outcome, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
          `opt_ab_${taskId}`,
          scriptMetadata.ab_test_id,
          scriptMetadata.ab_test_id,
          runId || taskId,
          scriptMetadata.assigned_variant,
          mapOutcomeToABResult(outcomeStatus),
        ]
      );

      updateVariantStatsForTest(db, scriptMetadata.ab_test_id);
      await autoCompleteIfSignificant(db, scriptMetadata.ab_test_id);
    }

    console.log(`[OptimizationWriteback] Recorded task outcome for task ${taskId}: ${outcome.status}`);
  } catch (error) {
    // Silent fail - optimization is non-critical
    console.warn(`[OptimizationWriteback] Error for task ${taskId}:`, error);
  }
}

/**
 * Utility: Extract script metadata from task
 */
export function extractScriptMetadata(task: any): any {
  return parseScriptMetadata(task);
}

/**
 * Utility: Store script metadata on task for later retrieval
 */
export function attachScriptMetadataToTask(
  db: any,
  taskId: string,
  metadata: Record<string, any>
): void {
  try {
    run(db, 'UPDATE tasks SET script_metadata = ? WHERE id = ?', [
      JSON.stringify(metadata),
      taskId
    ]);
  } catch (error) {
    console.warn(`[OptimizationWriteback] Error attaching metadata to task ${taskId}:`, error);
  }
}
