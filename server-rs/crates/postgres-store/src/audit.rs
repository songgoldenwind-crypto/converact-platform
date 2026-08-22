//! Default-disabled, writer-fenced audit persistence boundary.

use std::{error::Error, fmt};

use converact_audit::{
    AuditAppendDecision, AuditAppendInput, AuditEvent, audit_event_hash, decide_audit_append,
};
use converact_contracts::{format_canonical_timestamp_ms, parse_canonical_timestamp_ms};
use converact_kernel_ids::TenantId;
use converact_migration_routing::MutationScope;
use converact_migration_store::WriterFenceBinding;
use deadpool_postgres::tokio_postgres::{
    Row,
    error::{DbError, SqlState},
    types::ToSql,
};
use serde_json::{Value, json};

use super::{
    PostgresRuntime, TransactionError,
    platform_event::{FenceValues, bounded_identifier},
};

const AUDIT_AUTHORITY_KIND: &str = "audit";
const AUDIT_PARTITION_KEY: &str = "tenant-chain";
const AUDIT_LOCK_SQL: &str = "SELECT pg_advisory_xact_lock(hashtextextended($1, 947113))";
const AUDIT_FENCE_SQL: &str = concat!(
    "SELECT converact_audit_writer_fence(",
    "$1, $2, $3, $4::text::numeric, $5::text::numeric, $6, $7, ",
    "$8::text::numeric)"
);
const AUDIT_HEAD_SQL: &str = concat!(
    "SELECT previous_hash FROM converact_audit_chain_head(",
    "$1, $2, $3, $4::text::numeric, $5::text::numeric, $6, $7, ",
    "$8::text::numeric)"
);
const AUDIT_EXACT_SQL: &str = r"
SELECT id, tenant_id, actor_id, actor_role, action, resource_type, resource_id,
       business_ref_type, business_ref_id, request_id, idempotency_key, result,
       policy_decision, source_ip_hmac, metadata,
       trunc(extract(epoch FROM occurred_at) * 1000)::numeric(20, 0)::text
         AS occurred_at_ms,
       CASE WHEN retention_until IS NULL THEN NULL ELSE
         trunc(extract(epoch FROM retention_until) * 1000)::numeric(20, 0)::text
         END AS retention_until_ms,
       legal_hold, previous_hash, event_hash,
       trunc(extract(epoch FROM created_at) * 1000)::numeric(20, 0)::text
         AS created_at_ms
FROM ivekit_audit_events
WHERE tenant_id = $1 AND idempotency_key = $2
";
const AUDIT_ID_SQL: &str = r"
SELECT id, tenant_id, actor_id, actor_role, action, resource_type, resource_id,
       business_ref_type, business_ref_id, request_id, idempotency_key, result,
       policy_decision, source_ip_hmac, metadata,
       trunc(extract(epoch FROM occurred_at) * 1000)::numeric(20, 0)::text
         AS occurred_at_ms,
       CASE WHEN retention_until IS NULL THEN NULL ELSE
         trunc(extract(epoch FROM retention_until) * 1000)::numeric(20, 0)::text
         END AS retention_until_ms,
       legal_hold, previous_hash, event_hash,
       trunc(extract(epoch FROM created_at) * 1000)::numeric(20, 0)::text
         AS created_at_ms
FROM ivekit_audit_events
WHERE tenant_id = $1 AND id = $2
";
const AUDIT_APPEND_SQL: &str = concat!(
    "SELECT inserted_event_id FROM converact_audit_event_append(",
    "$1, $2, $3, $4::text::numeric, $5::text::numeric, $6, $7, ",
    "$8::text::numeric, $9, $10, $11, $12, $13, $14, $15, $16, $17, ",
    "$18, $19, $20, $21, $22::jsonb, ",
    "timestamptz 'epoch' + $23::text::numeric * interval '1 millisecond', ",
    "CASE WHEN $24::text IS NULL THEN NULL ELSE timestamptz 'epoch' + ",
    "$24::text::numeric * interval '1 millisecond' END, $25, $26, $27)"
);

/// Closed result of one idempotent audit append.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuditAppendStatus {
    Inserted,
    Replay,
}

impl AuditAppendStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Inserted => "inserted",
            Self::Replay => "replay",
        }
    }
}

/// Stored event plus its append disposition.
#[derive(Clone, Debug, PartialEq)]
pub struct AuditAppendResult {
    event: AuditEvent,
    status: AuditAppendStatus,
}

