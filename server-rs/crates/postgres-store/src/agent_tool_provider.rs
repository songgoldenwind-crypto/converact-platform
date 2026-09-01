use std::{error::Error, fmt, sync::Arc};

use converact_contracts::{canonical_sha256_with_max_bytes, sha256_bytes};
use converact_kernel_ids::TenantId;
use converact_tool_broker_core::{
    ActionFailureCode, ActionObservation, AuthorizedToolAction, ToolActionOutput, ToolActionPort,
    ToolDefinition, ToolEffectClass, ToolPortError, ToolProposal, ToolSchemaPort,
};
use converact_voice_agent_contracts::ToolCallId;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{PostgresRuntime, TransactionError};

const MAX_REASON_BYTES: usize = 1_024;
const MAX_SCHEMA_BYTES: usize = 16_384;
const CUSTOMER_LOOKUP: &str = "customer.lookup";
const CREATE_FOLLOW_UP: &str = "task.create_follow_up";
const CUSTOMER_LOOKUP_SCHEMA: &str = r#"{
  "additionalProperties": false,
  "properties": {
    "customer_id": {
      "maxLength": 255,
      "minLength": 1,
      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$",
      "type": "string"
    }
  },
  "required": ["customer_id"],
  "type": "object"
}"#;
const CREATE_FOLLOW_UP_SCHEMA: &str = r#"{
  "additionalProperties": false,
  "properties": {
    "customer_id": {
      "maxLength": 255,
      "minLength": 1,
      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$",
      "type": "string"
    },
    "due_at_ms": {"minimum": 1, "type": "integer"},
    "reason": {"maxLength": 1024, "minLength": 1, "type": "string"}
  },
  "required": ["customer_id", "reason", "due_at_ms"],
  "type": "object"
}"#;
const CUSTOMER_LOOKUP_SQL: &str = "
SELECT contact.external_contact_id, contact.state
FROM public.converact_outbound_campaign_contacts AS contact
WHERE contact.tenant_id = $1
  AND (contact.id = $2 OR contact.external_contact_id = $2)
ORDER BY CASE WHEN contact.id = $2 THEN 0 ELSE 1 END,
         contact.updated_at DESC,
         contact.id
LIMIT 1";

const INSERT_FOLLOW_UP_SQL: &str = "
INSERT INTO public.converact_agent_follow_up_tasks (
  tenant_id, id, tool_call_id, customer_id, reason, due_at
) VALUES ($1, $2, $3, $4, $5, to_timestamp($6::DOUBLE PRECISION / 1000.0))
ON CONFLICT (tenant_id, tool_call_id) DO NOTHING
RETURNING id";

const LOAD_FOLLOW_UP_SQL: &str = "
SELECT id, customer_id, reason,
       floor(extract(epoch FROM due_at) * 1000)::BIGINT AS due_at_ms
FROM public.converact_agent_follow_up_tasks
WHERE tenant_id = $1 AND tool_call_id = $2
LIMIT 1";

/// Bounded non-secret customer facts visible to an Agent Tool Adapter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PostgresAgentCustomer {
    customer_id: Box<str>,
    status: Box<str>,
}

impl PostgresAgentCustomer {
    #[must_use]
    pub fn customer_id(&self) -> &str {
        &self.customer_id
    }

    #[must_use]
    pub fn status(&self) -> &str {
        &self.status
    }
}

/// Stable Provider-owned identity for an idempotent follow-up Task.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PostgresAgentFollowUpTaskId(Box<str>);

impl PostgresAgentFollowUpTaskId {
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Observation of an idempotent follow-up Task effect.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PostgresAgentFollowUpResult {
    Created(PostgresAgentFollowUpTaskId),
    NotFound,
    OutcomeUnknown,
}

/// Stable `PostgreSQL` Provider failure without SQL, customer values or topology.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PostgresAgentToolProviderError;

impl fmt::Display for PostgresAgentToolProviderError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("agent_tool_provider_unavailable")
    }
}

impl Error for PostgresAgentToolProviderError {}

/// Tenant-transaction-owned Store for the first code-registered Agent Tools.
#[derive(Clone)]
pub struct PostgresAgentToolProvider {
    runtime: Arc<PostgresRuntime>,
}

/// Pre-execution schemas paired with [`PostgresAgentToolProvider`].
#[derive(Clone, Copy, Debug, Default)]
pub struct PostgresAgentToolSchema;

impl PostgresAgentToolSchema {
    #[must_use]
    pub const fn new() -> Self {
        Self
    }

    /// Returns the canonical digest for one deployment-registered Tool schema.
    #[must_use]
    pub fn schema_hash(self, action_capability: &str) -> Option<String> {
        let (_, schema) = registered_schema(action_capability)?;
        canonical_sha256_with_max_bytes(&schema, MAX_SCHEMA_BYTES).ok()
    }

