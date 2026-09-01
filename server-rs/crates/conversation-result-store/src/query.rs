use std::collections::BTreeMap;

use converact_conversation_result_core::{
    TranscriptSegment, TranscriptSegmentInput, TranscriptSpeaker,
};
use converact_voice_agent_contracts::{EnvelopeContext, EventId, TranscriptSegmentId};
use serde::Serialize;
use serde_json::Value;
use tokio_postgres::{Row, Transaction};

use crate::{ConversationResultSqlStore, ConversationResultStoreError};

const MAX_QUERY_LIMIT: u16 = 100;
const MAX_TRANSCRIPT_HISTORY_SEGMENTS: u16 = 32;
const MAX_CURSOR_BYTES: usize = 255;

/// Bounded list limit validated before SQL construction.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct QueryLimit(u16);

impl QueryLimit {
    /// Creates a list limit between 1 and 100.
    ///
    /// # Errors
    ///
    /// Rejects zero and values above the contract maximum.
    pub const fn new(value: u16) -> Result<Self, ConversationResultStoreError> {
        if value == 0 || value > MAX_QUERY_LIMIT {
            Err(ConversationResultStoreError::InvalidQuery)
        } else {
            Ok(Self(value))
        }
    }

    #[must_use]
    pub const fn get(self) -> u16 {
        self.0
    }

    fn fetch_count(self) -> i64 {
        i64::from(self.0) + 1
    }
}

/// Strict upper bound for one real-time understanding context window.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TranscriptHistoryLimit(u16);

impl TranscriptHistoryLimit {
    /// Creates a context limit between 1 and 32 final dialogue segments.
    ///
    /// # Errors
    ///
    /// Rejects zero and values above the runtime classifier contract.
    pub const fn new(value: u16) -> Result<Self, ConversationResultStoreError> {
        if value == 0 || value > MAX_TRANSCRIPT_HISTORY_SEGMENTS {
            Err(ConversationResultStoreError::InvalidQuery)
        } else {
            Ok(Self(value))
        }
    }

    #[must_use]
    pub const fn get(self) -> u16 {
        self.0
    }

    const fn query_count(self) -> i64 {
        self.0 as i64
    }
}

/// Store-ordered typed transcript context ending at one exact append receipt segment.
#[derive(Clone, Eq, PartialEq)]
pub struct TranscriptHistoryWindow {
    segments: Vec<TranscriptSegment>,
}

impl TranscriptHistoryWindow {
    /// Closes an untrusted Store result into one exact bounded understanding window.
    ///
    /// # Errors
    ///
    /// Rejects empty/oversized results, authority drift, system rows, non-increasing sequence or a
    /// final row that is not the exact current append receipt segment.
    pub fn try_new(
        current: &TranscriptSegment,
        segments: Vec<TranscriptSegment>,
        limit: TranscriptHistoryLimit,
    ) -> Result<Self, ConversationResultStoreError> {
        if segments.is_empty()
            || segments.len() > usize::from(limit.get())
            || segments.last() != Some(current)
            || segments.iter().any(|segment| {
                segment.context() != current.context()
                    || segment.speaker() == TranscriptSpeaker::System
            })
            || segments
                .windows(2)
                .any(|pair| pair[0].sequence() >= pair[1].sequence())
        {
            return Err(ConversationResultStoreError::StoredRowInvalid);
        }
        Ok(Self { segments })
    }

    #[must_use]
    pub fn segments(&self) -> &[TranscriptSegment] {
        &self.segments
    }

    #[must_use]
    pub fn into_segments(self) -> Vec<TranscriptSegment> {
        self.segments
    }
}

/// Opaque-to-HTTP entity cursor revalidated under the current tenant and query scope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EntityCursor(Box<str>);