impl AuditAppendResult {
    #[must_use]
    pub const fn event(&self) -> &AuditEvent {
        &self.event
    }

    #[must_use]
    pub const fn status(&self) -> AuditAppendStatus {
        self.status
    }

    #[must_use]
    pub fn into_event(self) -> AuditEvent {
        self.event
    }
}

/// Stable audit store failure without SQL, topology or domain values.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuditStoreError {
    InvalidInput,
    StaleWriter,
    Conflict,
    ChainTailStale,
    ChainUnqualified,
    ChainPositionExhausted,
    StoreInvalid,
    DatabaseRejected,
}

impl fmt::Display for AuditStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "audit_store_input_invalid",
            Self::StaleWriter => "audit_store_writer_stale",
            Self::Conflict => "audit_store_conflict",
            Self::ChainTailStale => "audit_store_chain_tail_stale",
            Self::ChainUnqualified => "audit_store_chain_unqualified",
            Self::ChainPositionExhausted => "audit_store_chain_position_exhausted",
            Self::StoreInvalid => "audit_store_data_invalid",
            Self::DatabaseRejected => "audit_store_database_rejected",
        })
    }
}

impl Error for AuditStoreError {}

pub type AuditStoreFailure = TransactionError<AuditStoreError>;

impl PostgresRuntime {
    /// Appends one immutable event under the exact tenant audit-chain writer
    /// fence. The adapter remains unreachable until a later runtime route and
    /// database role activation explicitly grants its fence, head and append
    /// domain functions.
    ///
    /// # Errors
    ///
    /// Returns a stable transaction/store failure for invalid route identity,
    /// stale ownership, idempotency conflict, corrupt data or unavailable
    /// storage. [`TransactionError::CommitUnknown`] requires query/reconcile.
    pub async fn append_audit_event(
        &self,
        fence: &WriterFenceBinding<'_>,
        audit_id: &str,
        input: &AuditAppendInput,
    ) -> Result<AuditAppendResult, AuditStoreFailure> {
        let values = audit_fence_values(fence, input)?;
        if !bounded_identifier(audit_id) {
            return Err(TransactionError::Work(AuditStoreError::InvalidInput));
        }
        let tenant_id = fence.route_key().tenant_id().clone();
        let audit_id = audit_id.to_owned();
        let input = input.clone();
        self.with_tenant_transaction(&tenant_id, move |transaction| {
            Box::pin(
                async move { append_in_transaction(transaction, &values, &audit_id, &input).await },
            )
        })
        .await
    }

    /// Queries the exact idempotency oracle after an ambiguous append commit.
    ///
    /// # Errors
    ///
    /// Returns a stable transaction/store failure for malformed identity,
    /// unavailable storage or an invalid durable row.
    pub async fn query_audit_event(
        &self,
        tenant_id: &TenantId,
        idempotency_key: &str,
    ) -> Result<Option<AuditEvent>, AuditStoreFailure> {
        if idempotency_key.is_empty() || idempotency_key.encode_utf16().count() > 255 {
            return Err(TransactionError::Work(AuditStoreError::InvalidInput));
        }
        let transaction_tenant = tenant_id.clone();
        let query_tenant = tenant_id.clone();
        let idempotency_key = idempotency_key.to_owned();
        self.with_tenant_transaction(&transaction_tenant, move |transaction| {
            Box::pin(async move {
                let rows = transaction
                    .query(AUDIT_EXACT_SQL, &[&query_tenant.as_str(), &idempotency_key])
                    .await
                    .map_err(map_audit_database_error)?;
                decode_optional_event(&rows)
            })
        })
        .await
    }
}

fn audit_fence_values(
    fence: &WriterFenceBinding<'_>,
    input: &AuditAppendInput,
) -> Result<FenceValues, AuditStoreFailure> {
    if fence.route_key().authority_kind().as_str() != AUDIT_AUTHORITY_KIND
        || fence.route_key().partition_key().as_str() != AUDIT_PARTITION_KEY
        || fence.route_key().tenant_id().as_str() != input.tenant_id()
        || !matches!(fence.scope(), MutationScope::NewObject)
    {
        return Err(TransactionError::Work(AuditStoreError::InvalidInput));
    }
    FenceValues::new(fence).map_err(|_| TransactionError::Work(AuditStoreError::InvalidInput))
}

