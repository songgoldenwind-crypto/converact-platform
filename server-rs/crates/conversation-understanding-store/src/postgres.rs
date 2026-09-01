use std::fmt;

use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CallId, CampaignContactId, CampaignId, ChannelAgentSessionId,
    EnvelopeContext, EnvelopeContextInput, ExecutionGeneration, InteractionId,
};
use serde_json::Value;
use tokio_postgres::{Row, Transaction, error::SqlState};

use crate::{
    AppendAction, AppendUnderstandingRecord, RecordPresence, UnderstandingDomain,
    UnderstandingHead, UnderstandingHeadInput, UnderstandingRecord, UnderstandingRecordInput,
    UnderstandingRecordKind, UnderstandingStoreError,
};

/// Durable outcome of one atomic append and optional latest-head transition.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppendOutcome {
    RecordOnlyAppended,
    RecordOnlyReplay,
    HeadAdvanced { head_revision: u64 },
    HeadReplay { head_revision: u64 },
    HeadSuperseded { current_head_revision: u64 },
}

/// Latest durable head plus the exact immutable record to which it points.
#[derive(Clone, Eq, PartialEq)]
pub struct StoredUnderstandingHead {
    head: UnderstandingHead,
    record: UnderstandingRecord,
}

impl StoredUnderstandingHead {
    #[must_use]
    pub const fn head(&self) -> &UnderstandingHead {
        &self.head
    }

    #[must_use]
    pub const fn record(&self) -> &UnderstandingRecord {
        &self.record
    }
}

impl fmt::Debug for StoredUnderstandingHead {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StoredUnderstandingHead")
            .field("head", &self.head)
            .field("record", &self.record)
            .finish()
    }
}

/// Stateless tenant-scoped `PostgreSQL` adapter for the understanding ledger.
#[derive(Clone, Copy, Debug, Default)]
pub struct UnderstandingSqlStore;

impl UnderstandingSqlStore {
    #[must_use]
    pub const fn new() -> Self {
        Self
    }

    /// Atomically appends immutable evidence and optionally advances one fenced latest head.
    ///
    /// The caller owns the transaction and must commit only an `Ok` result.
    ///
    /// # Errors
    ///
    /// Rejects conflicting record identities, stale head fences, malformed stored rows,
    /// conversion failures and database failures.
    pub async fn append(
        &self,
        transaction: &Transaction<'_>,
        command: &AppendUnderstandingRecord,
    ) -> Result<AppendOutcome, UnderstandingStoreError> {
        acquire_scope_lock(transaction, command).await?;
        let current = load_current_inner(
            transaction,
            command.record().context(),
            command.record().domain(),
            true,
        )
        .await?;
        let existing = load_record_by_id(
            transaction,
            command.record().context().tenant_id(),
            command.record().record_id(),
        )
        .await?;
        let presence = match existing.as_ref() {
            None => RecordPresence::Absent,
            Some(record) if record == command.record() => RecordPresence::Exact,
            Some(_) => RecordPresence::Conflict,
        };
        let action = command.decide(
            presence,
            current.as_ref().map(StoredUnderstandingHead::head),
        )?;
        match action {
            AppendAction::InsertRecordOnly => {
                if insert_record(transaction, command.record()).await? {
                    Ok(AppendOutcome::RecordOnlyAppended)
                } else {
                    ensure_exact_record(transaction, command.record()).await?;
                    Ok(AppendOutcome::RecordOnlyReplay)
                }
            }
            AppendAction::ReplayRecordOnly => Ok(AppendOutcome::RecordOnlyReplay),
            AppendAction::InsertRecordAndCreateHead { head_revision } => {
                if !insert_record(transaction, command.record()).await? {
                    ensure_exact_record(transaction, command.record()).await?;
                }
                create_head(transaction, command.record(), head_revision).await?;
                Ok(AppendOutcome::HeadAdvanced { head_revision })
            }
            AppendAction::ReuseRecordAndCreateHead { head_revision } => {
                create_head(transaction, command.record(), head_revision).await?;
                Ok(AppendOutcome::HeadAdvanced { head_revision })
            }
            AppendAction::InsertRecordAndAdvanceHead { head_revision } => {
                if !insert_record(transaction, command.record()).await? {
                    ensure_exact_record(transaction, command.record()).await?;
                }
                advance_head(transaction, command, head_revision).await?;
                Ok(AppendOutcome::HeadAdvanced { head_revision })
            }
            AppendAction::ReuseRecordAndAdvanceHead { head_revision } => {
                advance_head(transaction, command, head_revision).await?;
                Ok(AppendOutcome::HeadAdvanced { head_revision })
            }
            AppendAction::ReplayCurrent { head_revision } => {
                Ok(AppendOutcome::HeadReplay { head_revision })
            }
            AppendAction::ReplaySuperseded {
                current_head_revision,
            } => Ok(AppendOutcome::HeadSuperseded {
                current_head_revision,
            }),
        }
    }

