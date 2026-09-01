use std::{error::Error, fmt};

use converact_contracts::canonical_sha256;
use converact_voice_agent_contracts::EnvelopeContext;
use serde_json::Value;

const MAX_IDENTIFIER_BYTES: usize = 255;
const MAX_PAYLOAD_BYTES: usize = 131_072;

/// One independently fenced understanding authority domain.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UnderstandingDomain {
    Intent,
    Emotion,
    CustomerState,
    Dialogue,
}

impl UnderstandingDomain {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Intent => "intent",
            Self::Emotion => "emotion",
            Self::CustomerState => "customer_state",
            Self::Dialogue => "dialogue",
        }
    }
}

/// Closed immutable record kinds accepted by the understanding ledger.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UnderstandingRecordKind {
    IntentObservation,
    EmotionObservation,
    EmotionFusion,
    CustomerStateSnapshot,
    DialogueRecommendation,
}

impl UnderstandingRecordKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::IntentObservation => "intent_observation",
            Self::EmotionObservation => "emotion_observation",
            Self::EmotionFusion => "emotion_fusion",
            Self::CustomerStateSnapshot => "customer_state_snapshot",
            Self::DialogueRecommendation => "dialogue_recommendation",
        }
    }

    #[must_use]
    pub const fn domain(self) -> UnderstandingDomain {
        match self {
            Self::IntentObservation => UnderstandingDomain::Intent,
            Self::EmotionObservation | Self::EmotionFusion => UnderstandingDomain::Emotion,
            Self::CustomerStateSnapshot => UnderstandingDomain::CustomerState,
            Self::DialogueRecommendation => UnderstandingDomain::Dialogue,
        }
    }

    #[must_use]
    pub const fn can_advance_head(self) -> bool {
        !matches!(self, Self::EmotionObservation)
    }

    pub(crate) fn parse(value: &str) -> Result<Self, UnderstandingStoreError> {
        match value {
            "intent_observation" => Ok(Self::IntentObservation),
            "emotion_observation" => Ok(Self::EmotionObservation),
            "emotion_fusion" => Ok(Self::EmotionFusion),
            "customer_state_snapshot" => Ok(Self::CustomerStateSnapshot),
            "dialogue_recommendation" => Ok(Self::DialogueRecommendation),
            _ => Err(UnderstandingStoreError::StoredRowInvalid),
        }
    }
}

/// Untrusted immutable record fields from a Core-to-Store adapter.
pub struct UnderstandingRecordInput {
    pub record_id: String,
    pub context: EnvelopeContext,
    pub kind: UnderstandingRecordKind,
    pub turn_index: u32,
    pub observed_at_ms: u64,
    pub retention_policy_ref: String,
    pub retention_until_ms: u64,
    pub payload: Value,
    pub payload_hash: String,
}

/// Canonical, bounded and redacted durable understanding evidence.
#[derive(Clone, Eq, PartialEq)]
pub struct UnderstandingRecord {
    record_id: Box<str>,
    context: EnvelopeContext,
    kind: UnderstandingRecordKind,
    turn_index: u32,
    observed_at_ms: u64,
    retention_policy_ref: Box<str>,
    retention_until_ms: u64,
    payload: Value,
    payload_hash: Box<str>,
}

impl UnderstandingRecord {
    /// Validates a canonical object payload, authority clock and retention boundary.
    ///
    /// # Errors
    ///
    /// Rejects unbounded identifiers/payloads, non-object payloads, hash drift and invalid clocks.
    pub fn try_new(input: UnderstandingRecordInput) -> Result<Self, UnderstandingStoreError> {
        let encoded = serde_json::to_vec(&input.payload)
            .map_err(|_| UnderstandingStoreError::InvalidRecord)?;
        let canonical_hash =
            canonical_sha256(&input.payload).map_err(|_| UnderstandingStoreError::InvalidRecord)?;
        if !bounded_identifier(&input.record_id)
            || !bounded_identifier(&input.retention_policy_ref)
            || !input.payload.is_object()
            || encoded.len() > MAX_PAYLOAD_BYTES
            || input.observed_at_ms == 0
            || input.retention_until_ms <= input.observed_at_ms
            || !lowercase_sha256(&input.payload_hash)
            || input.payload_hash != canonical_hash
        {
            return Err(UnderstandingStoreError::InvalidRecord);
        }
        Ok(Self {
            record_id: input.record_id.into(),
            context: input.context,
            kind: input.kind,
            turn_index: input.turn_index,
            observed_at_ms: input.observed_at_ms,
            retention_policy_ref: input.retention_policy_ref.into(),
            retention_until_ms: input.retention_until_ms,
            payload: input.payload,
            payload_hash: input.payload_hash.into(),
        })
    }

