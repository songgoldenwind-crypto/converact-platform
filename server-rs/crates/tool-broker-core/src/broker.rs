use std::{error::Error, fmt};

use crate::{
    ActionReceipt, ApprovalPort, PolicyPort, ToolActionPort, ToolActionStorePort,
    ToolAuthorizationError, ToolCatalogPort, ToolGate, ToolProposal, ToolSchemaPort,
};

/// Atomic Store decision. Only `Prepared` grants execute permission.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PrepareDecision {
    Prepared,
    Replay(Box<ActionReceipt>),
    ReconcileRequired,
    Conflict,
}

/// Result classification returned to the current Agent generation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BrokerResult {
    Consumable(Box<ActionReceipt>),
    Historical(Box<ActionReceipt>),
    Pending,
}

/// Tool Broker coordinator. External execution remains behind Store permission.
pub struct ToolBroker<C, S, P, A, D, X> {
    gate: ToolGate<C, S, P, A>,
    store: D,
    action: X,
}

impl<C, S, P, A, D, X> ToolBroker<C, S, P, A, D, X>
where
    C: ToolCatalogPort,
    S: ToolSchemaPort,
    P: PolicyPort,
    A: ApprovalPort,
    D: ToolActionStorePort,
    X: ToolActionPort,
{
    #[must_use]
    pub const fn new(catalog: C, schema: S, policy: P, approval: A, store: D, action: X) -> Self {
        Self {
            gate: ToolGate::new(catalog, schema, policy, approval),
            store,
            action,
        }
    }

    /// Authorizes, prepares, executes and atomically finalizes one Tool Proposal.
    ///
    /// # Errors
    ///
    /// Returns bounded authority or dependency errors. Unknown outcomes remain pending.
    pub async fn execute(
        &self,
        proposal: ToolProposal,
        now_ms: u64,
    ) -> Result<BrokerResult, BrokerError> {
        let action = self
            .gate
            .authorize(proposal, now_ms)
            .await
            .map_err(BrokerError::Authorization)?;
        match self
            .store
            .prepare(&action, now_ms)
            .await
            .map_err(|_| BrokerError::StoreUnavailable)?
        {
            PrepareDecision::Prepared => {
                let observation = self
                    .action
                    .execute(&action)
                    .await
                    .map_err(|_| BrokerError::ActionUnavailable)?;
                if !observation.is_definitive() {
                    return Ok(BrokerResult::Pending);
                }
                let receipt = self
                    .store
                    .finalize(&action, observation, now_ms)
                    .await
                    .map_err(|_| BrokerError::StoreUnavailable)?;
                classify_receipt(&action, receipt)
            }
            PrepareDecision::Replay(receipt) => classify_receipt(&action, *receipt),
            PrepareDecision::ReconcileRequired => {
                let observation = self
                    .action
                    .query(&action)
                    .await
                    .map_err(|_| BrokerError::ActionUnavailable)?;
                if !observation.is_definitive() {
                    return Ok(BrokerResult::Pending);
                }
                let receipt = self
                    .store
                    .finalize(&action, observation, now_ms)
                    .await
                    .map_err(|_| BrokerError::StoreUnavailable)?;
                classify_receipt(&action, receipt)
            }
            PrepareDecision::Conflict => Err(BrokerError::Conflict),
        }
    }
}

fn classify_receipt(
    action: &crate::AuthorizedToolAction,
    receipt: ActionReceipt,
) -> Result<BrokerResult, BrokerError> {
    if !receipt.matches_authority(action) {
        return Err(BrokerError::Conflict);
    }
    if receipt.generation() == action.proposal().context().execution_generation() {
        Ok(BrokerResult::Consumable(Box::new(receipt)))
    } else {
        Ok(BrokerResult::Historical(Box::new(receipt)))
    }
}

/// Stable Broker failure safe for logs and Agent fallback behavior.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BrokerError {
    Authorization(ToolAuthorizationError),
    StoreUnavailable,
    ActionUnavailable,
    Conflict,
}

impl BrokerError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::Authorization(error) => error.code(),
            Self::StoreUnavailable => "tool_store_unavailable",
            Self::ActionUnavailable => "tool_action_unavailable",
            Self::Conflict => "tool_action_conflict",
        }
    }
}

impl fmt::Display for BrokerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for BrokerError {}