    /// Returns one immutable code-owned schema document for Release publication.
    #[must_use]
    pub fn schema_document(self, action_capability: &str) -> Option<Value> {
        registered_schema(action_capability).map(|(_, schema)| schema)
    }
}

impl ToolSchemaPort for PostgresAgentToolSchema {
    async fn validate(
        &self,
        definition: &ToolDefinition,
        proposal: &ToolProposal,
    ) -> Result<(), ToolPortError> {
        let (effect, schema) =
            registered_schema(definition.action_capability()).ok_or_else(schema_rejected)?;
        let schema_hash = canonical_sha256_with_max_bytes(&schema, MAX_SCHEMA_BYTES)
            .map_err(|_| schema_rejected())?;
        if definition.effect_class() != effect
            || definition.schema_hash() != schema_hash
            || proposal.tool_schema_hash() != schema_hash
            || definition.revision_id() != proposal.tool_revision_id()
            || definition.agent_release_id() != proposal.context().agent_release_id()
        {
            return Err(schema_rejected());
        }
        match definition.action_capability() {
            CUSTOMER_LOOKUP => parse_customer_arguments(proposal).map(|_| ()),
            CREATE_FOLLOW_UP => parse_follow_up_arguments(proposal).map(|_| ()),
            _ => Err(schema_rejected()),
        }
    }
}

impl ToolActionPort for PostgresAgentToolProvider {
    async fn execute(
        &self,
        action: &AuthorizedToolAction,
    ) -> Result<ActionObservation, ToolPortError> {
        match action.definition().action_capability() {
            CUSTOMER_LOOKUP if action.definition().effect_class() == ToolEffectClass::Query => {
                self.execute_customer_lookup(action).await
            }
            CREATE_FOLLOW_UP if action.definition().effect_class() == ToolEffectClass::Mutation => {
                let arguments = parse_follow_up_arguments(action.proposal())?;
                let tenant = parse_action_tenant(action)?;
                self.create_follow_up(
                    &tenant,
                    action.proposal().tool_call_id(),
                    &arguments.customer_id,
                    &arguments.reason,
                    arguments.due_at_ms,
                )
                .await
                .map_err(|_| provider_unavailable())
                .and_then(map_follow_up_result)
            }
            _ => Err(ToolPortError::new("agent_tool_capability_rejected")),
        }
    }

    async fn query(
        &self,
        action: &AuthorizedToolAction,
    ) -> Result<ActionObservation, ToolPortError> {
        match action.definition().action_capability() {
            CUSTOMER_LOOKUP if action.definition().effect_class() == ToolEffectClass::Query => {
                self.execute_customer_lookup(action).await
            }
            CREATE_FOLLOW_UP if action.definition().effect_class() == ToolEffectClass::Mutation => {
                let tenant = parse_action_tenant(action)?;
                self.query_follow_up(&tenant, action.proposal().tool_call_id())
                    .await
                    .map_err(|_| provider_unavailable())
                    .and_then(map_follow_up_result)
            }
            _ => Err(ToolPortError::new("agent_tool_capability_rejected")),
        }
    }
}

impl PostgresAgentToolProvider {
    #[must_use]
    pub const fn new(runtime: Arc<PostgresRuntime>) -> Self {
        Self { runtime }
    }

    async fn execute_customer_lookup(
        &self,
        action: &AuthorizedToolAction,
    ) -> Result<ActionObservation, ToolPortError> {
        let arguments = parse_customer_arguments(action.proposal())?;
        let tenant = parse_action_tenant(action)?;
        let customer = self
            .lookup_customer(&tenant, &arguments.customer_id)
            .await
            .map_err(|_| provider_unavailable())?;
        let value = match customer {
            Some(customer) => json!({
                "found": true,
                "customer_id": customer.customer_id(),
                "status": customer.status(),
                "segment": null,
                "preferred_language": null,
            }),
            None => json!({"found": false}),
        };
        ToolActionOutput::try_new(value)
            .map(ActionObservation::Applied)
            .map_err(|_| ToolPortError::new("agent_tool_result_invalid"))
    }

