use std::{error::Error, fmt};

use converact_contracts::{CanonicalJsonError, canonical_json, canonical_sha256};
use converact_kernel_ids::{CellId, Generation, OwnerEpoch};
use converact_migration_routing::{
    AbortCommand, ActiveZeroCommand, AuthorityRoute, CommitCommand, DrainCommand, Implementation,
    OperationId, PrepareCommand, PreparedBinding, RequestHash, RetireCommand, RouteCommand,
    RouteCommandKind, RouteKey, RouteReceipt, RouteRevision, RouteState, SchemaRevision,
    Transition, WriterBinding, apply,
};
use tokio_postgres::{Client, Row, Transaction, types::ToSql};

use crate::{
    GenerationStep, LeaseDigest, LeaseToken, PredecessorGeneration, PredecessorPage,
    PredecessorState, StoreConfig, decode_route_snapshot, encode_route_snapshot, plan_transition,
};
use serde_json::{Value, json};

const SET_TENANT_SQL: &str = "SELECT set_config('app.current_tenant', $1, true)";
const AUDIT_TRANSITION_BARRIER_SQL: &str =
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 947113))";

macro_rules! route_select_sql {
    () => {
        concat!(
            "SELECT ",
            "route.route_revision::text AS route_revision, ",
            "route.route_state, route.prepare_operation_id, route.resume_state, ",
            "route.draining_generation::text AS draining_generation, ",
            "current_writer.cell_id AS current_cell_id, ",
            "current_writer.implementation AS current_implementation, ",
            "current_writer.owner_epoch::text AS current_owner_epoch, ",
            "current_writer.generation::text AS current_generation, ",
            "current_writer.schema_revision::text AS current_schema_revision, ",
            "prepared_writer.cell_id AS prepared_cell_id, ",
            "prepared_writer.implementation AS prepared_implementation, ",
            "prepared_writer.owner_epoch::text AS prepared_owner_epoch, ",
            "prepared_writer.generation::text AS prepared_generation, ",
            "prepared_writer.schema_revision::text AS prepared_schema_revision ",
            "FROM converact_authority_routes AS route ",
            "INNER JOIN converact_authority_generations AS current_writer ",
            "ON current_writer.tenant_id = route.tenant_id ",
            "AND current_writer.authority_kind = route.authority_kind ",
            "AND current_writer.partition_key = route.partition_key ",
            "AND current_writer.generation = route.current_generation ",
            "LEFT JOIN converact_authority_generations AS prepared_writer ",
            "ON prepared_writer.tenant_id = route.tenant_id ",
            "AND prepared_writer.authority_kind = route.authority_kind ",
            "AND prepared_writer.partition_key = route.partition_key ",
            "AND prepared_writer.generation = route.prepared_generation ",
            "WHERE route.tenant_id = $1 ",
            "AND route.authority_kind = $2 ",
            "AND route.partition_key = $3"
        )
    };
}

const READ_ROUTE_SQL: &str = route_select_sql!();

const LOCK_ROUTE_SQL: &str = concat!(route_select_sql!(), " FOR UPDATE OF route");

const READ_RECEIPT_SQL: &str = concat!(
    "SELECT request_hash, command_kind, request_binding_sha256, ",
    "result_generation::text AS result_generation, ",
    "result_revision::text AS result_revision, ",
    "result_payload::text AS result_payload, result_payload_sha256 ",
    "FROM converact_authority_route_receipts ",
    "WHERE tenant_id = $1 AND authority_kind = $2 ",
    "AND partition_key = $3 AND operation_id = $4"
);

const INSERT_PREPARED_SQL: &str = concat!(
    "INSERT INTO converact_authority_generations (",
    "tenant_id, authority_kind, partition_key, generation, cell_id, ",
    "implementation, owner_epoch, schema_revision, generation_state, ",
    "lease_token_sha256, lease_expires_at",
    ") VALUES (",
    "$1, $2, $3, $4::text::numeric, $5, $6, $7::text::numeric, ",
    "$8::text::numeric, 'prepared', $9, ",
    "transaction_timestamp() + ($10::bigint * interval '1 millisecond')",
    ")"
);

const UPDATE_GENERATION_STATE_SQL: &str = concat!(
    "UPDATE converact_authority_generations SET generation_state = $5 ",
    "WHERE tenant_id = $1 AND authority_kind = $2 AND partition_key = $3 ",
    "AND generation = $4::text::numeric AND generation_state = $6"
);

