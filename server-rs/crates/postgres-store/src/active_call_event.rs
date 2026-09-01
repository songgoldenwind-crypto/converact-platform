use std::{error::Error, fmt, sync::Arc};

use converact_contracts::canonical_sha256;
use converact_kernel_ids::TenantId;
use converact_voice_agent_contracts::EnvelopeContext;
use deadpool_postgres::tokio_postgres::Row;

use crate::{PostgresRuntime, TransactionError};

const MAX_EVENT_BYTES: usize = 131_072;
const MAX_PENDING_EVENTS: usize = 1_024;
const LOAD_PENDING_LIMIT: i64 = 1_025;

const LOAD_SESSION_SQL: &str = "
SELECT contract_schema_version, campaign_id, campaign_contact_id, call_attempt_id, call_id,
       agent_release_id, channel_agent_session_id, last_received_cursor, last_applied_cursor,
       terminal_cursor, status, reconcile_reason
FROM public.converact_active_call_event_sessions
WHERE tenant_id = $1 AND interaction_id = $2 AND execution_generation = $3
FOR SHARE";

const LOAD_PENDING_SQL: &str = "
SELECT event_cursor, payload_digest, event_payload, terminal
FROM public.converact_active_call_event_inbox
WHERE tenant_id = $1 AND interaction_id = $2 AND execution_generation = $3
  AND event_cursor > $4 AND applied_at IS NULL
ORDER BY event_cursor
LIMIT 1025";

const APPEND_SQL: &str = "
SELECT public.converact_active_call_event_append(
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
) AS decision";

const MARK_APPLIED_SQL: &str = "
SELECT public.converact_active_call_event_mark_applied(
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
) AS decision";

const REQUIRE_RECONCILE_SQL: &str = "
SELECT public.converact_active_call_event_require_reconcile(
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
) AS decision";

const BIND_MEDIA_SQL: &str = "
SELECT public.converact_active_call_event_bind_media(
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
) AS decision";

const LOAD_MEDIA_BINDING_SQL: &str = "
SELECT contract_schema_version, campaign_id, campaign_contact_id, call_attempt_id, call_id,
       agent_release_id, channel_agent_session_id, customer_track_id, call_started_at_ms,
       language, retention_policy_ref
FROM public.converact_active_call_event_sessions
WHERE tenant_id = $1 AND interaction_id = $2 AND execution_generation = $3
FOR SHARE";

/// Durable lifecycle read from one exact Active Call session generation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PostgresActiveCallEventStatus {
    Active,
    Completed,
    ReconcileRequired,
}

/// Closed persisted reason that replay coverage can no longer be proved.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PostgresActiveCallEventReconcileReason {
    CoverageGap,
    SessionDisappeared,
    InvalidEvent,
}

impl PostgresActiveCallEventReconcileReason {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CoverageGap => "coverage_gap",
            Self::SessionDisappeared => "session_disappeared",
            Self::InvalidEvent => "invalid_event",
        }
    }
}

/// Exact durable append classification after a retried transaction result.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PostgresActiveCallEventAppendDecision {
    Appended,
    ReplayedPending,
    ReplayedApplied,
}

/// Exact classification of an idempotent customer-media binding.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PostgresActiveCallMediaBindDecision {
    Bound,
    Replayed,
}

/// Durable customer-input source and transcript metadata for one session generation.
#[derive(Clone, Eq, PartialEq)]
pub struct PostgresActiveCallMediaBinding {
    customer_track_id: Box<str>,
    call_started_at_ms: u64,
    language: Box<str>,
    retention_policy_ref: Box<str>,
}

impl PostgresActiveCallMediaBinding {
    #[must_use]
    pub fn customer_track_id(&self) -> &str {
        &self.customer_track_id
    }

    #[must_use]
    pub const fn call_started_at_ms(&self) -> u64 {
        self.call_started_at_ms
    }

    #[must_use]
    pub fn language(&self) -> &str {
        &self.language
    }

    #[must_use]
    pub fn retention_policy_ref(&self) -> &str {
        &self.retention_policy_ref
    }
}

impl fmt::Debug for PostgresActiveCallMediaBinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PostgresActiveCallMediaBinding")
            .field("has_customer_track", &true)
            .field("call_started_at_ms", &self.call_started_at_ms)
            .field("language", &self.language)
            .field("retention_policy_ref", &self.retention_policy_ref)
            .finish_non_exhaustive()
    }
}

