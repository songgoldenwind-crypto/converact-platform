//! Tenant-scoped durable post-call finalization queue.

#![forbid(unsafe_code)]

mod model;
mod postgres;

pub use model::{
    ClaimedFinalizationJob, EnqueueFinalizationDecision, FinalizationLease,
    FinalizationLeaseCommand, FinalizationReconcileCommand, FinalizationStoreConfig,
    FinalizationStoreError,
};
pub use postgres::FinalizationSqlStore;
