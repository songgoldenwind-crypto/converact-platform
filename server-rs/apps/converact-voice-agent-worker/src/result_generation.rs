use std::fmt;

use converact_contracts::canonical_sha256;
use converact_conversation_result_core::{TranscriptSnapshot, ValidatedIntentEvidence};
use converact_voice_agent_contracts::{EnvelopeContext, OutcomeSchemaRevisionId};
use serde_json::json;

use crate::ConversationProjectionPortError;

/// Immutable result-generation input bound to one transcript snapshot and Release schema.
#[derive(Clone, Eq, PartialEq)]
pub struct ResultGenerationEvidence {
    authority: EnvelopeContext,
    transcript_snapshot_digest: Box<str>,
    outcome_schema_revision_id: OutcomeSchemaRevisionId,
    intent_evidence: Option<ValidatedIntentEvidence>,
    expected_result_revision: u64,
    payload_hash: Box<str>,
}

impl ResultGenerationEvidence {
    /// Builds the digest that a durable result command must carry.
    ///
    /// # Errors
    ///
    /// Rejects zero revisions and intent evidence from another Release or schema.
    pub fn try_new(
        snapshot: &TranscriptSnapshot,
        outcome_schema_revision_id: OutcomeSchemaRevisionId,
        intent_evidence: Option<ValidatedIntentEvidence>,
        expected_result_revision: u64,
    ) -> Result<Self, ConversationProjectionPortError> {
        if expected_result_revision == 0
            || intent_evidence.as_ref().is_some_and(|evidence| {
                evidence.outcome_schema_revision_id() != &outcome_schema_revision_id
                    || evidence.agent_release_id() != snapshot.context().agent_release_id()
            })
        {
            return Err(ConversationProjectionPortError::new(
                "conversation_result_generation_evidence_invalid",
            ));
        }
        let payload_hash = canonical_sha256(&json!({
            "tenant_id": snapshot.context().tenant_id(),
            "interaction_id": snapshot.context().interaction_id().as_str(),
            "call_attempt_id": snapshot.context().call_attempt_id().as_str(),
            "agent_release_id": snapshot.context().agent_release_id().as_str(),
            "execution_generation": snapshot.context().execution_generation().get(),
            "transcript_snapshot_digest": snapshot.transcript_snapshot_digest(),
            "outcome_schema_revision_id": outcome_schema_revision_id.as_str(),
            "intent_evidence_payload_hash": intent_evidence
                .as_ref()
                .map(ValidatedIntentEvidence::payload_hash),
            "expected_result_revision": expected_result_revision,
        }))
        .map_err(|_| {
            ConversationProjectionPortError::new(
                "conversation_result_generation_evidence_hash_invalid",
            )
        })?;
        Ok(Self {
            authority: snapshot.context().clone(),
            transcript_snapshot_digest: snapshot.transcript_snapshot_digest().into(),
            outcome_schema_revision_id,
            intent_evidence,
            expected_result_revision,
            payload_hash: payload_hash.into(),
        })
    }

    #[must_use]
    pub const fn outcome_schema_revision_id(&self) -> &OutcomeSchemaRevisionId {
        &self.outcome_schema_revision_id
    }

    #[must_use]
    pub const fn intent_evidence(&self) -> Option<&ValidatedIntentEvidence> {
        self.intent_evidence.as_ref()
    }

    #[must_use]
    pub fn payload_hash(&self) -> &str {
        &self.payload_hash
    }

    pub(crate) const fn expected_result_revision(&self) -> u64 {
        self.expected_result_revision
    }

    pub(crate) fn matches_snapshot(&self, snapshot: &TranscriptSnapshot) -> bool {
        &self.authority == snapshot.context()
            && self.transcript_snapshot_digest.as_ref() == snapshot.transcript_snapshot_digest()
    }
}

impl fmt::Debug for ResultGenerationEvidence {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResultGenerationEvidence")
            .field(
                "outcome_schema_revision_id",
                &self.outcome_schema_revision_id,
            )
            .field("has_intent_evidence", &self.intent_evidence.is_some())
            .field("payload_hash", &self.payload_hash)
            .finish_non_exhaustive()
    }
}
