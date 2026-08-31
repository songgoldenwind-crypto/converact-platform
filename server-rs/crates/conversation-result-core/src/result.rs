use std::{collections::BTreeMap, fmt};

use converact_contracts::canonical_sha256;
use converact_voice_agent_contracts::{
    AgentReleaseId, ConversationResultId, EnvelopeContext, OutcomeSchemaRevisionId,
};
use serde::Serialize;
use serde_json::json;

use crate::{
    ResultError,
    validation::{
        bounded_identifier, bounded_reference, bounded_text, bounded_unique, lowercase_sha256,
    },
};

const MAX_SCHEMA_VALUES: usize = 128;
const MAX_CODE_BYTES: usize = 100;
const MAX_ATTRIBUTES: usize = 32;
const MAX_ATTRIBUTE_VALUE_BYTES: usize = 512;
const MAX_ARTIFACT_REF_BYTES: usize = 512;

/// Positive immutable conversation result revision.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct ResultRevision(u64);

impl ResultRevision {
    /// Creates a positive result revision.
    ///
    /// # Errors
    ///
    /// Rejects zero.
    pub const fn new(value: u64) -> Result<Self, ResultError> {
        if value == 0 {
            Err(ResultError::InvalidResultRevision)
        } else {
            Ok(Self(value))
        }
    }

    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }
}

/// Unvalidated immutable Outcome Schema revision.
pub struct OutcomeSchemaInput {
    pub id: OutcomeSchemaRevisionId,
    pub agent_release_id: AgentReleaseId,
    pub intents: Vec<String>,
    pub dispositions: Vec<String>,
    pub outcome_codes: Vec<String>,
    pub attribute_keys: Vec<String>,
}

/// Release-bound closed values accepted in a business conversation result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OutcomeSchema {
    id: OutcomeSchemaRevisionId,
    agent_release_id: AgentReleaseId,
    intents: Box<[Box<str>]>,
    dispositions: Box<[Box<str>]>,
    outcome_codes: Box<[Box<str>]>,
    attribute_keys: Box<[Box<str>]>,
}

/// Immutable intent evidence validated against one exact Agent Release schema.
#[derive(Clone, Eq, PartialEq)]
pub struct ValidatedIntentEvidence {
    outcome_schema_revision_id: OutcomeSchemaRevisionId,
    agent_release_id: AgentReleaseId,
    intent: Box<str>,
    payload_hash: Box<str>,
}

impl OutcomeSchema {
    /// Validates a bounded release-specific closed outcome schema.
    ///
    /// # Errors
    ///
    /// Rejects empty, duplicate or unbounded schema values.
    pub fn try_new(input: OutcomeSchemaInput) -> Result<Self, ResultError> {
        if input.intents.is_empty()
            || input.dispositions.is_empty()
            || input.outcome_codes.is_empty()
            || !bounded_unique(&input.intents, MAX_SCHEMA_VALUES, MAX_CODE_BYTES)
            || !bounded_unique(&input.dispositions, MAX_SCHEMA_VALUES, MAX_CODE_BYTES)
            || !bounded_unique(&input.outcome_codes, MAX_SCHEMA_VALUES, MAX_CODE_BYTES)
            || !bounded_unique(&input.attribute_keys, MAX_ATTRIBUTES, MAX_CODE_BYTES)
        {
            return Err(ResultError::InvalidOutcomeSchema);
        }
        Ok(Self {
            id: input.id,
            agent_release_id: input.agent_release_id,
            intents: boxed(input.intents),
            dispositions: boxed(input.dispositions),
            outcome_codes: boxed(input.outcome_codes),
            attribute_keys: boxed(input.attribute_keys),
        })
    }

    #[must_use]
    pub const fn id(&self) -> &OutcomeSchemaRevisionId {
        &self.id
    }

    #[must_use]
    pub const fn agent_release_id(&self) -> &AgentReleaseId {
        &self.agent_release_id
    }

