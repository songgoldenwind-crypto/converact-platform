//! Writer-fenced platform event persistence boundary.

use std::{error::Error, fmt, time::Duration};

use converact_event_log::{
    InboxWriteDecision, PlatformEvent, PlatformInboxState, decide_inbox_write,
};
use converact_idempotency::{
    EffectReceipt, EffectReceiptAppendDecision, EffectReceiptStage, decide_effect_receipt_append,
};
use converact_migration_routing::MutationScope;
use converact_migration_store::WriterFenceBinding;
use deadpool_postgres::tokio_postgres::{
    Row,
    error::{DbError, SqlState},
    types::ToSql,
};
use serde_json::json;

use super::{PostgresRuntime, TransactionError};

const MIN_DELIVERY_LEASE: Duration = Duration::from_secs(1);
const MAX_DELIVERY_LEASE: Duration = Duration::from_secs(900);
const MAX_RETRY_DELAY: Duration = Duration::from_secs(86_400);
const MAX_ATTEMPTS: u16 = 1_000;
const MAX_BATCH: u16 = 200;
pub(super) const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

const INBOX_LOCK_SQL: &str = concat!(
    "SELECT pg_advisory_xact_lock(hashtextextended(",
    "concat_ws(E'\\x1f', $1::text, $2::text, $3::text), 0))"
);
const INBOX_EXACT_SQL: &str = concat!(
    "SELECT payload_digest, aggregate_revision, event_id, ordering_key ",
    "FROM converact_platform_inbox WHERE tenant_id = $1 AND consumer_id = $2 ",
    "AND event_id = $3"
);
const INBOX_LATEST_SQL: &str = concat!(
    "SELECT payload_digest, aggregate_revision, event_id, ordering_key ",
    "FROM converact_platform_inbox WHERE tenant_id = $1 AND consumer_id = $2 ",
    "AND ordering_key = $3 ORDER BY aggregate_revision DESC, received_at DESC, ",
    "event_id DESC LIMIT 1"
);
const INBOX_APPEND_SQL: &str = concat!(
    "SELECT inserted_event_id FROM converact_platform_inbox_append(",
    "$1, $2, $3, $4::text::numeric, $5::text::numeric, $6, $7, ",
    "$8::text::numeric, $9, $10, $11, $12, $13, $14::text::timestamptz)"
);
const EFFECT_LOCK_SQL: &str = concat!(
    "SELECT pg_advisory_xact_lock(hashtextextended(",
    "concat_ws(E'\\x1f', 'platform-effect-receipt', $1::text, $2::text), 0))"
);
const EFFECT_CURRENT_SQL: &str = r#"
SELECT receipt_id, tenant_id, effect_id, event_id, correlation_id, stage,
       generation, writer_id, owner_epoch, receipt_digest,
       to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at,
       route_authority_kind, route_partition_key, route_generation::text,
       route_owner_epoch::text, route_object_scope,
       route_object_starting_generation::text
FROM converact_platform_effect_receipts
WHERE tenant_id = $1 AND effect_id = $2
  AND generation = (
    SELECT MAX(generation) FROM converact_platform_effect_receipts
    WHERE tenant_id = $1 AND effect_id = $2
  )
ORDER BY CASE stage WHEN 'accepted' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END
LIMIT 3
"#;
const EFFECT_EXACT_SQL: &str = concat!(
    "SELECT receipt_id, tenant_id, effect_id, event_id, correlation_id, stage, ",
    "generation, writer_id, owner_epoch, receipt_digest, ",
    "to_char(observed_at AT TIME ZONE 'UTC', ",
    "'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS observed_at, ",
    "route_authority_kind, route_partition_key, route_generation::text, ",
    "route_owner_epoch::text, route_object_scope, ",
    "route_object_starting_generation::text ",
    "FROM converact_platform_effect_receipts WHERE tenant_id = $1 ",
    "AND effect_id = $2 AND stage = $3 AND generation = $4"
);
const WRITER_FENCE_SQL: &str = concat!(
    "SELECT converact_platform_writer_fence(",
    "$1, $2, $3, $4::text::numeric, $5::text::numeric, $6, $7, ",
    "$8::text::numeric)"
);
const EFFECT_APPEND_SQL: &str = concat!(
    "SELECT inserted_receipt_id FROM converact_platform_effect_append(",
    "$1, $2, $3, $4::text::numeric, $5::text::numeric, $6, $7, ",
    "$8::text::numeric, $9, $10, $11, $12, $13, $14, $15, $16, $17, ",
    "$18::text::timestamptz)"
);

