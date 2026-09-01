use std::fmt;

use converact_kernel_ids::TenantId;
use converact_postgres_store::{PostgresAiOutboundAttemptStore, PostgresLeasedAttemptStore};
use ring::rand::{SecureRandom, SystemRandom};

use crate::{AttemptClaimSource, WorkerError};

const MAX_LEASE_OWNER_BYTES: usize = 255;

/// Produces one fresh lowercase SHA-256-shaped lease digest per atomic claim operation.
pub trait LeaseTokenDigestSource: Send + Sync + 'static {
    /// # Errors
    ///
    /// Returns a stable failure when secure random generation is unavailable.
    fn next_digest(&self) -> Result<String, WorkerError>;
}

/// Operating-system secure random lease digest source.
pub struct SystemLeaseTokenDigestSource {
    random: SystemRandom,
}

impl SystemLeaseTokenDigestSource {
    #[must_use]
    pub fn new() -> Self {
        Self {
            random: SystemRandom::new(),
        }
    }
}

impl Default for SystemLeaseTokenDigestSource {
    fn default() -> Self {
        Self::new()
    }
}

impl LeaseTokenDigestSource for SystemLeaseTokenDigestSource {
    fn next_digest(&self) -> Result<String, WorkerError> {
        let mut bytes = [0_u8; 32];
        self.random
            .fill(&mut bytes)
            .map_err(|_| WorkerError::new("voice_agent_lease_random_unavailable"))?;
        Ok(hex::encode(bytes))
    }
}

impl fmt::Debug for SystemLeaseTokenDigestSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SystemLeaseTokenDigestSource")
    }
}

/// Tenant-local `PostgreSQL` claim source that creates a fresh lease fence for every batch.
pub struct PostgresAttemptClaimSource<G> {
    store: PostgresAiOutboundAttemptStore,
    tenant_id: TenantId,
    lease_owner: Box<str>,
    digest_source: G,
}

impl<G> PostgresAttemptClaimSource<G> {
    /// Creates an inert source without opening a database connection.
    ///
    /// # Errors
    ///
    /// Rejects an owner outside the durable lease identifier grammar.
    pub fn try_new(
        store: PostgresAiOutboundAttemptStore,
        tenant_id: TenantId,
        lease_owner: &str,
        digest_source: G,
    ) -> Result<Self, WorkerError> {
        if !valid_lease_owner(lease_owner) {
            return Err(WorkerError::new("voice_agent_lease_owner_invalid"));
        }
        Ok(Self {
            store,
            tenant_id,
            lease_owner: lease_owner.into(),
            digest_source,
        })
    }
}

impl<G> AttemptClaimSource for PostgresAttemptClaimSource<G>
where
    G: LeaseTokenDigestSource,
{
    type Claim = PostgresLeasedAttemptStore;

    async fn claim(&self, limit: u16) -> Result<Vec<Self::Claim>, WorkerError> {
        let digest = self.digest_source.next_digest()?;
        self.store
            .claim_planned(&self.tenant_id, &self.lease_owner, &digest, limit)
            .await
            .map_err(|error| WorkerError::new(error.code()))
    }
}

impl<G> fmt::Debug for PostgresAttemptClaimSource<G> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PostgresAttemptClaimSource")
            .finish_non_exhaustive()
    }
}

fn valid_lease_owner(value: &str) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= MAX_LEASE_OWNER_BYTES
        && first.is_ascii_alphanumeric()
        && remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}