const MARK_ACTIVE_ZERO_SQL: &str = concat!(
    "UPDATE converact_authority_generations ",
    "SET generation_state = 'active_zero', ",
    "rollback_not_before = transaction_timestamp() + ",
    "($5::bigint * interval '1 millisecond') ",
    "WHERE tenant_id = $1 AND authority_kind = $2 AND partition_key = $3 ",
    "AND generation = $4::text::numeric AND generation_state = 'draining' ",
    "AND durable_active_count = 0 AND nonterminal_claims = 0 ",
    "AND claim_tracking_ready_at IS NOT NULL ",
    "AND NOT EXISTS (SELECT 1 FROM converact_authority_generation_claims AS claim ",
    "WHERE claim.tenant_id = $1 AND claim.authority_kind = $2 ",
    "AND claim.partition_key = $3 AND claim.generation = $4::text::numeric ",
    "AND claim.claim_state = 'active')"
);

const RETIRE_PREDECESSOR_SQL: &str = concat!(
    "UPDATE converact_authority_generations SET generation_state = 'retired' ",
    "WHERE tenant_id = $1 AND authority_kind = $2 AND partition_key = $3 ",
    "AND generation = $4::text::numeric AND generation_state = 'active_zero' ",
    "AND durable_active_count = 0 AND nonterminal_claims = 0 ",
    "AND rollback_not_before <= transaction_timestamp()"
);

const UPDATE_ROUTE_SQL: &str = concat!(
    "UPDATE converact_authority_routes SET ",
    "current_generation = $4::text::numeric, ",
    "route_revision = $5::text::numeric, route_state = $6, ",
    "prepared_generation = $7::text::numeric, prepare_operation_id = $8, ",
    "prepare_request_hash = $9, resume_state = $10, ",
    "draining_generation = $11::text::numeric ",
    "WHERE tenant_id = $1 AND authority_kind = $2 AND partition_key = $3 ",
    "AND current_generation = $12::text::numeric ",
    "AND route_revision = $13::text::numeric AND route_state = $14"
);

const INSERT_RECEIPT_SQL: &str = concat!(
    "INSERT INTO converact_authority_route_receipts (",
    "tenant_id, authority_kind, partition_key, operation_id, request_hash, ",
    "command_kind, request_binding_sha256, result_code, result_generation, result_revision, ",
    "result_payload, result_payload_sha256",
    ") VALUES (",
    "$1, $2, $3, $4, $5, $6, $7, 'applied', $8::text::numeric, ",
    "$9::text::numeric, $10::text::jsonb, $11",
    ")"
);

const PREDECESSOR_PAGE_SIZE: usize = 64;
const PREDECESSOR_QUERY_LIMIT: i64 = 65;
const READ_PREDECESSORS_SQL: &str = concat!(
    "SELECT generation.generation::text AS generation, generation.generation_state ",
    "FROM converact_authority_generations AS generation ",
    "INNER JOIN converact_authority_routes AS route ",
    "ON route.tenant_id = generation.tenant_id ",
    "AND route.authority_kind = generation.authority_kind ",
    "AND route.partition_key = generation.partition_key ",
    "WHERE route.tenant_id = $1 AND route.authority_kind = $2 ",
    "AND route.partition_key = $3 ",
    "AND generation.generation <> route.current_generation ",
    "AND generation.generation > $4::text::numeric ",
    "AND generation.generation_state IN ('draining', 'active_zero') ",
    "ORDER BY generation.generation LIMIT $5"
);
const MARK_UNREFERENCED_ACTIVE_ZERO_SQL: &str = concat!(
    "SELECT converact_authority_mark_unreferenced_active_zero(",
    "$1, $2, $3, $4::text::numeric, $5::bigint)"
);
const RETIRE_UNREFERENCED_SQL: &str = concat!(
    "SELECT converact_authority_retire_unreferenced_generation(",
    "$1, $2, $3, $4::text::numeric)"
);

/// A route command plus the database-only material required to persist it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DurableRouteCommand {
    Prepare {
        command: PrepareCommand,
        lease_digest: LeaseDigest,
    },
    Commit(CommitCommand),
    Abort(AbortCommand),
    Drain(DrainCommand),
    MarkActiveZero(ActiveZeroCommand),
    Retire(RetireCommand),
}

impl DurableRouteCommand {
    #[must_use]
    pub fn prepare(command: PrepareCommand, lease_token: &LeaseToken) -> Self {
        Self::Prepare {
            command,
            lease_digest: lease_token.digest(),
        }
    }

    #[must_use]
    pub fn route_command(&self) -> RouteCommand {
        match self {
            Self::Prepare { command, .. } => RouteCommand::Prepare(command.clone()),
            Self::Commit(command) => RouteCommand::Commit(command.clone()),
            Self::Abort(command) => RouteCommand::Abort(command.clone()),
            Self::Drain(command) => RouteCommand::Drain(command.clone()),
            Self::MarkActiveZero(command) => RouteCommand::MarkActiveZero(command.clone()),
            Self::Retire(command) => RouteCommand::Retire(command.clone()),
        }
    }

