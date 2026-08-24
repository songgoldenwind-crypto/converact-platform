use std::{error::Error, fmt, sync::Arc};

use tokio::sync::watch;

use crate::InternalMtlsServerConfig;

const INITIAL_CONFIG_REVISION: u64 = 1;

/// SHA-256 content identity supplied by the bounded material loader.
#[derive(Clone, Copy, Eq, Hash, PartialEq)]
pub struct InternalMtlsConfigFingerprint([u8; 32]);

impl InternalMtlsConfigFingerprint {
    #[must_use]
    pub const fn from_sha256(digest: [u8; 32]) -> Self {
        Self(digest)
    }
}

impl fmt::Debug for InternalMtlsConfigFingerprint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("InternalMtlsConfigFingerprint([REDACTED])")
    }
}

/// One fully validated configuration candidate and its content identity.
pub struct InternalMtlsConfigCandidate {
    server_config: InternalMtlsServerConfig,
    fingerprint: InternalMtlsConfigFingerprint,
}

impl InternalMtlsConfigCandidate {
    #[must_use]
    pub const fn new(
        server_config: InternalMtlsServerConfig,
        fingerprint: InternalMtlsConfigFingerprint,
    ) -> Self {
        Self {
            server_config,
            fingerprint,
        }
    }
}

impl fmt::Debug for InternalMtlsConfigCandidate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("InternalMtlsConfigCandidate([REDACTED])")
    }
}

/// Result of one serialized atomic publication attempt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InternalMtlsConfigPublishOutcome {
    Unchanged { revision: u64 },
    Published { revision: u64 },
}

/// Stable value-free publication failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InternalMtlsConfigPublishError {
    RevisionExhausted,
}

impl fmt::Display for InternalMtlsConfigPublishError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("internal_mtls_config_revision_exhausted")
    }
}

impl Error for InternalMtlsConfigPublishError {}

struct PublishedConfig {
    server_config: InternalMtlsServerConfig,
    fingerprint: InternalMtlsConfigFingerprint,
    revision: u64,
}

/// Atomic last-known-good configuration slot.
#[derive(Clone)]
pub struct InternalMtlsConfigSlot {
    sender: watch::Sender<Arc<PublishedConfig>>,
}

impl InternalMtlsConfigSlot {
    #[must_use]
    pub fn new(initial: InternalMtlsConfigCandidate) -> Self {
        Self::new_at_revision(initial, INITIAL_CONFIG_REVISION)
    }

    #[must_use]
    pub fn current_revision(&self) -> u64 {
        self.sender.borrow().revision
    }

    /// Atomically publishes a changed complete configuration.
    ///
    /// Equal fingerprints are idempotent. Revision exhaustion retains the
    /// exact previously published generation.
    ///
    /// # Errors
    ///
    /// Returns [`InternalMtlsConfigPublishError::RevisionExhausted`] without
    /// modifying the slot when the checked process-local revision is full.
    pub fn publish(
        &self,
        candidate: InternalMtlsConfigCandidate,
    ) -> Result<InternalMtlsConfigPublishOutcome, InternalMtlsConfigPublishError> {
        let mut outcome = None;
        self.sender.send_if_modified(|current| {
            if current.fingerprint == candidate.fingerprint {
                outcome = Some(InternalMtlsConfigPublishOutcome::Unchanged {
                    revision: current.revision,
                });
                return false;
            }
            let Ok(revision) = checked_next_revision(current.revision) else {
                return false;
            };
            *current = Arc::new(PublishedConfig {
                server_config: candidate.server_config,
                fingerprint: candidate.fingerprint,
                revision,
            });
            outcome = Some(InternalMtlsConfigPublishOutcome::Published { revision });
            true
        });
        outcome.ok_or(InternalMtlsConfigPublishError::RevisionExhausted)
    }

    pub(crate) fn subscribe(&self) -> InternalMtlsConfigReceiver {
        InternalMtlsConfigReceiver {
            receiver: self.sender.subscribe(),
        }
    }

    fn new_at_revision(initial: InternalMtlsConfigCandidate, revision: u64) -> Self {
        let (sender, _) = watch::channel(Arc::new(PublishedConfig {
            server_config: initial.server_config,
            fingerprint: initial.fingerprint,
            revision,
        }));
        Self { sender }
    }
}

impl fmt::Debug for InternalMtlsConfigSlot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("InternalMtlsConfigSlot([REDACTED])")
    }
}

pub(crate) struct InternalMtlsConfigReceiver {
    receiver: watch::Receiver<Arc<PublishedConfig>>,
}

impl InternalMtlsConfigReceiver {
    pub(crate) fn fixed(server_config: InternalMtlsServerConfig) -> Self {
        InternalMtlsConfigSlot::new(InternalMtlsConfigCandidate::new(
            server_config,
            InternalMtlsConfigFingerprint::from_sha256([0; 32]),
        ))
        .subscribe()
    }

    pub(crate) fn current_config(&self) -> InternalMtlsServerConfig {
        let published = self.receiver.borrow();
        published.server_config.clone()
    }
}

fn checked_next_revision(current: u64) -> Result<u64, InternalMtlsConfigPublishError> {
    current
        .checked_add(1)
        .ok_or(InternalMtlsConfigPublishError::RevisionExhausted)
}

#[cfg(test)]
mod tests {
    use rcgen::{
        BasicConstraints, CertificateParams, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
        KeyUsagePurpose,
    };

    use crate::MtlsMaterialPolicy;

    use super::*;

    #[test]
    fn revision_exhaustion_is_explicit() {
        assert_eq!(checked_next_revision(u64::MAX - 1), Ok(u64::MAX));
        assert_eq!(
            checked_next_revision(u64::MAX),
            Err(InternalMtlsConfigPublishError::RevisionExhausted)
        );
    }

    #[test]
    fn changed_candidate_at_revision_exhaustion_retains_the_published_generation() {
        let config = test_config();
        let slot = InternalMtlsConfigSlot::new_at_revision(
            InternalMtlsConfigCandidate::new(
                config.clone(),
                InternalMtlsConfigFingerprint::from_sha256([1; 32]),
            ),
            u64::MAX,
        );

        assert_eq!(
            slot.publish(InternalMtlsConfigCandidate::new(
                config,
                InternalMtlsConfigFingerprint::from_sha256([2; 32]),
            )),
            Err(InternalMtlsConfigPublishError::RevisionExhausted)
        );
        assert_eq!(slot.current_revision(), u64::MAX);
    }

    fn test_config() -> InternalMtlsServerConfig {
        let ca_key = KeyPair::generate().unwrap();
        let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
        ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        ca_params.key_usages = vec![KeyUsagePurpose::KeyCertSign];
        let ca = ca_params.self_signed(&ca_key).unwrap();
        let issuer = Issuer::from_params(&ca_params, &ca_key);
        let server_key = KeyPair::generate().unwrap();
        let mut server_params =
            CertificateParams::new(vec!["internal.converact.test".to_owned()]).unwrap();
        server_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        let server = server_params.signed_by(&server_key, &issuer).unwrap();
        InternalMtlsServerConfig::from_der(
            &[server.der(), ca.der()],
            &server_key.serialize_der(),
            &[ca.der()],
            &[],
            &MtlsMaterialPolicy::strict(),
        )
        .unwrap()
    }
}
