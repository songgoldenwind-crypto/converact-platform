use std::sync::Arc;

use converact_ai_outbound_core::{
    CallAttempt, CampaignSchedule, ComplianceDecision, ComplianceInput, CompliancePort,
    ConsentBasis, EvidenceStatus, GateStatus, MAX_PHYSICAL_ATTEMPTS, PortError,
    evaluate_compliance,
};
use converact_kernel_ids::TenantId as KernelTenantId;
use converact_voice_agent_contracts::TenantId;
use serde::Deserialize;
use serde_json::Value;
use tokio_postgres::Row;

use crate::{PostgresRuntime, TransactionError};

const LOAD_COMPLIANCE_FACTS_SQL: &str = "
SELECT campaign.schedule,
       ROUND(EXTRACT(EPOCH FROM attempt.scheduled_for) * 1000)::BIGINT AS scheduled_for_ms,
       ROUND(EXTRACT(EPOCH FROM transaction_timestamp()) * 1000)::BIGINT AS current_ms,
       attempt.attempt_number,
       contact.state AS contact_state,
       release.state AS release_state,
       COALESCE(
         consent.status = 'granted' AND
         (consent.expires_at IS NULL OR consent.expires_at > transaction_timestamp()),
         FALSE
       ) AS consent_allowed
FROM converact_outbound_call_attempts AS attempt
JOIN converact_outbound_campaign_contacts AS contact
  ON contact.tenant_id = attempt.tenant_id
 AND contact.id = attempt.campaign_contact_id
JOIN converact_outbound_campaigns AS campaign
  ON campaign.tenant_id = attempt.tenant_id
 AND campaign.id = attempt.campaign_id
JOIN converact_agent_releases AS release
  ON release.tenant_id = attempt.tenant_id
 AND release.id = attempt.agent_release_id
LEFT JOIN LATERAL (
  SELECT evidence.status, evidence.expires_at
  FROM converact_platform_consent_evidence AS evidence
  WHERE evidence.tenant_id = attempt.tenant_id
    AND evidence.consent_id = attempt.consent_id
    AND evidence.scope = 'phone_audio'
    AND evidence.purpose = 'ai_outbound'
  ORDER BY evidence.revision DESC
  LIMIT 1
) AS consent ON TRUE
WHERE attempt.tenant_id = $1
  AND attempt.id = $2
  AND attempt.state = 'claimed'
LIMIT 1";

/// Tenant-scoped pre-dial policy adapter over existing durable Campaign and consent authorities.
pub struct PostgresAiOutboundCompliancePort {
    runtime: Arc<PostgresRuntime>,
}

impl PostgresAiOutboundCompliancePort {
    #[must_use]
    pub const fn new(runtime: Arc<PostgresRuntime>) -> Self {
        Self { runtime }
    }
}

impl CompliancePort for PostgresAiOutboundCompliancePort {
    async fn evaluate(
        &self,
        tenant_id: &TenantId,
        attempt: &CallAttempt,
    ) -> Result<ComplianceDecision, PortError> {
        let transaction_tenant =
            KernelTenantId::parse(tenant_id.as_str()).map_err(|_| stored_facts_invalid())?;
        let query_tenant = tenant_id.as_str().to_owned();
        let attempt_id = attempt.id().clone();
        self.runtime
            .with_tenant_transaction(&transaction_tenant, move |transaction| {
                Box::pin(async move {
                    let row = transaction
                        .query_opt(
                            LOAD_COMPLIANCE_FACTS_SQL,
                            &[&query_tenant, &attempt_id.as_str()],
                        )
                        .await
                        .map_err(|_| {
                            PortError::unavailable("ai_outbound_compliance_store_unavailable")
                        })?
                        .ok_or_else(|| {
                            PortError::rejected("ai_outbound_compliance_facts_not_found")
                        })?;
                    resolve_facts(&parse_facts(&row)?)
                })
            })
            .await
            .map_err(map_transaction_error)
    }
}

impl std::fmt::Debug for PostgresAiOutboundCompliancePort {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("PostgresAiOutboundCompliancePort([REDACTED])")
    }
}

