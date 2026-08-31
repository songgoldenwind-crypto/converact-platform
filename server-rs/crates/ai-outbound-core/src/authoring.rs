use std::{collections::HashSet, error::Error, fmt};

use converact_contracts::canonical_sha256;
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CampaignContactId, CampaignId, IdempotencyKey, InteractionId,
};
use serde::Serialize;
use serde_json::json;

use crate::CampaignCommand;

const MAX_BATCH_SIZE: usize = 500;
const MAX_IDENTIFIER_BYTES: usize = 255;
const MAX_DESTINATION_BYTES: usize = 255;
const MAX_TIME_ZONE_BYTES: usize = 64;

/// Stable validation failures for Campaign authoring input.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuthoringError {
    InvalidSchedule,
    InvalidAudience,
    InvalidDialPolicy,
    InvalidRevision,
    InvalidBatchSize,
    DuplicateIdentity,
    InvalidExternalContact,
    InvalidDestination,
    InvalidConsent,
    InvalidRetention,
    RequestHashFailed,
}

impl fmt::Display for AuthoringError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidSchedule => "ai_outbound_campaign_schedule_invalid",
            Self::InvalidAudience => "ai_outbound_audience_invalid",
            Self::InvalidDialPolicy => "ai_outbound_dial_policy_invalid",
            Self::InvalidRevision => "ai_outbound_campaign_revision_invalid",
            Self::InvalidBatchSize => "ai_outbound_contact_batch_size_invalid",
            Self::DuplicateIdentity => "ai_outbound_contact_identity_duplicate",
            Self::InvalidExternalContact => "ai_outbound_external_contact_invalid",
            Self::InvalidDestination => "ai_outbound_destination_invalid",
            Self::InvalidConsent => "ai_outbound_consent_invalid",
            Self::InvalidRetention => "ai_outbound_retention_invalid",
            Self::RequestHashFailed => "ai_outbound_authoring_hash_failed",
        })
    }
}

impl Error for AuthoringError {}

/// Closed recording behavior persisted with every Contact and physical Attempt.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordingMode {
    Disabled,
    Always,
    AfterDisclosure,
    OnDemand,
}

impl RecordingMode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Always => "always",
            Self::AfterDisclosure => "after_disclosure",
            Self::OnDemand => "on_demand",
        }
    }
}

/// Bounded Campaign start schedule independent from a Provider clock.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct CampaignSchedule {
    starts_at_ms: u64,
    time_zone: Box<str>,
}

impl CampaignSchedule {
    /// Creates a non-zero Unix-millisecond start and bounded IANA-style zone name.
    ///
    /// # Errors
    ///
    /// Rejects zero timestamps and malformed zone identifiers.
    pub fn try_new(starts_at_ms: u64, time_zone: &str) -> Result<Self, AuthoringError> {
        if starts_at_ms == 0 || !valid_time_zone(time_zone) {
            return Err(AuthoringError::InvalidSchedule);
        }
        Ok(Self {
            starts_at_ms,
            time_zone: time_zone.into(),
        })
    }

    #[must_use]
    pub const fn starts_at_ms(&self) -> u64 {
        self.starts_at_ms
    }

    #[must_use]
    pub fn time_zone(&self) -> &str {
        &self.time_zone
    }
}

/// Validated creation of one draft Campaign bound to an immutable Agent Release.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreateCampaign {
    campaign_id: CampaignId,
    agent_release_id: AgentReleaseId,
    audience_id: Box<str>,
    dial_policy_revision: Box<str>,
    schedule: CampaignSchedule,
    request_hash: Box<str>,
}