    #[must_use]
    pub const fn lease_digest(&self) -> Option<&LeaseDigest> {
        match self {
            Self::Prepare { lease_digest, .. } => Some(lease_digest),
            Self::Commit(_)
            | Self::Abort(_)
            | Self::Drain(_)
            | Self::MarkActiveZero(_)
            | Self::Retire(_) => None,
        }
    }

    /// Returns a store-owned canonical binding over every command field and
    /// the prepare capability commitment. Callers cannot substitute only an
    /// operation id and request hash to replay a different command.
    ///
    /// # Errors
    ///
    /// Returns a canonical JSON error if the closed binding cannot be encoded.
    pub fn request_binding_sha256(&self) -> Result<String, CanonicalJsonError> {
        canonical_sha256(&command_binding_value(self))
    }
}

fn command_binding_value(command: &DurableRouteCommand) -> Value {
    match command {
        DurableRouteCommand::Prepare {
            command,
            lease_digest,
        } => json!({
            "command_kind": "prepare",
            "operation_id": command.operation_id.as_str(),
            "request_hash": command.request_hash.as_str(),
            "expected_generation": command.expected_generation.get().to_string(),
            "expected_revision": command.expected_revision.get().to_string(),
            "target": {
                "cell_id": command.target.cell_id().as_str(),
                "implementation": command.target.implementation().as_str(),
                "owner_epoch": command.target.owner_epoch().get().to_string(),
                "schema_revision": command.target.schema_revision().get().to_string()
            },
            "lease_token_sha256": lease_digest.as_str()
        }),
        DurableRouteCommand::Commit(command) => operation_binding(
            "commit",
            &command.operation,
            &json!({ "prepare_operation_id": command.prepare_operation_id.as_str() }),
        ),
        DurableRouteCommand::Abort(command) => operation_binding(
            "abort",
            &command.operation,
            &json!({ "prepare_operation_id": command.prepare_operation_id.as_str() }),
        ),
        DurableRouteCommand::Drain(command) => operation_binding(
            "drain",
            &command.operation,
            &json!({ "predecessor_generation": command.predecessor_generation.get().to_string() }),
        ),
        DurableRouteCommand::MarkActiveZero(command) => operation_binding(
            "mark_active_zero",
            &command.operation,
            &json!({
                "predecessor_generation": command.predecessor_generation.get().to_string(),
                "durable_active_count": command.durable_active_count.to_string(),
                "nonterminal_claims": command.nonterminal_claims.to_string()
            }),
        ),
        DurableRouteCommand::Retire(command) => operation_binding(
            "retire",
            &command.operation,
            &json!({ "rollback_window_expired": command.rollback_window_expired }),
        ),
    }
}

fn operation_binding(
    command_kind: &str,
    operation: &converact_migration_routing::OperationMeta,
    detail: &Value,
) -> Value {
    json!({
        "command_kind": command_kind,
        "operation_id": operation.operation_id.as_str(),
        "request_hash": operation.request_hash.as_str(),
        "expected_generation": operation.expected_generation.get().to_string(),
        "expected_revision": operation.expected_revision.get().to_string(),
        "detail": detail
    })
}

impl From<CommitCommand> for DurableRouteCommand {
    fn from(value: CommitCommand) -> Self {
        Self::Commit(value)
    }
}

impl From<AbortCommand> for DurableRouteCommand {
    fn from(value: AbortCommand) -> Self {
        Self::Abort(value)
    }
}

impl From<DrainCommand> for DurableRouteCommand {
    fn from(value: DrainCommand) -> Self {
        Self::Drain(value)
    }
}

impl From<ActiveZeroCommand> for DurableRouteCommand {
    fn from(value: ActiveZeroCommand) -> Self {
        Self::MarkActiveZero(value)
    }
}

impl From<RetireCommand> for DurableRouteCommand {
    fn from(value: RetireCommand) -> Self {
        Self::Retire(value)
    }
}

/// Stable route-store failure. Values and lease material are never included.
#[derive(Debug)]
pub enum StoreError {
    Database(tokio_postgres::Error),
    CorruptState,
    RouteNotFound,
    ConcurrentMutation,
    Domain(converact_migration_routing::RouteError),
    Snapshot(crate::SnapshotError),
    Plan(crate::PlanError),
}

impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Database(_) => "authority_route_database_failed",
            Self::CorruptState => "authority_route_durable_state_corrupt",
            Self::RouteNotFound => "authority_route_not_found",
            Self::ConcurrentMutation => "authority_route_concurrent_mutation",
            Self::Domain(error) => return error.fmt(formatter),
            Self::Snapshot(error) => return error.fmt(formatter),
            Self::Plan(error) => return error.fmt(formatter),
        })
    }
}

