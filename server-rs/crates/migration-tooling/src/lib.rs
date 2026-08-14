//! Dry-run-first Authority migration operator tooling.

use std::{error::Error, fmt};

use converact_contracts::canonical_sha256;
use converact_kernel_ids::{CellId, Generation, OwnerEpoch, TenantId};
use converact_migration_routing::{
    AbortCommand, ActiveZeroCommand, AuthorityKind, CommitCommand, DrainCommand, OperationId,
    OperationMeta, PartitionKey, PrepareCommand, RequestHash, RetireCommand, RouteError, RouteKey,
    RouteRevision, SchemaRevision, WriterTarget, apply as apply_route,
};
use converact_migration_store::{
    DurableRouteCommand, LeaseToken, PostgresRouteStore, SnapshotError, StoreError,
    encode_route_snapshot,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_postgres::Client;

const SCHEMA_VERSION: u8 = 1;

/// Whether the operator request may write durable state.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ExecutionMode {
    #[default]
    DryRun,
    Apply,
}

/// Closed top-level operator action.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActionKind {
    Query,
    Reconcile,
    Transition,
}

/// Stable request rejection without echoing caller-controlled input.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ValidationError {
    InvalidRequest,
    ConfirmationMissing,
    ConfirmationMismatch,
    ReadOnlyAction,
    ApplyModeRequired,
}

impl fmt::Display for ValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidRequest => "authority_migration_tool_request_invalid",
            Self::ConfirmationMissing => "authority_migration_confirmation_missing",
            Self::ConfirmationMismatch => "authority_migration_confirmation_mismatch",
            Self::ReadOnlyAction => "authority_migration_action_read_only",
            Self::ApplyModeRequired => "authority_migration_apply_mode_required",
        })
    }
}

impl Error for ValidationError {}

/// Closed execution result. Unknown means no matching receipt was found; it
/// never authorizes an automatic retry of the mutation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutcomeStatus {
    Found,
    NotFound,
    DryRun,
    Applied,
    Replayed,
    Reconciled,
    Unknown,
}

impl OutcomeStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Found => "found",
            Self::NotFound => "not_found",
            Self::DryRun => "dry_run",
            Self::Applied => "applied",
            Self::Replayed => "replayed",
            Self::Reconciled => "reconciled",
            Self::Unknown => "unknown",
        }
    }
}

/// Stable, secret-free operator result document.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolOutcome {
    status: OutcomeStatus,
    mutation_performed: bool,
    confirmation_sha256: Option<Box<str>>,
    payload: Value,
}

impl ToolOutcome {
    #[must_use]
    pub const fn status(&self) -> OutcomeStatus {
        self.status
    }

    #[must_use]
    pub const fn mutation_performed(&self) -> bool {
        self.mutation_performed
    }

    #[must_use]
    pub fn confirmation_sha256(&self) -> Option<&str> {
        self.confirmation_sha256.as_deref()
    }

    #[must_use]
    pub const fn payload(&self) -> &Value {
        &self.payload
    }
}

/// Stable execution failure. Store sources remain available for local
/// diagnostics, while its display value never includes database details.
#[derive(Debug)]
pub enum ExecutionError {
    Validation(ValidationError),
    Store(StoreError),
    Domain(RouteError),
    Snapshot(SnapshotError),
}

impl fmt::Display for ExecutionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Validation(error) => error.fmt(formatter),
            Self::Store(error) => error.fmt(formatter),
            Self::Domain(error) => error.fmt(formatter),
            Self::Snapshot(error) => error.fmt(formatter),
        }
    }
}

impl Error for ExecutionError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Validation(error) => Some(error),
            Self::Store(error) => Some(error),
            Self::Domain(error) => Some(error),
            Self::Snapshot(error) => Some(error),
        }
    }
}

impl From<ValidationError> for ExecutionError {
    fn from(value: ValidationError) -> Self {
        Self::Validation(value)
    }
}

impl From<StoreError> for ExecutionError {
    fn from(value: StoreError) -> Self {
        Self::Store(value)
    }
}

impl From<RouteError> for ExecutionError {
    fn from(value: RouteError) -> Self {
        Self::Domain(value)
    }
}

impl From<SnapshotError> for ExecutionError {
    fn from(value: SnapshotError) -> Self {
        Self::Snapshot(value)
    }
}

