use tokio_postgres::{Row, Transaction};

use converact_kernel_ids::TenantId;
use converact_voice_agent_contracts::{
    AgentDefinitionId, AgentReleaseId, CallAttemptId, CampaignContactId, CampaignId, CampaignState,
    IdempotencyKey, InteractionId,
};
use serde_json::Value;

use crate::{AiOutboundStore, StoreError};

const MAX_IDENTIFIER_BYTES: usize = 255;
const MAX_NAME_BYTES: usize = 200;
const MAX_LANGUAGE_BYTES: usize = 35;
const MAX_JSON_BYTES: usize = 65_536;
const MAX_CONTACTS: usize = 500;
const SHA256_HEX_BYTES: usize = 64;

const LOAD_EXACT_ADMIN_RECEIPT_SQL: &str = "
SELECT resource_id, result_state, result_revision, result_count
FROM converact_outbound_admin_receipts
WHERE tenant_id = $1 AND idempotency_key = $2
  AND command_kind = $3 AND request_hash = $4
";

const LOAD_ANY_ADMIN_RECEIPT_SQL: &str = "
SELECT 1
FROM converact_outbound_admin_receipts
WHERE tenant_id = $1 AND idempotency_key = $2
";

const INSERT_ADMIN_RECEIPT_SQL: &str = "
INSERT INTO converact_outbound_admin_receipts (
  tenant_id, idempotency_key, command_kind, request_hash,
  resource_type, resource_id, result_state, result_revision, result_count
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT DO NOTHING
RETURNING resource_id, result_state, result_revision, result_count
";

/// Closed identity persisted with every AI-outbound authoring receipt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AdminCommandKind {
    PublishAgent,
    CreateCampaign,
    ImportContacts,
    TransitionCampaign,
}

impl AdminCommandKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PublishAgent => "publish_agent",
            Self::CreateCampaign => "create_campaign",
            Self::ImportContacts => "import_contacts",
            Self::TransitionCampaign => "transition_campaign",
        }
    }
}

/// Content-free result from one durable authoring transaction.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminWriteReceipt {
    resource_id: Box<str>,
    state: Box<str>,
    revision: u64,
    accepted_count: u16,
    replayed: bool,
}

impl AdminWriteReceipt {
    #[must_use]
    pub fn resource_id(&self) -> &str {
        &self.resource_id
    }

    #[must_use]
    pub fn state(&self) -> &str {
        &self.state
    }

    #[must_use]
    pub const fn revision(&self) -> u64 {
        self.revision
    }

    #[must_use]
    pub const fn accepted_count(&self) -> u16 {
        self.accepted_count
    }

    #[must_use]
    pub const fn replayed(&self) -> bool {
        self.replayed
    }
}

/// Immutable Agent Release row prepared by the Core publication boundary.
pub struct AgentReleaseWrite {
    pub tenant_id: TenantId,
    pub idempotency_key: IdempotencyKey,
    pub release_id: AgentReleaseId,
    pub definition_id: AgentDefinitionId,
    pub name: String,
    pub language: String,
    pub content_hash: String,
    pub components: Value,
}

/// Draft Campaign row prepared by the Core authoring boundary.
pub struct CampaignCreateWrite {
    pub tenant_id: TenantId,
    pub idempotency_key: IdempotencyKey,
    pub campaign_id: CampaignId,
    pub agent_release_id: AgentReleaseId,
    pub audience_id: String,
    pub dial_policy_revision: String,
    pub schedule: Value,
    pub request_hash: String,
}

/// One PII-bearing Contact plus its first physical Attempt. Debug is intentionally unavailable.
pub struct ContactAttemptWrite {
    pub contact_id: CampaignContactId,
    pub external_contact_id: String,
    pub destination: String,
    pub consent_id: String,
    pub recording_mode: String,
    pub retention_until_ms: u64,
    pub scheduled_for_ms: u64,
    pub attempt_id: CallAttemptId,
    pub interaction_id: InteractionId,
    pub attempt_idempotency_key: IdempotencyKey,
}

