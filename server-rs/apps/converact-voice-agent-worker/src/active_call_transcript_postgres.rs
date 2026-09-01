use std::{error::Error, fmt};

use converact_conversation_result_core::{
    TranscriptGenerationStatus, TranscriptSegment, TranscriptSegmentDraft,
};
use converact_conversation_result_store::{TranscriptHistoryLimit, TranscriptHistoryWindow};
use converact_postgres_store::{
    PostgresConversationResultStore, PostgresSequencedTranscriptAppend,
    PostgresTranscriptAppendDecision,
};
use converact_voice_agent_contracts::ExecutionGeneration;

use crate::{
    ActiveCallTranscriptDurabilityPort, ActiveCallTranscriptIngestError,
    TranscriptUnderstandingDisposition,
};

/// Converts the durable append receipt into the only three understanding processing dispositions.
#[must_use]
pub const fn map_postgres_transcript_understanding_disposition(
    decision: PostgresTranscriptAppendDecision,
) -> TranscriptUnderstandingDisposition {
    match decision {
        PostgresTranscriptAppendDecision::Appended(TranscriptGenerationStatus::Current) => {
            TranscriptUnderstandingDisposition::AppendedCurrent
        }
        PostgresTranscriptAppendDecision::Replayed(TranscriptGenerationStatus::Current) => {
            TranscriptUnderstandingDisposition::ReplayedCurrent
        }
        PostgresTranscriptAppendDecision::Appended(TranscriptGenerationStatus::Historical)
        | PostgresTranscriptAppendDecision::Replayed(TranscriptGenerationStatus::Historical) => {
            TranscriptUnderstandingDisposition::Historical
        }
    }
}

/// Sanitized failure while preparing durable transcript input for understanding.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TranscriptUnderstandingSourceError {
    HistoryUnavailable,
}

impl TranscriptUnderstandingSourceError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::HistoryUnavailable => "transcript_understanding_history_unavailable",
        }
    }
}

impl fmt::Display for TranscriptUnderstandingSourceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for TranscriptUnderstandingSourceError {}

/// Port for the exact typed context ending at a durable append receipt segment.
pub trait TranscriptUnderstandingHistoryPort {
    fn load_recent_transcript_window(
        &self,
        current: &TranscriptSegment,
        limit: TranscriptHistoryLimit,
    ) -> impl Future<Output = Result<TranscriptHistoryWindow, TranscriptUnderstandingSourceError>> + Send;
}

/// Prepared append source. Transcript text is intentionally absent from `Debug` output.
#[derive(Clone, Eq, PartialEq)]
pub struct PostgresTranscriptUnderstandingSource {
    disposition: TranscriptUnderstandingDisposition,
    history: Option<TranscriptHistoryWindow>,
}

impl PostgresTranscriptUnderstandingSource {
    #[must_use]
    pub const fn disposition(&self) -> TranscriptUnderstandingDisposition {
        self.disposition
    }

    #[must_use]
    pub fn history(&self) -> &[TranscriptSegment] {
        self.history
            .as_ref()
            .map_or(&[], TranscriptHistoryWindow::segments)
    }

    #[must_use]
    pub fn into_history(self) -> Option<TranscriptHistoryWindow> {
        self.history
    }
}

/// Maps one append receipt and loads history only for a newly appended current segment.
///
/// # Errors
///
/// Returns a redacted history failure only when the new current segment cannot be loaded and
/// revalidated. Replay and historical receipts never invoke the history port.
pub async fn prepare_postgres_transcript_understanding_source<H>(
    history: &H,
    current: &TranscriptSegment,
    decision: PostgresTranscriptAppendDecision,
    limit: TranscriptHistoryLimit,
) -> Result<PostgresTranscriptUnderstandingSource, TranscriptUnderstandingSourceError>
where
    H: TranscriptUnderstandingHistoryPort + Sync,
{
    let disposition = map_postgres_transcript_understanding_disposition(decision);
    prepare_transcript_understanding_source(history, current, disposition, limit).await
}

/// Loads exact bounded history for a pre-classified append receipt.
///
/// # Errors
///
/// Returns a redacted history failure only for a newly appended current segment.
pub async fn prepare_transcript_understanding_source<H>(
    history: &H,
    current: &TranscriptSegment,
    disposition: TranscriptUnderstandingDisposition,
    limit: TranscriptHistoryLimit,
) -> Result<PostgresTranscriptUnderstandingSource, TranscriptUnderstandingSourceError>
where
    H: TranscriptUnderstandingHistoryPort + Sync,
{
    let window = match disposition {
        TranscriptUnderstandingDisposition::AppendedCurrent => Some(
            history
                .load_recent_transcript_window(current, limit)
                .await?,
        ),
        TranscriptUnderstandingDisposition::ReplayedCurrent
        | TranscriptUnderstandingDisposition::Historical => None,
    };
    Ok(PostgresTranscriptUnderstandingSource {
        disposition,
        history: window,
    })
}

impl TranscriptUnderstandingHistoryPort for PostgresConversationResultStore {
    async fn load_recent_transcript_window(
        &self,
        current: &TranscriptSegment,
        limit: TranscriptHistoryLimit,
    ) -> Result<TranscriptHistoryWindow, TranscriptUnderstandingSourceError> {
        PostgresConversationResultStore::load_recent_transcript_window(self, current, limit)
            .await
            .map_err(|_| TranscriptUnderstandingSourceError::HistoryUnavailable)
    }
}

impl ActiveCallTranscriptDurabilityPort for PostgresConversationResultStore {
    type Append = PostgresSequencedTranscriptAppend;

    async fn append_sequenced_final_segment(
        &self,
        draft: &TranscriptSegmentDraft,
        current_generation: ExecutionGeneration,
    ) -> Result<Self::Append, ActiveCallTranscriptIngestError> {
        PostgresConversationResultStore::append_sequenced_final_segment(
            self,
            draft,
            current_generation,
        )
        .await
        .map_err(|_| ActiveCallTranscriptIngestError::StoreUnavailable)
    }
}