impl EntityCursor {
    /// Parses the shared bounded entity identifier grammar.
    ///
    /// # Errors
    ///
    /// Rejects empty, oversized or non-canonical cursor values.
    pub fn parse(value: &str) -> Result<Self, ConversationResultStoreError> {
        if !bounded_identifier(value, MAX_CURSOR_BYTES) {
            return Err(ConversationResultStoreError::InvalidQuery);
        }
        Ok(Self(value.into()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Stable bounded cursor page.
#[derive(Clone, Eq, PartialEq, Serialize)]
pub struct QueryPage<T> {
    items: Vec<T>,
    next_cursor: Option<String>,
}

impl<T> QueryPage<T> {
    /// Builds a bounded adapter or test page using the same public cursor grammar.
    ///
    /// # Errors
    ///
    /// Rejects pages above the query maximum or malformed continuation cursors.
    pub fn try_new(
        items: Vec<T>,
        next_cursor: Option<String>,
    ) -> Result<Self, ConversationResultStoreError> {
        if items.len() > usize::from(MAX_QUERY_LIMIT)
            || next_cursor
                .as_deref()
                .is_some_and(|value| !bounded_identifier(value, MAX_CURSOR_BYTES))
        {
            return Err(ConversationResultStoreError::InvalidQuery);
        }
        Ok(Self { items, next_cursor })
    }

    #[must_use]
    pub fn items(&self) -> &[T] {
        &self.items
    }

    #[must_use]
    pub fn next_cursor(&self) -> Option<&str> {
        self.next_cursor.as_deref()
    }
}

/// Latest immutable business result detail without transcript text.
#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ConversationResultView {
    pub result_id: String,
    pub interaction_id: String,
    pub result_revision: u64,
    pub agent_release_id: String,
    pub outcome_schema_revision_id: String,
    pub transcript_snapshot_digest: String,
    pub summary_artifact_ref: String,
    pub intent: String,
    pub disposition: String,
    pub outcome_code: String,
    pub confidence_bps: u16,
    pub attributes: BTreeMap<String, String>,
    pub created_at_ms: u64,
}

/// Authorized final transcript detail. Debug is intentionally unavailable.
#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct TranscriptSegmentView {
    pub segment_id: String,
    pub execution_generation: u64,
    pub segment_sequence: u64,
    pub speaker: String,
    pub language: String,
    pub text: String,
    pub start_offset_ms: u64,
    pub end_offset_ms: u64,
    pub observed_at_ms: u64,
    pub historical: bool,
}

/// Immutable deterministic evaluation detail without transcript text.
#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ConversationEvaluationView {
    pub evaluation_id: String,
    pub result_id: String,
    pub result_revision: u64,
    pub evaluator_release_id: String,
    pub evaluation_rubric_revision_id: String,
    pub dimension_scores_bps: BTreeMap<String, u16>,
    pub evidence_segment_ids: Vec<String>,
    pub violation_codes: Vec<String>,
    pub overall_score_bps: u16,
    pub quality_grade: String,
    pub bad_case_reasons: Vec<String>,
    pub created_at_ms: u64,
}

/// Bounded Bad Case queue item without transcript, summary or Provider payload.
#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct BadCaseView {
    pub bad_case_id: String,
    pub interaction_id: String,
    pub evaluation_id: String,
    pub bad_case_reasons: Vec<String>,
    pub review_state: String,
    pub created_at_ms: u64,
}

impl ConversationResultSqlStore {
    /// Loads the latest result revision for one tenant-bound Interaction.
    ///
    /// # Errors
    ///
    /// Returns database, JSON or stored-row failures without query/topology details.
    pub async fn load_latest_result(
        &self,
        transaction: &Transaction<'_>,
        tenant_id: &str,
        interaction_id: &str,
    ) -> Result<Option<ConversationResultView>, ConversationResultStoreError> {
        transaction
            .query_opt(
                "SELECT result_id, interaction_id, result_revision, agent_release_id,
                        outcome_schema_revision_id, transcript_snapshot_digest,
                        summary_artifact_ref, intent_code, disposition_code, outcome_code,
                        confidence_bps, attributes,
                        floor(extract(epoch FROM created_at) * 1000)::BIGINT
                 FROM converact_conversation_results
                 WHERE tenant_id = $1 AND interaction_id = $2
                 ORDER BY result_revision DESC LIMIT 1",
                &[&tenant_id, &interaction_id],
            )
            .await
            .map_err(|_| ConversationResultStoreError::DatabaseUnavailable)?
            .map(|row| result_view(&row))
            .transpose()
    }

