use std::{error::Error, fmt};

use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};

const MAX_IDENTIFIER_BYTES: usize = 255;

/// A rejected voice-agent identifier or execution generation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IdentityError {
    /// A textual identifier does not match the frozen wire grammar.
    InvalidIdentifier,
    /// An execution generation must be positive.
    InvalidGeneration,
    /// An execution generation cannot be incremented without wrapping.
    GenerationExhausted,
}

impl fmt::Display for IdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidIdentifier => "voice_agent_identifier_invalid",
            Self::InvalidGeneration => "voice_agent_generation_invalid",
            Self::GenerationExhausted => "voice_agent_generation_exhausted",
        })
    }
}

impl Error for IdentityError {}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
struct BoundedId(Box<str>);

impl BoundedId {
    fn parse(value: &str) -> Result<Self, IdentityError> {
        if !is_valid_bounded_identifier(value) {
            return Err(IdentityError::InvalidIdentifier);
        }
        Ok(Self(value.into()))
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

pub(crate) fn is_valid_bounded_identifier(value: &str) -> bool {
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

macro_rules! voice_agent_id {
    ($name:ident) => {
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
        pub struct $name(BoundedId);

        impl $name {
            /// Parses the frozen 1-to-255-byte ASCII identifier grammar.
            ///
            /// # Errors
            ///
            /// Returns [`IdentityError::InvalidIdentifier`] for malformed input.
            pub fn parse(value: impl AsRef<str>) -> Result<Self, IdentityError> {
                BoundedId::parse(value.as_ref()).map(Self)
            }

            /// Returns the canonical wire value.
            #[must_use]
            pub fn as_str(&self) -> &str {
                self.0.as_str()
            }
        }

        impl Serialize for $name {
            fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
            where
                S: Serializer,
            {
                serializer.serialize_str(self.as_str())
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let value = Box::<str>::deserialize(deserializer)?;
                Self::parse(value).map_err(D::Error::custom)
            }
        }
    };
}

voice_agent_id!(AgentDefinitionId);
voice_agent_id!(AgentReleaseId);
voice_agent_id!(TenantId);
voice_agent_id!(CampaignId);
voice_agent_id!(CampaignContactId);
voice_agent_id!(CallAttemptId);
voice_agent_id!(InteractionId);
voice_agent_id!(CallId);
voice_agent_id!(ChannelAgentSessionId);
voice_agent_id!(EventId);
voice_agent_id!(IdempotencyKey);
voice_agent_id!(ToolRevisionId);
voice_agent_id!(ToolCallId);
voice_agent_id!(ApprovalId);
voice_agent_id!(ActionReceiptId);
voice_agent_id!(HandoffId);
voice_agent_id!(HandoffCommandId);
voice_agent_id!(HandoffReceiptId);
voice_agent_id!(ContextPacketId);
voice_agent_id!(HumanLegId);
voice_agent_id!(TranscriptSegmentId);
voice_agent_id!(TranscriptSnapshotId);
voice_agent_id!(IntentCatalogRevisionId);
voice_agent_id!(IntentObservationId);
voice_agent_id!(EmotionCatalogRevisionId);
voice_agent_id!(EmotionObservationId);
voice_agent_id!(EmotionFusionId);
voice_agent_id!(AudioEvidenceWindowId);
voice_agent_id!(CustomerStateSnapshotId);
voice_agent_id!(DialoguePolicyRevisionId);
voice_agent_id!(DialogueRecommendationId);
voice_agent_id!(ConversationResultId);
voice_agent_id!(OutcomeSchemaRevisionId);
voice_agent_id!(EvaluationId);
voice_agent_id!(EvaluationRubricRevisionId);
voice_agent_id!(BadCaseId);
voice_agent_id!(ResultProjectionCommandId);
voice_agent_id!(ResultProjectionReceiptId);
voice_agent_id!(ConversationFinalizationJobId);
voice_agent_id!(ConversationFinalizationReceiptId);

/// Positive generation that fences stale channel-agent commands and events.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct ExecutionGeneration(u64);

impl ExecutionGeneration {
    /// Creates a positive execution generation.
    ///
    /// # Errors
    ///
    /// Returns [`IdentityError::InvalidGeneration`] for zero.
    pub const fn new(value: u64) -> Result<Self, IdentityError> {
        if value == 0 {
            Err(IdentityError::InvalidGeneration)
        } else {
            Ok(Self(value))
        }
    }

    /// Returns the numeric wire value.
    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }

    /// Advances to the next generation without wrapping.
    ///
    /// # Errors
    ///
    /// Returns [`IdentityError::GenerationExhausted`] at `u64::MAX`.
    pub const fn next(self) -> Result<Self, IdentityError> {
        match self.0.checked_add(1) {
            Some(value) => Ok(Self(value)),
            None => Err(IdentityError::GenerationExhausted),
        }
    }
}

impl<'de> Deserialize<'de> for ExecutionGeneration {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(u64::deserialize(deserializer)?).map_err(D::Error::custom)
    }
}
