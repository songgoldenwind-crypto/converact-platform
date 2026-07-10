import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildContextEnvelope,
  decideNextStep,
  recoverFromFailure,
  verifyAndTune
} from '../src/agent-runtime/core-kernel/index.js';

const RETAINED_CONTEXT_FIELDS = ['decision_basis', 'progress', 'constraints', 'conclusions'] as const;
const MAX_COMPRESSED_CHARS = 480;
const REASONING_FAILURE_STRATEGIES = ['fallback', 'halt'] as const;

const createContextEnvelopeInput = (runId: string) => ({
  tenantId: 'tenant_1',
  runId,
  phase: 'lead_discovery',
  slices: {
    decision_basis: ['Owner wants high-intent SMB leads'],
    progress: ['source capture queued'],
    constraints: ['exclude unsubscribed contacts'],
    conclusions: ['prioritize businesses with hiring intent'],
    noise_notes: 'x'.repeat(4_000)
  },
  compression: {
    retain: [...RETAINED_CONTEXT_FIELDS],
    maxChars: MAX_COMPRESSED_CHARS
  }
});

const createControlInput = (
  overrides: Partial<{
    phase: string;
    plannedAction: string;
    dependencies: Array<{ id: string; status: string }>;
  }> = {}
) => ({
  phase: 'script_generation',
  plannedAction: 'generate_outreach_script',
  dependencies: [
    { id: 'lead_discovery', status: 'completed' },
    { id: 'lead_scoring', status: 'missing' }
  ],
  ...overrides
});

const createRecoveryInput = (
  overrides: Partial<{
    phase: string;
    stepId: string;
    attempt: number;
    maxRetries: number;
    error: {
      name: string;
      code: string;
      message: string;
    };
  }> = {}
) => {
  const error = {
    name: 'TimeoutError',
    code: 'ETIMEDOUT',
    message: 'upstream source request timed out',
    ...(overrides.error ?? {})
  };

  return {
    phase: 'lead_discovery',
    stepId: 'discover_public_sources',
    attempt: 1,
    maxRetries: 2,
    ...overrides,
    error
  };
};

test('context kernel isolates envelopes per run, keeps resume token deterministic, and compresses by contract', () => {
  const envelopeA = buildContextEnvelope(createContextEnvelopeInput('run_a'));
  const envelopeAResume = buildContextEnvelope(createContextEnvelopeInput('run_a'));
  const envelopeB = buildContextEnvelope(createContextEnvelopeInput('run_b'));

  assert.equal(envelopeA.isolation_scope, 'tenant_1:run_a');
  assert.equal(envelopeAResume.isolation_scope, 'tenant_1:run_a');
  assert.equal(envelopeB.isolation_scope, 'tenant_1:run_b');
  assert.equal(envelopeA.resume_token, envelopeAResume.resume_token);
  assert.notEqual(envelopeA.resume_token, envelopeB.resume_token);
  assert.equal(envelopeA.compression_applied, true);
  assert.equal('noise_notes' in envelopeA.compressed_context, false);
  assert.deepEqual(Object.keys(envelopeA.compressed_context).sort(), [...RETAINED_CONTEXT_FIELDS].sort());
  assert.ok(JSON.stringify(envelopeA.compressed_context).length <= MAX_COMPRESSED_CHARS);
  assert.deepEqual(envelopeA.compressed_context.decision_basis, ['Owner wants high-intent SMB leads']);
});

test('control kernel blocks when dependencies are missing', () => {
  const blockedDecision = decideNextStep(createControlInput());
  assert.equal(blockedDecision.dependency_status, 'blocked');
  assert.equal(blockedDecision.terminal_decision, 'blocked');
  assert.equal(blockedDecision.next_action, 'wait_for_dependencies');
  assert.match(blockedDecision.stop_reason ?? '', /lead_scoring/);
});

test('control kernel marks completed phase as terminal and keeps finalize action', () => {
  const completedDecision = decideNextStep(
    createControlInput({
      phase: 'completed',
      plannedAction: 'finalize_run',
      dependencies: [
        { id: 'lead_discovery', status: 'completed' },
        { id: 'lead_scoring', status: 'completed' }
      ]
    })
  );
  assert.equal(completedDecision.dependency_status, 'ready');
  assert.equal(completedDecision.terminal_decision, 'completed');
  assert.equal(completedDecision.next_action, 'finalize_run');
});

test('control kernel marks stopped phase as terminal and keeps resume action', () => {
  const stoppedDecision = decideNextStep(
    createControlInput({
      phase: 'stopped',
      plannedAction: 'await_resume',
      dependencies: [
        { id: 'lead_discovery', status: 'completed' },
        { id: 'lead_scoring', status: 'completed' }
      ]
    })
  );
  assert.equal(stoppedDecision.dependency_status, 'ready');
  assert.equal(stoppedDecision.terminal_decision, 'stopped');
  assert.equal(stoppedDecision.next_action, 'await_resume');
  assert.match(stoppedDecision.stop_reason ?? 'stopped', /stop|pause|resume|manual/i);
});