/// Opaque one-claim delivery capability. Only its SHA-256 digest is persisted.
pub struct DeliveryLeaseToken(Box<str>);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DeliveryLeaseTokenError;

impl fmt::Display for DeliveryLeaseTokenError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("platform_delivery_lease_token_invalid")
    }
}

impl Error for DeliveryLeaseTokenError {}

impl fmt::Debug for DeliveryLeaseToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("DeliveryLeaseToken([REDACTED])")
    }
}

impl DeliveryLeaseToken {
    /// Parses exactly 32 bytes encoded as lowercase hexadecimal.
    ///
    /// # Errors
    ///
    /// Returns a value-free error for a malformed capability.
    pub fn parse(value: &str) -> Result<Self, DeliveryLeaseTokenError> {
        if value.len() != 64
            || !value
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        {
            return Err(DeliveryLeaseTokenError);
        }
        Ok(Self(value.into()))
    }

    pub(crate) fn as_secret(&self) -> &str {
        &self.0
    }
}

/// Closed operational bounds for one event Store instance.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PlatformStorePolicy {
    delivery_lease: Duration,
    retry_delay: Duration,
    max_attempts: u16,
    claim_batch_limit: u16,
}

/// Stable domain-store failure without SQL, topology or input values.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PlatformStoreError {
    InvalidInput,
    StaleWriter,
    Conflict,
    GapRequiresReconcile,
    InvalidTransition,
    StoreInvalid,
    DatabaseRejected,
}

impl fmt::Display for PlatformStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "platform_store_input_invalid",
            Self::StaleWriter => "platform_store_writer_stale",
            Self::Conflict => "platform_store_conflict",
            Self::GapRequiresReconcile => "platform_store_gap_requires_reconcile",
            Self::InvalidTransition => "platform_store_transition_invalid",
            Self::StoreInvalid => "platform_store_data_invalid",
            Self::DatabaseRejected => "platform_store_database_rejected",
        })
    }
}

impl Error for PlatformStoreError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InboxAppendStatus {
    Inserted,
    Replay,
    Stale,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EffectAppendStatus {
    Inserted,
    Replay,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PlatformStorePolicyError {
    InvalidLease,
    InvalidRetry,
    InvalidAttempts,
    InvalidBatch,
}

impl fmt::Display for PlatformStorePolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidLease => "platform_delivery_lease_invalid",
            Self::InvalidRetry => "platform_retry_delay_invalid",
            Self::InvalidAttempts => "platform_max_attempts_invalid",
            Self::InvalidBatch => "platform_claim_batch_invalid",
        })
    }
}

impl Error for PlatformStorePolicyError {}

impl PlatformStorePolicy {
    /// Validates database-clock delivery and retry limits.
    ///
    /// # Errors
    ///
    /// Returns a stable field-specific error for zero, sub-millisecond or
    /// over-policy values.
    pub fn new(
        delivery_lease: Duration,
        retry_delay: Duration,
        max_attempts: u16,
        claim_batch_limit: u16,
    ) -> Result<Self, PlatformStorePolicyError> {
        if delivery_lease < MIN_DELIVERY_LEASE
            || delivery_lease > MAX_DELIVERY_LEASE
            || !whole_milliseconds(delivery_lease)
        {
            return Err(PlatformStorePolicyError::InvalidLease);
        }
        if retry_delay > MAX_RETRY_DELAY || !whole_milliseconds(retry_delay) {
            return Err(PlatformStorePolicyError::InvalidRetry);
        }
        if !(1..=MAX_ATTEMPTS).contains(&max_attempts) {
            return Err(PlatformStorePolicyError::InvalidAttempts);
        }
        if !(1..=MAX_BATCH).contains(&claim_batch_limit) {
            return Err(PlatformStorePolicyError::InvalidBatch);
        }
        Ok(Self {
            delivery_lease,
            retry_delay,
            max_attempts,
            claim_batch_limit,
        })
    }

