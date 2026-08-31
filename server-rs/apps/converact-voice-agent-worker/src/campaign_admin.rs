use std::{error::Error, fmt, future::Future};

use converact_ai_outbound_core::{
    AgentRelease, CampaignTransition, CreateCampaign, ImportContacts,
};
use converact_voice_agent_contracts::IdempotencyKey;
use serde::Serialize;

use crate::AuthenticatedTenant;

const MAX_IDENTIFIER_BYTES: usize = 255;
const MAX_STATE_BYTES: usize = 64;
const MAX_CONTACTS: u16 = 500;

/// Explicit authoring capabilities injected only after tenant authorization.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CampaignAdminAccess {
    publish_agent: bool,
    manage_campaign: bool,
    import_contacts: bool,
}

impl CampaignAdminAccess {
    #[must_use]
    pub const fn new(publish_agent: bool, manage_campaign: bool, import_contacts: bool) -> Self {
        Self {
            publish_agent,
            manage_campaign,
            import_contacts,
        }
    }

    #[must_use]
    pub const fn can_publish_agent(self) -> bool {
        self.publish_agent
    }

    #[must_use]
    pub const fn can_manage_campaign(self) -> bool {
        self.manage_campaign
    }

    #[must_use]
    pub const fn can_import_contacts(self) -> bool {
        self.import_contacts
    }
}

/// Sanitized Campaign authoring failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CampaignAdminError {
    kind: CampaignAdminErrorKind,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CampaignAdminErrorKind {
    Invalid,
    NotFound,
    Conflict,
    Stale,
    NotAllowed,
    Unavailable,
}

impl CampaignAdminError {
    #[must_use]
    pub const fn invalid() -> Self {
        Self {
            kind: CampaignAdminErrorKind::Invalid,
        }
    }

    #[must_use]
    pub const fn not_found() -> Self {
        Self {
            kind: CampaignAdminErrorKind::NotFound,
        }
    }

    #[must_use]
    pub const fn conflict() -> Self {
        Self {
            kind: CampaignAdminErrorKind::Conflict,
        }
    }

    #[must_use]
    pub const fn stale() -> Self {
        Self {
            kind: CampaignAdminErrorKind::Stale,
        }
    }

    #[must_use]
    pub const fn not_allowed() -> Self {
        Self {
            kind: CampaignAdminErrorKind::NotAllowed,
        }
    }

    #[must_use]
    pub const fn unavailable() -> Self {
        Self {
            kind: CampaignAdminErrorKind::Unavailable,
        }
    }

    #[must_use]
    pub const fn code(self) -> &'static str {
        match self.kind {
            CampaignAdminErrorKind::Invalid => "ai_outbound_admin_input_invalid",
            CampaignAdminErrorKind::NotFound => "ai_outbound_admin_resource_not_found",
            CampaignAdminErrorKind::Conflict => "ai_outbound_admin_conflict",
            CampaignAdminErrorKind::Stale => "ai_outbound_admin_stale",
            CampaignAdminErrorKind::NotAllowed => "ai_outbound_admin_not_allowed",
            CampaignAdminErrorKind::Unavailable => "ai_outbound_admin_unavailable",
        }
    }

    #[must_use]
    pub(crate) const fn kind(self) -> CampaignAdminErrorKind {
        self.kind
    }
}

impl fmt::Display for CampaignAdminError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for CampaignAdminError {}

/// PII-free result returned by the Campaign Admin API.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct AdminMutationResource {
    resource_id: Box<str>,
    state: Box<str>,
    revision: u64,
    accepted_count: u16,
    replayed: bool,
}

impl AdminMutationResource {
    /// Creates a bounded content-free mutation response.
    ///
    /// # Errors
    ///
    /// Rejects malformed identifiers, zero revision and counts above the import bound.
    pub fn try_new(
        resource_id: &str,
        state: &str,
        revision: u64,
        accepted_count: u16,
        replayed: bool,
    ) -> Result<Self, CampaignAdminError> {
        if !bounded_identifier(resource_id, MAX_IDENTIFIER_BYTES)
            || !bounded_identifier(state, MAX_STATE_BYTES)
            || revision == 0
            || accepted_count > MAX_CONTACTS
        {
            return Err(CampaignAdminError::invalid());
        }
        Ok(Self {
            resource_id: resource_id.into(),
            state: state.into(),
            revision,
            accepted_count,
            replayed,
        })
    }

    #[must_use]
    pub fn resource_id(&self) -> &str {
        &self.resource_id
    }

    #[must_use]
    pub fn state(&self) -> &str {
        &self.state
    }

    #[must_use]
    pub const fn revision(&self) -> u64 {
        self.revision
    }

    #[must_use]
    pub const fn accepted_count(&self) -> u16 {
        self.accepted_count
    }

    #[must_use]
    pub const fn replayed(&self) -> bool {
        self.replayed
    }
}

/// Tenant-scoped durable authoring boundary. Implementations own transactions and deadlines.
pub trait CampaignAdminPort: Send + Sync + 'static {
    fn publish_agent(
        &self,
        tenant: &AuthenticatedTenant,
        release: &AgentRelease,
        idempotency_key: &IdempotencyKey,
    ) -> impl Future<Output = Result<AdminMutationResource, CampaignAdminError>> + Send;

    fn create_campaign(
        &self,
        tenant: &AuthenticatedTenant,
        campaign: &CreateCampaign,
        idempotency_key: &IdempotencyKey,
    ) -> impl Future<Output = Result<AdminMutationResource, CampaignAdminError>> + Send;

    fn import_contacts(
        &self,
        tenant: &AuthenticatedTenant,
        command: &ImportContacts,
    ) -> impl Future<Output = Result<AdminMutationResource, CampaignAdminError>> + Send;

    fn transition_campaign(
        &self,
        tenant: &AuthenticatedTenant,
        command: &CampaignTransition,
    ) -> impl Future<Output = Result<AdminMutationResource, CampaignAdminError>> + Send;
}

fn bounded_identifier(value: &str, max_bytes: usize) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= max_bytes
        && first.is_ascii_alphanumeric()
        && remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}
