ALTER TABLE rustdesk_authorization_codes
  ADD COLUMN IF NOT EXISTS claim_id TEXT,
  ADD COLUMN IF NOT EXISTS claimed_by TEXT,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ;

ALTER TABLE rustdesk_authorization_codes
  DROP CONSTRAINT IF EXISTS rustdesk_authorization_codes_status_check;
ALTER TABLE rustdesk_authorization_codes
  ADD CONSTRAINT rustdesk_authorization_codes_status_check
  CHECK (status IN ('pending', 'verified', 'claimed', 'consumed', 'expired', 'locked'));

ALTER TABLE rustdesk_authorization_codes
  DROP CONSTRAINT IF EXISTS rustdesk_authorization_codes_claim_state_check;
ALTER TABLE rustdesk_authorization_codes
  ADD CONSTRAINT rustdesk_authorization_codes_claim_state_check CHECK (
    (
      status = 'claimed'
      AND claim_id IS NOT NULL
      AND claimed_by IS NOT NULL
      AND claimed_at IS NOT NULL
      AND claim_expires_at IS NOT NULL
    ) OR (
      status <> 'claimed'
      AND claim_id IS NULL
      AND claimed_by IS NULL
      AND claimed_at IS NULL
      AND claim_expires_at IS NULL
    )
  );

ALTER TABLE rustdesk_authorization_codes
  DROP CONSTRAINT IF EXISTS rustdesk_authorization_codes_claim_actor_check;
ALTER TABLE rustdesk_authorization_codes
  ADD CONSTRAINT rustdesk_authorization_codes_claim_actor_check
  CHECK (status <> 'claimed' OR claimed_by = verified_by);

ALTER TABLE rustdesk_authorization_codes
  DROP CONSTRAINT IF EXISTS rustdesk_authorization_codes_claim_id_check;
ALTER TABLE rustdesk_authorization_codes
  ADD CONSTRAINT rustdesk_authorization_codes_claim_id_check
  CHECK (claim_id IS NULL OR claim_id ~ '^rdclaim_[A-Za-z0-9_-]{8,200}$');

CREATE UNIQUE INDEX IF NOT EXISTS idx_rustdesk_authorization_codes_claim
  ON rustdesk_authorization_codes(tenant_id, claim_id)
  WHERE claim_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_rustdesk_authorization_codes_claim_expiry
  ON rustdesk_authorization_codes(tenant_id, status, claim_expires_at)
  WHERE status = 'claimed';