test('recovery kernel retries retryable external failures on first attempt', () => {
  const firstAttempt = recoverFromFailure(createRecoveryInput());

  assert.equal(firstAttempt.failure_type, 'external');
  assert.equal(firstAttempt.strategy, 'bounded_retry');
  assert.equal(firstAttempt.retryable, true);
  assert.equal(firstAttempt.next_attempt, 2);
});

test('recovery kernel halts external failures after retries are exhausted', () => {
  const exhaustedAttempt = recoverFromFailure(createRecoveryInput({ attempt: 2 }));

  assert.equal(exhaustedAttempt.failure_type, 'external');
  assert.equal(exhaustedAttempt.retryable, false);
  assert.equal(exhaustedAttempt.strategy, 'halt');
  assert.match(exhaustedAttempt.stop_reason ?? '', /retry/i);
});

test('recovery kernel marks reasoning failures non-retryable with halt-style strategy', () => {
  const reasoningFailure = recoverFromFailure(
    createRecoveryInput({
      stepId: 'generate_outreach_script',
      error: {
        name: 'ReasoningError',
        code: 'E_REASONING',
        message: 'unable to derive outreach angle from decision basis'
      }
    })
  );
  assert.equal(reasoningFailure.failure_type, 'reasoning');
  assert.equal(reasoningFailure.retryable, false);
  assert.ok(
    REASONING_FAILURE_STRATEGIES.includes(
      reasoningFailure.strategy as (typeof REASONING_FAILURE_STRATEGIES)[number]
    ),
    `expected reasoning strategy in ${REASONING_FAILURE_STRATEGIES.join(', ')}, got ${String(reasoningFailure.strategy)}`
  );
});

test('recovery kernel classifies input contract failures and surfaces stop reason', () => {
  const inputContractFailure = recoverFromFailure(
    createRecoveryInput({
      stepId: 'candidate_import',
      error: {
        name: 'InputContractError',
        code: 'E_INPUT_CONTRACT',
        message: 'lead payload missing required contact field'
      }
    })
  );
  assert.equal(inputContractFailure.failure_type, 'input_contract');
  assert.equal(inputContractFailure.retryable, false);
  assert.match(inputContractFailure.stop_reason ?? '', /input|contract|required/i);
});

test('recovery kernel keeps explicit input contract failures ahead of generic HTTP signals', () => {
  const inputContractFailure = recoverFromFailure(
    createRecoveryInput({
      stepId: 'candidate_import',
      error: {
        name: 'InputContractError',
        code: 'E_INPUT_CONTRACT',
        message: 'invalid HTTP payload missing required field'
      }
    })
  );

  assert.equal(inputContractFailure.failure_type, 'input_contract');
  assert.equal(inputContractFailure.strategy, 'targeted_fix');
  assert.equal(inputContractFailure.retryable, false);
  assert.equal(inputContractFailure.next_attempt, null);
});

test('recovery kernel prioritizes external timeout classification over generic input wording', () => {
  const externalFailureWithInputText = recoverFromFailure(
    createRecoveryInput({
      error: {
        name: 'TimeoutError',
        code: 'ETIMEDOUT',
        message: 'upstream input stream timed out on external network dependency'
      }
    })
  );

  assert.equal(externalFailureWithInputText.failure_type, 'external');
  assert.equal(externalFailureWithInputText.retryable, true);
  assert.equal(externalFailureWithInputText.strategy, 'bounded_retry');
});

test('recovery kernel keeps ETIMEDOUT with missing upstream response as external retry', () => {
  const externalTimeoutMissingResponse = recoverFromFailure(
    createRecoveryInput({
      attempt: 1,
      maxRetries: 3,
      error: {
        name: 'TimeoutError',
        code: 'ETIMEDOUT',
        message: 'missing response from upstream service'
      }
    })
  );

  assert.equal(externalTimeoutMissingResponse.failure_type, 'external');
  assert.equal(externalTimeoutMissingResponse.strategy, 'bounded_retry');
  assert.equal(externalTimeoutMissingResponse.retryable, true);
  assert.equal(externalTimeoutMissingResponse.next_attempt, 2);
});

test('context kernel safely falls back when structuredClone cannot clone retained slices', () => {
  const envelope = buildContextEnvelope({
    tenantId: 'tenant_1',
    runId: 'run_clone_fallback',
    phase: 'lead_discovery',
    slices: {
      decision_basis: ['keep real context'],
      progress: ['collecting public signals'],
      constraints: [() => 'not serializable', 'needs compliance review'],
      conclusions: ['keep the execution moving']
    },
    compression: {
      retain: [...RETAINED_CONTEXT_FIELDS],
      maxChars: MAX_COMPRESSED_CHARS
    }
  });

  assert.equal(envelope.isolation_scope, 'tenant_1:run_clone_fallback');
  assert.equal(envelope.compression_applied, true);
  assert.ok(JSON.stringify(envelope.compressed_context).length <= MAX_COMPRESSED_CHARS);
  assert.deepEqual(envelope.compressed_context.decision_basis, ['keep real context']);
});