/// One all-or-nothing Contact import transaction. Debug is intentionally unavailable.
pub struct ContactImportWrite {
    pub tenant_id: TenantId,
    pub campaign_id: CampaignId,
    pub expected_campaign_revision: u64,
    pub idempotency_key: IdempotencyKey,
    pub request_hash: String,
    pub contacts: Vec<ContactAttemptWrite>,
}

/// Fenced state produced by Core from a row locked in this same transaction.
pub struct CampaignTransitionWrite {
    pub tenant_id: TenantId,
    pub campaign_id: CampaignId,
    pub idempotency_key: IdempotencyKey,
    pub request_hash: String,
    pub expected_state: CampaignState,
    pub next_state: CampaignState,
    pub expected_campaign_revision: u64,
    pub next_campaign_revision: u64,
    pub expected_active_attempts: u32,
}

/// Durable Campaign projection returned only while its row is locked by the caller transaction.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoredCampaign {
    id: CampaignId,
    agent_release_id: AgentReleaseId,
    state: CampaignState,
    active_attempts: u32,
    revision: u64,
}

impl StoredCampaign {
    #[must_use]
    pub const fn id(&self) -> &CampaignId {
        &self.id
    }

    #[must_use]
    pub const fn agent_release_id(&self) -> &AgentReleaseId {
        &self.agent_release_id
    }

    #[must_use]
    pub const fn state(&self) -> CampaignState {
        self.state
    }

    #[must_use]
    pub const fn active_attempts(&self) -> u32 {
        self.active_attempts
    }

    #[must_use]
    pub const fn revision(&self) -> u64 {
        self.revision
    }
}

