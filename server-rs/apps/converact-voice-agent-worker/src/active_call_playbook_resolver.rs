use std::{error::Error, fmt, future::Future};

use converact_ai_outbound_core::AgentReleaseBinding;

use crate::{ActiveCallPlaybookArtifact, AuthenticatedTenant};

const MAX_COMPILER_REVISION_BYTES: usize = 128;

/// Sanitized failure from the tenant-scoped Active Call artifact resolver.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActiveCallPlaybookResolverError {
    InvalidConfiguration,
    Unavailable,
    NotFound,
    SourceDrift,
    CompilerDrift,
    ArtifactInvalid,
}

impl ActiveCallPlaybookResolverError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidConfiguration => "active_call_artifact_resolver_configuration_invalid",
            Self::Unavailable => "active_call_artifact_source_unavailable",
            Self::NotFound => "active_call_artifact_not_found",
            Self::SourceDrift => "active_call_artifact_source_drift",
            Self::CompilerDrift => "active_call_artifact_compiler_drift",
            Self::ArtifactInvalid => "active_call_artifact_invalid",
        }
    }
}

impl fmt::Display for ActiveCallPlaybookResolverError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for ActiveCallPlaybookResolverError {}

/// Untrusted artifact record loaded from a tenant-scoped content store.
#[derive(Clone, Eq, PartialEq)]
pub struct ActiveCallArtifactSource {
    release: AgentReleaseBinding,
    compiler_revision: Box<str>,
    content: Box<str>,
    artifact_hash: Box<str>,
}

impl ActiveCallArtifactSource {
    #[must_use]
    pub fn new(
        release: AgentReleaseBinding,
        compiler_revision: impl AsRef<str>,
        content: impl AsRef<str>,
        artifact_hash: impl AsRef<str>,
    ) -> Self {
        Self {
            release,
            compiler_revision: compiler_revision.as_ref().into(),
            content: content.as_ref().into(),
            artifact_hash: artifact_hash.as_ref().into(),
        }
    }
}

impl fmt::Debug for ActiveCallArtifactSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ActiveCallArtifactSource([REDACTED])")
    }
}

/// Tenant-scoped source of one compiled Active Call artifact candidate.
pub trait ActiveCallArtifactSourcePort: Send + Sync {
    fn load(
        &self,
        tenant: &AuthenticatedTenant,
        release: &AgentReleaseBinding,
    ) -> impl Future<
        Output = Result<Option<ActiveCallArtifactSource>, ActiveCallPlaybookResolverError>,
    > + Send;
}

/// Verifies stored provenance before constructing a bounded runtime artifact.
pub struct ActiveCallPlaybookResolver<S> {
    source: S,
    compiler_revision: Box<str>,
}

impl<S> ActiveCallPlaybookResolver<S>
where
    S: ActiveCallArtifactSourcePort,
{
    /// Pins this resolver to one reviewed deterministic compiler revision.
    ///
    /// # Errors
    ///
    /// Rejects empty, unbounded or non-canonical revision identifiers.
    pub fn new(
        source: S,
        compiler_revision: impl AsRef<str>,
    ) -> Result<Self, ActiveCallPlaybookResolverError> {
        let compiler_revision = compiler_revision.as_ref();
        if !valid_compiler_revision(compiler_revision) {
            return Err(ActiveCallPlaybookResolverError::InvalidConfiguration);
        }
        Ok(Self {
            source,
            compiler_revision: compiler_revision.into(),
        })
    }

    /// Loads and validates the exact tenant/Release/compiler artifact candidate.
    ///
    /// # Errors
    ///
    /// Fails closed on missing data, provenance drift, source failure or invalid content digest.
    pub async fn resolve(
        &self,
        tenant: &AuthenticatedTenant,
        release: &AgentReleaseBinding,
    ) -> Result<ActiveCallPlaybookArtifact, ActiveCallPlaybookResolverError> {
        let source = self
            .source
            .load(tenant, release)
            .await?
            .ok_or(ActiveCallPlaybookResolverError::NotFound)?;
        if &source.release != release {
            return Err(ActiveCallPlaybookResolverError::SourceDrift);
        }
        if source.compiler_revision.as_ref() != self.compiler_revision.as_ref() {
            return Err(ActiveCallPlaybookResolverError::CompilerDrift);
        }
        ActiveCallPlaybookArtifact::try_new(source.release, source.content, source.artifact_hash)
            .map_err(|_| ActiveCallPlaybookResolverError::ArtifactInvalid)
    }
}

fn valid_compiler_revision(value: &str) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= MAX_COMPILER_REVISION_BYTES
        && first.is_ascii_alphanumeric()
        && remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}
