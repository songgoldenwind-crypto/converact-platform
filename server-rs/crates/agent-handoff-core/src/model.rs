use std::{collections::HashSet, fmt};

use converact_voice_agent_contracts::{ActionReceiptId, ContextPacketId};
use serde::{Deserialize, Serialize};

use crate::HandoffError;

const MAX_ARTIFACT_REF_BYTES: usize = 512;
const MAX_QUEUE_BYTES: usize = 128;
const MAX_SKILL_BYTES: usize = 128;
const MAX_SEAT_BYTES: usize = 255;
const MAX_SKILLS: usize = 32;
const MAX_UNRESOLVED_ITEMS: usize = 64;
const MAX_ACTION_RECEIPTS: usize = 128;

/// Positive immutable Context Packet revision.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct ContextRevision(u64);

impl ContextRevision {
    /// Creates a positive Context Packet revision.
    ///
    /// # Errors
    ///
    /// Rejects zero.
    pub const fn new(value: u64) -> Result<Self, HandoffError> {
        if value == 0 {
            Err(HandoffError::InvalidContextRevision)
        } else {
            Ok(Self(value))
        }
    }

    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }
}

impl<'de> Deserialize<'de> for ContextRevision {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::new(u64::deserialize(deserializer)?).map_err(<D::Error as serde::de::Error>::custom)
    }
}

/// Exclusive interaction control owner.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlOwner {
    Ai,
    Human,
}

/// Durable phone handoff phase.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HandoffState {
    Requested,
    Prepared,
    HumanLegDialing,
    HumanLegAnswered,
    Committed,
    HumanActive,
    AiResumePreparing,
    AiResumed,
    Aborted,
    ReconcileRequired,
}

impl HandoffState {
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::AiResumed | Self::Aborted)
    }
}

/// Unvalidated, PII-minimized Context Packet values.
pub struct ContextPacketInput {
    pub id: ContextPacketId,
    pub revision: ContextRevision,
    pub digest: String,
    pub summary_artifact_ref: String,
    pub transcript_artifact_ref: Option<String>,
    pub unresolved_item_refs: Vec<String>,
    pub action_receipt_refs: Vec<ActionReceiptId>,
    pub disclosure_completed: bool,
    pub recording_active: bool,
    pub data_region_policy_ref: String,
    pub created_at_ms: u64,
}

/// Immutable bounded references presented to the receiving human.
#[derive(Clone, Eq, PartialEq)]
pub struct ContextPacket {
    id: ContextPacketId,
    revision: ContextRevision,
    digest: Box<str>,
    summary_artifact_ref: Box<str>,
    transcript_artifact_ref: Option<Box<str>>,
    unresolved_item_refs: Box<[Box<str>]>,
    action_receipt_refs: Box<[ActionReceiptId]>,
    disclosure_completed: bool,
    recording_active: bool,
    data_region_policy_ref: Box<str>,
    created_at_ms: u64,
}

impl ContextPacket {
    /// Validates all references and creates one immutable Packet.
    ///
    /// # Errors
    ///
    /// Rejects malformed hashes, unbounded references, duplicate list entries and zero time.
    pub fn try_new(input: ContextPacketInput) -> Result<Self, HandoffError> {
        if !valid_sha256(&input.digest)
            || !bounded_reference(&input.summary_artifact_ref, MAX_ARTIFACT_REF_BYTES)
            || input
                .transcript_artifact_ref
                .as_deref()
                .is_some_and(|value| !bounded_reference(value, MAX_ARTIFACT_REF_BYTES))
            || !bounded_unique_references(
                &input.unresolved_item_refs,
                MAX_UNRESOLVED_ITEMS,
                MAX_ARTIFACT_REF_BYTES,
            )
            || !bounded_unique_action_receipts(&input.action_receipt_refs, MAX_ACTION_RECEIPTS)
            || !bounded_reference(&input.data_region_policy_ref, MAX_ARTIFACT_REF_BYTES)
            || input.created_at_ms == 0
        {
            return Err(HandoffError::InvalidContextPacket);
        }
        Ok(Self {
            id: input.id,
            revision: input.revision,
            digest: input.digest.into(),
            summary_artifact_ref: input.summary_artifact_ref.into(),
            transcript_artifact_ref: input.transcript_artifact_ref.map(Into::into),
            unresolved_item_refs: input
                .unresolved_item_refs
                .into_iter()
                .map(Into::into)
                .collect(),
            action_receipt_refs: input.action_receipt_refs.into_boxed_slice(),
            disclosure_completed: input.disclosure_completed,
            recording_active: input.recording_active,
            data_region_policy_ref: input.data_region_policy_ref.into(),
            created_at_ms: input.created_at_ms,
        })
    }

