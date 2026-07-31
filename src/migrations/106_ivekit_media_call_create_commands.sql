CREATE TABLE IF NOT EXISTS ivekit_media_call_create_commands (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  idempotency_key_hash TEXT NOT NULL
    CHECK (char_length(idempotency_key_hash) = 64)
    CHECK (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  payload_hash TEXT NOT NULL
    CHECK (char_length(payload_hash) = 64)
    CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  requester_identity_hash TEXT NOT NULL
    CHECK (char_length(requester_identity_hash) = 64)
    CHECK (requester_identity_hash ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (
      state IN (
        'pending',
        'succeeded',
        'retryable_failed',
        'terminal_failed'
      )
    ),
  attempt_generation BIGINT NOT NULL DEFAULT 1
    CHECK (attempt_generation BETWEEN 1 AND 9007199254740991),
  attempt_token_hash TEXT NOT NULL
    CHECK (
      attempt_token_hash = ''
      OR (
        char_length(attempt_token_hash) = 64
        AND attempt_token_hash ~ '^[a-f0-9]{64}$'
      )
    ),
  lease_until TIMESTAMPTZ,
  result_snapshot JSONB,
  error_code TEXT NOT NULL DEFAULT '',
  error_status INTEGER NOT NULL DEFAULT 0
    CHECK (error_status = 0 OR error_status BETWEEN 400 AND 599),
  error_retryable BOOLEAN NOT NULL DEFAULT FALSE,
  next_retry_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, idempotency_key_hash),
  UNIQUE (tenant_id, call_id),
  CHECK (
    (state = 'pending' AND result_snapshot IS NULL
      AND char_length(attempt_token_hash) = 64
      AND lease_until IS NOT NULL
      AND error_code = '' AND error_status = 0
      AND error_retryable = FALSE AND next_retry_at IS NULL
      AND completed_at IS NULL)
    OR
    (state = 'retryable_failed' AND result_snapshot IS NULL
      AND attempt_token_hash = '' AND lease_until IS NULL
      AND error_code <> '' AND error_status BETWEEN 400 AND 599
      AND error_retryable = TRUE AND next_retry_at IS NOT NULL
      AND completed_at IS NULL)
    OR
    (state = 'terminal_failed' AND result_snapshot IS NULL
      AND attempt_token_hash = '' AND lease_until IS NULL
      AND error_code <> '' AND error_status BETWEEN 400 AND 599
      AND error_retryable = FALSE AND next_retry_at IS NULL
      AND completed_at IS NOT NULL)
    OR
    (state = 'succeeded' AND result_snapshot IS NOT NULL
      AND attempt_token_hash = '' AND lease_until IS NULL
      AND error_code = '' AND error_status = 0
      AND error_retryable = FALSE AND next_retry_at IS NULL
      AND completed_at IS NOT NULL)
  )
);

-- call_id intentionally has no foreign key: this ledger must commit before
-- placement and before the ivekit_media_calls row exists.
CREATE INDEX IF NOT EXISTS idx_ivekit_media_call_create_commands_recovery
  ON ivekit_media_call_create_commands(
    tenant_id,
    state,
    next_retry_at,
    lease_until,
    call_id
  )
  WHERE state IN ('pending', 'retryable_failed');

CREATE INDEX IF NOT EXISTS idx_ivekit_media_call_create_commands_expiry
  ON ivekit_media_call_create_commands(tenant_id, expires_at, call_id);

ALTER TABLE ivekit_media_call_create_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_media_call_create_commands FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_media_call_create_commands;
CREATE POLICY tenant_isolation ON ivekit_media_call_create_commands FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON ivekit_media_call_create_commands TO opc_runtime;
  END IF;
END
$$;
