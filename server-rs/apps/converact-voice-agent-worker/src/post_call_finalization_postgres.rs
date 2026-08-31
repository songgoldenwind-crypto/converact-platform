use converact_post_call_finalization_core::FinalizationResolution;
use converact_post_call_finalization_store::{
    ClaimedFinalizationJob, FinalizationLease, FinalizationLeaseCommand,
    FinalizationReconcileCommand,
};
use converact_postgres_store::{
    PostgresPostCallFinalizationStore, PostgresPostCallFinalizationStoreError,
};

use crate::{FinalizationQueuePort, FinalizationWorkerError};

impl FinalizationQueuePort for PostgresPostCallFinalizationStore {
    async fn claim_due(
        &self,
        tenant_id: &str,
        lease: &FinalizationLease,
        requested_limit: u16,
    ) -> Result<Vec<ClaimedFinalizationJob>, FinalizationWorkerError> {
        PostgresPostCallFinalizationStore::claim_due(self, tenant_id, lease, requested_limit)
            .await
            .map_err(queue_error)
    }

    async fn complete(
        &self,
        command: &FinalizationLeaseCommand,
        resolution: FinalizationResolution,
    ) -> Result<(), FinalizationWorkerError> {
        PostgresPostCallFinalizationStore::complete(self, command, resolution)
            .await
            .map(drop)
            .map_err(queue_error)
    }

    async fn require_reconcile(
        &self,
        command: &FinalizationReconcileCommand,
    ) -> Result<(), FinalizationWorkerError> {
        PostgresPostCallFinalizationStore::require_reconcile(self, command)
            .await
            .map(drop)
            .map_err(queue_error)
    }
}

fn queue_error(error: PostgresPostCallFinalizationStoreError) -> FinalizationWorkerError {
    FinalizationWorkerError::new(error.code())
}