impl CreateCampaign {
    /// Validates and content-addresses a draft Campaign proposal.
    ///
    /// # Errors
    ///
    /// Rejects malformed bounded references or canonical hashing failure.
    pub fn try_new(
        campaign_id: CampaignId,
        agent_release_id: AgentReleaseId,
        audience_id: &str,
        dial_policy_revision: &str,
        schedule: CampaignSchedule,
    ) -> Result<Self, AuthoringError> {
        if !valid_identifier(audience_id) {
            return Err(AuthoringError::InvalidAudience);
        }
        if !valid_identifier(dial_policy_revision) {
            return Err(AuthoringError::InvalidDialPolicy);
        }
        let request_hash = canonical_sha256(&json!({
            "campaign_id": campaign_id,
            "agent_release_id": agent_release_id,
            "audience_id": audience_id,
            "dial_policy_revision": dial_policy_revision,
            "schedule": schedule,
        }))
        .map_err(|_| AuthoringError::RequestHashFailed)?
        .into();
        Ok(Self {
            campaign_id,
            agent_release_id,
            audience_id: audience_id.into(),
            dial_policy_revision: dial_policy_revision.into(),
            schedule,
            request_hash,
        })
    }

    #[must_use]
    pub const fn campaign_id(&self) -> &CampaignId {
        &self.campaign_id
    }

    #[must_use]
    pub const fn agent_release_id(&self) -> &AgentReleaseId {
        &self.agent_release_id
    }

    #[must_use]
    pub fn audience_id(&self) -> &str {
        &self.audience_id
    }

    #[must_use]
    pub fn dial_policy_revision(&self) -> &str {
        &self.dial_policy_revision
    }

    #[must_use]
    pub const fn schedule(&self) -> &CampaignSchedule {
        &self.schedule
    }

    #[must_use]
    pub fn request_hash(&self) -> &str {
        &self.request_hash
    }
}

/// Untrusted owned input for one Campaign Contact and its first physical Attempt.
pub struct ImportContactInput {
    pub contact_id: CampaignContactId,
    pub external_contact_id: String,
    pub destination: String,
    pub consent_id: String,
    pub recording_mode: RecordingMode,
    pub retention_until_ms: u64,
    pub scheduled_for_ms: u64,
    pub attempt_id: CallAttemptId,
    pub interaction_id: InteractionId,
    pub idempotency_key: IdempotencyKey,
}

/// Validated Contact import item. Debug deliberately omits customer and consent data.
#[derive(Clone, Eq, PartialEq)]
pub struct ImportContact {
    contact_id: CampaignContactId,
    external_contact_id: Box<str>,
    destination: Box<str>,
    consent_id: Box<str>,
    recording_mode: RecordingMode,
    retention_until_ms: u64,
    scheduled_for_ms: u64,
    attempt_id: CallAttemptId,
    interaction_id: InteractionId,
    idempotency_key: IdempotencyKey,
}

impl ImportContact {
    /// Validates a Contact and its first Attempt binding.
    ///
    /// # Errors
    ///
    /// Rejects malformed identifiers/destination and retention not later than scheduled work.
    pub fn try_new(input: ImportContactInput) -> Result<Self, AuthoringError> {
        if !valid_identifier(&input.external_contact_id) {
            return Err(AuthoringError::InvalidExternalContact);
        }
        if !valid_destination(&input.destination) {
            return Err(AuthoringError::InvalidDestination);
        }
        if !valid_identifier(&input.consent_id) {
            return Err(AuthoringError::InvalidConsent);
        }
        if input.scheduled_for_ms == 0 || input.retention_until_ms <= input.scheduled_for_ms {
            return Err(AuthoringError::InvalidRetention);
        }
        Ok(Self {
            contact_id: input.contact_id,
            external_contact_id: input.external_contact_id.into(),
            destination: input.destination.into(),
            consent_id: input.consent_id.into(),
            recording_mode: input.recording_mode,
            retention_until_ms: input.retention_until_ms,
            scheduled_for_ms: input.scheduled_for_ms,
            attempt_id: input.attempt_id,
            interaction_id: input.interaction_id,
            idempotency_key: input.idempotency_key,
        })
    }

    #[must_use]
    pub const fn contact_id(&self) -> &CampaignContactId {
        &self.contact_id
    }

