/**
 * AI Optimization Scheduler - Simplified
 * 
 * Manages periodic tasks:
 * - Weekly refinement analysis
 * - Weekly learning/prompt evolution
 * - Daily cache maintenance  
 * - Hourly stats updates
 */

import cron from 'node-cron';
import { all, run } from '../db.js';
import { runWeeklyLearningForAllTenants, type WeeklyLearningResult } from './weekly-learning-loop.js';

export interface SchedulerConfig {
  enabled?: boolean;
  timezone?: string;
  basePrompt?: string;
}

export class OptimizationScheduler {
  private scheduledTasks: Map<string, any> = new Map();
  private config: SchedulerConfig;
  private db: any;

  constructor(db: any, config: SchedulerConfig = {}) {
    this.db = db;
    this.config = {
      enabled: config.enabled !== false,
      timezone: config.timezone || 'UTC',
      basePrompt: config.basePrompt || 'You are a sales script generator for lead acquisition follow-up.'
    };
  }

  private recordSchedulerMetric(tenantId: string, metricName: string, metricValue: number, note?: string): void {
    run(
      this.db,
      `INSERT INTO optimization_stats (id, tenant_id, stat_type, metric_name, metric_value, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        `opt_sched_${metricName}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        tenantId,
        'learning',
        metricName,
        metricValue,
        note || null,
      ]
    );
  }

  private getActiveTenantIds(): string[] {
    return all(this.db, `SELECT id FROM tenants WHERE status = 'active' ORDER BY created_at ASC`)
      .map((row: any) => row.id);
  }

  async runWeeklyRefinementNow(): Promise<number> {
    const tenantIds = this.getActiveTenantIds();
    for (const tenantId of tenantIds) {
      this.recordSchedulerMetric(
        tenantId,
        'weekly_refinement_executed',
        1,
        'Weekly refinement scheduler executed'
      );
    }
    return tenantIds.length;
  }

  async runWeeklyLearningNow(): Promise<WeeklyLearningResult[]> {
    return runWeeklyLearningForAllTenants(this.db, this.config.basePrompt || 'You are a sales script generator.');
  }

  async runDailyMaintenanceNow(): Promise<void> {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    run(this.db, `DELETE FROM optimization_stats WHERE recorded_at < ?`, [ninetyDaysAgo]);
  }

  async runHourlyStatsNow(): Promise<number> {
    const tenantIds = this.getActiveTenantIds();
    for (const tenantId of tenantIds) {
      this.recordSchedulerMetric(tenantId, 'scheduler_heartbeat', 1, 'Scheduler heartbeat');
      // Lead-acquisition mainline heartbeat removed: module archived.
    }
    return tenantIds.length;
  }

  /**
   * Start all scheduled tasks
   */
  start(): void {
    if (!this.config.enabled) {
      console.log('[OptimizationScheduler] Scheduler disabled');
      return;
    }

    console.log('[OptimizationScheduler] Starting optimization scheduler');

    this.scheduleWeeklyRefinement();
    this.scheduleWeeklyLearning();
    this.scheduleDailyMaintenance();
    this.scheduleHourlyStatsUpdate();

    console.log('[OptimizationScheduler] All scheduled tasks registered');
  }

  /**
   * Weekly: Monday 08:00 UTC
   */
  private scheduleWeeklyRefinement(): void {
    const task = cron.schedule('0 8 * * 1', async () => {
      try {
        console.log('[OptimizationScheduler] Weekly refinement analysis...');
        await this.runWeeklyRefinementNow();
      } catch (error) {
        console.warn('[OptimizationScheduler] Weekly refinement error:', error);
      }
    }, {
      timezone: this.config.timezone
    });

    this.scheduledTasks.set('weekly-refinement', task);
  }

  /**
   * Weekly: Monday 09:00 UTC
   */
  private scheduleWeeklyLearning(): void {
    const task = cron.schedule('0 9 * * 1', async () => {
      try {
        console.log('[OptimizationScheduler] Weekly learning/prompt evolution...');
        await this.runWeeklyLearningNow();
      } catch (error) {
        console.warn('[OptimizationScheduler] Weekly learning error:', error);
      }
    }, {
      timezone: this.config.timezone
    });

    this.scheduledTasks.set('weekly-learning', task);
  }

  /**
   * Daily: 03:00 UTC
   */
  private scheduleDailyMaintenance(): void {
    const task = cron.schedule('0 3 * * *', async () => {
      try {
        console.log('[OptimizationScheduler] Daily maintenance...');
        await this.runDailyMaintenanceNow();
        console.log('[OptimizationScheduler] Cleaned old stats');
      } catch (error) {
        console.warn('[OptimizationScheduler] Daily maintenance error:', error);
      }
    });

    this.scheduledTasks.set('daily-maintenance', task);
  }

  /**
   * Hourly: Update stats
   */
  private scheduleHourlyStatsUpdate(): void {
    const task = cron.schedule('0 * * * *', async () => {
      try {
        await this.runHourlyStatsNow();
      } catch (error) {
        console.warn('[OptimizationScheduler] Hourly update error:', error);
      }
    });

    this.scheduledTasks.set('hourly-stats', task);
  }

  /**
   * Stop all scheduled tasks
   */
  stop(): void {
    console.log('[OptimizationScheduler] Stopping scheduler');
    for (const [name, task] of this.scheduledTasks) {
      task.stop();
      console.log(`[OptimizationScheduler] Stopped ${name}`);
    }
    this.scheduledTasks.clear();
  }

  /**
   * Get scheduler status
   */
  getStatus(): {
    enabled: boolean;
    tasksRegistered: number;
    tasks: string[];
  } {
    return {
      enabled: this.config.enabled,
      tasksRegistered: this.scheduledTasks.size,
      tasks: Array.from(this.scheduledTasks.keys())
    };
  }
}

// Singleton instance
let schedulerInstance: OptimizationScheduler | null = null;

/**
 * Initialize global scheduler
 */
export function initializeOptimizationScheduler(db: any, config?: SchedulerConfig): OptimizationScheduler {
  if (schedulerInstance) {
    console.warn('[OptimizationScheduler] Scheduler already initialized');
    return schedulerInstance;
  }

  schedulerInstance = new OptimizationScheduler(db, config);
  schedulerInstance.start();

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('[OptimizationScheduler] SIGTERM received, stopping scheduler');
    schedulerInstance?.stop();
  });

  return schedulerInstance;
}

/**
 * Get global scheduler instance
 */
export function getOptimizationScheduler(): OptimizationScheduler | null {
  return schedulerInstance;
}