    /// Loads one exact current domain head and its immutable payload using the bounded head key.
    ///
    /// # Errors
    ///
    /// Rejects malformed stored data and database failures.
    pub async fn load_current(
        &self,
        transaction: &Transaction<'_>,
        context: &EnvelopeContext,
        domain: UnderstandingDomain,
    ) -> Result<Option<StoredUnderstandingHead>, UnderstandingStoreError> {
        load_current_inner(transaction, context, domain, false).await
    }
}

async fn acquire_scope_lock(
    transaction: &Transaction<'_>,
    command: &AppendUnderstandingRecord,
) -> Result<(), UnderstandingStoreError> {
    let record = command.record();
    let context = record.context();
    let suffix = if command.head_expectation().is_some() {
        record.domain().as_str()
    } else {
        record.record_id()
    };
    let lock_key = format!(
        "{}:{}:{}:{}:{suffix}",
        context.tenant_id(),
        context.interaction_id().as_str(),
        context.call_attempt_id().as_str(),
        context.execution_generation().get(),
    );
    transaction
        .query_one(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&lock_key],
        )
        .await
        .map_err(|error| map_database_error(&error))?;
    Ok(())
}

async fn insert_record(
    transaction: &Transaction<'_>,
    record: &UnderstandingRecord,
) -> Result<bool, UnderstandingStoreError> {
    let context = record.context();
    let schema_version = i16::try_from(context.schema_version())
        .map_err(|_| UnderstandingStoreError::InvalidRecord)?;
    let execution_generation = i64_from(context.execution_generation().get())?;
    let turn_index = i64::from(record.turn_index());
    let observed_at_ms = i64_from(record.observed_at_ms())?;
    let retention_until_ms = i64_from(record.retention_until_ms())?;
    let call_id = context.call_id().map(CallId::as_str);
    let channel_agent_session_id = context
        .channel_agent_session_id()
        .map(ChannelAgentSessionId::as_str);
    let inserted = transaction
        .execute(
            "INSERT INTO converact_conversation_understanding_records (
               tenant_id, record_id, record_kind, domain, contract_schema_version,
               interaction_id, campaign_id, campaign_contact_id, call_attempt_id, call_id,
               agent_release_id, channel_agent_session_id, trace_id, execution_generation,
               turn_index, observed_at, retention_policy_ref, retention_until, payload, payload_hash
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
               to_timestamp($16::DOUBLE PRECISION / 1000.0), $17,
               to_timestamp($18::DOUBLE PRECISION / 1000.0), $19, $20
             ) ON CONFLICT DO NOTHING",
            &[
                &context.tenant_id(),
                &record.record_id(),
                &record.kind().as_str(),
                &record.domain().as_str(),
                &schema_version,
                &context.interaction_id().as_str(),
                &context.campaign_id().as_str(),
                &context.campaign_contact_id().as_str(),
                &context.call_attempt_id().as_str(),
                &call_id,
                &context.agent_release_id().as_str(),
                &channel_agent_session_id,
                &context.trace_id(),
                &execution_generation,
                &turn_index,
                &observed_at_ms,
                &record.retention_policy_ref(),
                &retention_until_ms,
                &record.payload(),
                &record.payload_hash(),
            ],
        )
        .await
        .map_err(|error| map_database_error(&error))?;
    Ok(inserted == 1)
}

