-- Bound expired active-call recovery without scanning completed or unrelated Attempts.
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS idx_converact_outbound_attempt_active_recovery
  ON converact_outbound_call_attempts (tenant_id, lease_expires_at, id)
  WHERE state IN (
    'conversing', 'handoff_pending', 'human_active', 'ai_resuming', 'finalizing'
  );
