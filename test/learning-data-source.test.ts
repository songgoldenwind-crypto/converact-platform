import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDatabase, run } from '../src/db.js';
import {
  extractLearningInsights,
  extractLearningInsightsWithQualityGate
} from '../src/agent-runtime/auto-prompt-learning.js';
import {
  analyzeRouteConversionTrends,
  extractPatternsFromTopScripts
} from '../src/agent-runtime/iterative-refinement.js';

test('auto prompt learning extracts insights from schema-backed fine-tuning examples', () => {
  const db = createDatabase(':memory:');
  insertFineTuningExample(db, {
    id: 'ftex_1',
    script_variant_id: 'variant_a',
    script_content: '您好，我看到您最近在招销售。\n我们帮老板把线索跟进省时 30%。\n如果方便，今天下午确认下一步？',
    lead_profile: { industry: '装修服务', location: '杭州' },
    conversion_rate: 0.82,
    quality_signal: 'excellent',
    call_outcomes: { total_calls: 12, conversions: 10 },
    route_type: 'outbound_call',
    created_at: '2026-05-30T10:00:00.000Z'
  });
  insertFineTuningExample(db, {
    id: 'ftex_2',
    script_variant_id: 'variant_b',
    script_content: '您好，我看到您最近在招销售。\n已有客户用这个方式降低获客成本。\n如果方便，今天下午确认下一步？',
    lead_profile: { industry: '装修服务', location: '杭州' },
    conversion_rate: 0.74,
    quality_signal: 'good',
    call_outcomes: { total_calls: 10, conversions: 7 },
    route_type: 'outbound_call',
    created_at: '2026-05-31T10:00:00.000Z'
  });
  insertFineTuningExample(db, {
    id: 'ftex_3',
    script_variant_id: 'variant_c',
    script_content: '泛泛介绍产品功能，没有明确下一步。',
    lead_profile: { industry: '装修服务', location: '杭州' },
    conversion_rate: 0.1,
    quality_signal: 'poor',
    call_outcomes: { total_calls: 8, conversions: 1 },
    route_type: 'outbound_call',
    created_at: '2026-05-31T12:00:00.000Z'
  });

  const insights = extractLearningInsights(db, 'outbound_call', '装修服务', 100);

  assert.ok(insights.length > 0);
  assert.ok(insights.some((insight) => insight.insight_type === 'opening_pattern'));
  assert.ok(insights.some((insight) => insight.pattern_snippet.includes('您好，我看到')));
  assert.ok(insights.every((insight) => insight.route_type === 'outbound_call'));
  assert.ok(insights.every((insight) => insight.industry === '装修服务'));
});

test('iterative refinement reads route trends and top script patterns from fine-tuning examples', () => {
  const db = createDatabase(':memory:');
  insertFineTuningExample(db, {
    id: 'ftex_trend_1',
    script_variant_id: 'variant_old',
    script_content: '您好，先确认您现在最缺哪类客户。\n已有案例证明可以节省跟进时间。',
    lead_profile: { industry: '财税服务', location: '上海' },
    conversion_rate: 0.52,
    quality_signal: 'good',
    call_outcomes: { total_calls: 10, conversions: 5 },
    route_type: 'outbound_call',
    created_at: daysAgo(6)
  });
  insertFineTuningExample(db, {
    id: 'ftex_trend_2',
    script_variant_id: 'variant_new',
    script_content: '您好，先确认您现在最缺哪类客户。\n已有案例证明可以节省跟进时间并提高结果。',
    lead_profile: { industry: '财税服务', location: '上海' },
    conversion_rate: 0.86,
    quality_signal: 'excellent',
    call_outcomes: { total_calls: 12, conversions: 10 },
    route_type: 'outbound_call',
    created_at: daysAgo(1)
  });

  const trends = analyzeRouteConversionTrends(db, 30);
  const patterns = extractPatternsFromTopScripts(db, 10);

  assert.equal(trends.length, 1);
  assert.equal(trends[0].route_type, 'outbound_call');
  assert.equal(trends[0].trend, 'improving');
  assert.equal(trends[0].total_scripts, 2);
  assert.equal(trends[0].total_calls, 22);
  assert.equal(trends[0].conversions, 15);
  assert.ok(patterns.common_openings.some((opening) => opening.includes('您好，先确认')));
  assert.ok(patterns.high_engagement_phrases.includes('证明'));
});

test('auto prompt learning reports explicit quality gate status when examples are insufficient', () => {
  const db = createDatabase(':memory:');
  insertFineTuningExample(db, {
    id: 'ftex_gate_1',
    script_variant_id: 'variant_single',
    script_content: '您好，我们可以帮您节省跟进时间。',
    lead_profile: { industry: '装修服务', location: '杭州' },
    conversion_rate: 0.91,
    quality_signal: 'excellent',
    call_outcomes: { total_calls: 3, conversions: 3 },
    route_type: 'outbound_call',
    created_at: daysAgo(1)
  });

  const result = extractLearningInsightsWithQualityGate(db, 'outbound_call', '装修服务', {
    topPercentile: 100,
    minUsableExamples: 2,
    minTotalCalls: 8
  });

  assert.deepEqual(result.insights, []);
  assert.equal(result.quality_gate.status, 'insufficient_data');
  assert.equal(result.quality_gate.usable_example_count, 1);
  assert.equal(result.quality_gate.total_calls, 3);
  assert.match(result.quality_gate.no_insight_reason, /usable examples|total calls/i);
});