    /// Lists final transcript details in stable media order after revalidating the cursor row.
    ///
    /// # Errors
    ///
    /// Returns invalid cursor, database, conversion or stored-row failures.
    pub async fn list_transcript(
        &self,
        transaction: &Transaction<'_>,
        tenant_id: &str,
        interaction_id: &str,
        cursor: Option<&EntityCursor>,
        limit: QueryLimit,
    ) -> Result<QueryPage<TranscriptSegmentView>, ConversationResultStoreError> {
        let cursor_position = match cursor {
            Some(cursor) => Some(
                transaction
                    .query_opt(
                        "SELECT execution_generation, segment_sequence
                         FROM converact_conversation_transcript_segments
                         WHERE tenant_id = $1 AND interaction_id = $2 AND segment_id = $3",
                        &[&tenant_id, &interaction_id, &cursor.as_str()],
                    )
                    .await
                    .map_err(|_| ConversationResultStoreError::DatabaseUnavailable)?
                    .ok_or(ConversationResultStoreError::InvalidQuery)
                    .and_then(|row| Ok((i64_at(&row, 0)?, i64_at(&row, 1)?)))?,
            ),
            None => None,
        };
        let rows = match (cursor, cursor_position) {
            (Some(cursor), Some((generation, sequence))) => {
                transaction
                    .query(
                        "SELECT segment_id, execution_generation, segment_sequence, speaker,
                                language, transcript_text, start_offset_ms, end_offset_ms,
                                floor(extract(epoch FROM observed_at) * 1000)::BIGINT, historical
                         FROM converact_conversation_transcript_segments
                         WHERE tenant_id = $1 AND interaction_id = $2
                           AND (execution_generation, segment_sequence, segment_id) > ($3, $4, $5)
                         ORDER BY execution_generation, segment_sequence, segment_id LIMIT $6",
                        &[
                            &tenant_id,
                            &interaction_id,
                            &generation,
                            &sequence,
                            &cursor.as_str(),
                            &limit.fetch_count(),
                        ],
                    )
                    .await
            }
            (None, None) => {
                transaction
                    .query(
                        "SELECT segment_id, execution_generation, segment_sequence, speaker,
                                language, transcript_text, start_offset_ms, end_offset_ms,
                                floor(extract(epoch FROM observed_at) * 1000)::BIGINT, historical
                         FROM converact_conversation_transcript_segments
                         WHERE tenant_id = $1 AND interaction_id = $2
                         ORDER BY execution_generation, segment_sequence, segment_id LIMIT $3",
                        &[&tenant_id, &interaction_id, &limit.fetch_count()],
                    )
                    .await
            }
            _ => return Err(ConversationResultStoreError::InvalidQuery),
        }
        .map_err(|_| ConversationResultStoreError::DatabaseUnavailable)?;
        page(&rows, limit, transcript_view, |item| {
            item.segment_id.clone()
        })
    }

    /// Loads one bounded typed dialogue window ending at the exact current append receipt.
    ///
    /// # Errors
    ///
    /// Returns database, conversion or stored-row failures. Any authority, payload-hash, order or
    /// anchor drift fails closed.
    pub async fn load_recent_transcript_window(
        &self,
        transaction: &Transaction<'_>,
        current: &TranscriptSegment,
        limit: TranscriptHistoryLimit,
    ) -> Result<TranscriptHistoryWindow, ConversationResultStoreError> {
        let context = current.context();
        let generation = i64::try_from(context.execution_generation().get())
            .map_err(|_| ConversationResultStoreError::NumericOverflow)?;
        let sequence = i64::try_from(current.sequence())
            .map_err(|_| ConversationResultStoreError::NumericOverflow)?;
        let rows = transaction
            .query(
                "SELECT segment_id, source_event_id, segment_sequence, speaker, language,
                        transcript_text, start_offset_ms, end_offset_ms,
                        floor(extract(epoch FROM observed_at) * 1000)::BIGINT,
                        retention_policy_ref, payload_hash, historical
                 FROM converact_conversation_transcript_segments
                 WHERE tenant_id = $1 AND interaction_id = $2
                   AND call_attempt_id = $3 AND agent_release_id = $4
                   AND execution_generation = $5 AND segment_sequence <= $6
                   AND speaker <> 'system'
                 ORDER BY segment_sequence DESC LIMIT $7",
                &[
                    &context.tenant_id(),
                    &context.interaction_id().as_str(),
                    &context.call_attempt_id().as_str(),
                    &context.agent_release_id().as_str(),
                    &generation,
                    &sequence,
                    &limit.query_count(),
                ],
            )
            .await
            .map_err(|_| ConversationResultStoreError::DatabaseUnavailable)?;
        let mut segments = Vec::with_capacity(rows.len());
        for row in rows.iter().rev() {
            segments.push(typed_transcript_segment(row, context)?);
        }
        TranscriptHistoryWindow::try_new(current, segments, limit)
    }