    /// Resolves one known outbound customer without returning telephone or other PII.
    ///
    /// # Errors
    ///
    /// Returns a value-free error for malformed input, database failure or invalid stored rows.
    pub async fn lookup_customer(
        &self,
        tenant: &TenantId,
        customer_id: &str,
    ) -> Result<Option<PostgresAgentCustomer>, PostgresAgentToolProviderError> {
        if TenantId::parse(customer_id).is_err() {
            return Err(PostgresAgentToolProviderError);
        }
        let tenant_id = tenant.as_str().to_owned();
        let customer_id = customer_id.to_owned();
        self.runtime
            .with_tenant_transaction(tenant, move |transaction| {
                Box::pin(async move {
                    let row = transaction
                        .query_opt(CUSTOMER_LOOKUP_SQL, &[&tenant_id, &customer_id])
                        .await
                        .map_err(|_| ProviderWorkError)?;
                    let Some(row) = row else {
                        return Ok(None);
                    };
                    let external_contact_id: String =
                        row.try_get(0).map_err(|_| ProviderWorkError)?;
                    let status: String = row.try_get(1).map_err(|_| ProviderWorkError)?;
                    if TenantId::parse(&external_contact_id).is_err() || !bounded_status(&status) {
                        return Err(ProviderWorkError);
                    }
                    Ok(Some(PostgresAgentCustomer {
                        customer_id: external_contact_id.into(),
                        status: status.into(),
                    }))
                })
            })
            .await
            .map_err(map_provider_error)
    }

    /// Idempotently creates one follow-up Task after Tool Action prepare permission.
    ///
    /// # Errors
    ///
    /// Returns a value-free error for malformed input, database failure or conflicting state.
    pub async fn create_follow_up(
        &self,
        tenant: &TenantId,
        tool_call_id: &ToolCallId,
        customer_id: &str,
        reason: &str,
        due_at_ms: u64,
    ) -> Result<PostgresAgentFollowUpResult, PostgresAgentToolProviderError> {
        if TenantId::parse(customer_id).is_err() || !bounded_reason(reason) || due_at_ms == 0 {
            return Err(PostgresAgentToolProviderError);
        }
        let due_at_ms = i64::try_from(due_at_ms).map_err(|_| PostgresAgentToolProviderError)?;
        let task_id = derive_agent_follow_up_task_id(tenant.as_str(), tool_call_id)?;
        let tenant_id = tenant.as_str().to_owned();
        let task_id_value = task_id.as_str().to_owned();
        let tool_call_id = tool_call_id.as_str().to_owned();
        let customer_id = customer_id.to_owned();
        let reason = reason.to_owned();
        let result = self
            .runtime
            .with_tenant_transaction(tenant, move |transaction| {
                Box::pin(async move {
                    transaction
                        .query_opt(
                            INSERT_FOLLOW_UP_SQL,
                            &[
                                &tenant_id,
                                &task_id_value,
                                &tool_call_id,
                                &customer_id,
                                &reason,
                                &due_at_ms,
                            ],
                        )
                        .await
                        .map_err(|_| ProviderWorkError)?;
                    let row = transaction
                        .query_opt(LOAD_FOLLOW_UP_SQL, &[&tenant_id, &tool_call_id])
                        .await
                        .map_err(|_| ProviderWorkError)?
                        .ok_or(ProviderWorkError)?;
                    let stored_id: String = row.try_get(0).map_err(|_| ProviderWorkError)?;
                    let stored_customer: String = row.try_get(1).map_err(|_| ProviderWorkError)?;
                    let stored_reason: String = row.try_get(2).map_err(|_| ProviderWorkError)?;
                    let stored_due_at_ms: i64 = row.try_get(3).map_err(|_| ProviderWorkError)?;
                    if stored_id != task_id_value
                        || stored_customer != customer_id
                        || stored_reason != reason
                        || stored_due_at_ms != due_at_ms
                    {
                        return Err(ProviderWorkError);
                    }
                    Ok(PostgresAgentFollowUpResult::Created(task_id))
                })
            })
            .await;
        match result {
            Ok(result) => Ok(result),
            Err(TransactionError::CommitUnknown) => Ok(PostgresAgentFollowUpResult::OutcomeUnknown),
            Err(error) => Err(map_provider_error(error)),
        }
    }

    /// Reconciles an earlier unknown follow-up effect using the same stable identity.
    ///
    /// # Errors
    ///
    /// Returns a value-free error for malformed input, database failure or conflicting state.
    pub async fn query_follow_up(
        &self,
        tenant: &TenantId,
        tool_call_id: &ToolCallId,
    ) -> Result<PostgresAgentFollowUpResult, PostgresAgentToolProviderError> {
        let task_id = derive_agent_follow_up_task_id(tenant.as_str(), tool_call_id)?;
        let tenant_id = tenant.as_str().to_owned();
        let tool_call_id = tool_call_id.as_str().to_owned();
        self.runtime
            .with_tenant_transaction(tenant, move |transaction| {
                Box::pin(async move {
                    let row = transaction
                        .query_opt(LOAD_FOLLOW_UP_SQL, &[&tenant_id, &tool_call_id])
                        .await
                        .map_err(|_| ProviderWorkError)?;
                    let Some(row) = row else {
                        return Ok(PostgresAgentFollowUpResult::NotFound);
                    };
                    let stored_id: String = row.try_get(0).map_err(|_| ProviderWorkError)?;
                    if stored_id != task_id.as_str() {
                        return Err(ProviderWorkError);
                    }
                    Ok(PostgresAgentFollowUpResult::Created(task_id))
                })
            })
            .await
            .map_err(map_provider_error)
    }
}

