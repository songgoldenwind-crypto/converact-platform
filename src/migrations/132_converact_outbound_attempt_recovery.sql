-- Persist the disclosure fact required to restore the exact CallAttempt aggregate after a crash.
-- Existing rows receive FALSE without a table rewrite. The Rust reader derives TRUE from states
-- that can only be reached after disclosure, and the next fenced transition materializes it.
-- A later bounded cleanup can backfill and validate this constraint after old calls drain.
SET LOCAL lock_timeout = '5s';

ALTER TABLE converact_outbound_call_attempts
  ADD COLUMN IF NOT EXISTS disclosure_completed BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE converact_outbound_call_attempts
  DROP CONSTRAINT IF EXISTS converact_outbound_attempt_disclosure_state_check;
ALTER TABLE converact_outbound_call_attempts
  ADD CONSTRAINT converact_outbound_attempt_disclosure_state_check CHECK (
    (
      state IN ('conversing', 'handoff_pending', 'human_active', 'ai_resuming', 'finalizing', 'completed')
      AND disclosure_completed
    ) OR (
      state IN (
        'planned', 'claimed', 'compliance_approved', 'compliance_blocked',
        'agent_capacity_reserved', 'dialing', 'ringing', 'answered', 'agent_connecting',
        'busy', 'no_answer', 'rejected', 'failed_before_answer'
      )
      AND NOT disclosure_completed
    ) OR state IN (
      'disclosure_pending', 'failed_after_answer', 'cancelled',
      'outcome_unknown', 'reconcile_required'
    )
  ) NOT VALID;