    #[must_use]
    pub fn external_contact_id(&self) -> &str {
        &self.external_contact_id
    }

    #[must_use]
    pub fn destination(&self) -> &str {
        &self.destination
    }

    #[must_use]
    pub fn consent_id(&self) -> &str {
        &self.consent_id
    }

    #[must_use]
    pub const fn recording_mode(&self) -> RecordingMode {
        self.recording_mode
    }

    #[must_use]
    pub const fn retention_until_ms(&self) -> u64 {
        self.retention_until_ms
    }

    #[must_use]
    pub const fn scheduled_for_ms(&self) -> u64 {
        self.scheduled_for_ms
    }

    #[must_use]
    pub const fn attempt_id(&self) -> &CallAttemptId {
        &self.attempt_id
    }

    #[must_use]
    pub const fn interaction_id(&self) -> &InteractionId {
        &self.interaction_id
    }

    #[must_use]
    pub const fn idempotency_key(&self) -> &IdempotencyKey {
        &self.idempotency_key
    }
}

impl fmt::Debug for ImportContact {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ImportContact")
            .field("contact_id", &self.contact_id)
            .field("attempt_id", &self.attempt_id)
            .field("interaction_id", &self.interaction_id)
            .field("recording_mode", &self.recording_mode)
            .field("scheduled_for_ms", &self.scheduled_for_ms)
            .finish_non_exhaustive()
    }
}

/// One all-or-nothing bounded Contact import command.
#[derive(Clone, Eq, PartialEq)]
pub struct ImportContacts {
    campaign_id: CampaignId,
    expected_campaign_revision: u64,
    idempotency_key: IdempotencyKey,
    contacts: Vec<ImportContact>,
    request_hash: Box<str>,
}

impl ImportContacts {
    /// Validates identities across an entire bounded batch and computes one request hash.
    ///
    /// # Errors
    ///
    /// Rejects empty/oversized input, zero revision, duplicate identities or hashing failure.
    pub fn try_new(
        campaign_id: CampaignId,
        expected_campaign_revision: u64,
        idempotency_key: IdempotencyKey,
        contacts: Vec<ImportContact>,
    ) -> Result<Self, AuthoringError> {
        if contacts.is_empty() || contacts.len() > MAX_BATCH_SIZE {
            return Err(AuthoringError::InvalidBatchSize);
        }
        if expected_campaign_revision == 0 {
            return Err(AuthoringError::InvalidRevision);
        }
        reject_duplicate_identities(&contacts)?;
        let contact_hashes: Result<Vec<_>, _> = contacts
            .iter()
            .map(|contact| {
                canonical_sha256(&json!({
                    "contact_id": contact.contact_id,
                    "external_contact_id": contact.external_contact_id,
                    "destination": contact.destination,
                    "consent_id": contact.consent_id,
                    "recording_mode": contact.recording_mode,
                    "retention_until_ms": contact.retention_until_ms,
                    "scheduled_for_ms": contact.scheduled_for_ms,
                    "attempt_id": contact.attempt_id,
                    "interaction_id": contact.interaction_id,
                    "attempt_idempotency_key": contact.idempotency_key,
                }))
            })
            .collect();
        let contact_hashes = contact_hashes.map_err(|_| AuthoringError::RequestHashFailed)?;
        let request_hash = canonical_sha256(&json!({
            "campaign_id": campaign_id,
            "expected_campaign_revision": expected_campaign_revision,
            "contact_hashes": contact_hashes,
        }))
        .map_err(|_| AuthoringError::RequestHashFailed)?
        .into();
        Ok(Self {
            campaign_id,
            expected_campaign_revision,
            idempotency_key,
            contacts,
            request_hash,
        })
    }

    #[must_use]
    pub const fn campaign_id(&self) -> &CampaignId {
        &self.campaign_id
    }

    #[must_use]
    pub const fn expected_campaign_revision(&self) -> u64 {
        self.expected_campaign_revision
    }

