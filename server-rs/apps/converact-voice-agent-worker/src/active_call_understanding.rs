use std::{error::Error, fmt, future::Future};

use converact_active_call_adapter::NormalizedEvent;
use converact_conversation_result_core::TranscriptSegment;
use converact_conversation_result_store::TranscriptHistoryLimit;
use converact_postgres_store::PostgresSequencedTranscriptAppend;
use converact_voice_agent_contracts::ExecutionGeneration;

use crate::{
    ActiveCallTranscriptBinding, ActiveCallTranscriptDurabilityPort,
    FinalTranscriptUnderstandingError, TranscriptUnderstandingDisposition,
    TranscriptUnderstandingHistoryPort, append_active_call_final_transcript,
    prepare_transcript_understanding_source,
};

/// Minimum append receipt needed to continue one final transcript into understanding.
pub trait TranscriptUnderstandingAppendReceipt {
    fn segment(&self) -> &TranscriptSegment;
    fn disposition(&self) -> TranscriptUnderstandingDisposition;
}

impl TranscriptUnderstandingAppendReceipt for PostgresSequencedTranscriptAppend {
    fn segment(&self) -> &TranscriptSegment {
        self.segment()
    }

    fn disposition(&self) -> TranscriptUnderstandingDisposition {
        crate::map_postgres_transcript_understanding_disposition(self.decision())
    }
}

/// Product-neutral final-turn processor invoked only after transcript sequencing/history gates.
pub trait FinalTranscriptUnderstandingPort: Sync {
    type Outcome: Send;

    fn process<'a>(
        &'a self,
        disposition: TranscriptUnderstandingDisposition,
        history: &'a [TranscriptSegment],
    ) -> impl Future<Output = Result<Self::Outcome, FinalTranscriptUnderstandingError>> + Send + 'a;
}

/// Result of consuming one normalized Active Call event.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ActiveCallUnderstandingEventOutcome<O> {
    Ignored,
    Processed(O),
}

/// Stable coordinator failure without transcript, endpoint or Store details.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActiveCallUnderstandingEventError {
    TranscriptIngestFailed,
    HistoryUnavailable,
    UnderstandingFailed,
}

impl ActiveCallUnderstandingEventError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::TranscriptIngestFailed => "active_call_understanding_transcript_ingest_failed",
            Self::HistoryUnavailable => "active_call_understanding_history_unavailable",
            Self::UnderstandingFailed => "active_call_understanding_processing_failed",
        }
    }
}

impl fmt::Display for ActiveCallUnderstandingEventError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for ActiveCallUnderstandingEventError {}

/// Sequences one eligible Active Call final, loads bounded history only for a new current append,
/// and invokes one understanding processor.
///
/// # Errors
///
/// Returns redacted ingest, history or understanding categories. Ignored events perform no Store
/// or model work; replay/historical receipts never load transcript history.
pub async fn process_active_call_understanding_event<D, P>(
    store: &D,
    processor: &P,
    binding: &ActiveCallTranscriptBinding,
    event: &NormalizedEvent,
    current_generation: ExecutionGeneration,
    history_limit: TranscriptHistoryLimit,
) -> Result<ActiveCallUnderstandingEventOutcome<P::Outcome>, ActiveCallUnderstandingEventError>
where
    D: ActiveCallTranscriptDurabilityPort + TranscriptUnderstandingHistoryPort,
    D::Append: TranscriptUnderstandingAppendReceipt,
    P: FinalTranscriptUnderstandingPort,
{
    let Some(receipt) =
        append_active_call_final_transcript(store, binding, event, current_generation)
            .await
            .map_err(|_| ActiveCallUnderstandingEventError::TranscriptIngestFailed)?
    else {
        return Ok(ActiveCallUnderstandingEventOutcome::Ignored);
    };
    let source = prepare_transcript_understanding_source(
        store,
        receipt.segment(),
        receipt.disposition(),
        history_limit,
    )
    .await
    .map_err(|_| ActiveCallUnderstandingEventError::HistoryUnavailable)?;
    processor
        .process(source.disposition(), source.history())
        .await
        .map(ActiveCallUnderstandingEventOutcome::Processed)
        .map_err(|_| ActiveCallUnderstandingEventError::UnderstandingFailed)
}