struct StoredComplianceFacts {
    schedule: StoredSchedule,
    scheduled_for_ms: u64,
    current_ms: u64,
    attempt_number: i32,
    contact_state: String,
    release_state: String,
    consent_allowed: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredSchedule {
    starts_at_ms: u64,
    time_zone: String,
}

fn parse_facts(row: &Row) -> Result<StoredComplianceFacts, PortError> {
    let schedule = row
        .try_get::<_, Value>("schedule")
        .ok()
        .and_then(|value| serde_json::from_value(value).ok())
        .ok_or_else(stored_facts_invalid)?;
    Ok(StoredComplianceFacts {
        schedule,
        scheduled_for_ms: positive_millis(row, "scheduled_for_ms")?,
        current_ms: positive_millis(row, "current_ms")?,
        attempt_number: row
            .try_get("attempt_number")
            .map_err(|_| stored_facts_invalid())?,
        contact_state: row
            .try_get("contact_state")
            .map_err(|_| stored_facts_invalid())?,
        release_state: row
            .try_get("release_state")
            .map_err(|_| stored_facts_invalid())?,
        consent_allowed: row
            .try_get("consent_allowed")
            .map_err(|_| stored_facts_invalid())?,
    })
}

fn positive_millis(row: &Row, column: &str) -> Result<u64, PortError> {
    row.try_get::<_, i64>(column)
        .ok()
        .and_then(|value| u64::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or_else(stored_facts_invalid)
}

fn resolve_facts(facts: &StoredComplianceFacts) -> Result<ComplianceDecision, PortError> {
    CampaignSchedule::try_new(facts.schedule.starts_at_ms, &facts.schedule.time_zone)
        .map_err(|_| stored_facts_invalid())?;
    let dial_window = if facts.current_ms >= facts.schedule.starts_at_ms
        && facts.current_ms >= facts.scheduled_for_ms
    {
        GateStatus::Allowed
    } else {
        GateStatus::Blocked
    };
    let do_not_call = match facts.contact_state.as_str() {
        "queued" | "active" => GateStatus::Allowed,
        "suppressed" => GateStatus::Blocked,
        _ => GateStatus::Unknown,
    };
    let frequency = if (1..=i32::from(MAX_PHYSICAL_ATTEMPTS)).contains(&facts.attempt_number) {
        GateStatus::Allowed
    } else {
        GateStatus::Blocked
    };
    let release = if facts.release_state == "published" {
        GateStatus::Allowed
    } else {
        GateStatus::Blocked
    };
    Ok(evaluate_compliance(&ComplianceInput {
        consent_basis: facts.consent_allowed.then_some(ConsentBasis::Explicit),
        timezone: EvidenceStatus::Confirmed,
        dial_window,
        do_not_call,
        frequency,
        release,
    }))
}

const fn stored_facts_invalid() -> PortError {
    PortError::rejected("ai_outbound_compliance_facts_invalid")
}

#[allow(clippy::needless_pass_by_value)]
fn map_transaction_error(error: TransactionError<PortError>) -> PortError {
    match error {
        TransactionError::Work(error) => error,
        TransactionError::AdmissionRejected
        | TransactionError::PoolUnavailable
        | TransactionError::DatabaseUnavailable
        | TransactionError::DeadlineExceeded
        | TransactionError::RollbackUnknown
        | TransactionError::CommitUnknown => {
            PortError::unavailable("ai_outbound_compliance_store_unavailable")
        }
    }
}

#[cfg(test)]
mod tests {
    use converact_ai_outbound_core::ComplianceReason;

    use super::*;

    #[test]
    fn complete_current_facts_approve_one_attempt() {
        assert_eq!(
            resolve_facts(&facts()).unwrap(),
            ComplianceDecision::Approved
        );
    }

    #[test]
    fn missing_consent_and_stopped_contact_fail_closed() {
        let mut missing_consent = facts();
        missing_consent.consent_allowed = false;
        assert_eq!(
            resolve_facts(&missing_consent).unwrap(),
            ComplianceDecision::Blocked(ComplianceReason::ConsentUnknown)
        );

        let mut stopped = facts();
        stopped.contact_state = "suppressed".to_owned();
        assert_eq!(
            resolve_facts(&stopped).unwrap(),
            ComplianceDecision::Blocked(ComplianceReason::DoNotCall)
        );
    }

    fn facts() -> StoredComplianceFacts {
        StoredComplianceFacts {
            schedule: StoredSchedule {
                starts_at_ms: 1_000,
                time_zone: "Asia/Shanghai".to_owned(),
            },
            scheduled_for_ms: 2_000,
            current_ms: 3_000,
            attempt_number: 1,
            contact_state: "queued".to_owned(),
            release_state: "published".to_owned(),
            consent_allowed: true,
        }
    }
}
