//! Atomic effect-receipt and outbox-transition persistence adapter.

use std::{error::Error, fmt};

use converact_idempotency::{EffectReceipt, EffectReceiptStage};
use converact_migration_store::WriterFenceBinding;
use converact_outbox_worker::{DeliveryFinalizationPlan, OutboxTransitionDecision};
use deadpool_postgres::Transaction;

use super::{
    PlatformStoreError, PostgresRuntime, TransactionError,
    platform_event::{
        EffectAppendStatus, FenceValues, append_effect_in_transaction, execute_writer_fence,
        load_effect_history_in_transaction, lock_effect_in_transaction,
    },
    platform_outbox::{
        OutboxSnapshot, OutboxStatus, OutboxTransitionApplyStatus, OutboxTransitionCommand,
        OutboxTransitionKind, OutboxTransitionReconcileStatus, TransitionValues,
        apply_transition_in_transaction, fence_tenant_id, lock_transition_in_transaction,
        query_outbox_in_transaction, reconcile_transition_in_transaction,
    },
};

/// Invalid finalization command without exposing receipt or delivery values.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OutboxDeliveryFinalizationCommandError;

impl fmt::Display for OutboxDeliveryFinalizationCommandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("outbox_delivery_finalization_command_invalid")
    }
}

impl Error for OutboxDeliveryFinalizationCommandError {}

/// One exact completed/transition/state-observed atomic write command.
pub struct OutboxDeliveryFinalizationCommand {
    completed_receipt: EffectReceipt,
    state_observed_receipt: EffectReceipt,
    transition_command: OutboxTransitionCommand,
    attempt_count: u16,
    max_attempts: u16,
}

impl fmt::Debug for OutboxDeliveryFinalizationCommand {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OutboxDeliveryFinalizationCommand([REDACTED])")
    }
}

impl OutboxDeliveryFinalizationCommand {
    /// Binds a private-field domain plan to exact receipts and one durable
    /// outbox transition command.
    ///
    /// # Errors
    ///
    /// Rejects stage, lineage, identity, digest or transition mismatches.
    pub fn new(
        plan: &DeliveryFinalizationPlan,
        completed_receipt: EffectReceipt,
        state_observed_receipt: EffectReceipt,
        transition_command: OutboxTransitionCommand,
    ) -> Result<Self, OutboxDeliveryFinalizationCommandError> {
        if completed_receipt.stage() != EffectReceiptStage::Completed
            || state_observed_receipt.stage() != EffectReceiptStage::StateObserved
            || !same_effect_lineage(&completed_receipt, &state_observed_receipt)
            || completed_receipt.receipt_id() == state_observed_receipt.receipt_id()
            || completed_receipt.receipt_digest() == state_observed_receipt.receipt_digest()
            || !transition_matches_plan(plan.transition(), &transition_command)
        {
            return Err(OutboxDeliveryFinalizationCommandError);
        }
        Ok(Self {
            completed_receipt,
            state_observed_receipt,
            transition_command,
            attempt_count: plan.attempt_count(),
            max_attempts: plan.max_attempts(),
        })
    }

    #[must_use]
    pub fn effect_id(&self) -> &str {
        self.completed_receipt.effect_id()
    }

    #[must_use]
    pub const fn transition_command(&self) -> &OutboxTransitionCommand {
        &self.transition_command
    }

    #[must_use]
    pub const fn attempt_count(&self) -> u16 {
        self.attempt_count
    }

    #[must_use]
    pub const fn max_attempts(&self) -> u16 {
        self.max_attempts
    }

    fn completed_receipt(&self) -> &EffectReceipt {
        &self.completed_receipt
    }

    fn state_observed_receipt(&self) -> &EffectReceipt {
        &self.state_observed_receipt
    }
}

/// Closed apply result for one atomic finalization transaction.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutboxDeliveryFinalizationApplyStatus {
    Applied,
    Replay,
}

/// Closed read-only result after an unknown finalization commit.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutboxDeliveryFinalizationReconcileStatus {
    Applied,
    NotApplied,
    Conflict,
}