impl Error for StoreError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Database(error) => Some(error),
            Self::Domain(error) => Some(error),
            Self::Snapshot(error) => Some(error),
            Self::Plan(error) => Some(error),
            Self::CorruptState | Self::RouteNotFound | Self::ConcurrentMutation => None,
        }
    }
}

/// Stateless `PostgreSQL` route adapter. It owns no pool or background task.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PostgresRouteStore {
    config: StoreConfig,
}

impl PostgresRouteStore {
    #[must_use]
    pub const fn new(config: StoreConfig) -> Self {
        Self { config }
    }

    #[must_use]
    pub const fn config(&self) -> StoreConfig {
        self.config
    }

    /// Applies one exact route transition and its receipt atomically.
    ///
    /// The caller must reconcile by operation id after an unknown commit
    /// outcome. This method never retries a mutating transaction.
    ///
    /// # Errors
    ///
    /// Returns a stable fail-closed error for missing/corrupt state, stale
    /// domain fences, an unexpected database row count or a database failure.
    pub async fn apply(
        &self,
        client: &mut Client,
        key: &RouteKey,
        durable_command: DurableRouteCommand,
    ) -> Result<Transition, StoreError> {
        let transaction = client.transaction().await?;
        set_tenant(&transaction, key).await?;
        acquire_route_transition_barrier(&transaction, key).await?;
        let before = load_route(&transaction, key, true)
            .await?
            .ok_or(StoreError::RouteNotFound)?;
        let command = durable_command.route_command();
        let request_binding_sha256 = durable_command
            .request_binding_sha256()
            .map_err(|_| StoreError::CorruptState)?;
        let prior_receipt =
            load_receipt(&transaction, key, &command, &request_binding_sha256).await?;
        let transition = apply(&before, command.clone(), prior_receipt.as_ref())?;
        if transition.replayed {
            transaction.commit().await?;
            return Ok(transition);
        }

        let plan = plan_transition(&before, &command, &transition.route)?;
        persist_generation_steps(
            &transaction,
            key,
            &transition.route,
            &plan,
            durable_command.lease_digest(),
            self.config,
        )
        .await?;
        persist_route(&transaction, key, &before, &transition.route, &command).await?;
        persist_receipt(
            &transaction,
            key,
            &command,
            &request_binding_sha256,
            &transition,
        )
        .await?;
        transaction.commit().await?;
        Ok(transition)
    }

    /// Reads one exact route under tenant RLS without acquiring a write lock.
    ///
    /// # Errors
    ///
    /// Returns a stable database/corruption error. Absence is `Ok(None)`.
    pub async fn query(
        &self,
        client: &mut Client,
        key: &RouteKey,
    ) -> Result<Option<AuthorityRoute>, StoreError> {
        let transaction = client.transaction().await?;
        set_tenant(&transaction, key).await?;
        let route = load_route(&transaction, key, false).await?;
        transaction.commit().await?;
        Ok(route)
    }

    /// Reads one fixed-size page of nonterminal predecessors independently of
    /// the route's newest handoff pointer. Results are generation ordered.
    ///
    /// # Errors
    ///
    /// Fails closed if durable state is invalid. Pass the prior page's cursor
    /// to enumerate any number of predecessors with bounded work per call.
    pub async fn query_predecessor_page(
        &self,
        client: &mut Client,
        key: &RouteKey,
        after: Option<Generation>,
    ) -> Result<PredecessorPage, StoreError> {
        let transaction = client.transaction().await?;
        set_tenant(&transaction, key).await?;
        let after = after.map_or_else(|| "0".to_owned(), |value| value.get().to_string());
        let mut rows = transaction
            .query(
                READ_PREDECESSORS_SQL,
                &[
                    &key.tenant_id().as_str(),
                    &key.authority_kind().as_str(),
                    &key.partition_key().as_str(),
                    &after,
                    &PREDECESSOR_QUERY_LIMIT,
                ],
            )
            .await?;
        let has_more = rows.len() > PREDECESSOR_PAGE_SIZE;
        rows.truncate(PREDECESSOR_PAGE_SIZE);
        let predecessors = rows
            .into_iter()
            .map(|row| {
                let generation: String = row.try_get("generation")?;
                let state: String = row.try_get("generation_state")?;
                let state = match state.as_str() {
                    "draining" => PredecessorState::Draining,
                    "active_zero" => PredecessorState::ActiveZero,
                    _ => return Err(StoreError::CorruptState),
                };
                Ok(PredecessorGeneration::new(
                    parse_generation(&generation)?,
                    state,
                ))
            })
            .collect::<Result<Vec<_>, StoreError>>()?;
        let next_after = has_more
            .then(|| predecessors.last().map(|item| item.generation()))
            .flatten();
        transaction.commit().await?;
        Ok(PredecessorPage::new(
            predecessors.into_boxed_slice(),
            next_after,
        ))
    }