impl AiOutboundStore {
    /// Inserts or exactly replays an immutable published Agent Release.
    ///
    /// # Errors
    ///
    /// Rejects invalid fields, content conflicts, receipt conflicts and database failures.
    pub async fn publish_agent_release(
        &self,
        transaction: &Transaction<'_>,
        command: &AgentReleaseWrite,
    ) -> Result<AdminWriteReceipt, StoreError> {
        validate_release(command)?;
        if let Some(receipt) = existing_receipt(
            transaction,
            &command.tenant_id,
            &command.idempotency_key,
            AdminCommandKind::PublishAgent,
            &command.content_hash,
        )
        .await?
        {
            return Ok(receipt);
        }
        let inserted = transaction
            .query_opt(
                "INSERT INTO converact_agent_releases (
                   tenant_id, id, definition_id, state, name, language, content_hash, components
                 ) VALUES ($1, $2, $3, 'published', $4, $5, $6, $7)
                 ON CONFLICT DO NOTHING RETURNING id",
                &[
                    &command.tenant_id.as_str(),
                    &command.release_id.as_str(),
                    &command.definition_id.as_str(),
                    &command.name,
                    &command.language,
                    &command.content_hash,
                    &command.components,
                ],
            )
            .await
            .map_err(|_| StoreError::DatabaseUnavailable)?
            .is_some();
        if !inserted && !release_matches(transaction, command).await? {
            return Err(StoreError::AdminConflict);
        }
        write_receipt(
            transaction,
            ReceiptWrite {
                tenant_id: &command.tenant_id,
                idempotency_key: &command.idempotency_key,
                kind: AdminCommandKind::PublishAgent,
                request_hash: &command.content_hash,
                resource_type: "agent_release",
                resource_id: command.release_id.as_str(),
                state: "published",
                revision: 1,
                count: 0,
                replayed: !inserted,
            },
        )
        .await
    }

    /// Inserts or exactly replays one draft Campaign bound to a published Release.
    ///
    /// # Errors
    ///
    /// Rejects invalid input, missing/retired Release, conflicts and database failures.
    pub async fn create_campaign(
        &self,
        transaction: &Transaction<'_>,
        command: &CampaignCreateWrite,
    ) -> Result<AdminWriteReceipt, StoreError> {
        validate_campaign_create(command)?;
        if let Some(receipt) = existing_receipt(
            transaction,
            &command.tenant_id,
            &command.idempotency_key,
            AdminCommandKind::CreateCampaign,
            &command.request_hash,
        )
        .await?
        {
            return Ok(receipt);
        }
        let inserted = transaction
            .query_opt(
                "INSERT INTO converact_outbound_campaigns (
                   tenant_id, id, agent_release_id, audience_id, dial_policy_revision,
                   state, schedule, active_attempts, revision
                 )
                 SELECT $1, $2, release.id, $4, $5, 'draft', $6, 0, 1
                 FROM converact_agent_releases AS release
                 WHERE release.tenant_id = $1 AND release.id = $3 AND release.state = 'published'
                 ON CONFLICT DO NOTHING RETURNING id",
                &[
                    &command.tenant_id.as_str(),
                    &command.campaign_id.as_str(),
                    &command.agent_release_id.as_str(),
                    &command.audience_id,
                    &command.dial_policy_revision,
                    &command.schedule,
                ],
            )
            .await
            .map_err(|_| StoreError::DatabaseUnavailable)?
            .is_some();
        if !inserted {
            match campaign_matches(transaction, command).await? {
                Some(true) => {}
                Some(false) => return Err(StoreError::AdminConflict),
                None => return Err(StoreError::AdminNotAllowed),
            }
        }
        write_receipt(
            transaction,
            ReceiptWrite {
                tenant_id: &command.tenant_id,
                idempotency_key: &command.idempotency_key,
                kind: AdminCommandKind::CreateCampaign,
                request_hash: &command.request_hash,
                resource_type: "campaign",
                resource_id: command.campaign_id.as_str(),
                state: "draft",
                revision: 1,
                count: 0,
                replayed: !inserted,
            },
        )
        .await
    }

    /// Locks and restores one tenant Campaign for a Core transition in the same transaction.
    ///
    /// # Errors
    ///
    /// Returns not-found, invalid stored-row or database failure without leaking SQL.
    pub async fn lock_campaign(
        &self,
        transaction: &Transaction<'_>,
        tenant_id: &TenantId,
        campaign_id: &CampaignId,
    ) -> Result<StoredCampaign, StoreError> {
        let row = transaction
            .query_opt(
                "SELECT id, agent_release_id, state, active_attempts, revision
                 FROM converact_outbound_campaigns
                 WHERE tenant_id = $1 AND id = $2
                 FOR UPDATE",
                &[&tenant_id.as_str(), &campaign_id.as_str()],
            )
            .await
            .map_err(|_| StoreError::DatabaseUnavailable)?
            .ok_or(StoreError::AdminNotFound)?;
        parse_stored_campaign(&row)
    }

    /// Atomically inserts a bounded Contact batch and one initial planned Attempt per Contact.
    ///
    /// The caller must roll back the transaction on every error.
    ///
    /// # Errors
    ///
    /// Rejects stopped/stale Campaigns, duplicate rows, invalid content and database failures.
    pub async fn import_contacts(
        &self,
        transaction: &Transaction<'_>,
        command: &ContactImportWrite,
    ) -> Result<AdminWriteReceipt, StoreError> {
        validate_contact_import(command)?;
        if let Some(receipt) = existing_receipt(
            transaction,
            &command.tenant_id,
            &command.idempotency_key,
            AdminCommandKind::ImportContacts,
            &command.request_hash,
        )
        .await?
        {
            return Ok(receipt);
        }
        let campaign = self
            .lock_campaign(transaction, &command.tenant_id, &command.campaign_id)
            .await?;
        if let Some(receipt) = existing_receipt(
            transaction,
            &command.tenant_id,
            &command.idempotency_key,
            AdminCommandKind::ImportContacts,
            &command.request_hash,
        )
        .await?
        {
            return Ok(receipt);
        }
        if campaign.revision != command.expected_campaign_revision {
            return Err(StoreError::AdminStale);
        }
        if !matches!(
            campaign.state,
            CampaignState::Draft
                | CampaignState::Scheduled
                | CampaignState::Running
                | CampaignState::Paused
        ) {
            return Err(StoreError::AdminNotAllowed);
        }

        for contact in &command.contacts {
            insert_contact_and_attempt(transaction, command, &campaign, contact).await?;
        }
        let expected_campaign_revision = i64::try_from(command.expected_campaign_revision)
            .map_err(|_| StoreError::InvalidInput)?;
        let next_revision = command
            .expected_campaign_revision
            .checked_add(1)
            .ok_or(StoreError::InvalidInput)?;
        let row = transaction
            .query_opt(
                "UPDATE converact_outbound_campaigns
                 SET revision = revision + 1, updated_at = transaction_timestamp()
                 WHERE tenant_id = $1 AND id = $2 AND revision = $3
                 RETURNING revision",
                &[
                    &command.tenant_id.as_str(),
                    &command.campaign_id.as_str(),
                    &expected_campaign_revision,
                ],
            )
            .await
            .map_err(|_| StoreError::DatabaseUnavailable)?
            .ok_or(StoreError::AdminStale)?;
        let persisted_revision =
            positive_i64(row.try_get(0).map_err(|_| StoreError::StoredRowInvalid)?)?;
        if persisted_revision != next_revision {
            return Err(StoreError::StoredRowInvalid);
        }
        let count = u16::try_from(command.contacts.len()).map_err(|_| StoreError::InvalidInput)?;
        write_receipt(
            transaction,
            ReceiptWrite {
                tenant_id: &command.tenant_id,
                idempotency_key: &command.idempotency_key,
                kind: AdminCommandKind::ImportContacts,
                request_hash: &command.request_hash,
                resource_type: "campaign",
                resource_id: command.campaign_id.as_str(),
                state: campaign.state.as_str(),
                revision: next_revision,
                count,
                replayed: false,
            },
        )
        .await
    }

    /// Persists one Core-authorized Campaign transition with revision/active-count CAS.
    ///
    /// # Errors
    ///
    /// Rejects stale rows, empty Campaigns entering scheduled/running, conflicts and database
    /// failures.
    pub async fn persist_campaign_transition(
        &self,
        transaction: &Transaction<'_>,
        command: &CampaignTransitionWrite,
    ) -> Result<AdminWriteReceipt, StoreError> {
        validate_transition(command)?;
        if let Some(receipt) = existing_receipt(
            transaction,
            &command.tenant_id,
            &command.idempotency_key,
            AdminCommandKind::TransitionCampaign,
            &command.request_hash,
        )
        .await?
        {
            return Ok(receipt);
        }
        if matches!(
            command.next_state,
            CampaignState::Scheduled | CampaignState::Running
        ) && !campaign_has_queued_attempt(transaction, &command.tenant_id, &command.campaign_id)
            .await?
        {
            return Err(StoreError::AdminNotAllowed);
        }
        let expected_campaign_revision = i64::try_from(command.expected_campaign_revision)
            .map_err(|_| StoreError::InvalidInput)?;
        let next_campaign_revision =
            i64::try_from(command.next_campaign_revision).map_err(|_| StoreError::InvalidInput)?;
        let active_attempts = i64::from(command.expected_active_attempts);
        let row = transaction
            .query_opt(
                "UPDATE converact_outbound_campaigns
                 SET state = $4, revision = $5, updated_at = transaction_timestamp()
                 WHERE tenant_id = $1 AND id = $2 AND revision = $3
                   AND state = $6 AND active_attempts = $7
                 RETURNING revision",
                &[
                    &command.tenant_id.as_str(),
                    &command.campaign_id.as_str(),
                    &expected_campaign_revision,
                    &command.next_state.as_str(),
                    &next_campaign_revision,
                    &command.expected_state.as_str(),
                    &active_attempts,
                ],
            )
            .await
            .map_err(|_| StoreError::DatabaseUnavailable)?
            .ok_or(StoreError::AdminStale)?;
        let revision = positive_i64(row.try_get(0).map_err(|_| StoreError::StoredRowInvalid)?)?;
        write_receipt(
            transaction,
            ReceiptWrite {
                tenant_id: &command.tenant_id,
                idempotency_key: &command.idempotency_key,
                kind: AdminCommandKind::TransitionCampaign,
                request_hash: &command.request_hash,
                resource_type: "campaign",
                resource_id: command.campaign_id.as_str(),
                state: command.next_state.as_str(),
                revision,
                count: 0,
                replayed: false,
            },
        )
        .await
    }
}