async fn create_head(
    transaction: &Transaction<'_>,
    record: &UnderstandingRecord,
    head_revision: u64,
) -> Result<(), UnderstandingStoreError> {
    let context = record.context();
    let execution_generation = i64_from(context.execution_generation().get())?;
    let head_revision = i64_from(head_revision)?;
    let turn_index = i64::from(record.turn_index());
    let observed_at_ms = i64_from(record.observed_at_ms())?;
    let inserted = transaction
        .execute(
            "INSERT INTO converact_conversation_understanding_heads (
               tenant_id, interaction_id, call_attempt_id, execution_generation, domain,
               head_revision, record_id, record_kind, turn_index, observed_at, payload_hash
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               to_timestamp($10::DOUBLE PRECISION / 1000.0), $11)
             ON CONFLICT DO NOTHING",
            &[
                &context.tenant_id(),
                &context.interaction_id().as_str(),
                &context.call_attempt_id().as_str(),
                &execution_generation,
                &record.domain().as_str(),
                &head_revision,
                &record.record_id(),
                &record.kind().as_str(),
                &turn_index,
                &observed_at_ms,
                &record.payload_hash(),
            ],
        )
        .await
        .map_err(|error| map_database_error(&error))?;
    if inserted == 1 {
        Ok(())
    } else {
        Err(UnderstandingStoreError::StaleFence)
    }
}

async fn advance_head(
    transaction: &Transaction<'_>,
    command: &AppendUnderstandingRecord,
    head_revision: u64,
) -> Result<(), UnderstandingStoreError> {
    let record = command.record();
    let context = record.context();
    let expectation = command
        .head_expectation()
        .ok_or(UnderstandingStoreError::InvalidHeadExpectation)?;
    let execution_generation = i64_from(context.execution_generation().get())?;
    let expected_revision = i64_from(expectation.expected_revision())?;
    let head_revision = i64_from(head_revision)?;
    let turn_index = i64::from(record.turn_index());
    let observed_at_ms = i64_from(record.observed_at_ms())?;
    let updated = transaction
        .query_opt(
            "UPDATE converact_conversation_understanding_heads AS head
             SET head_revision = $9, record_id = $10, record_kind = $11, turn_index = $12,
                 observed_at = to_timestamp($13::DOUBLE PRECISION / 1000.0),
                 payload_hash = $14, updated_at = transaction_timestamp()
             WHERE head.tenant_id = $1
               AND head.interaction_id = $2
               AND head.call_attempt_id = $3
               AND head.execution_generation = $4
               AND head.domain = $5
               AND head.head_revision = $6
               AND head.record_id = $7
               AND head.payload_hash = $8
             RETURNING head.head_revision",
            &[
                &context.tenant_id(),
                &context.interaction_id().as_str(),
                &context.call_attempt_id().as_str(),
                &execution_generation,
                &record.domain().as_str(),
                &expected_revision,
                &expectation.expected_record_id(),
                &expectation.expected_payload_hash(),
                &head_revision,
                &record.record_id(),
                &record.kind().as_str(),
                &turn_index,
                &observed_at_ms,
                &record.payload_hash(),
            ],
        )
        .await
        .map_err(|error| map_database_error(&error))?;
    let row = updated.ok_or(UnderstandingStoreError::StaleFence)?;
    let observed_revision = u64_from(i64_at(&row, 0)?)?;
    if observed_revision == u64::try_from(head_revision).unwrap_or_default() {
        Ok(())
    } else {
        Err(UnderstandingStoreError::StoredRowInvalid)
    }
}

async fn ensure_exact_record(
    transaction: &Transaction<'_>,
    expected: &UnderstandingRecord,
) -> Result<(), UnderstandingStoreError> {
    match load_record_by_id(
        transaction,
        expected.context().tenant_id(),
        expected.record_id(),
    )
    .await?
    {
        Some(stored) if &stored == expected => Ok(()),
        Some(_) => Err(UnderstandingStoreError::Conflict),
        None => Err(UnderstandingStoreError::StoredRowInvalid),
    }
}