impl PostgresRuntime {
    /// Atomically appends completed, applies the outbox transition and appends
    /// state-observed under one tenant transaction and exact writer fence.
    ///
    /// # Errors
    ///
    /// Returns a stable error for stale ownership, partial durable state,
    /// invalid transition, timeout or unavailable storage. Commit-unknown must
    /// be followed by [`Self::reconcile_outbox_delivery_finalization`].
    pub async fn apply_outbox_delivery_finalization(
        &self,
        fence: &WriterFenceBinding<'_>,
        command: &OutboxDeliveryFinalizationCommand,
    ) -> Result<OutboxDeliveryFinalizationApplyStatus, TransactionError<PlatformStoreError>> {
        let fence = FenceValues::new(fence).map_err(TransactionError::Work)?;
        validate_command_tenant(command, &fence).map_err(TransactionError::Work)?;
        let command = FinalizationValues::new(command).map_err(TransactionError::Work)?;
        let tenant_id = fence_tenant_id(&fence.tenant)?;
        self.with_tenant_transaction(&tenant_id, move |transaction| {
            Box::pin(async move {
                lock_finalization_in_transaction(transaction, &fence, &command).await?;
                match reconcile_finalization_in_transaction(transaction, &fence, &command).await? {
                    OutboxDeliveryFinalizationReconcileStatus::Applied => {
                        execute_writer_fence(transaction, &fence).await?;
                        Ok(OutboxDeliveryFinalizationApplyStatus::Replay)
                    }
                    OutboxDeliveryFinalizationReconcileStatus::Conflict => {
                        Err(PlatformStoreError::Conflict)
                    }
                    OutboxDeliveryFinalizationReconcileStatus::NotApplied => {
                        apply_finalization_in_transaction(transaction, &fence, &command).await
                    }
                }
            })
        })
        .await
    }

    /// Reconciles an ambiguous finalization commit without repeating an
    /// external provider effect or mutating durable delivery state.
    ///
    /// # Errors
    ///
    /// Returns a stable error for invalid command identity, timeout or
    /// unavailable/invalid storage.
    pub async fn reconcile_outbox_delivery_finalization(
        &self,
        fence: &WriterFenceBinding<'_>,
        command: &OutboxDeliveryFinalizationCommand,
    ) -> Result<OutboxDeliveryFinalizationReconcileStatus, TransactionError<PlatformStoreError>>
    {
        let fence = FenceValues::new(fence).map_err(TransactionError::Work)?;
        validate_command_tenant(command, &fence).map_err(TransactionError::Work)?;
        let command = FinalizationValues::new(command).map_err(TransactionError::Work)?;
        let tenant_id = fence_tenant_id(&fence.tenant)?;
        self.with_tenant_transaction(&tenant_id, move |transaction| {
            Box::pin(async move {
                lock_finalization_in_transaction(transaction, &fence, &command).await?;
                reconcile_finalization_in_transaction(transaction, &fence, &command).await
            })
        })
        .await
    }
}

struct FinalizationValues {
    completed_receipt: EffectReceipt,
    state_observed_receipt: EffectReceipt,
    transition: TransitionValues,
    attempt_count: u16,
    max_attempts: u16,
}

impl FinalizationValues {
    fn new(command: &OutboxDeliveryFinalizationCommand) -> Result<Self, PlatformStoreError> {
        Ok(Self {
            completed_receipt: command.completed_receipt().clone(),
            state_observed_receipt: command.state_observed_receipt().clone(),
            transition: TransitionValues::new(command.transition_command())?,
            attempt_count: command.attempt_count(),
            max_attempts: command.max_attempts(),
        })
    }
}

async fn lock_finalization_in_transaction(
    transaction: &Transaction<'_>,
    fence: &FenceValues,
    command: &FinalizationValues,
) -> Result<(), PlatformStoreError> {
    lock_effect_in_transaction(transaction, fence, command.completed_receipt.effect_id()).await?;
    lock_transition_in_transaction(transaction, fence, &command.transition).await
}

async fn reconcile_finalization_in_transaction(
    transaction: &Transaction<'_>,
    fence: &FenceValues,
    command: &FinalizationValues,
) -> Result<OutboxDeliveryFinalizationReconcileStatus, PlatformStoreError> {
    let history = load_effect_history_in_transaction(
        transaction,
        fence,
        command.completed_receipt.effect_id(),
    )
    .await?;
    let transition =
        reconcile_transition_in_transaction(transaction, fence, &command.transition).await?;
    let Some(outbox) =
        query_outbox_in_transaction(transaction, fence, command.transition.outbox_id()).await?
    else {
        return Ok(OutboxDeliveryFinalizationReconcileStatus::Conflict);
    };
    if !outbox_matches_command(&outbox, command, transition)? {
        return Ok(OutboxDeliveryFinalizationReconcileStatus::Conflict);
    }

    if history.len() == 1
        && accepted_matches_command(&history[0], command)
        && transition == OutboxTransitionReconcileStatus::NotApplied
    {
        return Ok(OutboxDeliveryFinalizationReconcileStatus::NotApplied);
    }
    if history.len() == 3
        && accepted_matches_command(&history[0], command)
        && history[1] == command.completed_receipt
        && history[2] == command.state_observed_receipt
        && transition == OutboxTransitionReconcileStatus::Applied
    {
        return Ok(OutboxDeliveryFinalizationReconcileStatus::Applied);
    }
    Ok(OutboxDeliveryFinalizationReconcileStatus::Conflict)
}