struct ReceiptWrite<'a> {
    tenant_id: &'a TenantId,
    idempotency_key: &'a IdempotencyKey,
    kind: AdminCommandKind,
    request_hash: &'a str,
    resource_type: &'static str,
    resource_id: &'a str,
    state: &'a str,
    revision: u64,
    count: u16,
    replayed: bool,
}

async fn existing_receipt(
    transaction: &Transaction<'_>,
    tenant_id: &TenantId,
    idempotency_key: &IdempotencyKey,
    kind: AdminCommandKind,
    request_hash: &str,
) -> Result<Option<AdminWriteReceipt>, StoreError> {
    if let Some(row) = transaction
        .query_opt(
            LOAD_EXACT_ADMIN_RECEIPT_SQL,
            &[
                &tenant_id.as_str(),
                &idempotency_key.as_str(),
                &kind.as_str(),
                &request_hash,
            ],
        )
        .await
        .map_err(|_| StoreError::DatabaseUnavailable)?
    {
        return parse_receipt(&row, true).map(Some);
    }
    if transaction
        .query_opt(
            LOAD_ANY_ADMIN_RECEIPT_SQL,
            &[&tenant_id.as_str(), &idempotency_key.as_str()],
        )
        .await
        .map_err(|_| StoreError::DatabaseUnavailable)?
        .is_some()
    {
        return Err(StoreError::AdminConflict);
    }
    Ok(None)
}