    /// Converts one untrusted intent candidate into release-bound evidence.
    ///
    /// # Errors
    ///
    /// Rejects candidates outside this schema's closed intent set.
    pub fn validate_intent_candidate(
        &self,
        candidate: &str,
    ) -> Result<ValidatedIntentEvidence, ResultError> {
        if !contains(&self.intents, candidate) {
            return Err(ResultError::OutcomeSchemaMismatch);
        }
        let payload_hash = canonical_sha256(&json!({
            "outcome_schema_revision_id": self.id.as_str(),
            "agent_release_id": self.agent_release_id.as_str(),
            "intent": candidate,
        }))
        .map_err(|_| ResultError::CanonicalPayloadInvalid)?;
        Ok(ValidatedIntentEvidence {
            outcome_schema_revision_id: self.id.clone(),
            agent_release_id: self.agent_release_id.clone(),
            intent: candidate.into(),
            payload_hash: payload_hash.into(),
        })
    }
}

impl ValidatedIntentEvidence {
    #[must_use]
    pub const fn outcome_schema_revision_id(&self) -> &OutcomeSchemaRevisionId {
        &self.outcome_schema_revision_id
    }

    #[must_use]
    pub const fn agent_release_id(&self) -> &AgentReleaseId {
        &self.agent_release_id
    }

    #[must_use]
    pub fn intent(&self) -> &str {
        &self.intent
    }

    #[must_use]
    pub fn payload_hash(&self) -> &str {
        &self.payload_hash
    }
}

impl fmt::Debug for ValidatedIntentEvidence {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ValidatedIntentEvidence")
            .field(
                "outcome_schema_revision_id",
                &self.outcome_schema_revision_id,
            )
            .field("agent_release_id", &self.agent_release_id)
            .field("payload_hash", &self.payload_hash)
            .finish_non_exhaustive()
    }
}

/// Unvalidated versioned business result.
pub struct ConversationResultInput {
    pub id: ConversationResultId,
    pub context: EnvelopeContext,
    pub revision: ResultRevision,
    pub outcome_schema_revision_id: OutcomeSchemaRevisionId,
    pub transcript_snapshot_digest: String,
    pub summary_artifact_ref: String,
    pub intent: String,
    pub disposition: String,
    pub outcome_code: String,
    pub confidence_bps: u16,
    pub attributes: BTreeMap<String, String>,
    pub created_at_ms: u64,
}

/// Immutable schema-validated business projection. Debug output omits customer-derived data.
#[derive(Clone, Eq, PartialEq)]
pub struct ConversationResult {
    id: ConversationResultId,
    context: EnvelopeContext,
    revision: ResultRevision,
    outcome_schema_revision_id: OutcomeSchemaRevisionId,
    transcript_snapshot_digest: Box<str>,
    summary_artifact_ref: Box<str>,
    intent: Box<str>,
    disposition: Box<str>,
    outcome_code: Box<str>,
    confidence_bps: u16,
    attributes: BTreeMap<Box<str>, Box<str>>,
    created_at_ms: u64,
    payload_hash: Box<str>,
}