    /// Marks an older unreferenced predecessor active-zero. The database
    /// rejects current, prepared or newest route-referenced generations.
    ///
    /// # Errors
    ///
    /// Returns a fail-closed database error if claims remain or state is stale.
    pub async fn mark_unreferenced_active_zero(
        &self,
        client: &mut Client,
        key: &RouteKey,
        generation: Generation,
    ) -> Result<bool, StoreError> {
        let transaction = client.transaction().await?;
        set_tenant(&transaction, key).await?;
        let generation = generation.get().to_string();
        let changed: bool = transaction
            .query_one(
                MARK_UNREFERENCED_ACTIVE_ZERO_SQL,
                &[
                    &key.tenant_id().as_str(),
                    &key.authority_kind().as_str(),
                    &key.partition_key().as_str(),
                    &generation,
                    &self.config.rollback_window_ms,
                ],
            )
            .await?
            .try_get(0)?;
        transaction.commit().await?;
        Ok(changed)
    }

    /// Retires an older unreferenced predecessor after its rollback boundary.
    ///
    /// # Errors
    ///
    /// Returns a fail-closed database error for a referenced/stale generation.
    pub async fn retire_unreferenced_generation(
        &self,
        client: &mut Client,
        key: &RouteKey,
        generation: Generation,
    ) -> Result<bool, StoreError> {
        let transaction = client.transaction().await?;
        set_tenant(&transaction, key).await?;
        let generation = generation.get().to_string();
        let changed: bool = transaction
            .query_one(
                RETIRE_UNREFERENCED_SQL,
                &[
                    &key.tenant_id().as_str(),
                    &key.authority_kind().as_str(),
                    &key.partition_key().as_str(),
                    &generation,
                ],
            )
            .await?
            .try_get(0)?;
        transaction.commit().await?;
        Ok(changed)
    }

    /// Resolves an unknown command outcome from its immutable exact receipt.
    ///
    /// # Errors
    ///
    /// A reused operation id with a different hash fails closed.
    pub async fn reconcile(
        &self,
        client: &mut Client,
        key: &RouteKey,
        durable_command: &DurableRouteCommand,
    ) -> Result<Option<RouteReceipt>, StoreError> {
        let transaction = client.transaction().await?;
        set_tenant(&transaction, key).await?;
        let command = durable_command.route_command();
        let request_binding_sha256 = durable_command
            .request_binding_sha256()
            .map_err(|_| StoreError::CorruptState)?;
        let receipt = load_receipt(&transaction, key, &command, &request_binding_sha256).await?;
        transaction.commit().await?;
        Ok(receipt)
    }
}

impl From<tokio_postgres::Error> for StoreError {
    fn from(value: tokio_postgres::Error) -> Self {
        Self::Database(value)
    }
}

impl From<converact_migration_routing::RouteError> for StoreError {
    fn from(value: converact_migration_routing::RouteError) -> Self {
        Self::Domain(value)
    }
}

impl From<crate::SnapshotError> for StoreError {
    fn from(value: crate::SnapshotError) -> Self {
        Self::Snapshot(value)
    }
}

impl From<crate::PlanError> for StoreError {
    fn from(value: crate::PlanError) -> Self {
        Self::Plan(value)
    }
}

async fn set_tenant(transaction: &Transaction<'_>, key: &RouteKey) -> Result<(), StoreError> {
    transaction
        .query_one(SET_TENANT_SQL, &[&key.tenant_id().as_str()])
        .await?;
    Ok(())
}

async fn acquire_route_transition_barrier(
    transaction: &Transaction<'_>,
    key: &RouteKey,
) -> Result<(), StoreError> {
    if needs_audit_transition_barrier(key) {
        transaction
            .query_one(AUDIT_TRANSITION_BARRIER_SQL, &[&key.tenant_id().as_str()])
            .await?;
    }
    Ok(())
}

fn needs_audit_transition_barrier(key: &RouteKey) -> bool {
    key.authority_kind().as_str() == "audit" && key.partition_key().as_str() == "tenant-chain"
}

async fn load_route(
    transaction: &Transaction<'_>,
    key: &RouteKey,
    lock: bool,
) -> Result<Option<AuthorityRoute>, StoreError> {
    let sql = if lock { LOCK_ROUTE_SQL } else { READ_ROUTE_SQL };
    let row = transaction
        .query_opt(
            sql,
            &[
                &key.tenant_id().as_str(),
                &key.authority_kind().as_str(),
                &key.partition_key().as_str(),
            ],
        )
        .await?;
    row.map(|row| restore_route_row(key, &row)).transpose()
}