/// One validated pending event loaded in cursor order.
#[derive(Clone, Eq, PartialEq)]
pub struct PostgresStoredActiveCallEvent {
    cursor: u64,
    payload_digest: Box<str>,
    payload: Box<str>,
    terminal: bool,
}

impl PostgresStoredActiveCallEvent {
    #[must_use]
    pub const fn cursor(&self) -> u64 {
        self.cursor
    }

    #[must_use]
    pub fn payload_digest(&self) -> &str {
        &self.payload_digest
    }

    #[must_use]
    pub fn payload(&self) -> &str {
        &self.payload
    }

    #[must_use]
    pub const fn is_terminal(&self) -> bool {
        self.terminal
    }
}

impl fmt::Debug for PostgresStoredActiveCallEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PostgresStoredActiveCallEvent")
            .field("cursor", &self.cursor)
            .field("payload_digest", &self.payload_digest)
            .field("payload_bytes", &self.payload.len())
            .field("terminal", &self.terminal)
            .finish_non_exhaustive()
    }
}

/// Validated cursor head and its complete bounded unapplied suffix.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PostgresActiveCallEventSnapshot {
    status: PostgresActiveCallEventStatus,
    last_received_cursor: u64,
    last_applied_cursor: u64,
    terminal_cursor: Option<u64>,
    reconcile_reason: Option<PostgresActiveCallEventReconcileReason>,
    pending: Box<[PostgresStoredActiveCallEvent]>,
}

impl PostgresActiveCallEventSnapshot {
    fn empty() -> Self {
        Self {
            status: PostgresActiveCallEventStatus::Active,
            last_received_cursor: 0,
            last_applied_cursor: 0,
            terminal_cursor: None,
            reconcile_reason: None,
            pending: Box::new([]),
        }
    }

    #[must_use]
    pub const fn status(&self) -> PostgresActiveCallEventStatus {
        self.status
    }

    #[must_use]
    pub const fn last_received_cursor(&self) -> u64 {
        self.last_received_cursor
    }

    #[must_use]
    pub const fn last_applied_cursor(&self) -> u64 {
        self.last_applied_cursor
    }

    #[must_use]
    pub const fn terminal_cursor(&self) -> Option<u64> {
        self.terminal_cursor
    }

    #[must_use]
    pub const fn reconcile_reason(&self) -> Option<PostgresActiveCallEventReconcileReason> {
        self.reconcile_reason
    }

    #[must_use]
    pub fn pending(&self) -> &[PostgresStoredActiveCallEvent] {
        &self.pending
    }
}

/// Sanitized tenant-transaction or durable-event Store failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PostgresActiveCallEventStoreError {
    code: &'static str,
}

impl PostgresActiveCallEventStoreError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        self.code
    }
}

impl fmt::Display for PostgresActiveCallEventStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for PostgresActiveCallEventStoreError {}

/// Tenant-scoped durable cursor and inbox owner for Active Call semantic events.
pub struct PostgresActiveCallEventStore {
    runtime: Arc<PostgresRuntime>,
}

impl PostgresActiveCallEventStore {
    #[must_use]
    pub const fn new(runtime: Arc<PostgresRuntime>) -> Self {
        Self { runtime }
    }