    #[must_use]
    pub fn record_id(&self) -> &str {
        &self.record_id
    }

    #[must_use]
    pub const fn context(&self) -> &EnvelopeContext {
        &self.context
    }

    #[must_use]
    pub const fn kind(&self) -> UnderstandingRecordKind {
        self.kind
    }

    #[must_use]
    pub const fn domain(&self) -> UnderstandingDomain {
        self.kind.domain()
    }

    #[must_use]
    pub const fn turn_index(&self) -> u32 {
        self.turn_index
    }

    #[must_use]
    pub const fn observed_at_ms(&self) -> u64 {
        self.observed_at_ms
    }

    #[must_use]
    pub fn retention_policy_ref(&self) -> &str {
        &self.retention_policy_ref
    }

    #[must_use]
    pub const fn retention_until_ms(&self) -> u64 {
        self.retention_until_ms
    }

    #[must_use]
    pub const fn payload(&self) -> &Value {
        &self.payload
    }

    #[must_use]
    pub fn payload_hash(&self) -> &str {
        &self.payload_hash
    }

    #[must_use]
    pub const fn can_advance_head(&self) -> bool {
        self.kind.can_advance_head()
    }
}

impl fmt::Debug for UnderstandingRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UnderstandingRecord")
            .field("record_id", &self.record_id)
            .field("kind", &self.kind)
            .field("domain", &self.domain())
            .field("turn_index", &self.turn_index)
            .field("observed_at_ms", &self.observed_at_ms)
            .field("retention_policy_ref", &self.retention_policy_ref)
            .field("retention_until_ms", &self.retention_until_ms)
            .field("payload_hash", &self.payload_hash)
            .finish_non_exhaustive()
    }
}

/// Untrusted optimistic fence for the latest domain head.
pub struct UnderstandingHeadExpectationInput {
    pub expected_revision: u64,
    pub expected_record_id: Option<String>,
    pub expected_payload_hash: Option<String>,
}

/// Exact absence or current-head fence supplied to an atomic append.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnderstandingHeadExpectation {
    revision: u64,
    record_id: Option<Box<str>>,
    payload_hash: Option<Box<str>>,
}

/// Untrusted latest-head row loaded under a transaction lock.
pub struct UnderstandingHeadInput {
    pub context: EnvelopeContext,
    pub kind: UnderstandingRecordKind,
    pub revision: u64,
    pub record_id: String,
    pub payload_hash: String,
    pub turn_index: u32,
    pub observed_at_ms: u64,
}

/// Validated latest record pointer for one authority/domain generation.
#[derive(Clone, Eq, PartialEq)]
pub struct UnderstandingHead {
    context: EnvelopeContext,
    kind: UnderstandingRecordKind,
    revision: u64,
    record_id: Box<str>,
    payload_hash: Box<str>,
    turn_index: u32,
    observed_at_ms: u64,
}

impl UnderstandingHead {
    /// Validates a current head loaded from durable storage.
    ///
    /// # Errors
    ///
    /// Rejects raw-only kinds, zero revisions/times and malformed identity or hash fields.
    pub fn try_new(input: UnderstandingHeadInput) -> Result<Self, UnderstandingStoreError> {
        if !input.kind.can_advance_head()
            || input.revision == 0
            || input.observed_at_ms == 0
            || !bounded_identifier(&input.record_id)
            || !lowercase_sha256(&input.payload_hash)
        {
            return Err(UnderstandingStoreError::StoredRowInvalid);
        }
        Ok(Self {
            context: input.context,
            kind: input.kind,
            revision: input.revision,
            record_id: input.record_id.into(),
            payload_hash: input.payload_hash.into(),
            turn_index: input.turn_index,
            observed_at_ms: input.observed_at_ms,
        })
    }

    #[must_use]
    pub const fn context(&self) -> &EnvelopeContext {
        &self.context
    }

    #[must_use]
    pub const fn kind(&self) -> UnderstandingRecordKind {
        self.kind
    }

    #[must_use]
    pub const fn domain(&self) -> UnderstandingDomain {
        self.kind.domain()
    }

    #[must_use]
    pub const fn revision(&self) -> u64 {
        self.revision
    }

    #[must_use]
    pub fn record_id(&self) -> &str {
        &self.record_id
    }