    /// Lists immutable evaluations newest first without transcript text.
    ///
    /// # Errors
    ///
    /// Returns invalid cursor, database, JSON, conversion or stored-row failures.
    pub async fn list_evaluations(
        &self,
        transaction: &Transaction<'_>,
        tenant_id: &str,
        interaction_id: &str,
        cursor: Option<&EntityCursor>,
        limit: QueryLimit,
    ) -> Result<QueryPage<ConversationEvaluationView>, ConversationResultStoreError> {
        let cursor_time =
            evaluation_cursor_timestamp(transaction, tenant_id, interaction_id, cursor).await?;
        let rows =
            match (cursor, cursor_time) {
                (Some(cursor), Some(created_at)) => transaction
                    .query(
                        "SELECT evaluation_id, result_id, result_revision, evaluator_release_id,
                                evaluation_rubric_revision_id, dimension_scores,
                                evidence_segment_ids, violation_codes, overall_score_bps,
                                quality_grade, bad_case_reasons,
                                floor(extract(epoch FROM created_at) * 1000)::BIGINT
                         FROM converact_conversation_evaluations
                         WHERE tenant_id = $1 AND interaction_id = $2
                           AND (created_at, evaluation_id) <
                               ($3::TIMESTAMPTZ, $4)
                         ORDER BY created_at DESC, evaluation_id DESC LIMIT $5",
                        &[
                            &tenant_id,
                            &interaction_id,
                            &created_at,
                            &cursor.as_str(),
                            &limit.fetch_count(),
                        ],
                    )
                    .await,
                (None, None) => transaction
                    .query(
                        "SELECT evaluation_id, result_id, result_revision, evaluator_release_id,
                                evaluation_rubric_revision_id, dimension_scores,
                                evidence_segment_ids, violation_codes, overall_score_bps,
                                quality_grade, bad_case_reasons,
                                floor(extract(epoch FROM created_at) * 1000)::BIGINT
                         FROM converact_conversation_evaluations
                         WHERE tenant_id = $1 AND interaction_id = $2
                         ORDER BY created_at DESC, evaluation_id DESC LIMIT $3",
                        &[&tenant_id, &interaction_id, &limit.fetch_count()],
                    )
                    .await,
                _ => return Err(ConversationResultStoreError::InvalidQuery),
            }
            .map_err(|_| ConversationResultStoreError::DatabaseUnavailable)?;
        page(&rows, limit, evaluation_view, |item| {
            item.evaluation_id.clone()
        })
    }

    /// Lists the tenant Bad Case queue newest first without transcript or summary content.
    ///
    /// # Errors
    ///
    /// Returns invalid cursor, database, JSON, conversion or stored-row failures.
    pub async fn list_bad_cases(
        &self,
        transaction: &Transaction<'_>,
        tenant_id: &str,
        cursor: Option<&EntityCursor>,
        limit: QueryLimit,
    ) -> Result<QueryPage<BadCaseView>, ConversationResultStoreError> {
        let cursor_time = bad_case_cursor_timestamp(transaction, tenant_id, cursor).await?;
        let rows = match (cursor, cursor_time) {
            (Some(cursor), Some(created_at)) => {
                transaction
                    .query(
                        "SELECT bad_case_id, interaction_id, evaluation_id, bad_case_reasons,
                                review_state,
                                floor(extract(epoch FROM created_at) * 1000)::BIGINT
                         FROM converact_conversation_bad_cases
                         WHERE tenant_id = $1 AND (created_at, bad_case_id) <
                           ($2::TIMESTAMPTZ, $3)
                         ORDER BY created_at DESC, bad_case_id DESC LIMIT $4",
                        &[
                            &tenant_id,
                            &created_at,
                            &cursor.as_str(),
                            &limit.fetch_count(),
                        ],
                    )
                    .await
            }
            (None, None) => {
                transaction
                    .query(
                        "SELECT bad_case_id, interaction_id, evaluation_id, bad_case_reasons,
                                review_state,
                                floor(extract(epoch FROM created_at) * 1000)::BIGINT
                         FROM converact_conversation_bad_cases
                         WHERE tenant_id = $1
                         ORDER BY created_at DESC, bad_case_id DESC LIMIT $2",
                        &[&tenant_id, &limit.fetch_count()],
                    )
                    .await
            }
            _ => return Err(ConversationResultStoreError::InvalidQuery),
        }
        .map_err(|_| ConversationResultStoreError::DatabaseUnavailable)?;
        page(&rows, limit, bad_case_view, |item| item.bad_case_id.clone())
    }
}