    #[must_use]
    pub const fn delivery_lease(self) -> Duration {
        self.delivery_lease
    }

    #[must_use]
    pub const fn retry_delay(self) -> Duration {
        self.retry_delay
    }

    #[must_use]
    pub const fn max_attempts(self) -> u16 {
        self.max_attempts
    }

    #[must_use]
    pub const fn claim_batch_limit(self) -> u16 {
        self.claim_batch_limit
    }
}

impl PostgresRuntime {
    /// Appends one immutable consumer receipt under the exact route writer
    /// fence. Duplicate, stale and gap decisions replay the frozen domain
    /// contract inside one tenant transaction.
    ///
    /// # Errors
    ///
    /// Returns a stable transaction/store error for malformed identity,
    /// stale route ownership, unavailable storage or invalid persisted data.
    pub async fn append_platform_inbox(
        &self,
        fence: &WriterFenceBinding<'_>,
        consumer_id: &str,
        event: &PlatformEvent,
    ) -> Result<InboxAppendStatus, TransactionError<PlatformStoreError>> {
        let values = FenceValues::new(fence).map_err(TransactionError::Work)?;
        if !bounded_identifier(consumer_id) || event.tenant_id() != values.tenant {
            return Err(TransactionError::Work(PlatformStoreError::InvalidInput));
        }
        let tenant_id = fence.route_key().tenant_id().clone();
        let consumer_id = consumer_id.to_owned();
        let event = event.clone();
        self.with_tenant_transaction(&tenant_id, move |transaction| {
            Box::pin(async move {
                append_inbox_in_transaction(transaction, &values, &consumer_id, &event).await
            })
        })
        .await
    }

    /// Appends one effect lifecycle receipt. Accepted receipts atomically
    /// claim nonterminal generation work; state-observed receipts atomically
    /// release it. Receipt generation never authorizes the route write.
    ///
    /// # Errors
    ///
    /// Returns a stable transaction/store error for an invalid lifecycle,
    /// stale route ownership, unavailable storage or invalid persisted data.
    pub async fn append_platform_effect_receipt(
        &self,
        fence: &WriterFenceBinding<'_>,
        receipt: &EffectReceipt,
    ) -> Result<EffectAppendStatus, TransactionError<PlatformStoreError>> {
        let values = FenceValues::new(fence).map_err(TransactionError::Work)?;
        if receipt.tenant_id() != values.tenant {
            return Err(TransactionError::Work(PlatformStoreError::InvalidInput));
        }
        if receipt.stage() != EffectReceiptStage::Accepted
            && !matches!(fence.scope(), MutationScope::ExistingObject { .. })
        {
            return Err(TransactionError::Work(PlatformStoreError::InvalidInput));
        }
        let tenant_id = fence.route_key().tenant_id().clone();
        let receipt = receipt.clone();
        self.with_tenant_transaction(&tenant_id, move |transaction| {
            Box::pin(
                async move { append_effect_in_transaction(transaction, &values, &receipt).await },
            )
        })
        .await
    }
}

pub(super) struct FenceValues {
    pub(super) tenant: String,
    pub(super) authority_kind: String,
    pub(super) partition_key: String,
    pub(super) generation: String,
    pub(super) owner_epoch: String,
    pub(super) lease_token: String,
    pub(super) object_scope: &'static str,
    pub(super) starting_generation: Option<String>,
}

impl FenceValues {
    pub(super) fn new(binding: &WriterFenceBinding<'_>) -> Result<Self, PlatformStoreError> {
        let (object_scope, starting_generation) = match binding.scope() {
            MutationScope::NewObject => ("new", None),
            MutationScope::ExistingObject {
                starting_generation,
            } if starting_generation == binding.generation() => {
                ("existing", Some(starting_generation.get().to_string()))
            }
            MutationScope::ExistingObject { .. } => return Err(PlatformStoreError::InvalidInput),
        };
        Ok(Self {
            tenant: binding.route_key().tenant_id().as_str().to_owned(),
            authority_kind: binding.route_key().authority_kind().as_str().to_owned(),
            partition_key: binding.route_key().partition_key().as_str().to_owned(),
            generation: binding.generation().get().to_string(),
            owner_epoch: binding.owner_epoch().get().to_string(),
            lease_token: binding.lease_token().as_secret().to_owned(),
            object_scope,
            starting_generation,
        })
    }

