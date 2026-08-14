//! Bounded cross-runtime identifiers for Converact server authorities.

use std::{error::Error, fmt};

const MAX_IDENTIFIER_BYTES: usize = 255;

/// A rejected authority identifier or generation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IdentityError {
    /// A textual identifier does not match the frozen wire grammar.
    InvalidIdentifier,
    /// An owner epoch is not a canonical unsigned 64-bit decimal value.
    InvalidOwnerEpoch,
    /// A generation must be positive.
    InvalidGeneration,
    /// A generation cannot be incremented without wrapping.
    GenerationExhausted,
}

impl fmt::Display for IdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidIdentifier => "invalid bounded identifier",
            Self::InvalidOwnerEpoch => "invalid owner epoch",
            Self::InvalidGeneration => "invalid generation",
            Self::GenerationExhausted => "generation exhausted",
        })
    }
}

impl Error for IdentityError {}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
struct BoundedId(Box<str>);

impl BoundedId {
    fn parse(value: &str) -> Result<Self, IdentityError> {
        let bytes = value.as_bytes();
        let Some((&first, remainder)) = bytes.split_first() else {
            return Err(IdentityError::InvalidIdentifier);
        };
        if bytes.len() > MAX_IDENTIFIER_BYTES
            || !first.is_ascii_alphanumeric()
            || !remainder.iter().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
            })
        {
            return Err(IdentityError::InvalidIdentifier);
        }
        Ok(Self(value.into()))
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

/// A tenant identifier on an authority boundary.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct TenantId(BoundedId);

impl TenantId {
    /// Parses the existing 1-to-255-byte ASCII identifier grammar.
    ///
    /// # Errors
    ///
    /// Returns [`IdentityError::InvalidIdentifier`] when the value is empty,
    /// oversized or contains a character outside `[A-Za-z0-9._:-]`.
    pub fn parse(value: impl AsRef<str>) -> Result<Self, IdentityError> {
        BoundedId::parse(value.as_ref()).map(Self)
    }

    /// Returns the canonical wire value.
    #[must_use]
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

/// A Cell identifier on an authority boundary.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct CellId(BoundedId);

impl CellId {
    /// Parses the existing 1-to-255-byte ASCII identifier grammar.
    ///
    /// # Errors
    ///
    /// Returns [`IdentityError::InvalidIdentifier`] when the value is empty,
    /// oversized or contains a character outside `[A-Za-z0-9._:-]`.
    pub fn parse(value: impl AsRef<str>) -> Result<Self, IdentityError> {
        BoundedId::parse(value.as_ref()).map(Self)
    }

    /// Returns the canonical wire value.
    #[must_use]
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

/// A canonical unsigned 64-bit owner epoch encoded as decimal on the wire.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct OwnerEpoch(u64);

impl OwnerEpoch {
    /// Parses `0` or a non-zero canonical decimal value without leading zeros.
    ///
    /// # Errors
    ///
    /// Returns [`IdentityError::InvalidOwnerEpoch`] for non-canonical text or
    /// a value larger than `u64::MAX`.
    pub fn parse(value: &str) -> Result<Self, IdentityError> {
        let canonical = value == "0"
            || (value.len() <= 20
                && value.as_bytes().first().is_some_and(u8::is_ascii_digit)
                && !value.starts_with('0')
                && value.bytes().all(|byte| byte.is_ascii_digit()));
        if !canonical {
            return Err(IdentityError::InvalidOwnerEpoch);
        }
        value
            .parse::<u64>()
            .map(Self)
            .map_err(|_| IdentityError::InvalidOwnerEpoch)
    }

    /// Returns the numeric epoch.
    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }
}

impl fmt::Display for OwnerEpoch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// A positive authority generation.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct Generation(u64);

impl Generation {
    /// Creates a positive generation.
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

    /// Returns the numeric generation.
    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }

    /// Advances by exactly one without wrapping.
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