async fn evaluation_cursor_timestamp(
    transaction: &Transaction<'_>,
    tenant_id: &str,
    interaction_id: &str,
    cursor: Option<&EntityCursor>,
) -> Result<Option<String>, ConversationResultStoreError> {
    let Some(cursor) = cursor else {
        return Ok(None);
    };
    let row = transaction
        .query_opt(
            "SELECT created_at::TEXT
             FROM converact_conversation_evaluations
             WHERE tenant_id = $1 AND interaction_id = $2 AND evaluation_id = $3",
            &[&tenant_id, &interaction_id, &cursor.as_str()],
        )
        .await
        .map_err(|_| ConversationResultStoreError::DatabaseUnavailable)?
        .ok_or(ConversationResultStoreError::InvalidQuery)?;
    Ok(Some(string_at(&row, 0)?))
}

async fn bad_case_cursor_timestamp(
    transaction: &Transaction<'_>,
    tenant_id: &str,
    cursor: Option<&EntityCursor>,
) -> Result<Option<String>, ConversationResultStoreError> {
    let Some(cursor) = cursor else {
        return Ok(None);
    };
    let row = transaction
        .query_opt(
            "SELECT created_at::TEXT
             FROM converact_conversation_bad_cases
             WHERE tenant_id = $1 AND bad_case_id = $2",
            &[&tenant_id, &cursor.as_str()],
        )
        .await
        .map_err(|_| ConversationResultStoreError::DatabaseUnavailable)?
        .ok_or(ConversationResultStoreError::InvalidQuery)?;
    Ok(Some(string_at(&row, 0)?))
}

fn page<T, F, C>(
    rows: &[Row],
    limit: QueryLimit,
    map: F,
    cursor: C,
) -> Result<QueryPage<T>, ConversationResultStoreError>
where
    F: Fn(&Row) -> Result<T, ConversationResultStoreError>,
    C: Fn(&T) -> String,
{
    let has_more = rows.len() > usize::from(limit.get());
    let items = rows
        .iter()
        .take(usize::from(limit.get()))
        .map(map)
        .collect::<Result<Vec<_>, _>>()?;
    let next_cursor = if has_more {
        items.last().map(cursor)
    } else {
        None
    };
    QueryPage::try_new(items, next_cursor)
}

fn result_view(row: &Row) -> Result<ConversationResultView, ConversationResultStoreError> {
    Ok(ConversationResultView {
        result_id: string_at(row, 0)?,
        interaction_id: string_at(row, 1)?,
        result_revision: u64_at(row, 2)?,
        agent_release_id: string_at(row, 3)?,
        outcome_schema_revision_id: string_at(row, 4)?,
        transcript_snapshot_digest: string_at(row, 5)?,
        summary_artifact_ref: string_at(row, 6)?,
        intent: string_at(row, 7)?,
        disposition: string_at(row, 8)?,
        outcome_code: string_at(row, 9)?,
        confidence_bps: u16_at(row, 10)?,
        attributes: json_at(row, 11)?,
        created_at_ms: u64_at(row, 12)?,
    })
}

fn transcript_view(row: &Row) -> Result<TranscriptSegmentView, ConversationResultStoreError> {
    Ok(TranscriptSegmentView {
        segment_id: string_at(row, 0)?,
        execution_generation: u64_at(row, 1)?,
        segment_sequence: u64_at(row, 2)?,
        speaker: string_at(row, 3)?,
        language: string_at(row, 4)?,
        text: string_at(row, 5)?,
        start_offset_ms: u64_at(row, 6)?,
        end_offset_ms: u64_at(row, 7)?,
        observed_at_ms: u64_at(row, 8)?,
        historical: row
            .try_get(9)
            .map_err(|_| ConversationResultStoreError::StoredRowInvalid)?,
    })
}