    #[must_use]
    pub fn payload_hash(&self) -> &str {
        &self.payload_hash
    }

    #[must_use]
    pub const fn turn_index(&self) -> u32 {
        self.turn_index
    }

    #[must_use]
    pub const fn observed_at_ms(&self) -> u64 {
        self.observed_at_ms
    }
}

impl fmt::Debug for UnderstandingHead {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UnderstandingHead")
            .field("kind", &self.kind)
            .field("domain", &self.domain())
            .field("revision", &self.revision)
            .field("record_id", &self.record_id)
            .field("payload_hash", &self.payload_hash)
            .field("turn_index", &self.turn_index)
            .field("observed_at_ms", &self.observed_at_ms)
            .finish_non_exhaustive()
    }
}

impl UnderstandingHeadExpectation {
    /// Validates an absent-head fence or a complete revision/record/hash fence.
    ///
    /// # Errors
    ///
    /// Rejects partial, malformed or contradictory head expectations.
    pub fn try_new(
        input: UnderstandingHeadExpectationInput,
    ) -> Result<Self, UnderstandingStoreError> {
        let valid = match (
            input.expected_revision,
            input.expected_record_id.as_deref(),
            input.expected_payload_hash.as_deref(),
        ) {
            (0, None, None) => true,
            (1.., Some(record_id), Some(payload_hash)) => {
                bounded_identifier(record_id) && lowercase_sha256(payload_hash)
            }
            _ => false,
        };
        if !valid {
            return Err(UnderstandingStoreError::InvalidHeadExpectation);
        }
        Ok(Self {
            revision: input.expected_revision,
            record_id: input.expected_record_id.map(Into::into),
            payload_hash: input.expected_payload_hash.map(Into::into),
        })
    }

    #[must_use]
    pub const fn expected_revision(&self) -> u64 {
        self.revision
    }

    #[must_use]
    pub fn expected_record_id(&self) -> Option<&str> {
        self.record_id.as_deref()
    }

    #[must_use]
    pub fn expected_payload_hash(&self) -> Option<&str> {
        self.payload_hash.as_deref()
    }

    /// Computes the consecutive head revision without wrapping.
    ///
    /// # Errors
    ///
    /// Rejects exhausted revision space.
    pub fn next_revision(&self) -> Result<u64, UnderstandingStoreError> {
        self.revision
            .checked_add(1)
            .ok_or(UnderstandingStoreError::HeadRevisionExhausted)
    }
}

/// Durable presence classification for the command's immutable record identity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecordPresence {
    Absent,
    Exact,
    Conflict,
}

/// Mutation plan selected before any SQL write.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppendAction {
    InsertRecordOnly,
    ReplayRecordOnly,
    InsertRecordAndCreateHead { head_revision: u64 },
    ReuseRecordAndCreateHead { head_revision: u64 },
    InsertRecordAndAdvanceHead { head_revision: u64 },
    ReuseRecordAndAdvanceHead { head_revision: u64 },
    ReplayCurrent { head_revision: u64 },
    ReplaySuperseded { current_head_revision: u64 },
}

/// One immutable append, optionally coupled to an exact latest-head fence.
#[derive(Clone, Eq, PartialEq)]
pub struct AppendUnderstandingRecord {
    record: UnderstandingRecord,
    head_expectation: Option<UnderstandingHeadExpectation>,
}

impl AppendUnderstandingRecord {
    /// Creates a record-only append or atomic record-and-head command.
    ///
    /// # Errors
    ///
    /// Rejects an attempt to make a raw Emotion observation authoritative.
    pub fn try_new(
        record: UnderstandingRecord,
        head_expectation: Option<UnderstandingHeadExpectation>,
    ) -> Result<Self, UnderstandingStoreError> {
        if head_expectation.is_some() && !record.can_advance_head() {
            return Err(UnderstandingStoreError::HeadAdvanceNotAllowed);
        }
        Ok(Self {
            record,
            head_expectation,
        })
    }

    #[must_use]
    pub const fn record(&self) -> &UnderstandingRecord {
        &self.record
    }

    #[must_use]
    pub const fn head_expectation(&self) -> Option<&UnderstandingHeadExpectation> {
        self.head_expectation.as_ref()
    }