async fn append_in_transaction(
    transaction: &deadpool_postgres::Transaction<'_>,
    fence: &FenceValues,
    audit_id: &str,
    input: &AuditAppendInput,
) -> Result<AuditAppendResult, AuditStoreError> {
    transaction
        .query_one(AUDIT_LOCK_SQL, &[&fence.tenant])
        .await
        .map_err(map_audit_database_error)?;

    let existing = transaction
        .query(AUDIT_EXACT_SQL, &[&fence.tenant, &input.idempotency_key()])
        .await
        .map_err(map_audit_database_error)?;
    if let Some(event) = decode_optional_event(&existing)? {
        return match decide_audit_append(Some(&event), input) {
            AuditAppendDecision::Replay => {
                execute_audit_fence(transaction, fence).await?;
                Ok(AuditAppendResult {
                    event,
                    status: AuditAppendStatus::Replay,
                })
            }
            AuditAppendDecision::Append => Err(AuditStoreError::StoreInvalid),
            AuditAppendDecision::Conflict => Err(AuditStoreError::Conflict),
        };
    }

    append_new_in_transaction(transaction, fence, audit_id, input).await
}

async fn append_new_in_transaction(
    transaction: &deadpool_postgres::Transaction<'_>,
    fence: &FenceValues,
    audit_id: &str,
    input: &AuditAppendInput,
) -> Result<AuditAppendResult, AuditStoreError> {
    let head = transaction
        .query_one(AUDIT_HEAD_SQL, &fence.sql_params())
        .await
        .map_err(map_audit_database_error)?;
    let previous_hash = row_text(&head, "previous_hash")?;
    let event_hash =
        audit_event_hash(input, &previous_hash).map_err(|_| AuditStoreError::InvalidInput)?;

    let actor_role = input.actor_role().as_str();
    let actor_id = input.actor_id();
    let action = input.action();
    let resource_type = input.resource_type();
    let resource_id = input.resource_id();
    let business_ref_type = input.business_ref_type();
    let business_ref_id = input.business_ref_id();
    let request_id = input.request_id();
    let idempotency_key = input.idempotency_key();
    let result = input.result().as_str();
    let policy_decision = input.policy_decision().as_str();
    let source_ip_hmac = input.source_ip_hmac();
    let metadata = input.metadata();
    let occurred_at_ms = parse_canonical_timestamp_ms(input.occurred_at())
        .ok_or(AuditStoreError::InvalidInput)?
        .to_string();
    let retention_until_ms = input
        .retention_until()
        .map(|value| {
            parse_canonical_timestamp_ms(value)
                .ok_or(AuditStoreError::InvalidInput)
                .map(|milliseconds| milliseconds.to_string())
        })
        .transpose()?;
    let legal_hold = input.legal_hold();
    let mut params = fence.sql_params().to_vec();
    params.extend([
        &audit_id as &(dyn ToSql + Sync),
        &actor_id,
        &actor_role,
        &action,
        &resource_type,
        &resource_id,
        &business_ref_type,
        &business_ref_id,
        &request_id,
        &idempotency_key,
        &result,
        &policy_decision,
        &source_ip_hmac,
        &metadata,
        &occurred_at_ms,
        &retention_until_ms,
        &legal_hold,
        &previous_hash,
        &event_hash,
    ]);
    let inserted = transaction
        .query(AUDIT_APPEND_SQL, &params)
        .await
        .map_err(map_audit_database_error)?;
    if inserted.len() > 1 {
        return Err(AuditStoreError::StoreInvalid);
    }
    if let Some(row) = inserted.first() {
        if row_text(row, "inserted_event_id")? != audit_id {
            return Err(AuditStoreError::StoreInvalid);
        }
        let rows = transaction
            .query(AUDIT_ID_SQL, &[&fence.tenant, &audit_id])
            .await
            .map_err(map_audit_database_error)?;
        let event = decode_optional_event(&rows)?.ok_or(AuditStoreError::StoreInvalid)?;
        return Ok(AuditAppendResult {
            event,
            status: AuditAppendStatus::Inserted,
        });
    }

    let rows = transaction
        .query(AUDIT_EXACT_SQL, &[&fence.tenant, &input.idempotency_key()])
        .await
        .map_err(map_audit_database_error)?;
    let event = decode_optional_event(&rows)?.ok_or(AuditStoreError::Conflict)?;
    if decide_audit_append(Some(&event), input) != AuditAppendDecision::Replay {
        return Err(AuditStoreError::Conflict);
    }
    Ok(AuditAppendResult {
        event,
        status: AuditAppendStatus::Replay,
    })
}