async fn load_current_inner(
    transaction: &Transaction<'_>,
    context: &EnvelopeContext,
    domain: UnderstandingDomain,
    for_update: bool,
) -> Result<Option<StoredUnderstandingHead>, UnderstandingStoreError> {
    let execution_generation = i64_from(context.execution_generation().get())?;
    let query = if for_update {
        "SELECT head.head_revision, head.record_id, head.record_kind, head.turn_index,
                floor(extract(epoch FROM head.observed_at) * 1000)::BIGINT,
                head.payload_hash, record.contract_schema_version, record.campaign_id,
                record.campaign_contact_id, record.call_id, record.agent_release_id,
                record.channel_agent_session_id, record.trace_id, record.retention_policy_ref,
                floor(extract(epoch FROM record.retention_until) * 1000)::BIGINT,
                record.payload, record.domain
         FROM converact_conversation_understanding_heads AS head
         JOIN converact_conversation_understanding_records AS record
           ON record.tenant_id = head.tenant_id AND record.record_id = head.record_id
         WHERE head.tenant_id = $1
           AND head.interaction_id = $2
           AND head.call_attempt_id = $3
           AND head.execution_generation = $4
           AND head.domain = $5
         FOR UPDATE OF head"
    } else {
        "SELECT head.head_revision, head.record_id, head.record_kind, head.turn_index,
                floor(extract(epoch FROM head.observed_at) * 1000)::BIGINT,
                head.payload_hash, record.contract_schema_version, record.campaign_id,
                record.campaign_contact_id, record.call_id, record.agent_release_id,
                record.channel_agent_session_id, record.trace_id, record.retention_policy_ref,
                floor(extract(epoch FROM record.retention_until) * 1000)::BIGINT,
                record.payload, record.domain
         FROM converact_conversation_understanding_heads AS head
         JOIN converact_conversation_understanding_records AS record
           ON record.tenant_id = head.tenant_id AND record.record_id = head.record_id
         WHERE head.tenant_id = $1
           AND head.interaction_id = $2
           AND head.call_attempt_id = $3
           AND head.execution_generation = $4
           AND head.domain = $5"
    };
    let row = transaction
        .query_opt(
            query,
            &[
                &context.tenant_id(),
                &context.interaction_id().as_str(),
                &context.call_attempt_id().as_str(),
                &execution_generation,
                &domain.as_str(),
            ],
        )
        .await
        .map_err(|error| map_database_error(&error))?;
    row.map(|row| current_from_row(context, domain, &row))
        .transpose()
}

fn current_from_row(
    key_context: &EnvelopeContext,
    domain: UnderstandingDomain,
    row: &Row,
) -> Result<StoredUnderstandingHead, UnderstandingStoreError> {
    let revision = u64_from(i64_at(row, 0)?)?;
    let record_id = string_at(row, 1)?;
    let kind = UnderstandingRecordKind::parse(string_at(row, 2)?)?;
    let turn_index = u32_from(i64_at(row, 3)?)?;
    let observed_at_ms = u64_from(i64_at(row, 4)?)?;
    let payload_hash = string_at(row, 5)?.to_owned();
    let context = context_from_head_row(key_context, row)?;
    if !same_authority(key_context, &context) {
        return Err(UnderstandingStoreError::StoredRowInvalid);
    }
    let retention_policy_ref = string_at(row, 13)?.to_owned();
    let retention_until_ms = u64_from(i64_at(row, 14)?)?;
    let payload = value_at(row, 15)?;
    if string_at(row, 16)? != domain.as_str() || kind.domain() != domain {
        return Err(UnderstandingStoreError::StoredRowInvalid);
    }
    let record = UnderstandingRecord::try_new(UnderstandingRecordInput {
        record_id: record_id.to_owned(),
        context: context.clone(),
        kind,
        turn_index,
        observed_at_ms,
        retention_policy_ref,
        retention_until_ms,
        payload,
        payload_hash: payload_hash.clone(),
    })
    .map_err(|_| UnderstandingStoreError::StoredRowInvalid)?;
    let head = UnderstandingHead::try_new(UnderstandingHeadInput {
        context,
        kind,
        revision,
        record_id: record_id.to_owned(),
        payload_hash,
        turn_index,
        observed_at_ms,
    })?;
    Ok(StoredUnderstandingHead { head, record })
}

