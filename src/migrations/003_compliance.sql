-- Sprint 1: compliance tables

CREATE TABLE IF NOT EXISTS compliance_dnc_list (
    id           TEXT PRIMARY KEY,
    tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    phone_number TEXT NOT NULL,
    reason       TEXT,
    added_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, phone_number)
);

CREATE INDEX IF NOT EXISTS idx_dnc_tenant_phone ON compliance_dnc_list (tenant_id, phone_number);

CREATE TABLE IF NOT EXISTS compliance_call_log (
    id           TEXT PRIMARY KEY,
    tenant_id    TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    called_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    result       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_compliance_log_phone_day
    ON compliance_call_log (tenant_id, phone_number, called_at DESC);

CREATE TABLE IF NOT EXISTS compliance_consent (
    id              TEXT PRIMARY KEY,
    call_session_id TEXT NOT NULL,
    tenant_id       TEXT NOT NULL,
    consent_type    TEXT NOT NULL
                    CHECK (consent_type IN ('recording', 'ai_disclosure')),
    status          TEXT NOT NULL
                    CHECK (status IN ('granted', 'denied', 'pending')),
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_consent_session ON compliance_consent (call_session_id, consent_type);