async fn write_receipt(
    transaction: &Transaction<'_>,
    command: ReceiptWrite<'_>,
) -> Result<AdminWriteReceipt, StoreError> {
    let revision = i64::try_from(command.revision).map_err(|_| StoreError::InvalidInput)?;
    let count = i32::from(command.count);
    if let Some(row) = transaction
        .query_opt(
            INSERT_ADMIN_RECEIPT_SQL,
            &[
                &command.tenant_id.as_str(),
                &command.idempotency_key.as_str(),
                &command.kind.as_str(),
                &command.request_hash,
                &command.resource_type,
                &command.resource_id,
                &command.state,
                &revision,
                &count,
            ],
        )
        .await
        .map_err(|_| StoreError::DatabaseUnavailable)?
    {
        return parse_receipt(&row, command.replayed);
    }
    existing_receipt(
        transaction,
        command.tenant_id,
        command.idempotency_key,
        command.kind,
        command.request_hash,
    )
    .await?
    .ok_or(StoreError::AdminConflict)
}

async fn release_matches(
    transaction: &Transaction<'_>,
    command: &AgentReleaseWrite,
) -> Result<bool, StoreError> {
    let row = transaction
        .query_opt(
            "SELECT definition_id, state, name, language, content_hash, components
             FROM converact_agent_releases WHERE tenant_id = $1 AND id = $2",
            &[&command.tenant_id.as_str(), &command.release_id.as_str()],
        )
        .await
        .map_err(|_| StoreError::DatabaseUnavailable)?;
    let Some(row) = row else {
        return Ok(false);
    };
    Ok(
        row.try_get::<_, &str>(0).ok() == Some(command.definition_id.as_str())
            && row.try_get::<_, &str>(1).ok() == Some("published")
            && row.try_get::<_, &str>(2).ok() == Some(command.name.as_str())
            && row.try_get::<_, &str>(3).ok() == Some(command.language.as_str())
            && row.try_get::<_, &str>(4).ok() == Some(command.content_hash.as_str())
            && row.try_get::<_, Value>(5).ok().as_ref() == Some(&command.components),
    )
}