    /// Classifies a locked durable snapshot into an exact mutation plan.
    ///
    /// # Errors
    ///
    /// Rejects conflicting record identities, stale/mismatched fences, authority drift and
    /// backwards turn/time movement.
    pub fn decide(
        &self,
        presence: RecordPresence,
        current_head: Option<&UnderstandingHead>,
    ) -> Result<AppendAction, UnderstandingStoreError> {
        if presence == RecordPresence::Conflict {
            return Err(UnderstandingStoreError::Conflict);
        }
        let Some(expectation) = &self.head_expectation else {
            return Ok(if presence == RecordPresence::Exact {
                AppendAction::ReplayRecordOnly
            } else {
                AppendAction::InsertRecordOnly
            });
        };
        let Some(current) = current_head else {
            if expectation.expected_revision() != 0 {
                return Err(UnderstandingStoreError::StaleFence);
            }
            let head_revision = expectation.next_revision()?;
            return Ok(if presence == RecordPresence::Exact {
                AppendAction::ReuseRecordAndCreateHead { head_revision }
            } else {
                AppendAction::InsertRecordAndCreateHead { head_revision }
            });
        };
        if !same_authority(self.record.context(), current.context())
            || self.record.domain() != current.domain()
        {
            return Err(UnderstandingStoreError::StoredRowInvalid);
        }
        if current.record_id() == self.record.record_id()
            && current.payload_hash() == self.record.payload_hash()
        {
            return if presence == RecordPresence::Exact {
                Ok(AppendAction::ReplayCurrent {
                    head_revision: current.revision(),
                })
            } else {
                Err(UnderstandingStoreError::StoredRowInvalid)
            };
        }
        let record_is_older = self.record.turn_index() < current.turn_index()
            || self.record.observed_at_ms() < current.observed_at_ms();
        if !expectation.matches(current) {
            if presence == RecordPresence::Exact && record_is_older {
                return Ok(AppendAction::ReplaySuperseded {
                    current_head_revision: current.revision(),
                });
            }
            return Err(UnderstandingStoreError::StaleFence);
        }
        if record_is_older || current.record_id() == self.record.record_id() {
            return Err(UnderstandingStoreError::StaleFence);
        }
        let head_revision = expectation.next_revision()?;
        Ok(if presence == RecordPresence::Exact {
            AppendAction::ReuseRecordAndAdvanceHead { head_revision }
        } else {
            AppendAction::InsertRecordAndAdvanceHead { head_revision }
        })
    }
}

impl fmt::Debug for AppendUnderstandingRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AppendUnderstandingRecord")
            .field("record", &self.record)
            .field("head_expectation", &self.head_expectation)
            .finish()
    }
}

impl UnderstandingHeadExpectation {
    fn matches(&self, head: &UnderstandingHead) -> bool {
        self.revision == head.revision
            && self.expected_record_id() == Some(head.record_id())
            && self.expected_payload_hash() == Some(head.payload_hash())
    }
}

/// Stable low-cardinality Store failures without customer data, SQL or topology.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UnderstandingStoreError {
    InvalidRecord,
    InvalidHeadExpectation,
    HeadRevisionExhausted,
    HeadAdvanceNotAllowed,
    DatabaseUnavailable,
    Conflict,
    StaleFence,
    StoredRowInvalid,
}

impl UnderstandingStoreError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidRecord => "understanding_store_record_invalid",
            Self::InvalidHeadExpectation => "understanding_store_head_expectation_invalid",
            Self::HeadRevisionExhausted => "understanding_store_head_revision_exhausted",
            Self::HeadAdvanceNotAllowed => "understanding_store_head_advance_not_allowed",
            Self::DatabaseUnavailable => "understanding_store_database_unavailable",
            Self::Conflict => "understanding_store_conflict",
            Self::StaleFence => "understanding_store_stale_fence",
            Self::StoredRowInvalid => "understanding_store_row_invalid",
        }
    }
}

impl fmt::Display for UnderstandingStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for UnderstandingStoreError {}

fn bounded_identifier(value: &str) -> bool {
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

fn lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value.as_bytes().iter().all(u8::is_ascii_hexdigit)
        && !value.as_bytes().iter().any(u8::is_ascii_uppercase)
}

fn same_authority(left: &EnvelopeContext, right: &EnvelopeContext) -> bool {
    left.schema_version() == right.schema_version()
        && left.tenant_id() == right.tenant_id()
        && left.interaction_id() == right.interaction_id()
        && left.campaign_id() == right.campaign_id()
        && left.campaign_contact_id() == right.campaign_contact_id()
        && left.call_attempt_id() == right.call_attempt_id()
        && left.call_id() == right.call_id()
        && left.agent_release_id() == right.agent_release_id()
        && left.channel_agent_session_id() == right.channel_agent_session_id()
        && left.execution_generation() == right.execution_generation()
}