fn restore_route_row(key: &RouteKey, row: &Row) -> Result<AuthorityRoute, StoreError> {
    let current_writer = restore_writer_row(row, "current")?;
    let prepared_generation: Option<String> = row.try_get("prepared_generation")?;
    let prepared = prepared_generation
        .map(|generation| {
            let writer = restore_optional_writer_row(row, &generation)?;
            let operation_id: Option<String> = row.try_get("prepare_operation_id")?;
            let resume_state: Option<String> = row.try_get("resume_state")?;
            PreparedBinding::restore(
                writer,
                OperationId::parse(operation_id.as_deref().ok_or(StoreError::CorruptState)?)
                    .map_err(|_| StoreError::CorruptState)?,
                RouteState::parse(resume_state.as_deref().ok_or(StoreError::CorruptState)?)
                    .map_err(|_| StoreError::CorruptState)?,
            )
            .map_err(StoreError::Domain)
        })
        .transpose()?;
    let draining_generation: Option<String> = row.try_get("draining_generation")?;
    let state: String = row.try_get("route_state")?;
    let revision: String = row.try_get("route_revision")?;
    AuthorityRoute::restore(
        key.clone(),
        current_writer,
        prepared,
        draining_generation
            .map(|value| parse_generation(&value))
            .transpose()?,
        RouteState::parse(&state).map_err(|_| StoreError::CorruptState)?,
        RouteRevision::new(parse_u64(&revision)?).map_err(|_| StoreError::CorruptState)?,
    )
    .map_err(StoreError::Domain)
}

fn restore_writer_row(row: &Row, prefix: &str) -> Result<WriterBinding, StoreError> {
    let cell_id: String = row.try_get(format!("{prefix}_cell_id").as_str())?;
    let implementation: String = row.try_get(format!("{prefix}_implementation").as_str())?;
    let owner_epoch: String = row.try_get(format!("{prefix}_owner_epoch").as_str())?;
    let generation: String = row.try_get(format!("{prefix}_generation").as_str())?;
    let schema_revision: String = row.try_get(format!("{prefix}_schema_revision").as_str())?;
    restore_writer(
        &cell_id,
        &implementation,
        &owner_epoch,
        &generation,
        &schema_revision,
    )
}

fn restore_optional_writer_row(row: &Row, generation: &str) -> Result<WriterBinding, StoreError> {
    let cell_id: Option<String> = row.try_get("prepared_cell_id")?;
    let implementation: Option<String> = row.try_get("prepared_implementation")?;
    let owner_epoch: Option<String> = row.try_get("prepared_owner_epoch")?;
    let schema_revision: Option<String> = row.try_get("prepared_schema_revision")?;
    restore_writer(
        cell_id.as_deref().ok_or(StoreError::CorruptState)?,
        implementation.as_deref().ok_or(StoreError::CorruptState)?,
        owner_epoch.as_deref().ok_or(StoreError::CorruptState)?,
        generation,
        schema_revision.as_deref().ok_or(StoreError::CorruptState)?,
    )
}

fn restore_writer(
    cell_id: &str,
    implementation: &str,
    owner_epoch: &str,
    generation: &str,
    schema_revision: &str,
) -> Result<WriterBinding, StoreError> {
    Ok(WriterBinding::new(
        CellId::parse(cell_id).map_err(|_| StoreError::CorruptState)?,
        Implementation::parse(implementation).map_err(|_| StoreError::CorruptState)?,
        OwnerEpoch::parse(owner_epoch).map_err(|_| StoreError::CorruptState)?,
        parse_generation(generation)?,
        SchemaRevision::new(parse_u64(schema_revision)?).map_err(|_| StoreError::CorruptState)?,
    ))
}

async fn load_receipt(
    transaction: &Transaction<'_>,
    key: &RouteKey,
    command: &RouteCommand,
    expected_binding_sha256: &str,
) -> Result<Option<RouteReceipt>, StoreError> {
    let row = transaction
        .query_opt(
            READ_RECEIPT_SQL,
            &[
                &key.tenant_id().as_str(),
                &key.authority_kind().as_str(),
                &key.partition_key().as_str(),
                &command.operation_id().as_str(),
            ],
        )
        .await?;
    row.map(|row| restore_receipt_row(key, command, expected_binding_sha256, &row))
        .transpose()
}