/// Derives a stable, tenant-separated Provider identity from the durable Tool Call identity.
///
/// # Errors
///
/// Returns a value-free error when the tenant identifier is malformed.
pub fn derive_agent_follow_up_task_id(
    tenant_id: &str,
    tool_call_id: &ToolCallId,
) -> Result<PostgresAgentFollowUpTaskId, PostgresAgentToolProviderError> {
    let tenant = TenantId::parse(tenant_id).map_err(|_| PostgresAgentToolProviderError)?;
    let mut preimage = Vec::with_capacity(tenant.as_str().len() + tool_call_id.as_str().len() + 1);
    preimage.extend_from_slice(tenant.as_str().as_bytes());
    preimage.push(0);
    preimage.extend_from_slice(tool_call_id.as_str().as_bytes());
    Ok(PostgresAgentFollowUpTaskId(
        format!("agent-follow-up-{}", sha256_bytes(&preimage)).into(),
    ))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ProviderWorkError;

fn bounded_status(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.trim().len() == value.len()
        && !value.chars().any(char::is_control)
}

fn bounded_reason(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_REASON_BYTES
        && value.trim().len() == value.len()
        && !value.chars().any(char::is_control)
}

fn registered_schema(action_capability: &str) -> Option<(ToolEffectClass, Value)> {
    let (effect, source) = match action_capability {
        CUSTOMER_LOOKUP => (ToolEffectClass::Query, CUSTOMER_LOOKUP_SCHEMA),
        CREATE_FOLLOW_UP => (ToolEffectClass::Mutation, CREATE_FOLLOW_UP_SCHEMA),
        _ => return None,
    };
    serde_json::from_str(source)
        .ok()
        .map(|schema| (effect, schema))
}

fn parse_customer_arguments(
    proposal: &ToolProposal,
) -> Result<CustomerLookupArguments, ToolPortError> {
    let arguments: CustomerLookupArguments =
        serde_json::from_value(proposal.arguments().clone()).map_err(|_| schema_rejected())?;
    if TenantId::parse(&arguments.customer_id).is_err() {
        return Err(schema_rejected());
    }
    Ok(arguments)
}

fn parse_follow_up_arguments(proposal: &ToolProposal) -> Result<FollowUpArguments, ToolPortError> {
    let arguments: FollowUpArguments =
        serde_json::from_value(proposal.arguments().clone()).map_err(|_| schema_rejected())?;
    if TenantId::parse(&arguments.customer_id).is_err()
        || !bounded_reason(&arguments.reason)
        || arguments.due_at_ms <= proposal.requested_at_ms()
        || i64::try_from(arguments.due_at_ms).is_err()
    {
        return Err(schema_rejected());
    }
    Ok(arguments)
}

fn parse_action_tenant(action: &AuthorizedToolAction) -> Result<TenantId, ToolPortError> {
    TenantId::parse(action.proposal().context().tenant_id())
        .map_err(|_| ToolPortError::new("agent_tool_tenant_invalid"))
}

fn map_follow_up_result(
    result: PostgresAgentFollowUpResult,
) -> Result<ActionObservation, ToolPortError> {
    match result {
        PostgresAgentFollowUpResult::Created(task_id) => {
            ToolActionOutput::try_new(json!({"task_id": task_id.as_str()}))
                .map(ActionObservation::Applied)
                .map_err(|_| ToolPortError::new("agent_tool_result_invalid"))
        }
        PostgresAgentFollowUpResult::NotFound => {
            ActionFailureCode::try_new("follow_up_task_not_found")
                .map(ActionObservation::NotApplied)
                .map_err(|_| ToolPortError::new("agent_tool_result_invalid"))
        }
        PostgresAgentFollowUpResult::OutcomeUnknown => Ok(ActionObservation::OutcomeUnknown),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CustomerLookupArguments {
    customer_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FollowUpArguments {
    customer_id: String,
    reason: String,
    due_at_ms: u64,
}

const fn schema_rejected() -> ToolPortError {
    ToolPortError::new("agent_tool_schema_rejected")
}

const fn provider_unavailable() -> ToolPortError {
    ToolPortError::new("agent_tool_provider_unavailable")
}

#[allow(clippy::needless_pass_by_value)]
fn map_provider_error(
    error: TransactionError<ProviderWorkError>,
) -> PostgresAgentToolProviderError {
    match error {
        TransactionError::Work(_)
        | TransactionError::AdmissionRejected
        | TransactionError::PoolUnavailable
        | TransactionError::DatabaseUnavailable
        | TransactionError::DeadlineExceeded
        | TransactionError::RollbackUnknown
        | TransactionError::CommitUnknown => PostgresAgentToolProviderError,
    }
}
