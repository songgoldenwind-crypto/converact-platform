use converact_tool_broker_core::{
    ActionObservation, AuthorizedToolAction, ToolActionOutput, ToolActionPort, ToolEffectClass,
    ToolPortError,
};
use serde::Deserialize;
use serde_json::json;

use crate::{
    CustomerDirectoryPort, CustomerLookup, CustomerLookupResult, FollowUpExecuteResult,
    FollowUpQuery, FollowUpRequest, FollowUpTaskPort,
};

const CUSTOMER_LOOKUP: &str = "customer.lookup";
const CREATE_FOLLOW_UP: &str = "task.create_follow_up";

/// Compile-time registry for the first industry-neutral Agent business Tools.
pub struct AgentToolAdapter<Q, M> {
    customer_directory: Q,
    follow_up_tasks: M,
}

impl<Q, M> AgentToolAdapter<Q, M> {
    #[must_use]
    pub const fn new(customer_directory: Q, follow_up_tasks: M) -> Self {
        Self {
            customer_directory,
            follow_up_tasks,
        }
    }
}

impl<Q, M> ToolActionPort for AgentToolAdapter<Q, M>
where
    Q: CustomerDirectoryPort + Sync,
    M: FollowUpTaskPort + Sync,
{
    async fn execute(
        &self,
        action: &AuthorizedToolAction,
    ) -> Result<ActionObservation, ToolPortError> {
        match action.definition().action_capability() {
            CUSTOMER_LOOKUP if action.definition().effect_class() == ToolEffectClass::Query => {
                self.lookup(action).await
            }
            CREATE_FOLLOW_UP if action.definition().effect_class() == ToolEffectClass::Mutation => {
                let arguments: FollowUpArguments =
                    serde_json::from_value(action.proposal().arguments().clone())
                        .map_err(|_| invalid_input())?;
                let request = FollowUpRequest::try_new(
                    action.proposal().context().tenant_id(),
                    &arguments.customer_id,
                    &arguments.reason,
                    arguments.due_at_ms,
                    action.proposal().tool_call_id().clone(),
                )
                .map_err(|_| invalid_input())?;
                self.follow_up_tasks
                    .create(request)
                    .await
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
                self.lookup(action).await
            }
            CREATE_FOLLOW_UP if action.definition().effect_class() == ToolEffectClass::Mutation => {
                let request = FollowUpQuery::try_new(
                    action.proposal().context().tenant_id(),
                    action.proposal().tool_call_id().clone(),
                )
                .map_err(|_| invalid_input())?;
                self.follow_up_tasks
                    .query(request)
                    .await
                    .and_then(map_follow_up_result)
            }
            _ => Err(ToolPortError::new("agent_tool_capability_rejected")),
        }
    }
}

impl<Q, M> AgentToolAdapter<Q, M>
where
    Q: CustomerDirectoryPort + Sync,
{
    async fn lookup(
        &self,
        action: &AuthorizedToolAction,
    ) -> Result<ActionObservation, ToolPortError> {
        let arguments: CustomerLookupArguments =
            serde_json::from_value(action.proposal().arguments().clone())
                .map_err(|_| invalid_input())?;
        let request = CustomerLookup::try_new(
            action.proposal().context().tenant_id(),
            &arguments.customer_id,
        )
        .map_err(|_| invalid_input())?;
        let result = self.customer_directory.lookup(request).await?;
        let value = match result {
            CustomerLookupResult::Found(snapshot) => json!({
                "found": true,
                "customer_id": snapshot.customer_id(),
                "status": snapshot.status(),
                "segment": snapshot.segment(),
                "preferred_language": snapshot.preferred_language(),
            }),
            CustomerLookupResult::NotFound => json!({"found": false}),
        };
        ToolActionOutput::try_new(value)
            .map(ActionObservation::Applied)
            .map_err(|_| ToolPortError::new("agent_tool_result_invalid"))
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

fn map_follow_up_result(result: FollowUpExecuteResult) -> Result<ActionObservation, ToolPortError> {
    match result {
        FollowUpExecuteResult::Created(task_id) => ToolActionOutput::try_new(json!({
            "task_id": task_id.as_str(),
        }))
        .map(ActionObservation::Applied)
        .map_err(|_| ToolPortError::new("agent_tool_result_invalid")),
        FollowUpExecuteResult::NotApplied(code) => Ok(ActionObservation::NotApplied(code)),
        FollowUpExecuteResult::OutcomeUnknown => Ok(ActionObservation::OutcomeUnknown),
    }
}

const fn invalid_input() -> ToolPortError {
    ToolPortError::new("agent_tool_arguments_invalid")
}