async fn execute_audit_fence(
    transaction: &deadpool_postgres::Transaction<'_>,
    fence: &FenceValues,
) -> Result<(), AuditStoreError> {
    transaction
        .query_one(AUDIT_FENCE_SQL, &fence.sql_params())
        .await
        .map(|_| ())
        .map_err(map_audit_database_error)
}

fn decode_optional_event(rows: &[Row]) -> Result<Option<AuditEvent>, AuditStoreError> {
    if rows.len() > 1 {
        return Err(AuditStoreError::StoreInvalid);
    }
    rows.first().map(decode_event).transpose()
}

fn decode_event(row: &Row) -> Result<AuditEvent, AuditStoreError> {
    let metadata: Value = row
        .try_get("metadata")
        .map_err(|_| AuditStoreError::StoreInvalid)?;
    let retention_until_ms: Option<String> = row
        .try_get("retention_until_ms")
        .map_err(|_| AuditStoreError::StoreInvalid)?;
    let retention_until = retention_until_ms
        .as_deref()
        .map(epoch_milliseconds_to_canonical)
        .transpose()?;
    let legal_hold: bool = row
        .try_get("legal_hold")
        .map_err(|_| AuditStoreError::StoreInvalid)?;
    AuditEvent::try_from(&json!({
        "id": row_text(row, "id")?,
        "tenant_id": row_text(row, "tenant_id")?,
        "actor_id": row_text(row, "actor_id")?,
        "actor_role": row_text(row, "actor_role")?,
        "action": row_text(row, "action")?,
        "resource_type": row_text(row, "resource_type")?,
        "resource_id": row_text(row, "resource_id")?,
        "business_ref_type": row_text(row, "business_ref_type")?,
        "business_ref_id": row_text(row, "business_ref_id")?,
        "request_id": row_text(row, "request_id")?,
        "idempotency_key": row_text(row, "idempotency_key")?,
        "result": row_text(row, "result")?,
        "policy_decision": row_text(row, "policy_decision")?,
        "source_ip_hmac": row_text(row, "source_ip_hmac")?,
        "metadata": metadata,
        "occurred_at": epoch_milliseconds_field(row, "occurred_at_ms")?,
        "retention_until": retention_until,
        "legal_hold": legal_hold,
        "previous_hash": row_text(row, "previous_hash")?,
        "event_hash": row_text(row, "event_hash")?,
        "created_at": epoch_milliseconds_field(row, "created_at_ms")?
    }))
    .map_err(|_| AuditStoreError::StoreInvalid)
}

fn epoch_milliseconds_field(row: &Row, field: &str) -> Result<String, AuditStoreError> {
    epoch_milliseconds_to_canonical(&row_text(row, field)?)
}

fn epoch_milliseconds_to_canonical(value: &str) -> Result<String, AuditStoreError> {
    let milliseconds = value
        .parse::<i64>()
        .map_err(|_| AuditStoreError::StoreInvalid)?;
    format_canonical_timestamp_ms(milliseconds).ok_or(AuditStoreError::StoreInvalid)
}

fn row_text(row: &Row, field: &str) -> Result<String, AuditStoreError> {
    row.try_get(field)
        .map_err(|_| AuditStoreError::StoreInvalid)
}

#[allow(
    clippy::needless_pass_by_value,
    reason = "used directly as the map_err callback at every database await boundary"
)]
fn map_audit_database_error(error: deadpool_postgres::tokio_postgres::Error) -> AuditStoreError {
    error.as_db_error().map_or(
        AuditStoreError::DatabaseRejected,
        classify_audit_database_error,
    )
}