async fn campaign_matches(
    transaction: &Transaction<'_>,
    command: &CampaignCreateWrite,
) -> Result<Option<bool>, StoreError> {
    let row = transaction
        .query_opt(
            "SELECT agent_release_id, audience_id, dial_policy_revision, state, schedule,
                    active_attempts, revision
             FROM converact_outbound_campaigns WHERE tenant_id = $1 AND id = $2",
            &[&command.tenant_id.as_str(), &command.campaign_id.as_str()],
        )
        .await
        .map_err(|_| StoreError::DatabaseUnavailable)?;
    let Some(row) = row else {
        return Ok(None);
    };
    Ok(Some(
        row.try_get::<_, &str>(0).ok() == Some(command.agent_release_id.as_str())
            && row.try_get::<_, &str>(1).ok() == Some(command.audience_id.as_str())
            && row.try_get::<_, &str>(2).ok() == Some(command.dial_policy_revision.as_str())
            && row.try_get::<_, &str>(3).ok() == Some("draft")
            && row.try_get::<_, Value>(4).ok().as_ref() == Some(&command.schedule)
            && row.try_get::<_, i32>(5).ok() == Some(0)
            && row.try_get::<_, i64>(6).ok() == Some(1),
    ))
}

async fn insert_contact_and_attempt(
    transaction: &Transaction<'_>,
    command: &ContactImportWrite,
    campaign: &StoredCampaign,
    contact: &ContactAttemptWrite,
) -> Result<(), StoreError> {
    let retention_until_ms =
        i64::try_from(contact.retention_until_ms).map_err(|_| StoreError::InvalidInput)?;
    let scheduled_for_ms =
        i64::try_from(contact.scheduled_for_ms).map_err(|_| StoreError::InvalidInput)?;
    let contact_inserted = transaction
        .query_opt(
            "INSERT INTO converact_outbound_campaign_contacts (
               tenant_id, id, campaign_id, external_contact_id, destination, consent_id,
               recording_mode, retention_until, state, scheduled_for, attempt_count
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7,
               to_timestamp($8::double precision / 1000.0), 'queued',
               to_timestamp($9::double precision / 1000.0), 1
             ) ON CONFLICT DO NOTHING RETURNING id",
            &[
                &command.tenant_id.as_str(),
                &contact.contact_id.as_str(),
                &command.campaign_id.as_str(),
                &contact.external_contact_id,
                &contact.destination,
                &contact.consent_id,
                &contact.recording_mode,
                &retention_until_ms,
                &scheduled_for_ms,
            ],
        )
        .await
        .map_err(|_| StoreError::DatabaseUnavailable)?
        .is_some();
    if !contact_inserted {
        return Err(StoreError::AdminConflict);
    }
    let attempt_inserted = transaction
        .query_opt(
            "INSERT INTO converact_outbound_call_attempts (
               tenant_id, id, campaign_id, campaign_contact_id, attempt_number,
               previous_attempt_id, interaction_id, agent_release_id, execution_generation,
               state, idempotency_key, consent_id, recording_mode, retention_until, scheduled_for
             ) VALUES (
               $1, $2, $3, $4, 1, NULL, $5, $6, 1, 'planned', $7, $8, $9,
               to_timestamp($10::double precision / 1000.0),
               to_timestamp($11::double precision / 1000.0)
             ) ON CONFLICT DO NOTHING RETURNING id",
            &[
                &command.tenant_id.as_str(),
                &contact.attempt_id.as_str(),
                &command.campaign_id.as_str(),
                &contact.contact_id.as_str(),
                &contact.interaction_id.as_str(),
                &campaign.agent_release_id.as_str(),
                &contact.attempt_idempotency_key.as_str(),
                &contact.consent_id,
                &contact.recording_mode,
                &retention_until_ms,
                &scheduled_for_ms,
            ],
        )
        .await
        .map_err(|_| StoreError::DatabaseUnavailable)?
        .is_some();
    if !attempt_inserted {
        return Err(StoreError::AdminConflict);
    }
    Ok(())
}