/// Validated exact-key operation. It contains no connection or secret data.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationRequest {
    key: RouteKey,
    execution: ExecutionMode,
    action: ValidatedAction,
    confirmation_sha256: Option<Box<str>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum ValidatedAction {
    Query,
    Reconcile(DurableRouteCommand),
    Transition(DurableRouteCommand),
}

impl MigrationRequest {
    /// Parses the closed versioned JSON request.
    ///
    /// # Errors
    ///
    /// Unknown fields, noncanonical numbers, invalid identifiers, unsupported
    /// commands and any in-document execution/confirmation field fail closed
    /// with no caller value in the error. Parsed requests are always dry-run;
    /// only [`Self::with_apply_confirmation`] can promote a transition.
    pub fn from_json(document: &str) -> Result<Self, ValidationError> {
        let wire: WireRequest =
            serde_json::from_str(document).map_err(|_| ValidationError::InvalidRequest)?;
        if wire.schema_version != SCHEMA_VERSION {
            return Err(ValidationError::InvalidRequest);
        }
        let key = RouteKey::new(
            TenantId::parse(wire.tenant_id).map_err(|_| ValidationError::InvalidRequest)?,
            AuthorityKind::parse(&wire.authority_kind)
                .map_err(|_| ValidationError::InvalidRequest)?,
            PartitionKey::parse(&wire.partition_key)
                .map_err(|_| ValidationError::InvalidRequest)?,
        );
        let action = match wire.action {
            WireAction::Query => ValidatedAction::Query,
            WireAction::Reconcile { command } => ValidatedAction::Reconcile(command.validate()?),
            WireAction::Transition { command } => ValidatedAction::Transition(command.validate()?),
        };
        Ok(Self {
            key,
            execution: ExecutionMode::DryRun,
            action,
            confirmation_sha256: None,
        })
    }

    #[must_use]
    pub const fn execution(&self) -> ExecutionMode {
        self.execution
    }

    #[must_use]
    pub const fn action_kind(&self) -> ActionKind {
        match self.action {
            ValidatedAction::Query => ActionKind::Query,
            ValidatedAction::Reconcile(_) => ActionKind::Reconcile,
            ValidatedAction::Transition(_) => ActionKind::Transition,
        }
    }

    #[must_use]
    pub const fn key(&self) -> &RouteKey {
        &self.key
    }

    #[must_use]
    pub const fn command(&self) -> Option<&DurableRouteCommand> {
        match &self.action {
            ValidatedAction::Query => None,
            ValidatedAction::Reconcile(command) | ValidatedAction::Transition(command) => {
                Some(command)
            }
        }
    }

    /// Returns the exact confirmation emitted by a dry run.
    ///
    /// # Errors
    ///
    /// Query/reconcile actions are permanently read-only.
    pub fn required_confirmation_sha256(&self) -> Result<String, ValidationError> {
        let ValidatedAction::Transition(command) = &self.action else {
            return Err(ValidationError::ReadOnlyAction);
        };
        let request_binding = command
            .request_binding_sha256()
            .map_err(|_| ValidationError::InvalidRequest)?;
        canonical_sha256(&json!({
            "schema_version": SCHEMA_VERSION,
            "action": "transition",
            "tenant_id": self.key.tenant_id().as_str(),
            "authority_kind": self.key.authority_kind().as_str(),
            "partition_key": self.key.partition_key().as_str(),
            "request_binding_sha256": request_binding
        }))
        .map_err(|_| ValidationError::InvalidRequest)
    }

    /// Authorizes a mutation only in apply mode with the exact dry-run digest.
    ///
    /// # Errors
    ///
    /// Read-only/dry-run, missing and mismatched confirmations fail closed.
    pub fn authorize_apply(&self) -> Result<(), ValidationError> {
        if !matches!(self.action, ValidatedAction::Transition(_)) {
            return Err(ValidationError::ReadOnlyAction);
        }
        if self.execution != ExecutionMode::Apply {
            return Err(ValidationError::ApplyModeRequired);
        }
        let supplied = self
            .confirmation_sha256
            .as_deref()
            .ok_or(ValidationError::ConfirmationMissing)?;
        if supplied != self.required_confirmation_sha256()? {
            return Err(ValidationError::ConfirmationMismatch);
        }
        Ok(())
    }