    /// Loads one cursor head and its bounded contiguous pending suffix atomically.
    ///
    /// # Errors
    ///
    /// Rejects tenant/authority drift, malformed rows, cursor gaps and transaction failures.
    pub async fn load_snapshot(
        &self,
        context: &EnvelopeContext,
    ) -> Result<PostgresActiveCallEventSnapshot, PostgresActiveCallEventStoreError> {
        let authority = ActiveCallEventAuthority::try_from(context)?;
        let tenant = authority.tenant.clone();
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move {
                    let session = transaction
                        .query_opt(
                            LOAD_SESSION_SQL,
                            &[
                                &authority.tenant_id,
                                &authority.interaction_id,
                                &authority.execution_generation,
                            ],
                        )
                        .await
                        .map_err(|_| unavailable())?;
                    let Some(session) = session else {
                        return Ok(PostgresActiveCallEventSnapshot::empty());
                    };
                    validate_stored_authority(&authority, &session)?;
                    let last_applied: i64 = session
                        .try_get("last_applied_cursor")
                        .map_err(|_| invalid_snapshot())?;
                    let pending = transaction
                        .query(
                            LOAD_PENDING_SQL,
                            &[
                                &authority.tenant_id,
                                &authority.interaction_id,
                                &authority.execution_generation,
                                &last_applied,
                            ],
                        )
                        .await
                        .map_err(|_| unavailable())?;
                    if pending.len() >= usize::try_from(LOAD_PENDING_LIMIT).unwrap_or(usize::MAX) {
                        return Err(invalid_snapshot());
                    }
                    decode_snapshot(&session, &pending)
                })
            })
            .await
            .map_err(map_transaction_error)
    }

    /// Atomically appends or classifies an exact replay at the expected previous cursor.
    ///
    /// # Errors
    ///
    /// Rejects non-canonical payloads, authority drift, cursor gaps and conflicting replays.
    pub async fn append_event(
        &self,
        context: &EnvelopeContext,
        expected_previous_cursor: u64,
        cursor: u64,
        payload_digest: &str,
        payload: &str,
        terminal: bool,
    ) -> Result<PostgresActiveCallEventAppendDecision, PostgresActiveCallEventStoreError> {
        validate_event(cursor, payload_digest, payload)?;
        let authority = ActiveCallEventAuthority::try_from(context)?;
        let expected_previous_cursor = durable_cursor(expected_previous_cursor)?;
        let cursor = positive_cursor(cursor)?;
        if expected_previous_cursor != cursor - 1 {
            return Err(invalid_input());
        }
        let payload_digest = payload_digest.to_owned();
        let payload = payload.to_owned();
        let tenant = authority.tenant.clone();
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move {
                    let row = transaction
                        .query_one(
                            APPEND_SQL,
                            &[
                                &authority.tenant_id,
                                &authority.contract_schema_version,
                                &authority.interaction_id,
                                &authority.campaign_id,
                                &authority.campaign_contact_id,
                                &authority.call_attempt_id,
                                &authority.call_id,
                                &authority.agent_release_id,
                                &authority.channel_agent_session_id,
                                &authority.execution_generation,
                                &expected_previous_cursor,
                                &cursor,
                                &payload_digest,
                                &payload,
                                &terminal,
                            ],
                        )
                        .await
                        .map_err(|_| unavailable())?;
                    match row
                        .try_get::<_, String>("decision")
                        .map_err(|_| invalid_snapshot())?
                        .as_str()
                    {
                        "appended" => Ok(PostgresActiveCallEventAppendDecision::Appended),
                        "replayed_pending" => {
                            Ok(PostgresActiveCallEventAppendDecision::ReplayedPending)
                        }
                        "replayed_applied" => {
                            Ok(PostgresActiveCallEventAppendDecision::ReplayedApplied)
                        }
                        _ => Err(invalid_snapshot()),
                    }
                })
            })
            .await
            .map_err(map_transaction_error)
    }

    /// Atomically acknowledges exactly the next durable event or accepts its exact replay.
    ///
    /// # Errors
    ///
    /// Rejects out-of-order, cross-authority or payload-conflicting acknowledgements.
    pub async fn mark_event_applied(
        &self,
        context: &EnvelopeContext,
        cursor: u64,
        payload_digest: &str,
        terminal: bool,
    ) -> Result<(), PostgresActiveCallEventStoreError> {
        if !lowercase_sha256(payload_digest) {
            return Err(invalid_input());
        }
        let authority = ActiveCallEventAuthority::try_from(context)?;
        let cursor = positive_cursor(cursor)?;
        let payload_digest = payload_digest.to_owned();
        let tenant = authority.tenant.clone();
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move {
                    let row = transaction
                        .query_one(
                            MARK_APPLIED_SQL,
                            &[
                                &authority.tenant_id,
                                &authority.contract_schema_version,
                                &authority.interaction_id,
                                &authority.campaign_id,
                                &authority.campaign_contact_id,
                                &authority.call_attempt_id,
                                &authority.call_id,
                                &authority.agent_release_id,
                                &authority.channel_agent_session_id,
                                &authority.execution_generation,
                                &cursor,
                                &payload_digest,
                                &terminal,
                            ],
                        )
                        .await
                        .map_err(|_| unavailable())?;
                    match row
                        .try_get::<_, String>("decision")
                        .map_err(|_| invalid_snapshot())?
                        .as_str()
                    {
                        "applied" | "replayed" => Ok(()),
                        _ => Err(invalid_snapshot()),
                    }
                })
            })
            .await
            .map_err(map_transaction_error)
    }

    /// Durably closes automatic consumption when complete replay coverage is no longer provable.
    ///
    /// # Errors
    ///
    /// Rejects authority drift, reason conflict and completed streams.
    pub async fn require_reconcile(
        &self,
        context: &EnvelopeContext,
        reason: PostgresActiveCallEventReconcileReason,
    ) -> Result<(), PostgresActiveCallEventStoreError> {
        let authority = ActiveCallEventAuthority::try_from(context)?;
        let reason = reason.as_str().to_owned();
        let tenant = authority.tenant.clone();
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move {
                    let row = transaction
                        .query_one(
                            REQUIRE_RECONCILE_SQL,
                            &[
                                &authority.tenant_id,
                                &authority.contract_schema_version,
                                &authority.interaction_id,
                                &authority.campaign_id,
                                &authority.campaign_contact_id,
                                &authority.call_attempt_id,
                                &authority.call_id,
                                &authority.agent_release_id,
                                &authority.channel_agent_session_id,
                                &authority.execution_generation,
                                &reason,
                            ],
                        )
                        .await
                        .map_err(|_| unavailable())?;
                    match row
                        .try_get::<_, String>("decision")
                        .map_err(|_| invalid_snapshot())?
                        .as_str()
                    {
                        "marked" | "replayed" => Ok(()),
                        _ => Err(invalid_snapshot()),
                    }
                })
            })
            .await
            .map_err(map_transaction_error)
    }

    /// Idempotently freezes the first customer media source for one exact session generation.
    ///
    /// The database resolves language and retention from the immutable Release and Attempt; callers
    /// cannot supply or override either value.
    ///
    /// # Errors
    ///
    /// Rejects malformed media facts, authority drift, conflicting replay and Store failures.
    pub async fn bind_media(
        &self,
        context: &EnvelopeContext,
        customer_track_id: &str,
        call_started_at_ms: u64,
    ) -> Result<PostgresActiveCallMediaBindDecision, PostgresActiveCallEventStoreError> {
        if !valid_track_id(customer_track_id) || call_started_at_ms > 9_007_199_254_740_991 {
            return Err(invalid_input());
        }
        let authority = ActiveCallEventAuthority::try_from(context)?;
        let customer_track_id = customer_track_id.to_owned();
        let call_started_at_ms = positive_cursor(call_started_at_ms)?;
        let tenant = authority.tenant.clone();
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move {
                    let row = transaction
                        .query_one(
                            BIND_MEDIA_SQL,
                            &[
                                &authority.tenant_id,
                                &authority.contract_schema_version,
                                &authority.interaction_id,
                                &authority.campaign_id,
                                &authority.campaign_contact_id,
                                &authority.call_attempt_id,
                                &authority.call_id,
                                &authority.agent_release_id,
                                &authority.channel_agent_session_id,
                                &authority.execution_generation,
                                &customer_track_id,
                                &call_started_at_ms,
                            ],
                        )
                        .await
                        .map_err(|_| unavailable())?;
                    match row
                        .try_get::<_, String>("decision")
                        .map_err(|_| invalid_snapshot())?
                        .as_str()
                    {
                        "bound" => Ok(PostgresActiveCallMediaBindDecision::Bound),
                        "replayed" => Ok(PostgresActiveCallMediaBindDecision::Replayed),
                        _ => Err(invalid_snapshot()),
                    }
                })
            })
            .await
            .map_err(map_transaction_error)
    }

    /// Loads and revalidates the complete media binding for one exact session generation.
    ///
    /// # Errors
    ///
    /// Rejects partial metadata, authority drift and malformed stored values.
    pub async fn load_media_binding(
        &self,
        context: &EnvelopeContext,
    ) -> Result<Option<PostgresActiveCallMediaBinding>, PostgresActiveCallEventStoreError> {
        let authority = ActiveCallEventAuthority::try_from(context)?;
        let tenant = authority.tenant.clone();
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move {
                    transaction
                        .query_opt(
                            LOAD_MEDIA_BINDING_SQL,
                            &[
                                &authority.tenant_id,
                                &authority.interaction_id,
                                &authority.execution_generation,
                            ],
                        )
                        .await
                        .map_err(|_| unavailable())?
                        .map(|row| decode_media_binding(&authority, &row))
                        .transpose()
                        .map(Option::flatten)
                })
            })
            .await
            .map_err(map_transaction_error)
    }
}