async fn campaign_has_queued_attempt(
    transaction: &Transaction<'_>,
    tenant_id: &TenantId,
    campaign_id: &CampaignId,
) -> Result<bool, StoreError> {
    transaction
        .query_one(
            "SELECT EXISTS (
               SELECT 1
               FROM converact_outbound_campaign_contacts AS contact
               JOIN converact_outbound_call_attempts AS attempt
                 ON attempt.tenant_id = contact.tenant_id
                AND attempt.campaign_contact_id = contact.id
               WHERE contact.tenant_id = $1 AND contact.campaign_id = $2
                 AND contact.state = 'queued' AND attempt.state = 'planned'
             )",
            &[&tenant_id.as_str(), &campaign_id.as_str()],
        )
        .await
        .map_err(|_| StoreError::DatabaseUnavailable)?
        .try_get(0)
        .map_err(|_| StoreError::StoredRowInvalid)
}

fn parse_receipt(row: &Row, replayed: bool) -> Result<AdminWriteReceipt, StoreError> {
    let resource_id: &str = row.try_get(0).map_err(|_| StoreError::StoredRowInvalid)?;
    let state: &str = row.try_get(1).map_err(|_| StoreError::StoredRowInvalid)?;
    let revision: i64 = row.try_get(2).map_err(|_| StoreError::StoredRowInvalid)?;
    let count: i32 = row.try_get(3).map_err(|_| StoreError::StoredRowInvalid)?;
    if !valid_identifier(resource_id) || !valid_identifier(state) {
        return Err(StoreError::StoredRowInvalid);
    }
    Ok(AdminWriteReceipt {
        resource_id: resource_id.into(),
        state: state.into(),
        revision: positive_i64(revision)?,
        accepted_count: u16::try_from(count)
            .ok()
            .filter(|count| usize::from(*count) <= MAX_CONTACTS)
            .ok_or(StoreError::StoredRowInvalid)?,
        replayed,
    })
}

fn parse_stored_campaign(row: &Row) -> Result<StoredCampaign, StoreError> {
    let id: &str = row.try_get(0).map_err(|_| StoreError::StoredRowInvalid)?;
    let release_id: &str = row.try_get(1).map_err(|_| StoreError::StoredRowInvalid)?;
    let state: &str = row.try_get(2).map_err(|_| StoreError::StoredRowInvalid)?;
    let active_attempts: i32 = row.try_get(3).map_err(|_| StoreError::StoredRowInvalid)?;
    let revision: i64 = row.try_get(4).map_err(|_| StoreError::StoredRowInvalid)?;
    Ok(StoredCampaign {
        id: CampaignId::parse(id).map_err(|_| StoreError::StoredRowInvalid)?,
        agent_release_id: AgentReleaseId::parse(release_id)
            .map_err(|_| StoreError::StoredRowInvalid)?,
        state: parse_campaign_state(state)?,
        active_attempts: u32::try_from(active_attempts)
            .map_err(|_| StoreError::StoredRowInvalid)?,
        revision: positive_i64(revision)?,
    })
}