fn restore_receipt_row(
    key: &RouteKey,
    command: &RouteCommand,
    expected_binding_sha256: &str,
    row: &Row,
) -> Result<RouteReceipt, StoreError> {
    let request_hash: String = row.try_get("request_hash")?;
    let request_hash = RequestHash::parse(&request_hash).map_err(|_| StoreError::CorruptState)?;
    if &request_hash != command.request_hash() {
        return Err(StoreError::Domain(
            converact_migration_routing::RouteError::IdempotencyConflict,
        ));
    }
    let command_kind: String = row.try_get("command_kind")?;
    let command_kind =
        RouteCommandKind::parse(&command_kind).map_err(|_| StoreError::CorruptState)?;
    let request_binding_sha256: String = row.try_get("request_binding_sha256")?;
    if command_kind != command.command_kind() || request_binding_sha256 != expected_binding_sha256 {
        return Err(StoreError::Domain(
            converact_migration_routing::RouteError::ReceiptMismatch,
        ));
    }
    let payload: String = row.try_get("result_payload")?;
    let payload: serde_json::Value =
        serde_json::from_str(&payload).map_err(|_| StoreError::CorruptState)?;
    let payload_sha256: String = row.try_get("result_payload_sha256")?;
    let route = decode_route_snapshot(&payload, &payload_sha256)?;
    let result_generation: String = row.try_get("result_generation")?;
    let result_revision: String = row.try_get("result_revision")?;
    if route.key() != key
        || route.current_writer().generation() != parse_generation(&result_generation)?
        || route.revision().get() != parse_u64(&result_revision)?
    {
        return Err(StoreError::CorruptState);
    }
    Ok(RouteReceipt::restore(
        command.operation_id().clone(),
        request_hash,
        command_kind,
        route,
    ))
}

async fn persist_generation_steps(
    transaction: &Transaction<'_>,
    key: &RouteKey,
    after: &AuthorityRoute,
    plan: &crate::RouteMutationPlan,
    lease_digest: Option<&LeaseDigest>,
    config: StoreConfig,
) -> Result<(), StoreError> {
    for step in plan.generation_steps() {
        match step {
            GenerationStep::InsertPrepared(generation) => {
                let prepared = after.prepared().ok_or(StoreError::CorruptState)?;
                let lease_digest = lease_digest.ok_or(StoreError::CorruptState)?;
                let writer = prepared.writer();
                let generation = generation.get().to_string();
                let owner_epoch = writer.owner_epoch().get().to_string();
                let schema_revision = writer.schema_revision().get().to_string();
                expect_one(
                    transaction
                        .execute(
                            INSERT_PREPARED_SQL,
                            &[
                                &key.tenant_id().as_str(),
                                &key.authority_kind().as_str(),
                                &key.partition_key().as_str(),
                                &generation,
                                &writer.cell_id().as_str(),
                                &writer.implementation().as_str(),
                                &owner_epoch,
                                &schema_revision,
                                &lease_digest.as_str(),
                                &config.lease_ttl_ms,
                            ],
                        )
                        .await?,
                )?;
            }
            GenerationStep::BeginDrain(generation) => {
                update_generation_state(
                    transaction,
                    key,
                    *generation,
                    "accepting_new_work",
                    "draining",
                )
                .await?;
            }
            GenerationStep::ActivatePrepared(generation) => {
                update_generation_state(
                    transaction,
                    key,
                    *generation,
                    "prepared",
                    "accepting_new_work",
                )
                .await?;
            }
            GenerationStep::AbortPrepared(generation) => {
                update_generation_state(transaction, key, *generation, "prepared", "retired")
                    .await?;
            }
            GenerationStep::MarkActiveZero(generation) => {
                let generation = generation.get().to_string();
                expect_one(
                    transaction
                        .execute(
                            MARK_ACTIVE_ZERO_SQL,
                            &[
                                &key.tenant_id().as_str(),
                                &key.authority_kind().as_str(),
                                &key.partition_key().as_str(),
                                &generation,
                                &config.rollback_window_ms,
                            ],
                        )
                        .await?,
                )?;
            }
            GenerationStep::RetirePredecessor(generation) => {
                let generation = generation.get().to_string();
                expect_one(
                    transaction
                        .execute(
                            RETIRE_PREDECESSOR_SQL,
                            &[
                                &key.tenant_id().as_str(),
                                &key.authority_kind().as_str(),
                                &key.partition_key().as_str(),
                                &generation,
                            ],
                        )
                        .await?,
                )?;
            }
        }
    }
    if !matches!(plan.generation_steps(), [GenerationStep::InsertPrepared(_)])
        && lease_digest.is_some()
    {
        return Err(StoreError::CorruptState);
    }
    Ok(())
}