    /// Promotes a parsed dry-run transition using an external confirmation
    /// channel, such as an explicit CLI flag.
    ///
    /// # Errors
    ///
    /// Read-only/already-promoted requests and malformed or mismatched
    /// confirmations fail closed.
    pub fn with_apply_confirmation(mut self, confirmation: &str) -> Result<Self, ValidationError> {
        if !matches!(self.action, ValidatedAction::Transition(_)) {
            return Err(ValidationError::ReadOnlyAction);
        }
        if self.execution != ExecutionMode::DryRun || self.confirmation_sha256.is_some() {
            return Err(ValidationError::InvalidRequest);
        }
        if !is_lower_sha256(confirmation) {
            return Err(ValidationError::InvalidRequest);
        }
        self.execution = ExecutionMode::Apply;
        self.confirmation_sha256 = Some(confirmation.into());
        self.authorize_apply()?;
        Ok(self)
    }
}

/// Executes one validated request without retrying a mutating transaction.
///
/// Query, reconcile and dry-run paths are read-only. Apply requires the exact
/// confirmation emitted by the equivalent dry run. A missing reconcile
/// receipt is returned as [`OutcomeStatus::Unknown`] and never retried.
///
/// # Errors
///
/// Returns stable validation, store, domain or snapshot failures. Apply
/// authorization is checked before the first database operation.
pub async fn execute(
    store: &PostgresRouteStore,
    client: &mut Client,
    request: &MigrationRequest,
) -> Result<ToolOutcome, ExecutionError> {
    match &request.action {
        ValidatedAction::Query => execute_query(store, client, request).await,
        ValidatedAction::Reconcile(command) => {
            execute_reconcile(store, client, request, command).await
        }
        ValidatedAction::Transition(command) => match request.execution {
            ExecutionMode::DryRun => execute_dry_run(store, client, request, command).await,
            ExecutionMode::Apply => {
                request.authorize_apply()?;
                let confirmation = request.required_confirmation_sha256()?;
                let transition = store.apply(client, &request.key, command.clone()).await?;
                let status = if transition.replayed {
                    OutcomeStatus::Replayed
                } else {
                    OutcomeStatus::Applied
                };
                outcome_with_route(
                    status,
                    !transition.replayed,
                    Some(confirmation),
                    &transition.route,
                )
            }
        },
    }
}

async fn execute_query(
    store: &PostgresRouteStore,
    client: &mut Client,
    request: &MigrationRequest,
) -> Result<ToolOutcome, ExecutionError> {
    match store.query(client, &request.key).await? {
        Some(route) => outcome_with_route(OutcomeStatus::Found, false, None, &route),
        None => Ok(outcome_without_route(OutcomeStatus::NotFound)),
    }
}

async fn execute_reconcile(
    store: &PostgresRouteStore,
    client: &mut Client,
    request: &MigrationRequest,
    command: &DurableRouteCommand,
) -> Result<ToolOutcome, ExecutionError> {
    match store.reconcile(client, &request.key, command).await? {
        Some(receipt) => {
            outcome_with_route(OutcomeStatus::Reconciled, false, None, receipt.route())
        }
        None => Ok(outcome_without_route(OutcomeStatus::Unknown)),
    }
}

async fn execute_dry_run(
    store: &PostgresRouteStore,
    client: &mut Client,
    request: &MigrationRequest,
    command: &DurableRouteCommand,
) -> Result<ToolOutcome, ExecutionError> {
    let route = store
        .query(client, &request.key)
        .await?
        .ok_or(StoreError::RouteNotFound)?;
    let prior_receipt = store.reconcile(client, &request.key, command).await?;
    let transition = apply_route(&route, command.route_command(), prior_receipt.as_ref())?;
    let confirmation = request.required_confirmation_sha256()?;
    let before = encode_route_snapshot(&route)?;
    let proposed = encode_route_snapshot(&transition.route)?;
    let payload = json!({
        "schema_version": SCHEMA_VERSION,
        "status": OutcomeStatus::DryRun.as_str(),
        "mutation_performed": false,
        "confirmation_sha256": confirmation,
        "replayed": transition.replayed,
        "before": snapshot_value(&before),
        "proposed": snapshot_value(&proposed)
    });
    Ok(ToolOutcome {
        status: OutcomeStatus::DryRun,
        mutation_performed: false,
        confirmation_sha256: Some(confirmation.into_boxed_str()),
        payload,
    })
}