fn classify_audit_database_error(error: &DbError) -> AuditStoreError {
    if error.code() == &SqlState::UNIQUE_VIOLATION {
        return AuditStoreError::Conflict;
    }
    match error.message() {
        "authority writer tenant fence rejected"
        | "authority writer fence is stale"
        | "authority writer generation is not authorized" => AuditStoreError::StaleWriter,
        "audit chain tail is stale" => AuditStoreError::ChainTailStale,
        "audit chain requires qualification" => AuditStoreError::ChainUnqualified,
        "audit append position is exhausted" => AuditStoreError::ChainPositionExhausted,
        _ => AuditStoreError::DatabaseRejected,
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use converact_kernel_ids::{Generation, OwnerEpoch, TenantId};
    use converact_migration_routing::{AuthorityKind, PartitionKey, RouteKey};
    use converact_migration_store::LeaseToken;
    use deadpool_postgres::tokio_postgres::NoTls;

    use super::*;

    fn audit_input() -> AuditAppendInput {
        audit_input_for(
            "tenant-a",
            "session.created",
            "audit-a",
            "2026-08-22T00:00:00.000Z",
        )
    }

    fn audit_input_for(
        tenant_id: &str,
        action: &str,
        idempotency_key: &str,
        occurred_at: &str,
    ) -> AuditAppendInput {
        AuditAppendInput::try_from(&json!({
            "tenant_id": tenant_id,
            "actor_id": "actor-a",
            "actor_role": "system",
            "action": action,
            "resource_type": "session",
            "resource_id": "session-a",
            "business_ref_type": "interaction",
            "business_ref_id": "interaction-a",
            "request_id": "request-a",
            "idempotency_key": idempotency_key,
            "result": "succeeded",
            "policy_decision": "allow",
            "source_ip_hmac": "",
            "metadata": {},
            "occurred_at": occurred_at,
            "retention_until": null,
            "legal_hold": false
        }))
        .unwrap()
    }

    fn route(authority: &str, partition: &str, tenant: &str) -> RouteKey {
        RouteKey::new(
            TenantId::parse(tenant).unwrap(),
            AuthorityKind::parse(authority).unwrap(),
            PartitionKey::parse(partition).unwrap(),
        )
    }

    #[test]
    fn audit_writer_accepts_only_the_fixed_new_tenant_chain() {
        let lease = LeaseToken::parse(&"a".repeat(64)).unwrap();
        let input = audit_input();

        for (route, scope, accepted) in [
            (
                route("audit", "tenant-chain", "tenant-a"),
                MutationScope::NewObject,
                true,
            ),
            (
                route("platform-event", "tenant-chain", "tenant-a"),
                MutationScope::NewObject,
                false,
            ),
            (
                route("audit", "partition-a", "tenant-a"),
                MutationScope::NewObject,
                false,
            ),
            (
                route("audit", "tenant-chain", "tenant-b"),
                MutationScope::NewObject,
                false,
            ),
            (
                route("audit", "tenant-chain", "tenant-a"),
                MutationScope::ExistingObject {
                    starting_generation: Generation::new(1).unwrap(),
                },
                false,
            ),
        ] {
            let fence = WriterFenceBinding::new(
                &route,
                Generation::new(1).unwrap(),
                OwnerEpoch::parse("1").unwrap(),
                &lease,
                scope,
            );
            assert_eq!(audit_fence_values(&fence, &input).is_ok(), accepted);
        }
    }

    #[tokio::test]
    #[ignore = "requires isolated PostgreSQL admin/runtime URLs migrated through 123"]
    async fn audit_append_is_physically_fenced_idempotent_and_reconcilable() {
        seed_audit_route().await;
        let runtime = audit_runtime();
        let route = route("audit", "tenant-chain", "tenant-audit-rust");
        let lease = LeaseToken::parse(&"a".repeat(64)).unwrap();
        let fence = WriterFenceBinding::new(
            &route,
            Generation::new(1).unwrap(),
            OwnerEpoch::parse("7").unwrap(),
            &lease,
            MutationScope::NewObject,
        );
        let input = audit_input_for(
            "tenant-audit-rust",
            "session.created",
            "audit-a",
            "2026-08-22T00:00:00.000Z",
        );

        let inserted = runtime
            .append_audit_event(&fence, "audit-event-a", &input)
            .await
            .unwrap();
        assert_eq!(inserted.status(), AuditAppendStatus::Inserted);
        let replay = runtime
            .append_audit_event(&fence, "audit-event-replay-ignored", &input)
            .await
            .unwrap();
        assert_eq!(replay.status(), AuditAppendStatus::Replay);
        assert_eq!(replay.event(), inserted.event());
        assert_eq!(
            runtime
                .query_audit_event(&TenantId::parse("tenant-audit-rust").unwrap(), "audit-a",)
                .await
                .unwrap(),
            Some(inserted.event().clone())
        );

        let late_old_event = audit_input_for(
            "tenant-audit-rust",
            "session.observed",
            "audit-b",
            "2026-08-21T00:00:00.000Z",
        );
        let second = runtime
            .append_audit_event(&fence, "audit-event-b", &late_old_event)
            .await
            .unwrap();
        assert_eq!(
            second.event().previous_hash(),
            inserted.event().event_hash()
        );
        let third_input = audit_input_for(
            "tenant-audit-rust",
            "session.closed",
            "audit-c",
            "2026-08-23T00:00:00.000Z",
        );
        let third = runtime
            .append_audit_event(&fence, "audit-event-c", &third_input)
            .await
            .unwrap();
        assert_eq!(third.event().previous_hash(), second.event().event_hash());

        assert_extended_year_round_trip(&runtime, &fence, third.event().event_hash()).await;

        let changed = audit_input_for(
            "tenant-audit-rust",
            "session.changed",
            "audit-a",
            "2026-08-22T00:00:00.000Z",
        );
        assert_eq!(
            runtime
                .append_audit_event(&fence, "audit-event-conflict", &changed)
                .await,
            Err(TransactionError::Work(AuditStoreError::Conflict))
        );
        let stale_lease = LeaseToken::parse(&"b".repeat(64)).unwrap();
        let stale = WriterFenceBinding::new(
            &route,
            Generation::new(1).unwrap(),
            OwnerEpoch::parse("7").unwrap(),
            &stale_lease,
            MutationScope::NewObject,
        );
        assert_eq!(
            runtime
                .append_audit_event(&stale, "audit-event-stale", &input)
                .await,
            Err(TransactionError::Work(AuditStoreError::StaleWriter))
        );
    }

    async fn assert_extended_year_round_trip(
        runtime: &PostgresRuntime,
        fence: &WriterFenceBinding<'_>,
        previous_hash: &str,
    ) {
        let input = audit_input_for(
            "tenant-audit-rust",
            "session.archived",
            "audit-extended-year",
            "+010000-01-01T00:00:00.000Z",
        );
        let result = runtime
            .append_audit_event(fence, "audit-event-extended-year", &input)
            .await
            .unwrap();
        assert_eq!(
            result.event().input().occurred_at(),
            "+010000-01-01T00:00:00.000Z"
        );
        assert_eq!(result.event().previous_hash(), previous_hash);
    }

    fn audit_runtime() -> PostgresRuntime {
        let database_url = std::env::var("CONVERACT_AUDIT_TEST_DATABASE_URL").unwrap();
        let settings =
            super::super::PostgresRuntimeSettings::new(super::super::PostgresRuntimeLimits {
                max_connections: 2,
                max_waiters: 2,
                pool_wait_timeout: Duration::from_secs(2),
                connect_timeout: Duration::from_secs(2),
                recycle_timeout: Duration::from_secs(2),
                statement_timeout: Duration::from_secs(2),
                lock_timeout: Duration::from_secs(1),
                transaction_timeout: Duration::from_secs(5),
                rollback_timeout: Duration::from_secs(1),
            })
            .unwrap();
        PostgresRuntime::build(database_url.parse().unwrap(), NoTls, settings).unwrap()
    }

    async fn seed_audit_route() {
        let database_url = std::env::var("CONVERACT_AUDIT_TEST_ADMIN_DATABASE_URL")
            .or_else(|_| std::env::var("CONVERACT_AUDIT_TEST_DATABASE_URL"))
            .unwrap();
        let (mut admin, connection) =
            deadpool_postgres::tokio_postgres::connect(&database_url, NoTls)
                .await
                .unwrap();
        let task = tokio::spawn(connection);
        let transaction = admin.transaction().await.unwrap();
        transaction
            .query_one(
                "SELECT set_config('app.current_tenant', 'tenant-audit-rust', true)",
                &[],
            )
            .await
            .unwrap();
        transaction
            .batch_execute(
                r"
                INSERT INTO tenants (id, name)
                VALUES ('tenant-audit-rust', 'Tenant Audit Rust');
                INSERT INTO converact_authority_routes (
                  tenant_id, authority_kind, partition_key,
                  current_generation, route_revision, route_state
                ) VALUES (
                  'tenant-audit-rust', 'audit', 'tenant-chain',
                  1, 1, 'shadow'
                );
                INSERT INTO converact_authority_generations (
                  tenant_id, authority_kind, partition_key, generation,
                  cell_id, implementation, owner_epoch, schema_revision,
                  generation_state, lease_token_sha256, lease_expires_at
                ) VALUES (
                  'tenant-audit-rust', 'audit', 'tenant-chain', 1,
                  'cell-a', 'rust', 7, 1, 'accepting_new_work',
                  encode(sha256(convert_to(repeat('a', 64), 'UTF8')), 'hex'),
                  transaction_timestamp() + interval '1 hour'
                );
                ",
            )
            .await
            .unwrap();
        transaction.commit().await.unwrap();
        drop(admin);
        task.await.unwrap().unwrap();
    }
}