fn context_from_head_row(
    key_context: &EnvelopeContext,
    row: &Row,
) -> Result<EnvelopeContext, UnderstandingStoreError> {
    let schema_version =
        u16::try_from(i16_at(row, 6)?).map_err(|_| UnderstandingStoreError::StoredRowInvalid)?;
    EnvelopeContext::try_new(EnvelopeContextInput {
        schema_version,
        tenant_id: key_context.tenant_id().to_owned(),
        interaction_id: key_context.interaction_id().clone(),
        campaign_id: CampaignId::parse(string_at(row, 7)?)
            .map_err(|_| UnderstandingStoreError::StoredRowInvalid)?,
        campaign_contact_id: CampaignContactId::parse(string_at(row, 8)?)
            .map_err(|_| UnderstandingStoreError::StoredRowInvalid)?,
        call_attempt_id: key_context.call_attempt_id().clone(),
        call_id: optional_string_at(row, 9)?
            .map(CallId::parse)
            .transpose()
            .map_err(|_| UnderstandingStoreError::StoredRowInvalid)?,
        agent_release_id: AgentReleaseId::parse(string_at(row, 10)?)
            .map_err(|_| UnderstandingStoreError::StoredRowInvalid)?,
        channel_agent_session_id: optional_string_at(row, 11)?
            .map(ChannelAgentSessionId::parse)
            .transpose()
            .map_err(|_| UnderstandingStoreError::StoredRowInvalid)?,
        execution_generation: key_context.execution_generation(),
        trace_id: string_at(row, 12)?.to_owned(),
    })
    .map_err(|_| UnderstandingStoreError::StoredRowInvalid)
}

async fn load_record_by_id(
    transaction: &Transaction<'_>,
    tenant_id: &str,
    record_id: &str,
) -> Result<Option<UnderstandingRecord>, UnderstandingStoreError> {
    let row = transaction
        .query_opt(
            "SELECT record_kind, domain, contract_schema_version, interaction_id, campaign_id,
                    campaign_contact_id, call_attempt_id, call_id, agent_release_id,
                    channel_agent_session_id, trace_id, execution_generation, turn_index,
                    floor(extract(epoch FROM observed_at) * 1000)::BIGINT,
                    retention_policy_ref,
                    floor(extract(epoch FROM retention_until) * 1000)::BIGINT,
                    payload, payload_hash
             FROM converact_conversation_understanding_records
             WHERE tenant_id = $1 AND record_id = $2",
            &[&tenant_id, &record_id],
        )
        .await
        .map_err(|error| map_database_error(&error))?;
    row.map(|row| record_from_row(tenant_id, record_id, &row))
        .transpose()
}

fn record_from_row(
    tenant_id: &str,
    record_id: &str,
    row: &Row,
) -> Result<UnderstandingRecord, UnderstandingStoreError> {
    let kind = UnderstandingRecordKind::parse(string_at(row, 0)?)?;
    if string_at(row, 1)? != kind.domain().as_str() {
        return Err(UnderstandingStoreError::StoredRowInvalid);
    }
    let schema_version =
        u16::try_from(i16_at(row, 2)?).map_err(|_| UnderstandingStoreError::StoredRowInvalid)?;
    let execution_generation = ExecutionGeneration::new(u64_from(i64_at(row, 11)?)?)
        .map_err(|_| UnderstandingStoreError::StoredRowInvalid)?;
    let context = EnvelopeContext::try_new(EnvelopeContextInput {
        schema_version,
        tenant_id: tenant_id.to_owned(),
        interaction_id: InteractionId::parse(string_at(row, 3)?)
            .map_err(|_| UnderstandingStoreError::StoredRowInvalid)?,
        campaign_id: CampaignId::parse(string_at(row, 4)?)
            .map_err(|_| UnderstandingStoreError::StoredRowInvalid)?,
        campaign_contact_id: CampaignContactId::parse(string_at(row, 5)?)
            .map_err(|_| UnderstandingStoreError::StoredRowInvalid)?,
        call_attempt_id: CallAttemptId::parse(string_at(row, 6)?)
            .map_err(|_| UnderstandingStoreError::StoredRowInvalid)?,
        call_id: optional_string_at(row, 7)?
            .map(CallId::parse)
            .transpose()
            .map_err(|_| UnderstandingStoreError::StoredRowInvalid)?,
        agent_release_id: AgentReleaseId::parse(string_at(row, 8)?)
            .map_err(|_| UnderstandingStoreError::StoredRowInvalid)?,
        channel_agent_session_id: optional_string_at(row, 9)?
            .map(ChannelAgentSessionId::parse)
            .transpose()
            .map_err(|_| UnderstandingStoreError::StoredRowInvalid)?,
        execution_generation,
        trace_id: string_at(row, 10)?.to_owned(),
    })
    .map_err(|_| UnderstandingStoreError::StoredRowInvalid)?;
    UnderstandingRecord::try_new(UnderstandingRecordInput {
        record_id: record_id.to_owned(),
        context,
        kind,
        turn_index: u32_from(i64_at(row, 12)?)?,
        observed_at_ms: u64_from(i64_at(row, 13)?)?,
        retention_policy_ref: string_at(row, 14)?.to_owned(),
        retention_until_ms: u64_from(i64_at(row, 15)?)?,
        payload: value_at(row, 16)?,
        payload_hash: string_at(row, 17)?.to_owned(),
    })
    .map_err(|_| UnderstandingStoreError::StoredRowInvalid)
}