fn outcome_with_route(
    status: OutcomeStatus,
    mutation_performed: bool,
    confirmation_sha256: Option<String>,
    route: &converact_migration_routing::AuthorityRoute,
) -> Result<ToolOutcome, ExecutionError> {
    let snapshot = encode_route_snapshot(route)?;
    let payload = json!({
        "schema_version": SCHEMA_VERSION,
        "status": status.as_str(),
        "mutation_performed": mutation_performed,
        "confirmation_sha256": confirmation_sha256,
        "route": snapshot_value(&snapshot)
    });
    Ok(ToolOutcome {
        status,
        mutation_performed,
        confirmation_sha256: confirmation_sha256.map(String::into_boxed_str),
        payload,
    })
}

fn outcome_without_route(status: OutcomeStatus) -> ToolOutcome {
    ToolOutcome {
        status,
        mutation_performed: false,
        confirmation_sha256: None,
        payload: json!({
            "schema_version": SCHEMA_VERSION,
            "status": status.as_str(),
            "mutation_performed": false,
            "confirmation_sha256": null,
            "route": null
        }),
    }
}

fn snapshot_value(snapshot: &converact_migration_store::EncodedRouteSnapshot) -> Value {
    json!({
        "payload": snapshot.payload(),
        "sha256": snapshot.sha256()
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireRequest {
    schema_version: u8,
    tenant_id: String,
    authority_kind: String,
    partition_key: String,
    action: WireAction,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum WireAction {
    Query,
    Reconcile { command: WireCommand },
    Transition { command: WireCommand },
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum WireCommand {
    Prepare {
        operation_id: String,
        request_hash: String,
        expected_generation: String,
        expected_revision: String,
        cell_id: String,
        implementation: String,
        owner_epoch: String,
        schema_revision: String,
        lease_token: String,
    },
    Commit {
        operation_id: String,
        request_hash: String,
        expected_generation: String,
        expected_revision: String,
        prepare_operation_id: String,
    },
    Abort {
        operation_id: String,
        request_hash: String,
        expected_generation: String,
        expected_revision: String,
        prepare_operation_id: String,
    },
    Drain {
        operation_id: String,
        request_hash: String,
        expected_generation: String,
        expected_revision: String,
        predecessor_generation: String,
    },
    MarkActiveZero {
        operation_id: String,
        request_hash: String,
        expected_generation: String,
        expected_revision: String,
        predecessor_generation: String,
        durable_active_count: String,
        nonterminal_claims: String,
    },
    Retire {
        operation_id: String,
        request_hash: String,
        expected_generation: String,
        expected_revision: String,
        rollback_window_expired: bool,
    },
}

struct PrepareValues {
    operation_id: String,
    request_hash: String,
    expected_generation: String,
    expected_revision: String,
    cell_id: String,
    implementation: String,
    owner_epoch: String,
    schema_revision: String,
    lease_token: String,
}

impl WireCommand {
    #[allow(
        clippy::too_many_lines,
        reason = "closed wire variants stay together for exhaustive auditability"
    )]
    fn validate(self) -> Result<DurableRouteCommand, ValidationError> {
        match self {
            Self::Prepare {
                operation_id,
                request_hash,
                expected_generation,
                expected_revision,
                cell_id,
                implementation,
                owner_epoch,
                schema_revision,
                lease_token,
            } => validate_prepare(&PrepareValues {
                operation_id,
                request_hash,
                expected_generation,
                expected_revision,
                cell_id,
                implementation,
                owner_epoch,
                schema_revision,
                lease_token,
            }),
            Self::Commit {
                operation_id,
                request_hash,
                expected_generation,
                expected_revision,
                prepare_operation_id,
            } => Ok(CommitCommand {
                operation: operation(
                    &operation_id,
                    &request_hash,
                    &expected_generation,
                    &expected_revision,
                )?,
                prepare_operation_id: parse_operation(&prepare_operation_id)?,
            }
            .into()),
            Self::Abort {
                operation_id,
                request_hash,
                expected_generation,
                expected_revision,
                prepare_operation_id,
            } => Ok(AbortCommand {
                operation: operation(
                    &operation_id,
                    &request_hash,
                    &expected_generation,
                    &expected_revision,
                )?,
                prepare_operation_id: parse_operation(&prepare_operation_id)?,
            }
            .into()),
            Self::Drain {
                operation_id,
                request_hash,
                expected_generation,
                expected_revision,
                predecessor_generation,
            } => Ok(DrainCommand {
                operation: operation(
                    &operation_id,
                    &request_hash,
                    &expected_generation,
                    &expected_revision,
                )?,
                predecessor_generation: parse_generation(&predecessor_generation)?,
            }
            .into()),
            Self::MarkActiveZero {
                operation_id,
                request_hash,
                expected_generation,
                expected_revision,
                predecessor_generation,
                durable_active_count,
                nonterminal_claims,
            } => Ok(ActiveZeroCommand {
                operation: operation(
                    &operation_id,
                    &request_hash,
                    &expected_generation,
                    &expected_revision,
                )?,
                predecessor_generation: parse_generation(&predecessor_generation)?,
                durable_active_count: parse_canonical_u64(&durable_active_count)?,
                nonterminal_claims: parse_canonical_u64(&nonterminal_claims)?,
            }
            .into()),
            Self::Retire {
                operation_id,
                request_hash,
                expected_generation,
                expected_revision,
                rollback_window_expired,
            } => Ok(RetireCommand {
                operation: operation(
                    &operation_id,
                    &request_hash,
                    &expected_generation,
                    &expected_revision,
                )?,
                rollback_window_expired,
            }
            .into()),
        }
    }
}

fn validate_prepare(values: &PrepareValues) -> Result<DurableRouteCommand, ValidationError> {
    let lease_token =
        LeaseToken::parse(&values.lease_token).map_err(|_| ValidationError::InvalidRequest)?;
    Ok(DurableRouteCommand::prepare(
        PrepareCommand {
            operation_id: parse_operation(&values.operation_id)?,
            request_hash: RequestHash::parse(&values.request_hash)
                .map_err(|_| ValidationError::InvalidRequest)?,
            expected_generation: parse_generation(&values.expected_generation)?,
            expected_revision: RouteRevision::new(parse_positive_u64(&values.expected_revision)?)
                .map_err(|_| ValidationError::InvalidRequest)?,
            target: WriterTarget::new(
                CellId::parse(&values.cell_id).map_err(|_| ValidationError::InvalidRequest)?,
                converact_migration_routing::Implementation::parse(&values.implementation)
                    .map_err(|_| ValidationError::InvalidRequest)?,
                OwnerEpoch::parse(&values.owner_epoch)
                    .map_err(|_| ValidationError::InvalidRequest)?,
                SchemaRevision::new(parse_positive_u64(&values.schema_revision)?)
                    .map_err(|_| ValidationError::InvalidRequest)?,
            ),
        },
        &lease_token,
    ))
}

fn operation(
    operation_id: &str,
    request_hash: &str,
    expected_generation: &str,
    expected_revision: &str,
) -> Result<OperationMeta, ValidationError> {
    Ok(OperationMeta {
        operation_id: parse_operation(operation_id)?,
        request_hash: RequestHash::parse(request_hash)
            .map_err(|_| ValidationError::InvalidRequest)?,
        expected_generation: parse_generation(expected_generation)?,
        expected_revision: RouteRevision::new(parse_positive_u64(expected_revision)?)
            .map_err(|_| ValidationError::InvalidRequest)?,
    })
}

fn parse_operation(value: &str) -> Result<OperationId, ValidationError> {
    OperationId::parse(value).map_err(|_| ValidationError::InvalidRequest)
}

fn parse_generation(value: &str) -> Result<Generation, ValidationError> {
    Generation::new(parse_positive_u64(value)?).map_err(|_| ValidationError::InvalidRequest)
}

fn parse_positive_u64(value: &str) -> Result<u64, ValidationError> {
    let parsed = parse_canonical_u64(value)?;
    if parsed == 0 {
        return Err(ValidationError::InvalidRequest);
    }
    Ok(parsed)
}

fn parse_canonical_u64(value: &str) -> Result<u64, ValidationError> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(ValidationError::InvalidRequest);
    }
    value
        .parse::<u64>()
        .map_err(|_| ValidationError::InvalidRequest)
}

fn is_lower_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}
