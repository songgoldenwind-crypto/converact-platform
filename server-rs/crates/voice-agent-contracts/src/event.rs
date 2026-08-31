use serde::{Deserialize, Deserializer, Serialize, de::Error as _};

use crate::{EnvelopeContext, EnvelopeError, EventId};

/// A versioned event with both source and receiver clock evidence.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct EventEnvelope<T> {
    #[serde(flatten)]
    context: EnvelopeContext,
    event_id: EventId,
    occurred_at_ms: u64,
    received_at_ms: u64,
    event: T,
}

#[derive(Deserialize)]
struct EventEnvelopeWire<T> {
    #[serde(flatten)]
    context: EnvelopeContext,
    event_id: EventId,
    occurred_at_ms: u64,
    received_at_ms: u64,
    event: T,
}

impl<T> EventEnvelope<T> {
    /// Validates clock ordering and creates an event envelope.
    ///
    /// # Errors
    ///
    /// Rejects an event received before its declared occurrence time.
    pub fn try_new(
        context: EnvelopeContext,
        event_id: EventId,
        occurred_at_ms: u64,
        received_at_ms: u64,
        event: T,
    ) -> Result<Self, EnvelopeError> {
        if received_at_ms < occurred_at_ms {
            return Err(EnvelopeError::InvalidTimestampOrder);
        }
        Ok(Self {
            context,
            event_id,
            occurred_at_ms,
            received_at_ms,
            event,
        })
    }

    /// Returns the validated authority metadata.
    #[must_use]
    pub const fn context(&self) -> &EnvelopeContext {
        &self.context
    }

    /// Returns the unique event identifier.
    #[must_use]
    pub const fn event_id(&self) -> &EventId {
        &self.event_id
    }

    /// Returns the source clock time in Unix milliseconds.
    #[must_use]
    pub const fn occurred_at_ms(&self) -> u64 {
        self.occurred_at_ms
    }

    /// Returns the receiver clock time in Unix milliseconds.
    #[must_use]
    pub const fn received_at_ms(&self) -> u64 {
        self.received_at_ms
    }

    /// Returns the event payload.
    #[must_use]
    pub const fn event(&self) -> &T {
        &self.event
    }
}

impl<'de, T> Deserialize<'de> for EventEnvelope<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = EventEnvelopeWire::<T>::deserialize(deserializer)?;
        Self::try_new(
            wire.context,
            wire.event_id,
            wire.occurred_at_ms,
            wire.received_at_ms,
            wire.event,
        )
        .map_err(D::Error::custom)
    }
}