fn outbox_matches_command(
    outbox: &OutboxSnapshot,
    command: &FinalizationValues,
    transition: OutboxTransitionReconcileStatus,
) -> Result<bool, PlatformStoreError> {
    let claim_revision = u64::try_from(command.transition.claim_revision())
        .map_err(|_| PlatformStoreError::StoreInvalid)?;
    if outbox.event().event_id() != command.completed_receipt.event_id()
        || outbox.max_attempts() != command.max_attempts
    {
        return Ok(false);
    }
    match transition {
        OutboxTransitionReconcileStatus::NotApplied => Ok(outbox.status() == OutboxStatus::Claimed
            && outbox.attempt_count() == command.attempt_count
            && outbox.transition_revision() == claim_revision),
        OutboxTransitionReconcileStatus::Applied => {
            let Some(applied_revision) = claim_revision.checked_add(1) else {
                return Err(PlatformStoreError::StoreInvalid);
            };
            Ok(outbox.attempt_count() >= command.attempt_count
                && outbox.transition_revision() >= applied_revision
                && (outbox.transition_revision() > applied_revision
                    || outbox_status_matches_kind(outbox.status(), command.transition.kind())))
        }
        OutboxTransitionReconcileStatus::Conflict => Ok(false),
    }
}

fn outbox_status_matches_kind(status: OutboxStatus, kind: &str) -> bool {
    matches!(
        (status, kind),
        (OutboxStatus::Delivered, "complete")
            | (OutboxStatus::Pending, "retry")
            | (OutboxStatus::DeadLetter, "dead_letter")
    )
}

async fn apply_finalization_in_transaction(
    transaction: &Transaction<'_>,
    fence: &FenceValues,
    command: &FinalizationValues,
) -> Result<OutboxDeliveryFinalizationApplyStatus, PlatformStoreError> {
    if append_effect_in_transaction(transaction, fence, &command.completed_receipt).await?
        != EffectAppendStatus::Inserted
        || apply_transition_in_transaction(transaction, fence, &command.transition).await?
            != OutboxTransitionApplyStatus::Applied
        || append_effect_in_transaction(transaction, fence, &command.state_observed_receipt).await?
            != EffectAppendStatus::Inserted
    {
        return Err(PlatformStoreError::Conflict);
    }
    Ok(OutboxDeliveryFinalizationApplyStatus::Applied)
}

fn validate_command_tenant(
    command: &OutboxDeliveryFinalizationCommand,
    fence: &FenceValues,
) -> Result<(), PlatformStoreError> {
    if command.completed_receipt().tenant_id() == fence.tenant {
        Ok(())
    } else {
        Err(PlatformStoreError::InvalidInput)
    }
}

fn accepted_matches_command(accepted: &EffectReceipt, command: &FinalizationValues) -> bool {
    accepted.stage() == EffectReceiptStage::Accepted
        && same_effect_lineage(accepted, &command.completed_receipt)
        && accepted.receipt_id() != command.completed_receipt.receipt_id()
        && accepted.receipt_id() != command.state_observed_receipt.receipt_id()
        && accepted.receipt_digest() != command.completed_receipt.receipt_digest()
        && accepted.receipt_digest() != command.state_observed_receipt.receipt_digest()
}

fn same_effect_lineage(left: &EffectReceipt, right: &EffectReceipt) -> bool {
    left.tenant_id() == right.tenant_id()
        && left.effect_id() == right.effect_id()
        && left.event_id() == right.event_id()
        && left.correlation_id() == right.correlation_id()
        && left.generation() == right.generation()
        && left.writer_id() == right.writer_id()
        && left.owner_epoch() == right.owner_epoch()
}

fn transition_matches_plan(
    planned: &OutboxTransitionDecision,
    command: &OutboxTransitionCommand,
) -> bool {
    match planned {
        OutboxTransitionDecision::Complete => command.kind() == OutboxTransitionKind::Complete,
        OutboxTransitionDecision::Retry {
            error_code,
            retry_delay,
        } => {
            command.kind() == OutboxTransitionKind::Retry
                && command.error_code() == Some(error_code.as_str())
                && command.retry_delay() == *retry_delay
        }
        OutboxTransitionDecision::DeadLetter { error_code } => {
            command.kind() == OutboxTransitionKind::DeadLetter
                && command.error_code() == Some(error_code.as_str())
        }
    }
}