fn map_database_error(error: &tokio_postgres::Error) -> UnderstandingStoreError {
    match error.code() {
        Some(&SqlState::UNIQUE_VIOLATION) => UnderstandingStoreError::Conflict,
        Some(&SqlState::T_R_SERIALIZATION_FAILURE) => UnderstandingStoreError::StaleFence,
        Some(&SqlState::CHECK_VIOLATION | &SqlState::FOREIGN_KEY_VIOLATION) => {
            UnderstandingStoreError::StoredRowInvalid
        }
        _ => UnderstandingStoreError::DatabaseUnavailable,
    }
}

fn i64_from(value: u64) -> Result<i64, UnderstandingStoreError> {
    i64::try_from(value).map_err(|_| UnderstandingStoreError::InvalidRecord)
}

fn u64_from(value: i64) -> Result<u64, UnderstandingStoreError> {
    u64::try_from(value).map_err(|_| UnderstandingStoreError::StoredRowInvalid)
}

fn u32_from(value: i64) -> Result<u32, UnderstandingStoreError> {
    u32::try_from(value).map_err(|_| UnderstandingStoreError::StoredRowInvalid)
}

fn string_at(row: &Row, index: usize) -> Result<&str, UnderstandingStoreError> {
    row.try_get(index)
        .map_err(|_| UnderstandingStoreError::StoredRowInvalid)
}

fn optional_string_at(row: &Row, index: usize) -> Result<Option<&str>, UnderstandingStoreError> {
    row.try_get(index)
        .map_err(|_| UnderstandingStoreError::StoredRowInvalid)
}

fn i64_at(row: &Row, index: usize) -> Result<i64, UnderstandingStoreError> {
    row.try_get(index)
        .map_err(|_| UnderstandingStoreError::StoredRowInvalid)
}

fn i16_at(row: &Row, index: usize) -> Result<i16, UnderstandingStoreError> {
    row.try_get(index)
        .map_err(|_| UnderstandingStoreError::StoredRowInvalid)
}

fn value_at(row: &Row, index: usize) -> Result<Value, UnderstandingStoreError> {
    row.try_get(index)
        .map_err(|_| UnderstandingStoreError::StoredRowInvalid)
}

fn same_authority(left: &EnvelopeContext, right: &EnvelopeContext) -> bool {
    left.schema_version() == right.schema_version()
        && left.tenant_id() == right.tenant_id()
        && left.interaction_id() == right.interaction_id()
        && left.campaign_id() == right.campaign_id()
        && left.campaign_contact_id() == right.campaign_contact_id()
        && left.call_attempt_id() == right.call_attempt_id()
        && left.call_id() == right.call_id()
        && left.agent_release_id() == right.agent_release_id()
        && left.channel_agent_session_id() == right.channel_agent_session_id()
        && left.execution_generation() == right.execution_generation()
}
