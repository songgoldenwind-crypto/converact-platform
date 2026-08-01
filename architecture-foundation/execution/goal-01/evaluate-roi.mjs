const monetaryFields = [
  'eligible_annual_items',
  'verified_value_per_avoided_event_usd',
  'first_year_subscription_usd',
  'first_year_services_usd',
  'first_year_usage_cost_usd',
  'first_year_customer_change_cost_usd',
  'annual_recognized_revenue_usd',
  'credits_usd',
  'reversals_usd',
  'refunds_usd',
  'cac_usd',
];

const costFields = [
  'carrier_line_sfu_usd',
  'gpu_model_usd',
  'storage_egress_usd',
  'support_sre_usd',
  'implementation_amortized_usd',
  'partner_fees_usd',
];

function finiteNonNegative(value, field) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a finite non-negative number`);
  }
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : value;
}

function dedupeAdditionalValuePools(pools, primaryValueDedupeKey) {
  if (!Array.isArray(pools)) throw new TypeError('additional_value_pools must be an array');
  const values = new Map();
  let primaryOverlapExcludedCount = 0;
  for (const pool of pools) {
    if (pool === null || typeof pool !== 'object') throw new TypeError('each value pool must be an object');
    if (typeof pool.pool_id !== 'string' || pool.pool_id.length === 0) throw new TypeError('value pool pool_id is required');
    if (typeof pool.dedupe_key !== 'string' || pool.dedupe_key.length === 0) throw new TypeError('value pool dedupe_key is required');
    finiteNonNegative(pool.annual_value_usd, `value pool ${pool.pool_id} annual_value_usd`);
    if (pool.dedupe_key === primaryValueDedupeKey) {
      primaryOverlapExcludedCount += 1;
      continue;
    }
    const prior = values.get(pool.dedupe_key);
    if (!prior || pool.annual_value_usd < prior.annual_value_usd) values.set(pool.dedupe_key, pool);
  }
  return {
    annualValueUsd: [...values.values()].reduce((sum, pool) => sum + pool.annual_value_usd, 0),
    inputCount: pools.length,
    dedupedCount: values.size,
    primaryOverlapExcludedCount,
  };
}

export function evaluatePilotEconomics(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('input must be an object');
  }
  for (const field of monetaryFields) finiteNonNegative(input[field], field);
  if (typeof input.primary_value_dedupe_key !== 'string' || input.primary_value_dedupe_key.length === 0) {
    throw new TypeError('primary_value_dedupe_key is required');
  }
  if (!Number.isFinite(input.baseline_avoidable_event_rate)
      || input.baseline_avoidable_event_rate < 0
      || input.baseline_avoidable_event_rate > 1) {
    throw new TypeError('baseline_avoidable_event_rate must be between zero and one');
  }
  if (input.costs === null || typeof input.costs !== 'object' || Array.isArray(input.costs)) {
    throw new TypeError('costs must be an object');
  }
  for (const field of costFields) finiteNonNegative(input.costs[field], `costs.${field}`);

  const firstYearCost = input.first_year_subscription_usd
    + input.first_year_services_usd
    + input.first_year_usage_cost_usd
    + input.first_year_customer_change_cost_usd;
  if (firstYearCost <= 0) throw new RangeError('first-year cost must be greater than zero');

  const primaryAvoidedEventValue = input.eligible_annual_items
    * input.baseline_avoidable_event_rate
    * input.verified_value_per_avoided_event_usd;
  const deduped = dedupeAdditionalValuePools(input.additional_value_pools, input.primary_value_dedupe_key);
  const annualAddressableValue = primaryAvoidedEventValue + deduped.annualValueUsd;

  const netRecognizedRevenue = input.annual_recognized_revenue_usd
    - input.credits_usd
    - input.reversals_usd
    - input.refunds_usd;
  const steadyStateCost = costFields.reduce((sum, field) => sum + input.costs[field], 0);
  const grossProfit = netRecognizedRevenue - steadyStateCost;
  const grossMarginRatio = netRecognizedRevenue > 0 ? grossProfit / netRecognizedRevenue : -Infinity;
  const monthlyGrossProfit = grossProfit / 12;
  const cacPaybackMonths = monthlyGrossProfit > 0 ? input.cac_usd / monthlyGrossProfit : Infinity;
  const valueToCostRatio = annualAddressableValue / firstYearCost;

  const failedGates = [];
  if (input.eligible_annual_items <= 0) failedGates.push('eligible_annual_items_gt_zero');
  if (valueToCostRatio < 3) failedGates.push('annual_value_at_least_3x_first_year_cost');
  if (grossMarginRatio < 0.7) failedGates.push('steady_state_gross_margin_at_least_70_percent');
  if (!(cacPaybackMonths < 12)) failedGates.push('cac_payback_under_12_months');

  return {
    formula_version: 'resolve-roi-v1',
    market_evidence: false,
    primary_avoided_event_value_usd: round(primaryAvoidedEventValue),
    deduped_additional_value_usd: round(deduped.annualValueUsd),
    additional_value_pool_input_count: deduped.inputCount,
    additional_value_pool_deduped_count: deduped.dedupedCount,
    primary_overlap_excluded_count: deduped.primaryOverlapExcludedCount,
    annual_addressable_value_usd: round(annualAddressableValue),
    first_year_cost_usd: round(firstYearCost),
    value_to_first_year_cost_ratio: round(valueToCostRatio),
    net_recognized_revenue_usd: round(netRecognizedRevenue),
    steady_state_cost_usd: round(steadyStateCost),
    steady_state_gross_profit_usd: round(grossProfit),
    steady_state_gross_margin_ratio: round(grossMarginRatio),
    cac_payback_months: round(cacPaybackMonths),
    failed_gates: failedGates,
    decision: failedGates.length === 0 ? 'qualified_candidate' : 'no_bid',
  };
}