fn validate_release(command: &AgentReleaseWrite) -> Result<(), StoreError> {
    if command.name.is_empty()
        || command.name.len() > MAX_NAME_BYTES
        || command.name.trim().len() != command.name.len()
        || command.name.chars().any(char::is_control)
        || command.language.len() < 2
        || command.language.len() > MAX_LANGUAGE_BYTES
        || !valid_identifier(&command.language.replace('-', "_"))
        || !is_lowercase_sha256(&command.content_hash)
        || json_size(&command.components)? > MAX_JSON_BYTES
        || !command.components.is_object()
    {
        return Err(StoreError::InvalidInput);
    }
    Ok(())
}

fn validate_campaign_create(command: &CampaignCreateWrite) -> Result<(), StoreError> {
    if !valid_identifier(&command.audience_id)
        || !valid_identifier(&command.dial_policy_revision)
        || !is_lowercase_sha256(&command.request_hash)
        || json_size(&command.schedule)? > MAX_JSON_BYTES
        || !command.schedule.is_object()
    {
        return Err(StoreError::InvalidInput);
    }
    Ok(())
}

fn validate_contact_import(command: &ContactImportWrite) -> Result<(), StoreError> {
    if command.expected_campaign_revision == 0
        || command.contacts.is_empty()
        || command.contacts.len() > MAX_CONTACTS
        || !is_lowercase_sha256(&command.request_hash)
    {
        return Err(StoreError::InvalidInput);
    }
    for contact in &command.contacts {
        if !valid_identifier(&contact.external_contact_id)
            || !valid_destination(&contact.destination)
            || !valid_identifier(&contact.consent_id)
            || !matches!(
                contact.recording_mode.as_str(),
                "disabled" | "always" | "after_disclosure" | "on_demand"
            )
            || contact.scheduled_for_ms == 0
            || contact.retention_until_ms <= contact.scheduled_for_ms
        {
            return Err(StoreError::InvalidInput);
        }
    }
    Ok(())
}

fn validate_transition(command: &CampaignTransitionWrite) -> Result<(), StoreError> {
    if command.expected_campaign_revision == 0
        || command.next_campaign_revision
            != command
                .expected_campaign_revision
                .checked_add(1)
                .ok_or(StoreError::InvalidInput)?
        || command.expected_state == command.next_state
        || !is_lowercase_sha256(&command.request_hash)
    {
        return Err(StoreError::InvalidInput);
    }
    Ok(())
}

fn json_size(value: &Value) -> Result<usize, StoreError> {
    serde_json::to_vec(value)
        .map(|encoded| encoded.len())
        .map_err(|_| StoreError::InvalidInput)
}

fn positive_i64(value: i64) -> Result<u64, StoreError> {
    u64::try_from(value)
        .ok()
        .filter(|value| *value > 0)
        .ok_or(StoreError::StoredRowInvalid)
}

fn valid_identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= MAX_IDENTIFIER_BYTES
        && first.is_ascii_alphanumeric()
        && remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_destination(value: &str) -> bool {
    value.len() >= 3
        && value.len() <= MAX_IDENTIFIER_BYTES
        && value.is_ascii()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_graphic() && !matches!(byte, b'"' | b'\'' | b'`'))
}

fn is_lowercase_sha256(value: &str) -> bool {
    value.len() == SHA256_HEX_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn parse_campaign_state(value: &str) -> Result<CampaignState, StoreError> {
    match value {
        "draft" => Ok(CampaignState::Draft),
        "scheduled" => Ok(CampaignState::Scheduled),
        "running" => Ok(CampaignState::Running),
        "paused" => Ok(CampaignState::Paused),
        "draining" => Ok(CampaignState::Draining),
        "completed" => Ok(CampaignState::Completed),
        "cancelled" => Ok(CampaignState::Cancelled),
        "archived" => Ok(CampaignState::Archived),
        _ => Err(StoreError::StoredRowInvalid),
    }
}