impl fmt::Debug for PostgresActiveCallEventStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PostgresActiveCallEventStore")
            .finish_non_exhaustive()
    }
}

#[derive(Clone)]
struct ActiveCallEventAuthority {
    tenant: TenantId,
    tenant_id: String,
    contract_schema_version: i16,
    interaction_id: String,
    campaign_id: String,
    campaign_contact_id: String,
    call_attempt_id: String,
    call_id: Option<String>,
    agent_release_id: String,
    channel_agent_session_id: String,
    execution_generation: i64,
}

impl TryFrom<&EnvelopeContext> for ActiveCallEventAuthority {
    type Error = PostgresActiveCallEventStoreError;

    fn try_from(context: &EnvelopeContext) -> Result<Self, Self::Error> {
        let tenant = TenantId::parse(context.tenant_id()).map_err(|_| invalid_authority())?;
        let contract_schema_version =
            i16::try_from(context.schema_version()).map_err(|_| invalid_authority())?;
        let execution_generation =
            i64::try_from(context.execution_generation().get()).map_err(|_| invalid_authority())?;
        let channel_agent_session_id = context
            .channel_agent_session_id()
            .ok_or_else(invalid_authority)?
            .as_str()
            .to_owned();
        Ok(Self {
            tenant,
            tenant_id: context.tenant_id().to_owned(),
            contract_schema_version,
            interaction_id: context.interaction_id().as_str().to_owned(),
            campaign_id: context.campaign_id().as_str().to_owned(),
            campaign_contact_id: context.campaign_contact_id().as_str().to_owned(),
            call_attempt_id: context.call_attempt_id().as_str().to_owned(),
            call_id: context.call_id().map(|value| value.as_str().to_owned()),
            agent_release_id: context.agent_release_id().as_str().to_owned(),
            channel_agent_session_id,
            execution_generation,
        })
    }
}

