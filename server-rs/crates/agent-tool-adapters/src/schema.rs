use converact_contracts::canonical_sha256_with_max_bytes;
use converact_tool_broker_core::{
    ToolDefinition, ToolEffectClass, ToolPortError, ToolProposal, ToolSchemaPort,
};
use serde::Deserialize;
use serde_json::Value;

use crate::{CustomerLookup, FollowUpRequest};

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

/// Code-owned schema gate for deployment-registered Agent Tool adapters.
#[derive(Clone, Copy, Debug, Default)]
pub struct AgentToolSchema;

impl AgentToolSchema {
    #[must_use]
    pub const fn new() -> Self {
        Self
    }

    /// Returns the canonical digest of one code-owned schema.
    #[must_use]
    pub fn schema_hash(self, action_capability: &str) -> Option<String> {
        let (_, schema) = registered_schema(action_capability)?;
        canonical_sha256_with_max_bytes(&schema, MAX_SCHEMA_BYTES).ok()
    }
}

impl ToolSchemaPort for AgentToolSchema {
    async fn validate(
        &self,
        definition: &ToolDefinition,
        proposal: &ToolProposal,
    ) -> Result<(), ToolPortError> {
        let (effect, schema) =
            registered_schema(definition.action_capability()).ok_or_else(rejected)?;
        let schema_hash =
            canonical_sha256_with_max_bytes(&schema, MAX_SCHEMA_BYTES).map_err(|_| rejected())?;
        if definition.effect_class() != effect
            || definition.schema_hash() != schema_hash
            || proposal.tool_schema_hash() != schema_hash
            || definition.revision_id() != proposal.tool_revision_id()
            || definition.agent_release_id() != proposal.context().agent_release_id()
        {
            return Err(rejected());
        }
        match definition.action_capability() {
            CUSTOMER_LOOKUP => validate_customer_lookup(proposal),
            CREATE_FOLLOW_UP => validate_follow_up(proposal),
            _ => Err(rejected()),
        }
    }
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

fn validate_customer_lookup(proposal: &ToolProposal) -> Result<(), ToolPortError> {
    let arguments: CustomerLookupArguments =
        serde_json::from_value(proposal.arguments().clone()).map_err(|_| rejected())?;
    CustomerLookup::try_new(proposal.context().tenant_id(), &arguments.customer_id)
        .map(|_| ())
        .map_err(|_| rejected())
}

fn validate_follow_up(proposal: &ToolProposal) -> Result<(), ToolPortError> {
    let arguments: FollowUpArguments =
        serde_json::from_value(proposal.arguments().clone()).map_err(|_| rejected())?;
    FollowUpRequest::try_new(
        proposal.context().tenant_id(),
        &arguments.customer_id,
        &arguments.reason,
        arguments.due_at_ms,
        proposal.tool_call_id().clone(),
    )
    .map(|_| ())
    .map_err(|_| rejected())
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

const fn rejected() -> ToolPortError {
    ToolPortError::new("agent_tool_schema_rejected")
}