test('auto prompt learning extracts adaptive English phrases without Chinese keyword lists', () => {
  const db = createDatabase(':memory:');
  for (let i = 0; i < 6; i += 1) {
    insertFineTuningExample(db, {
      id: `ftex_adaptive_top_${i}`,
      script_variant_id: `variant_adaptive_top_${i}`,
      script_content: `Hello founder ${i}.\nSame day revenue follow up turns replies into booked calls.\nCan we confirm the next step today?`,
      lead_profile: { industry: 'AI SaaS', location: '上海' },
      conversion_rate: 0.91 - i * 0.01,
      quality_signal: 'excellent',
      call_outcomes: { total_calls: 12, conversions: 10 },
      route_type: 'outbound_call',
      created_at: daysAgo(i + 1)
    });
  }
  for (let i = 0; i < 6; i += 1) {
    insertFineTuningExample(db, {
      id: `ftex_adaptive_bottom_${i}`,
      script_variant_id: `variant_adaptive_bottom_${i}`,
      script_content: `Hello founder ${i}.\nThis is a broad platform overview with many modules.\nLet us know if you want more information.`,
      lead_profile: { industry: 'AI SaaS', location: '上海' },
      conversion_rate: 0.21 + i * 0.01,
      quality_signal: 'good',
      call_outcomes: { total_calls: 12, conversions: 2 },
      route_type: 'outbound_call',
      created_at: daysAgo(i + 10)
    });
  }

  const result = extractLearningInsightsWithQualityGate(db, 'outbound_call', 'AI SaaS', {
    topPercentile: 50,
    bottomPercentile: 50,
    minUsableExamples: 10,
    minTotalCalls: 100
  });

  assert.equal(result.quality_gate.status, 'ready');
  assert.ok(result.insights.some((insight) => /same day revenue/.test(insight.pattern_snippet)));
  assert.equal(result.insights.some((insight) => /hello founder/.test(insight.pattern_snippet)), false);
  assert.ok(result.insights.every((insight) => insight.confidence_score > 0));
});

test('iterative refinement uses adaptive high engagement phrases when top and bottom scripts differ', () => {
  const db = createDatabase(':memory:');
  for (let i = 0; i < 6; i += 1) {
    insertFineTuningExample(db, {
      id: `ftex_iter_top_${i}`,
      script_variant_id: `variant_iter_top_${i}`,
      script_content: `Hi owner ${i}.\nSame day revenue follow up gives you proof before the next call.\nCan we book the next step?`,
      lead_profile: { industry: 'AI SaaS', location: '上海' },
      conversion_rate: 0.88 - i * 0.01,
      quality_signal: 'excellent',
      call_outcomes: { total_calls: 9, conversions: 7 },
      route_type: 'outbound_call',
      created_at: daysAgo(i + 1)
    });
  }
  for (let i = 0; i < 6; i += 1) {
    insertFineTuningExample(db, {
      id: `ftex_iter_bottom_${i}`,
      script_variant_id: `variant_iter_bottom_${i}`,
      script_content: `Hi owner ${i}.\nHere is a general product introduction and feature list.\nPlease reply if interested.`,
      lead_profile: { industry: 'AI SaaS', location: '上海' },
      conversion_rate: 0.28 + i * 0.01,
      quality_signal: 'fair',
      call_outcomes: { total_calls: 9, conversions: 2 },
      route_type: 'outbound_call',
      created_at: daysAgo(i + 10)
    });
  }

  const patterns = extractPatternsFromTopScripts(db, 20);

  assert.ok(patterns.common_openings.some((opening: string) => /Hi owner/.test(opening)));
  assert.ok(patterns.high_engagement_phrases.some((phrase: string) => /same day revenue/.test(phrase)));
  assert.equal(patterns.high_engagement_phrases.some((phrase: string) => /hi owner/.test(phrase)), false);
});

function daysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}

function insertFineTuningExample(
  db: unknown,
  input: {
    id: string;
    script_variant_id: string;
    script_content: string;
    lead_profile: Record<string, unknown>;
    conversion_rate: number;
    quality_signal: 'excellent' | 'good' | 'fair' | 'poor';
    call_outcomes: Record<string, unknown>;
    route_type: string;
    created_at: string;
  }
): void {
  run(
    db,
    `INSERT INTO finetuning_examples
      (id, script_variant_id, script_content, lead_profile, conversion_rate, quality_signal, call_outcomes, route_type, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.script_variant_id,
      input.script_content,
      JSON.stringify(input.lead_profile),
      input.conversion_rate,
      input.quality_signal,
      JSON.stringify(input.call_outcomes),
      input.route_type,
      input.created_at
    ]
  );
}