    pub(super) fn sql_params(&self) -> [&(dyn ToSql + Sync); 8] {
        [
            &self.tenant,
            &self.authority_kind,
            &self.partition_key,
            &self.generation,
            &self.owner_epoch,
            &self.lease_token,
            &self.object_scope,
            &self.starting_generation,
        ]
    }
}

async fn append_inbox_in_transaction(
    transaction: &deadpool_postgres::Transaction<'_>,
    fence: &FenceValues,
    consumer_id: &str,
    event: &PlatformEvent,
) -> Result<InboxAppendStatus, PlatformStoreError> {
    transaction
        .query_one(
            INBOX_LOCK_SQL,
            &[&fence.tenant, &consumer_id, &event.ordering_key()],
        )
        .await
        .map_err(map_database_error)?;
    let exact = transaction
        .query(
            INBOX_EXACT_SQL,
            &[&fence.tenant, &consumer_id, &event.event_id()],
        )
        .await
        .map_err(map_database_error)?;
    if exact.len() > 1 {
        return Err(PlatformStoreError::StoreInvalid);
    }
    if let Some(row) = exact.first() {
        return match decide_inbox_write(Some(&decode_inbox_state(row)?), event) {
            InboxWriteDecision::Replay => {
                execute_writer_fence(transaction, fence).await?;
                Ok(InboxAppendStatus::Replay)
            }
            _ => Err(PlatformStoreError::Conflict),
        };
    }

    let latest = transaction
        .query(
            INBOX_LATEST_SQL,
            &[&fence.tenant, &consumer_id, &event.ordering_key()],
        )
        .await
        .map_err(map_database_error)?;
    if latest.len() > 1 {
        return Err(PlatformStoreError::StoreInvalid);
    }
    let decision = decide_inbox_write(
        latest.first().map(decode_inbox_state).transpose()?.as_ref(),
        event,
    );
    match decision {
        InboxWriteDecision::Conflict => return Err(PlatformStoreError::Conflict),
        InboxWriteDecision::GapRequiresReconcile => {
            return Err(PlatformStoreError::GapRequiresReconcile);
        }
        InboxWriteDecision::Replay => {
            execute_writer_fence(transaction, fence).await?;
            return Ok(InboxAppendStatus::Replay);
        }
        InboxWriteDecision::Insert | InboxWriteDecision::Stale => {}
    }

    let event_id = event.event_id();
    let payload_digest = event.payload_digest();
    let ordering_key = event.ordering_key();
    let observed_at = event.observed_at();
    let mut params = fence.sql_params().to_vec();
    let aggregate_revision =
        i64::try_from(event.aggregate_revision()).map_err(|_| PlatformStoreError::InvalidInput)?;
    params.extend([
        &consumer_id as &(dyn ToSql + Sync),
        &event_id,
        &payload_digest,
        &aggregate_revision,
        &ordering_key,
        &observed_at,
    ]);
    let inserted = transaction
        .query(INBOX_APPEND_SQL, &params)
        .await
        .map_err(map_database_error)?;
    if inserted.len() > 1 {
        return Err(PlatformStoreError::StoreInvalid);
    }
    if inserted.len() == 1 {
        return Ok(if decision == InboxWriteDecision::Stale {
            InboxAppendStatus::Stale
        } else {
            InboxAppendStatus::Inserted
        });
    }
    let replay = transaction
        .query(
            INBOX_EXACT_SQL,
            &[&fence.tenant, &consumer_id, &event.event_id()],
        )
        .await
        .map_err(map_database_error)?;
    if replay.len() != 1
        || decide_inbox_write(Some(&decode_inbox_state(&replay[0])?), event)
            != InboxWriteDecision::Replay
    {
        return Err(PlatformStoreError::Conflict);
    }
    Ok(InboxAppendStatus::Replay)
}

