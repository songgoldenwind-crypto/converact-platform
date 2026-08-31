use std::future::Future;

use converact_tool_broker_core::ToolPortError;

use crate::{
    CustomerLookup, CustomerLookupResult, FollowUpExecuteResult, FollowUpQuery, FollowUpRequest,
};

/// Read-only customer directory boundary.
pub trait CustomerDirectoryPort {
    fn lookup(
        &self,
        request: CustomerLookup,
    ) -> impl Future<Output = Result<CustomerLookupResult, ToolPortError>> + Send;
}

/// Idempotent follow-up Task authority with explicit unknown-outcome query.
pub trait FollowUpTaskPort {
    fn create(
        &self,
        request: FollowUpRequest,
    ) -> impl Future<Output = Result<FollowUpExecuteResult, ToolPortError>> + Send;

    fn query(
        &self,
        request: FollowUpQuery,
    ) -> impl Future<Output = Result<FollowUpExecuteResult, ToolPortError>> + Send;
}