fn validate_stored_authority(
    expected: &ActiveCallEventAuthority,
    row: &Row,
) -> Result<(), PostgresActiveCallEventStoreError> {
    let matches = row.try_get::<_, i16>("contract_schema_version").ok()
        == Some(expected.contract_schema_version)
        && row.try_get::<_, String>("campaign_id").ok().as_deref()
            == Some(expected.campaign_id.as_str())
        && row
            .try_get::<_, String>("campaign_contact_id")
            .ok()
            .as_deref()
            == Some(expected.campaign_contact_id.as_str())
        && row.try_get::<_, String>("call_attempt_id").ok().as_deref()
            == Some(expected.call_attempt_id.as_str())
        && row.try_get::<_, Option<String>>("call_id").ok().as_ref() == Some(&expected.call_id)
        && row.try_get::<_, String>("agent_release_id").ok().as_deref()
            == Some(expected.agent_release_id.as_str())
        && row
            .try_get::<_, String>("channel_agent_session_id")
            .ok()
            .as_deref()
            == Some(expected.channel_agent_session_id.as_str());
    if matches {
        Ok(())
    } else {
        Err(invalid_authority())
    }
}

fn decode_media_binding(
    authority: &ActiveCallEventAuthority,
    row: &Row,
) -> Result<Option<PostgresActiveCallMediaBinding>, PostgresActiveCallEventStoreError> {
    validate_stored_authority(authority, row)?;
    let customer_track_id: Option<String> = row
        .try_get("customer_track_id")
        .map_err(|_| invalid_snapshot())?;
    let call_started_at_ms: Option<i64> = row
        .try_get("call_started_at_ms")
        .map_err(|_| invalid_snapshot())?;
    let language: Option<String> = row.try_get("language").map_err(|_| invalid_snapshot())?;
    let retention_policy_ref: Option<String> = row
        .try_get("retention_policy_ref")
        .map_err(|_| invalid_snapshot())?;
    match (
        customer_track_id,
        call_started_at_ms,
        language,
        retention_policy_ref,
    ) {
        (None, None, None, None) => Ok(None),
        (Some(track), Some(started), Some(language), Some(retention))
            if valid_track_id(&track)
                && (1..=9_007_199_254_740_991).contains(&started)
                && valid_language(&language)
                && valid_retention_reference(&retention) =>
        {
            Ok(Some(PostgresActiveCallMediaBinding {
                customer_track_id: track.into(),
                call_started_at_ms: u64::try_from(started).map_err(|_| invalid_snapshot())?,
                language: language.into(),
                retention_policy_ref: retention.into(),
            }))
        }
        _ => Err(invalid_snapshot()),
    }
}