async fn append_effect_in_transaction(
    transaction: &deadpool_postgres::Transaction<'_>,
    fence: &FenceValues,
    receipt: &EffectReceipt,
) -> Result<EffectAppendStatus, PlatformStoreError> {
    transaction
        .query_one(EFFECT_LOCK_SQL, &[&fence.tenant, &receipt.effect_id()])
        .await
        .map_err(map_database_error)?;
    let current = transaction
        .query(EFFECT_CURRENT_SQL, &[&fence.tenant, &receipt.effect_id()])
        .await
        .map_err(map_database_error)?;
    if current.len() > 3 {
        return Err(PlatformStoreError::StoreInvalid);
    }
    let history: Vec<_> = current
        .iter()
        .map(|row| {
            validate_row_fence(row, fence)?;
            decode_effect_receipt(row)
        })
        .collect::<Result<_, _>>()?;
    match decide_effect_receipt_append(&history, receipt) {
        EffectReceiptAppendDecision::Replay => {
            execute_writer_fence(transaction, fence).await?;
            return Ok(EffectAppendStatus::Replay);
        }
        EffectReceiptAppendDecision::Append => {}
        EffectReceiptAppendDecision::StaleWriter => {
            return Err(PlatformStoreError::StaleWriter);
        }
        EffectReceiptAppendDecision::Conflict => return Err(PlatformStoreError::Conflict),
        EffectReceiptAppendDecision::InvalidTransition => {
            return Err(PlatformStoreError::InvalidTransition);
        }
    }

    let effect_generation =
        i64::try_from(receipt.generation()).map_err(|_| PlatformStoreError::InvalidInput)?;
    let effect_owner_epoch =
        i64::try_from(receipt.owner_epoch()).map_err(|_| PlatformStoreError::InvalidInput)?;
    let receipt_id = receipt.receipt_id();
    let effect_id = receipt.effect_id();
    let event_id = receipt.event_id();
    let correlation_id = receipt.correlation_id();
    let stage = receipt.stage().as_str();
    let writer_id = receipt.writer_id();
    let receipt_digest = receipt.receipt_digest();
    let observed_at = receipt.observed_at();
    let mut params = fence.sql_params().to_vec();
    params.extend([
        &receipt_id as &(dyn ToSql + Sync),
        &effect_id,
        &event_id,
        &correlation_id,
        &stage,
        &effect_generation,
        &writer_id,
        &effect_owner_epoch,
        &receipt_digest,
        &observed_at,
    ]);
    let inserted = transaction
        .query(EFFECT_APPEND_SQL, &params)
        .await
        .map_err(map_database_error)?;
    if inserted.len() > 1 {
        return Err(PlatformStoreError::StoreInvalid);
    }
    if inserted.len() == 1 {
        return Ok(EffectAppendStatus::Inserted);
    }
    let exact = transaction
        .query(
            EFFECT_EXACT_SQL,
            &[
                &fence.tenant,
                &receipt.effect_id(),
                &receipt.stage().as_str(),
                &effect_generation,
            ],
        )
        .await
        .map_err(map_database_error)?;
    if exact.len() != 1 {
        return Err(PlatformStoreError::Conflict);
    }
    validate_row_fence(&exact[0], fence)?;
    if decode_effect_receipt(&exact[0])? != *receipt {
        return Err(PlatformStoreError::Conflict);
    }
    Ok(EffectAppendStatus::Replay)
}

async fn execute_writer_fence(
    transaction: &deadpool_postgres::Transaction<'_>,
    fence: &FenceValues,
) -> Result<(), PlatformStoreError> {
    transaction
        .query_one(WRITER_FENCE_SQL, &fence.sql_params())
        .await
        .map(|_| ())
        .map_err(map_database_error)
}

fn decode_inbox_state(row: &Row) -> Result<PlatformInboxState, PlatformStoreError> {
    let revision = safe_i64(row, "aggregate_revision")?;
    PlatformInboxState::try_from(&json!({
        "payload_digest": text(row, "payload_digest")?,
        "aggregate_revision": revision,
        "event_id": text(row, "event_id")?,
        "ordering_key": text(row, "ordering_key")?
    }))
    .map_err(|_| PlatformStoreError::StoreInvalid)
}