async fn update_generation_state(
    transaction: &Transaction<'_>,
    key: &RouteKey,
    generation: Generation,
    expected_state: &str,
    next_state: &str,
) -> Result<(), StoreError> {
    let generation = generation.get().to_string();
    expect_one(
        transaction
            .execute(
                UPDATE_GENERATION_STATE_SQL,
                &[
                    &key.tenant_id().as_str(),
                    &key.authority_kind().as_str(),
                    &key.partition_key().as_str(),
                    &generation,
                    &next_state,
                    &expected_state,
                ],
            )
            .await?,
    )
}

async fn persist_route(
    transaction: &Transaction<'_>,
    key: &RouteKey,
    before: &AuthorityRoute,
    after: &AuthorityRoute,
    command: &RouteCommand,
) -> Result<(), StoreError> {
    let current_generation = after.current_writer().generation().get().to_string();
    let revision = after.revision().get().to_string();
    let prepared_generation = after
        .prepared()
        .map(|prepared| prepared.writer().generation().get().to_string());
    let prepared_operation_id = after
        .prepared()
        .map(|prepared| prepared.operation_id().as_str());
    let prepared_request_hash = after.prepared().map(|_| command.request_hash().as_str());
    let resume_state = after
        .prepared()
        .map(|prepared| prepared.resume_state().as_str());
    let draining_generation = after
        .draining_generation()
        .map(|generation| generation.get().to_string());
    let before_generation = before.current_writer().generation().get().to_string();
    let before_revision = before.revision().get().to_string();
    let parameters: [&(dyn ToSql + Sync); 14] = [
        &key.tenant_id().as_str(),
        &key.authority_kind().as_str(),
        &key.partition_key().as_str(),
        &current_generation,
        &revision,
        &after.state().as_str(),
        &prepared_generation.as_deref(),
        &prepared_operation_id,
        &prepared_request_hash,
        &resume_state,
        &draining_generation.as_deref(),
        &before_generation,
        &before_revision,
        &before.state().as_str(),
    ];
    expect_one(transaction.execute(UPDATE_ROUTE_SQL, &parameters).await?)
}

async fn persist_receipt(
    transaction: &Transaction<'_>,
    key: &RouteKey,
    command: &RouteCommand,
    request_binding_sha256: &str,
    transition: &Transition,
) -> Result<(), StoreError> {
    let encoded = encode_route_snapshot(&transition.route)?;
    let payload = canonical_json(encoded.payload())
        .map_err(|_| StoreError::Snapshot(crate::SnapshotError::EncodingFailed))?;
    let result_generation = transition
        .route
        .current_writer()
        .generation()
        .get()
        .to_string();
    let result_revision = transition.route.revision().get().to_string();
    expect_one(
        transaction
            .execute(
                INSERT_RECEIPT_SQL,
                &[
                    &key.tenant_id().as_str(),
                    &key.authority_kind().as_str(),
                    &key.partition_key().as_str(),
                    &command.operation_id().as_str(),
                    &command.request_hash().as_str(),
                    &command.kind(),
                    &request_binding_sha256,
                    &result_generation,
                    &result_revision,
                    &payload,
                    &encoded.sha256(),
                ],
            )
            .await?,
    )
}

fn expect_one(affected: u64) -> Result<(), StoreError> {
    if affected == 1 {
        Ok(())
    } else {
        Err(StoreError::ConcurrentMutation)
    }
}

fn parse_generation(value: &str) -> Result<Generation, StoreError> {
    Generation::new(parse_u64(value)?).map_err(|_| StoreError::CorruptState)
}

fn parse_u64(value: &str) -> Result<u64, StoreError> {
    let canonical = value == "0"
        || (!value.is_empty()
            && !value.starts_with('0')
            && value.bytes().all(|byte| byte.is_ascii_digit()));
    if !canonical {
        return Err(StoreError::CorruptState);
    }
    value.parse().map_err(|_| StoreError::CorruptState)
}

#[cfg(test)]
mod tests {
    use converact_kernel_ids::TenantId;
    use converact_migration_routing::{AuthorityKind, PartitionKey, RouteKey};

    use super::needs_audit_transition_barrier;

    fn route(authority: &str, partition: &str) -> RouteKey {
        RouteKey::new(
            TenantId::parse("tenant-a").unwrap(),
            AuthorityKind::parse(authority).unwrap(),
            PartitionKey::parse(partition).unwrap(),
        )
    }

    #[test]
    fn transition_barrier_is_exactly_the_audit_tenant_chain() {
        assert!(needs_audit_transition_barrier(&route(
            "audit",
            "tenant-chain"
        )));
        assert!(!needs_audit_transition_barrier(&route(
            "platform-event",
            "tenant-chain"
        )));
        assert!(!needs_audit_transition_barrier(&route(
            "audit",
            "partition-a"
        )));
    }
}