test('context kernel keeps retained BigInt slices json-safe during compression', () => {
  const envelope = buildContextEnvelope({
    tenantId: 'tenant_1',
    runId: 'run_bigint_safe',
    phase: 'lead_discovery',
    slices: {
      decision_basis: ['high intent segment'],
      progress: [987654321987654321n, 'source capture in progress'],
      constraints: ['call only during office hours'],
      conclusions: ['contact by verification confidence']
    },
    compression: {
      retain: [...RETAINED_CONTEXT_FIELDS],
      maxChars: MAX_COMPRESSED_CHARS
    }
  });

  assert.equal(envelope.compression_applied, true);
  assert.equal(typeof envelope.compressed_context, 'object');
  assert.ok(envelope.compressed_context !== null);
  const serialized = JSON.stringify(envelope.compressed_context);
  assert.ok(serialized.length <= MAX_COMPRESSED_CHARS);
  assert.match(serialized, /987654321987654321n/);
});

test('context kernel serializes DataView slices as json-safe metadata and bytes', () => {
  const sourceBytes = new Uint8Array([9, 18, 27, 36]);
  const progressView = new DataView(sourceBytes.buffer, 1, 2);

  const envelope = buildContextEnvelope({
    tenantId: 'tenant_1',
    runId: 'run_data_view_safe',
    phase: 'lead_discovery',
    slices: {
      decision_basis: ['focus on high intent leads'],
      progress: progressView,
      constraints: ['respect quiet hours'],
      conclusions: ['prioritize qualified callbacks']
    },
    compression: {
      retain: [...RETAINED_CONTEXT_FIELDS],
      maxChars: MAX_COMPRESSED_CHARS
    }
  });

  assert.deepEqual(envelope.compressed_context.progress, {
    view_type: 'DataView',
    byte_offset: 1,
    byte_length: 2,
    bytes: [18, 27]
  });
  assert.doesNotThrow(() => JSON.stringify(envelope.compressed_context));
});

test('context kernel serializes typed array views into json-safe arrays', () => {
  const envelope = buildContextEnvelope({
    tenantId: 'tenant_1',
    runId: 'run_typed_array_safe',
    phase: 'lead_discovery',
    slices: {
      decision_basis: ['score by strongest signals'],
      progress: new BigInt64Array([1n, -2n]),
      constraints: new Uint8Array([3, 5, 8]),
      conclusions: ['promote highest conversion cohort']
    },
    compression: {
      retain: [...RETAINED_CONTEXT_FIELDS],
      maxChars: MAX_COMPRESSED_CHARS
    }
  });

  assert.deepEqual(envelope.compressed_context.progress, ['1n', '-2n']);
  assert.deepEqual(envelope.compressed_context.constraints, [3, 5, 8]);
  assert.doesNotThrow(() => JSON.stringify(envelope.compressed_context));
});

test('feedback kernel detects drift and emits adjustment actions', () => {
  const feedback = verifyAndTune({
    goal: 'book 3 discovery calls this week',
    stage: 'follow_up',
    receipt: {
      contacted_leads: 12,
      replied_leads: 0,
      booked_calls: 0,
      bounce_rate: 0.67
    },
    thresholds: {
      min_reply_rate: 0.1,
      min_booking_rate: 0.05,
      max_bounce_rate: 0.2
    }
  });

  assert.equal(feedback.drift_detected, true);
  assert.equal(feedback.quality_status, 'warn');
  assert.ok(feedback.adjustment_actions.includes('tighten_lead_scoring'));
  assert.ok(feedback.adjustment_actions.includes('refresh_script_angles'));
  assert.ok(feedback.adjustment_actions.includes('prioritize_verified_channels'));
  assert.deepEqual(
    feedback.action_recommendations.map((action) => action.action_type),
    ['tighten_lead_scoring', 'refresh_script_angles', 'prioritize_verified_channels']
  );
  assert.ok(
    feedback.action_recommendations.every(
      (action) => action.status === 'pending' && action.scope === 'lead_acquisition_run'
    )
  );
  assert.ok(
    feedback.action_recommendations.every(
      (action) =>
        action.metrics.reply_rate === feedback.metrics.reply_rate
        && action.metrics.booking_rate === feedback.metrics.booking_rate
        && action.metrics.bounce_rate === feedback.metrics.bounce_rate
    )
  );
});

test('feedback kernel keeps healthy performance aligned with no drift', () => {
  const feedback = verifyAndTune({
    goal: 'book 3 discovery calls this week',
    stage: 'follow_up',
    receipt: {
      contacted_leads: 20,
      replied_leads: 4,
      booked_calls: 2,
      bounce_rate: 0.05
    },
    thresholds: {
      min_reply_rate: 0.1,
      min_booking_rate: 0.05,
      max_bounce_rate: 0.2
    }
  });

  assert.equal(feedback.drift_detected, false);
  assert.equal(feedback.quality_status, 'pass');
  assert.deepEqual(feedback.adjustment_actions, []);
  assert.deepEqual(feedback.action_recommendations, []);
});