fn decode_effect_receipt(row: &Row) -> Result<EffectReceipt, PlatformStoreError> {
    let generation = safe_i64(row, "generation")?;
    let owner_epoch = safe_i64(row, "owner_epoch")?;
    EffectReceipt::try_from(&json!({
        "receipt_id": text(row, "receipt_id")?,
        "tenant_id": text(row, "tenant_id")?,
        "effect_id": text(row, "effect_id")?,
        "event_id": text(row, "event_id")?,
        "correlation_id": text(row, "correlation_id")?,
        "stage": text(row, "stage")?,
        "generation": generation,
        "writer_id": text(row, "writer_id")?,
        "owner_epoch": owner_epoch,
        "receipt_digest": text(row, "receipt_digest")?,
        "observed_at": text(row, "observed_at")?
    }))
    .map_err(|_| PlatformStoreError::StoreInvalid)
}

fn validate_row_fence(row: &Row, fence: &FenceValues) -> Result<(), PlatformStoreError> {
    let starting = optional_text(row, "route_object_starting_generation")?;
    if text(row, "route_authority_kind")? != fence.authority_kind
        || text(row, "route_partition_key")? != fence.partition_key
        || text(row, "route_generation")? != fence.generation
        || text(row, "route_owner_epoch")? != fence.owner_epoch
        || text(row, "route_object_scope")? != fence.object_scope
        || starting.as_deref() != fence.starting_generation.as_deref()
    {
        return Err(PlatformStoreError::StoreInvalid);
    }
    Ok(())
}

pub(super) fn text(row: &Row, field: &str) -> Result<String, PlatformStoreError> {
    row.try_get(field)
        .map_err(|_| PlatformStoreError::StoreInvalid)
}

pub(super) fn optional_text(row: &Row, field: &str) -> Result<Option<String>, PlatformStoreError> {
    row.try_get(field)
        .map_err(|_| PlatformStoreError::StoreInvalid)
}

pub(super) fn safe_i64(row: &Row, field: &str) -> Result<i64, PlatformStoreError> {
    let value: i64 = row
        .try_get(field)
        .map_err(|_| PlatformStoreError::StoreInvalid)?;
    if value < 0
        || u64::try_from(value)
            .ok()
            .is_none_or(|value| value > MAX_SAFE_INTEGER)
    {
        return Err(PlatformStoreError::StoreInvalid);
    }
    Ok(value)
}

pub(super) fn bounded_identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.split_first().is_some_and(|(first, rest)| {
        first.is_ascii_alphanumeric()
            && rest.iter().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
            })
    }) && bytes.len() <= 255
}

#[allow(
    clippy::needless_pass_by_value,
    reason = "used directly as the map_err callback at every database await boundary"
)]
pub(super) fn map_database_error(
    error: deadpool_postgres::tokio_postgres::Error,
) -> PlatformStoreError {
    error.as_db_error().map_or(
        PlatformStoreError::DatabaseRejected,
        classify_database_error,
    )
}

fn classify_database_error(error: &DbError) -> PlatformStoreError {
    if error.code() == &SqlState::UNIQUE_VIOLATION {
        return PlatformStoreError::Conflict;
    }
    match error.message() {
        "authority writer tenant fence rejected"
        | "authority writer fence is stale"
        | "authority writer generation is not authorized"
        | "authority generation claim tenant fence rejected"
        | "authority generation claim route is missing"
        | "authority generation claim target is missing"
        | "authority generation release tenant fence rejected"
        | "authority generation release route is missing"
        | "authority generation release target is missing" => PlatformStoreError::StaleWriter,
        "platform outbox transition target is stale"
        | "platform outbox transition shape is invalid" => PlatformStoreError::InvalidTransition,
        _ => PlatformStoreError::DatabaseRejected,
    }
}

fn whole_milliseconds(value: Duration) -> bool {
    value.subsec_nanos().is_multiple_of(1_000_000)
}
