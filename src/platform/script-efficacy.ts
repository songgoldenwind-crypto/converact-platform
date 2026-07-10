/**
 * Phase K Batch 102: script variant usage and efficacy analytics.
 */
import { all, id, json, one, run } from '../db.js';
import { badRequest, notFound } from './scoring.js';

export function recordScriptVariantUsage(db: unknown, input: Record<string, unknown>) {
  const tenant_id = String(input.tenant_id || '');
  const run_id = String(input.run_id || '');
  const lead_id = String(input.lead_id || '');
  const variant_key = String(input.variant_key || '');
  const script_key_sections = input.script_key_sections;
  if (!tenant_id || !run_id || !variant_key) {
    throw badRequest('tenant_id, run_id, and variant_key are required');
  }

  const item = one(
    db,
    `SELECT id FROM lead_acquisition_run_items
     WHERE tenant_id = ? AND run_id = ? AND object_type = 'lead' AND object_id = ?
     LIMIT 1`,
    [tenant_id, run_id, lead_id]
  );

  if (!item) {
    throw notFound(`lead ${lead_id} not found in run ${run_id}`);
  }

  const itemRecord = one(
    db,
    `SELECT metadata FROM lead_acquisition_run_items WHERE id = ?`,
    [item.id]
  );

  const metadata = itemRecord?.metadata && typeof itemRecord.metadata === 'object'
    ? itemRecord.metadata as Record<string, unknown>
    : {};
  run(
    db,
    `UPDATE lead_acquisition_run_items SET metadata = ? WHERE id = ?`,
    [
      json({
        ...metadata,
        script_variant_key: variant_key,
        script_used_at: new Date().toISOString(),
        script_sections: script_key_sections || []
      }),
      item.id
    ]
  );

  return { recorded: true, item_id: item.id };
}

export function computeScriptVariantEfficacy(db: unknown, input: Record<string, unknown>) {
  const tenant_id = String(input.tenant_id || '');
  const run_id = String(input.run_id || '');
  const variant_key = String(input.variant_key || '');
  if (!tenant_id || !run_id) {
    throw badRequest('tenant_id and run_id are required');
  }

  const today = new Date().toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const stats = all(
    db,
    `SELECT
       COUNT(CASE WHEN vcs.lead_id IS NOT NULL THEN 1 END) as total_uses,
       COUNT(CASE WHEN vcs.lead_id IS NOT NULL AND vm.next_step_type IN ('appointment_confirm', 'quote_followup', 'appointment', 'quote') THEN 1 END) as converted_count
     FROM lead_acquisition_run_items lari
     LEFT JOIN voice_call_sessions vcs ON vcs.lead_id = lari.object_id AND vcs.tenant_id = lari.tenant_id
     LEFT JOIN (SELECT id, metadata FROM voice_call_sessions) v ON v.id = vcs.id
     LEFT JOIN json_extract(v.metadata, '$.next_step_type') as vm ON vm.next_step_type IS NOT NULL
     WHERE lari.tenant_id = ? AND lari.run_id = ? AND lari.object_type = 'lead'
       AND json_extract(lari.metadata, '$.script_variant_key') = ?
       AND json_extract(lari.metadata, '$.script_used_at') >= ?
       AND vcs.ended_at >= ?`,
    [tenant_id, run_id, variant_key, sevenDaysAgo, sevenDaysAgo]
  );

  const totalUses = stats[0]?.total_uses || 0;
  const convertedCount = stats[0]?.converted_count || 0;
  const conversionRate = totalUses > 0 ? convertedCount / totalUses : 0;

  const existing = one(
    db,
    `SELECT id FROM script_variant_efficacy
     WHERE tenant_id = ? AND run_id = ? AND variant_key = ? AND period_start = ?`,
    [tenant_id, run_id, variant_key, today]
  );

  if (existing) {
    run(
      db,
      `UPDATE script_variant_efficacy SET total_uses = ?, converted_count = ?, conversion_rate = ?, last_updated = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [totalUses, convertedCount, conversionRate, existing.id]
    );
  } else {
    run(
      db,
      `INSERT INTO script_variant_efficacy (id, tenant_id, run_id, variant_key, period_start, total_uses, converted_count, conversion_rate, sample_size_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id('efficacy'),
        tenant_id,
        run_id,
        variant_key,
        today,
        totalUses,
        convertedCount,
        conversionRate,
        `样本量: ${totalUses}次，转化${convertedCount}次`
      ]
    );
  }

  return {
    variant_key,
    total_uses: totalUses,
    converted_count: convertedCount,
    conversion_rate: conversionRate,
    conversion_rate_pct: Math.round(conversionRate * 100),
    min_sample_reached: totalUses >= 3
  };
}

export function getScriptVariantEfficacy(db: unknown, input: Record<string, unknown>) {
  const tenant_id = String(input.tenant_id || '');
  const run_id = String(input.run_id || '');
  if (!tenant_id || !run_id) {
    throw badRequest('tenant_id and run_id are required');
  }

  const today = new Date().toISOString().slice(0, 10);

  const efficacyRecords = all(
    db,
    `SELECT variant_key, total_uses, converted_count, conversion_rate, sample_size_note
     FROM script_variant_efficacy
     WHERE tenant_id = ? AND run_id = ? AND period_start = ?
     ORDER BY conversion_rate DESC, converted_count DESC`,
    [tenant_id, run_id, today]
  ).map((row) => ({
    ...row,
    conversion_rate_pct: Math.round((row.conversion_rate || 0) * 100)
  }));

  return {
    date: today,
    variants: efficacyRecords,
    best_variant: efficacyRecords[0] || null,
    total_variants: efficacyRecords.length
  };
}

export function selectBestScriptVariant(db: unknown, input: Record<string, unknown>) {
  const tenant_id = String(input.tenant_id || '');
  const run_id = String(input.run_id || '');
  if (!tenant_id || !run_id) {
    throw badRequest('tenant_id and run_id are required');
  }

  const efficacy = getScriptVariantEfficacy(db, { tenant_id, run_id });

  if (efficacy.best_variant && efficacy.best_variant.total_uses >= 3) {
    const sortedVariants = [...efficacy.variants].sort((a, b) => {
      const rateA = a.conversion_rate || 0;
      const rateB = b.conversion_rate || 0;
      if (rateA !== rateB) return rateB - rateA;
      return (b.converted_count || 0) - (a.converted_count || 0);
    });

    const randomNum = Math.random();
    if (randomNum < 0.8 && sortedVariants[0]) {
      return {
        selected_variant: sortedVariants[0].variant_key,
        selection_reason: `优化版本，${sortedVariants[0].conversion_rate_pct || 0}% 转化率 (${sortedVariants[0].total_uses} 次试用)`,
        strategy: 'exploit_best'
      };
    }
    if (sortedVariants.length > 1) {
      return {
        selected_variant: sortedVariants[1].variant_key,
        selection_reason: `探索版本，${sortedVariants[1].conversion_rate_pct || 0}% 转化率 (${sortedVariants[1].total_uses} 次试用)`,
        strategy: 'explore_alternative'
      };
    }
  }

  return {
    selected_variant: null,
    selection_reason: '无历史数据，使用行业模板默认话术',
    strategy: 'template_default'
  };
}