impl ConversationResult {
    /// Validates one result against the exact schema bound to the source Agent Release.
    ///
    /// # Errors
    ///
    /// Rejects schema/release mismatch, unknown closed values, unbounded attributes or hash failure.
    pub fn try_new(
        input: ConversationResultInput,
        schema: &OutcomeSchema,
    ) -> Result<Self, ResultError> {
        if input.confidence_bps > 10_000
            || input.created_at_ms == 0
            || !lowercase_sha256(&input.transcript_snapshot_digest)
            || !bounded_reference(&input.summary_artifact_ref, MAX_ARTIFACT_REF_BYTES)
            || input.attributes.len() > MAX_ATTRIBUTES
            || input.attributes.iter().any(|(key, value)| {
                !bounded_identifier(key, MAX_CODE_BYTES)
                    || !bounded_text(value, MAX_ATTRIBUTE_VALUE_BYTES)
            })
        {
            return Err(ResultError::InvalidConversationResult);
        }
        if input.outcome_schema_revision_id != schema.id
            || input.context.agent_release_id() != &schema.agent_release_id
            || !contains(&schema.intents, &input.intent)
            || !contains(&schema.dispositions, &input.disposition)
            || !contains(&schema.outcome_codes, &input.outcome_code)
            || input
                .attributes
                .keys()
                .any(|key| !contains(&schema.attribute_keys, key))
        {
            return Err(ResultError::OutcomeSchemaMismatch);
        }
        let payload_hash = canonical_sha256(&json!({
            "tenant_id": input.context.tenant_id(),
            "interaction_id": input.context.interaction_id().as_str(),
            "call_attempt_id": input.context.call_attempt_id().as_str(),
            "agent_release_id": input.context.agent_release_id().as_str(),
            "result_id": input.id.as_str(),
            "result_revision": input.revision.get(),
            "outcome_schema_revision_id": input.outcome_schema_revision_id.as_str(),
            "transcript_snapshot_digest": input.transcript_snapshot_digest,
            "summary_artifact_ref": input.summary_artifact_ref,
            "intent": input.intent,
            "disposition": input.disposition,
            "outcome_code": input.outcome_code,
            "confidence_bps": input.confidence_bps,
            "attributes": input.attributes,
            "created_at_ms": input.created_at_ms
        }))
        .map_err(|_| ResultError::CanonicalPayloadInvalid)?;
        Ok(Self {
            id: input.id,
            context: input.context,
            revision: input.revision,
            outcome_schema_revision_id: input.outcome_schema_revision_id,
            transcript_snapshot_digest: input.transcript_snapshot_digest.into(),
            summary_artifact_ref: input.summary_artifact_ref.into(),
            intent: input.intent.into(),
            disposition: input.disposition.into(),
            outcome_code: input.outcome_code.into(),
            confidence_bps: input.confidence_bps,
            attributes: input
                .attributes
                .into_iter()
                .map(|(key, value)| (key.into(), value.into()))
                .collect(),
            created_at_ms: input.created_at_ms,
            payload_hash: payload_hash.into(),
        })
    }

    #[must_use]
    pub const fn id(&self) -> &ConversationResultId {
        &self.id
    }

    #[must_use]
    pub const fn context(&self) -> &EnvelopeContext {
        &self.context
    }

    #[must_use]
    pub const fn revision(&self) -> ResultRevision {
        self.revision
    }

    #[must_use]
    pub const fn outcome_schema_revision_id(&self) -> &OutcomeSchemaRevisionId {
        &self.outcome_schema_revision_id
    }

    #[must_use]
    pub fn transcript_snapshot_digest(&self) -> &str {
        &self.transcript_snapshot_digest
    }

    #[must_use]
    pub fn summary_artifact_ref(&self) -> &str {
        &self.summary_artifact_ref
    }

    #[must_use]
    pub fn intent(&self) -> &str {
        &self.intent
    }

    #[must_use]
    pub fn disposition(&self) -> &str {
        &self.disposition
    }

    #[must_use]
    pub fn outcome_code(&self) -> &str {
        &self.outcome_code
    }

    #[must_use]
    pub const fn confidence_bps(&self) -> u16 {
        self.confidence_bps
    }

    #[must_use]
    pub const fn attributes(&self) -> &BTreeMap<Box<str>, Box<str>> {
        &self.attributes
    }

    #[must_use]
    pub const fn created_at_ms(&self) -> u64 {
        self.created_at_ms
    }

    #[must_use]
    pub fn payload_hash(&self) -> &str {
        &self.payload_hash
    }
}

impl fmt::Debug for ConversationResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ConversationResult")
            .field("id", &self.id)
            .field("revision", &self.revision)
            .field("payload_hash", &self.payload_hash)
            .finish_non_exhaustive()
    }
}

fn boxed(values: Vec<String>) -> Box<[Box<str>]> {
    values.into_iter().map(Into::into).collect()
}

fn contains(values: &[Box<str>], candidate: &str) -> bool {
    values.iter().any(|value| value.as_ref() == candidate)
}