fn decode_snapshot(
    session: &Row,
    pending_rows: &[Row],
) -> Result<PostgresActiveCallEventSnapshot, PostgresActiveCallEventStoreError> {
    let status = match session
        .try_get::<_, String>("status")
        .map_err(|_| invalid_snapshot())?
        .as_str()
    {
        "active" => PostgresActiveCallEventStatus::Active,
        "completed" => PostgresActiveCallEventStatus::Completed,
        "reconcile_required" => PostgresActiveCallEventStatus::ReconcileRequired,
        _ => return Err(invalid_snapshot()),
    };
    let reconcile_reason = match session
        .try_get::<_, Option<String>>("reconcile_reason")
        .map_err(|_| invalid_snapshot())?
        .as_deref()
    {
        None => None,
        Some("coverage_gap") => Some(PostgresActiveCallEventReconcileReason::CoverageGap),
        Some("session_disappeared") => {
            Some(PostgresActiveCallEventReconcileReason::SessionDisappeared)
        }
        Some("invalid_event") => Some(PostgresActiveCallEventReconcileReason::InvalidEvent),
        Some(_) => return Err(invalid_snapshot()),
    };
    let last_received_cursor = nonnegative_cursor(
        session
            .try_get("last_received_cursor")
            .map_err(|_| invalid_snapshot())?,
    )?;
    let last_applied_cursor = nonnegative_cursor(
        session
            .try_get("last_applied_cursor")
            .map_err(|_| invalid_snapshot())?,
    )?;
    let terminal_cursor = session
        .try_get::<_, Option<i64>>("terminal_cursor")
        .map_err(|_| invalid_snapshot())?
        .map(|value| positive_cursor_i64(value).and_then(nonnegative_cursor))
        .transpose()?;
    let pending = pending_rows
        .iter()
        .map(decode_event)
        .collect::<Result<Vec<_>, _>>()?;
    validate_snapshot(
        status,
        last_received_cursor,
        last_applied_cursor,
        terminal_cursor,
        reconcile_reason,
        &pending,
    )?;
    Ok(PostgresActiveCallEventSnapshot {
        status,
        last_received_cursor,
        last_applied_cursor,
        terminal_cursor,
        reconcile_reason,
        pending: pending.into(),
    })
}

fn decode_event(
    row: &Row,
) -> Result<PostgresStoredActiveCallEvent, PostgresActiveCallEventStoreError> {
    let cursor = nonnegative_cursor(positive_cursor_i64(
        row.try_get("event_cursor")
            .map_err(|_| invalid_snapshot())?,
    )?)?;
    let payload_digest: String = row
        .try_get("payload_digest")
        .map_err(|_| invalid_snapshot())?;
    let payload: String = row
        .try_get("event_payload")
        .map_err(|_| invalid_snapshot())?;
    validate_event(cursor, &payload_digest, &payload)?;
    Ok(PostgresStoredActiveCallEvent {
        cursor,
        payload_digest: payload_digest.into(),
        payload: payload.into(),
        terminal: row.try_get("terminal").map_err(|_| invalid_snapshot())?,
    })
}