    #[must_use]
    pub const fn id(&self) -> &ContextPacketId {
        &self.id
    }

    #[must_use]
    pub const fn revision(&self) -> ContextRevision {
        self.revision
    }

    #[must_use]
    pub fn digest(&self) -> &str {
        &self.digest
    }

    #[must_use]
    pub fn summary_artifact_ref(&self) -> &str {
        &self.summary_artifact_ref
    }

    #[must_use]
    pub fn transcript_artifact_ref(&self) -> Option<&str> {
        self.transcript_artifact_ref.as_deref()
    }

    #[must_use]
    pub fn unresolved_item_refs(&self) -> &[Box<str>] {
        &self.unresolved_item_refs
    }

    #[must_use]
    pub fn action_receipt_refs(&self) -> &[ActionReceiptId] {
        &self.action_receipt_refs
    }

    #[must_use]
    pub const fn disclosure_completed(&self) -> bool {
        self.disclosure_completed
    }

    #[must_use]
    pub const fn recording_active(&self) -> bool {
        self.recording_active
    }

    #[must_use]
    pub fn data_region_policy_ref(&self) -> &str {
        &self.data_region_policy_ref
    }

    #[must_use]
    pub const fn created_at_ms(&self) -> u64 {
        self.created_at_ms
    }
}

impl fmt::Debug for ContextPacket {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ContextPacket")
            .field("id", &self.id)
            .field("revision", &self.revision)
            .field("digest", &self.digest)
            .finish_non_exhaustive()
    }
}

/// Bounded target selection frozen before dialing a human Leg.
#[derive(Clone, Eq, PartialEq)]
pub struct HandoffTarget {
    queue: Box<str>,
    skills: Box<[Box<str>]>,
    preferred_seat: Option<Box<str>>,
}

impl HandoffTarget {
    /// Creates an industry-neutral queue/skill/seat target.
    ///
    /// # Errors
    ///
    /// Rejects empty, duplicate or unbounded target fields.
    pub fn try_new<'a>(
        queue: &'a str,
        skills: impl IntoIterator<Item = &'a str>,
        preferred_seat: Option<&'a str>,
    ) -> Result<Self, HandoffError> {
        let skills: Vec<&str> = skills.into_iter().collect();
        if !bounded_reference(queue, MAX_QUEUE_BYTES)
            || skills.len() > MAX_SKILLS
            || !bounded_unique_strs(&skills, MAX_SKILL_BYTES)
            || preferred_seat.is_some_and(|value| !bounded_reference(value, MAX_SEAT_BYTES))
        {
            return Err(HandoffError::InvalidTarget);
        }
        Ok(Self {
            queue: queue.into(),
            skills: skills.into_iter().map(Into::into).collect(),
            preferred_seat: preferred_seat.map(Into::into),
        })
    }

    #[must_use]
    pub fn queue(&self) -> &str {
        &self.queue
    }

    #[must_use]
    pub fn skills(&self) -> &[Box<str>] {
        &self.skills
    }

    #[must_use]
    pub fn preferred_seat(&self) -> Option<&str> {
        self.preferred_seat.as_deref()
    }
}

impl fmt::Debug for HandoffTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("HandoffTarget([REDACTED])")
    }
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn bounded_reference(value: &str, maximum: usize) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= maximum
        && first.is_ascii_alphanumeric()
        && remainder.iter().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'/' | b'-')
        })
}

fn bounded_unique_references(
    values: &[String],
    maximum_items: usize,
    maximum_bytes: usize,
) -> bool {
    if values.len() > maximum_items {
        return false;
    }
    let mut unique = HashSet::with_capacity(values.len());
    values
        .iter()
        .all(|value| bounded_reference(value, maximum_bytes) && unique.insert(value.as_str()))
}

fn bounded_unique_strs(values: &[&str], maximum_bytes: usize) -> bool {
    let mut unique = HashSet::with_capacity(values.len());
    values
        .iter()
        .all(|value| bounded_reference(value, maximum_bytes) && unique.insert(*value))
}

fn bounded_unique_action_receipts(values: &[ActionReceiptId], maximum_items: usize) -> bool {
    if values.len() > maximum_items {
        return false;
    }
    let mut unique = HashSet::with_capacity(values.len());
    values.iter().all(|value| unique.insert(value.as_str()))
}