fn typed_transcript_segment(
    row: &Row,
    context: &EnvelopeContext,
) -> Result<TranscriptSegment, ConversationResultStoreError> {
    if bool_at(row, 11)? {
        return Err(ConversationResultStoreError::StoredRowInvalid);
    }
    let stored_payload_hash = string_at(row, 10)?;
    let segment = TranscriptSegment::try_new(TranscriptSegmentInput {
        id: TranscriptSegmentId::parse(&string_at(row, 0)?)
            .map_err(|_| ConversationResultStoreError::StoredRowInvalid)?,
        context: context.clone(),
        source_event_id: EventId::parse(&string_at(row, 1)?)
            .map_err(|_| ConversationResultStoreError::StoredRowInvalid)?,
        sequence: u64_at(row, 2)?,
        speaker: transcript_speaker_at(row, 3)?,
        language: string_at(row, 4)?,
        text: string_at(row, 5)?,
        start_offset_ms: u64_at(row, 6)?,
        end_offset_ms: u64_at(row, 7)?,
        observed_at_ms: u64_at(row, 8)?,
        retention_policy_ref: string_at(row, 9)?,
    })
    .map_err(|_| ConversationResultStoreError::StoredRowInvalid)?;
    if segment.payload_hash() != stored_payload_hash {
        return Err(ConversationResultStoreError::StoredRowInvalid);
    }
    Ok(segment)
}

fn transcript_speaker_at(
    row: &Row,
    index: usize,
) -> Result<TranscriptSpeaker, ConversationResultStoreError> {
    match string_at(row, index)?.as_str() {
        "customer" => Ok(TranscriptSpeaker::Customer),
        "ai_agent" => Ok(TranscriptSpeaker::AiAgent),
        "human_agent" => Ok(TranscriptSpeaker::HumanAgent),
        "system" => Ok(TranscriptSpeaker::System),
        _ => Err(ConversationResultStoreError::StoredRowInvalid),
    }
}

fn evaluation_view(row: &Row) -> Result<ConversationEvaluationView, ConversationResultStoreError> {
    Ok(ConversationEvaluationView {
        evaluation_id: string_at(row, 0)?,
        result_id: string_at(row, 1)?,
        result_revision: u64_at(row, 2)?,
        evaluator_release_id: string_at(row, 3)?,
        evaluation_rubric_revision_id: string_at(row, 4)?,
        dimension_scores_bps: json_at(row, 5)?,
        evidence_segment_ids: json_at(row, 6)?,
        violation_codes: json_at(row, 7)?,
        overall_score_bps: u16_at(row, 8)?,
        quality_grade: string_at(row, 9)?,
        bad_case_reasons: json_at(row, 10)?,
        created_at_ms: u64_at(row, 11)?,
    })
}

fn bad_case_view(row: &Row) -> Result<BadCaseView, ConversationResultStoreError> {
    Ok(BadCaseView {
        bad_case_id: string_at(row, 0)?,
        interaction_id: string_at(row, 1)?,
        evaluation_id: string_at(row, 2)?,
        bad_case_reasons: json_at(row, 3)?,
        review_state: string_at(row, 4)?,
        created_at_ms: u64_at(row, 5)?,
    })
}

fn string_at(row: &Row, index: usize) -> Result<String, ConversationResultStoreError> {
    row.try_get(index)
        .map_err(|_| ConversationResultStoreError::StoredRowInvalid)
}

fn i64_at(row: &Row, index: usize) -> Result<i64, ConversationResultStoreError> {
    row.try_get(index)
        .map_err(|_| ConversationResultStoreError::StoredRowInvalid)
}

fn bool_at(row: &Row, index: usize) -> Result<bool, ConversationResultStoreError> {
    row.try_get(index)
        .map_err(|_| ConversationResultStoreError::StoredRowInvalid)
}

fn u64_at(row: &Row, index: usize) -> Result<u64, ConversationResultStoreError> {
    u64::try_from(i64_at(row, index)?).map_err(|_| ConversationResultStoreError::StoredRowInvalid)
}

fn u16_at(row: &Row, index: usize) -> Result<u16, ConversationResultStoreError> {
    let value: i32 = row
        .try_get(index)
        .map_err(|_| ConversationResultStoreError::StoredRowInvalid)?;
    u16::try_from(value).map_err(|_| ConversationResultStoreError::StoredRowInvalid)
}

fn json_at<T>(row: &Row, index: usize) -> Result<T, ConversationResultStoreError>
where
    T: serde::de::DeserializeOwned,
{
    let value: Value = row
        .try_get(index)
        .map_err(|_| ConversationResultStoreError::StoredRowInvalid)?;
    serde_json::from_value(value).map_err(|_| ConversationResultStoreError::StoredRowInvalid)
}

fn bounded_identifier(value: &str, maximum: usize) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= maximum
        && first.is_ascii_alphanumeric()
        && remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}