fn validate_snapshot(
    status: PostgresActiveCallEventStatus,
    last_received: u64,
    last_applied: u64,
    terminal_cursor: Option<u64>,
    reconcile_reason: Option<PostgresActiveCallEventReconcileReason>,
    pending: &[PostgresStoredActiveCallEvent],
) -> Result<(), PostgresActiveCallEventStoreError> {
    let pending_count = last_received
        .checked_sub(last_applied)
        .ok_or_else(invalid_snapshot)?;
    if pending.len() > MAX_PENDING_EVENTS
        || usize::try_from(pending_count).ok() != Some(pending.len())
        || pending.iter().enumerate().any(|(index, event)| {
            event.cursor
                != last_applied.saturating_add(u64::try_from(index).unwrap_or(u64::MAX) + 1)
        })
    {
        return Err(invalid_snapshot());
    }
    let terminal_evidence_valid = match terminal_cursor {
        None => pending.iter().all(|event| !event.terminal),
        Some(terminal) => {
            terminal == last_received
                && terminal > last_applied
                && pending.iter().filter(|event| event.terminal).count() == 1
                && pending.last().is_some_and(|event| event.terminal)
        }
    };
    let lifecycle_valid = match status {
        PostgresActiveCallEventStatus::Active => {
            reconcile_reason.is_none() && terminal_evidence_valid
        }
        PostgresActiveCallEventStatus::Completed => {
            reconcile_reason.is_none()
                && terminal_cursor == Some(last_received)
                && last_received == last_applied
                && pending.is_empty()
        }
        PostgresActiveCallEventStatus::ReconcileRequired => {
            reconcile_reason.is_some() && terminal_evidence_valid
        }
    };
    if lifecycle_valid {
        Ok(())
    } else {
        Err(invalid_snapshot())
    }
}

fn validate_event(
    cursor: u64,
    payload_digest: &str,
    payload: &str,
) -> Result<(), PostgresActiveCallEventStoreError> {
    positive_cursor(cursor)?;
    if payload.is_empty() || payload.len() > MAX_EVENT_BYTES || !lowercase_sha256(payload_digest) {
        return Err(invalid_input());
    }
    let value: serde_json::Value = serde_json::from_str(payload).map_err(|_| invalid_input())?;
    if !value.is_object()
        || canonical_sha256(&value).map_err(|_| invalid_input())? != payload_digest
    {
        return Err(invalid_input());
    }
    Ok(())
}

fn lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_track_id(value: &str) -> bool {
    bounded_token(value, 255, b"._:-")
}

fn valid_language(value: &str) -> bool {
    bounded_token(value, 35, b"_-") && value.len() >= 2
}

fn valid_retention_reference(value: &str) -> bool {
    bounded_token(value, 255, b"._:/-")
}

fn bounded_token(value: &str, maximum: usize, punctuation: &[u8]) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= maximum
        && first.is_ascii_alphanumeric()
        && remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || punctuation.contains(byte))
}

fn durable_cursor(value: u64) -> Result<i64, PostgresActiveCallEventStoreError> {
    i64::try_from(value).map_err(|_| invalid_input())
}

fn positive_cursor(value: u64) -> Result<i64, PostgresActiveCallEventStoreError> {
    if value == 0 {
        return Err(invalid_input());
    }
    durable_cursor(value)
}

fn positive_cursor_i64(value: i64) -> Result<i64, PostgresActiveCallEventStoreError> {
    if value > 0 {
        Ok(value)
    } else {
        Err(invalid_snapshot())
    }
}

fn nonnegative_cursor(value: i64) -> Result<u64, PostgresActiveCallEventStoreError> {
    u64::try_from(value).map_err(|_| invalid_snapshot())
}

fn invalid_input() -> PostgresActiveCallEventStoreError {
    PostgresActiveCallEventStoreError {
        code: "active_call_event_store_input_invalid",
    }
}

fn invalid_authority() -> PostgresActiveCallEventStoreError {
    PostgresActiveCallEventStoreError {
        code: "active_call_event_store_authority_invalid",
    }
}

fn invalid_snapshot() -> PostgresActiveCallEventStoreError {
    PostgresActiveCallEventStoreError {
        code: "active_call_event_store_snapshot_invalid",
    }
}

fn unavailable() -> PostgresActiveCallEventStoreError {
    PostgresActiveCallEventStoreError {
        code: "active_call_event_store_unavailable",
    }
}

#[allow(clippy::needless_pass_by_value)]
fn map_transaction_error(
    error: TransactionError<PostgresActiveCallEventStoreError>,
) -> PostgresActiveCallEventStoreError {
    match error {
        TransactionError::Work(error) => error,
        TransactionError::AdmissionRejected => PostgresActiveCallEventStoreError {
            code: "active_call_event_store_admission_rejected",
        },
        TransactionError::PoolUnavailable
        | TransactionError::DatabaseUnavailable
        | TransactionError::DeadlineExceeded
        | TransactionError::RollbackUnknown
        | TransactionError::CommitUnknown => unavailable(),
    }
}