    #[must_use]
    pub const fn idempotency_key(&self) -> &IdempotencyKey {
        &self.idempotency_key
    }

    #[must_use]
    pub fn contacts(&self) -> &[ImportContact] {
        &self.contacts
    }

    #[must_use]
    pub fn request_hash(&self) -> &str {
        &self.request_hash
    }
}

impl fmt::Debug for ImportContacts {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ImportContacts")
            .field("campaign_id", &self.campaign_id)
            .field(
                "expected_campaign_revision",
                &self.expected_campaign_revision,
            )
            .field("contact_count", &self.contacts.len())
            .field("request_hash", &self.request_hash)
            .finish_non_exhaustive()
    }
}

/// Idempotent requested transition for one durable Campaign revision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CampaignTransition {
    campaign_id: CampaignId,
    command: CampaignCommand,
    expected_revision: u64,
    idempotency_key: IdempotencyKey,
    request_hash: Box<str>,
}

impl CampaignTransition {
    /// Creates a revision-fenced Campaign transition.
    ///
    /// # Errors
    ///
    /// Rejects zero revision or canonical hashing failure.
    pub fn try_new(
        campaign_id: CampaignId,
        command: CampaignCommand,
        expected_revision: u64,
        idempotency_key: IdempotencyKey,
    ) -> Result<Self, AuthoringError> {
        if expected_revision == 0 {
            return Err(AuthoringError::InvalidRevision);
        }
        let request_hash = canonical_sha256(&json!({
            "campaign_id": campaign_id,
            "command": command.as_str(),
            "expected_revision": expected_revision,
        }))
        .map_err(|_| AuthoringError::RequestHashFailed)?
        .into();
        Ok(Self {
            campaign_id,
            command,
            expected_revision,
            idempotency_key,
            request_hash,
        })
    }

    #[must_use]
    pub const fn campaign_id(&self) -> &CampaignId {
        &self.campaign_id
    }

    #[must_use]
    pub const fn command(&self) -> CampaignCommand {
        self.command
    }

    #[must_use]
    pub const fn expected_revision(&self) -> u64 {
        self.expected_revision
    }

    #[must_use]
    pub const fn idempotency_key(&self) -> &IdempotencyKey {
        &self.idempotency_key
    }

    #[must_use]
    pub fn request_hash(&self) -> &str {
        &self.request_hash
    }
}

fn reject_duplicate_identities(contacts: &[ImportContact]) -> Result<(), AuthoringError> {
    let mut contact_ids = HashSet::with_capacity(contacts.len());
    let mut external_ids = HashSet::with_capacity(contacts.len());
    let mut attempt_ids = HashSet::with_capacity(contacts.len());
    let mut interaction_ids = HashSet::with_capacity(contacts.len());
    let mut idempotency_keys = HashSet::with_capacity(contacts.len());
    for contact in contacts {
        if !contact_ids.insert(contact.contact_id.as_str())
            || !external_ids.insert(contact.external_contact_id.as_ref())
            || !attempt_ids.insert(contact.attempt_id.as_str())
            || !interaction_ids.insert(contact.interaction_id.as_str())
            || !idempotency_keys.insert(contact.idempotency_key.as_str())
        {
            return Err(AuthoringError::DuplicateIdentity);
        }
    }
    Ok(())
}

fn valid_identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= MAX_IDENTIFIER_BYTES
        && first.is_ascii_alphanumeric()
        && remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_destination(value: &str) -> bool {
    value.len() >= 3
        && value.len() <= MAX_DESTINATION_BYTES
        && value.is_ascii()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_graphic() && !matches!(byte, b'"' | b'\'' | b'`'))
}

fn valid_time_zone(value: &str) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= MAX_TIME_ZONE_BYTES
        && first.is_ascii_alphanumeric()
        && remainder.iter().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'+' | b'-' | b'/' | b'.')
        })
}
