use converact_migration_store::{
    CLAIM_GENERATION_WORK_SQL, LEASE_RENEWAL_SQL, LeaseDigest, LeaseToken,
    RELEASE_GENERATION_WORK_SQL, StoreConfig, StoreConfigError, WRITER_FENCE_PREDICATE_SQL,
};

#[test]
fn store_config_bounds_database_clock_windows() {
    assert!(StoreConfig::new(30_000, 86_400_000).is_ok());
    assert_eq!(
        StoreConfig::new(0, 1),
        Err(StoreConfigError::InvalidLeaseTtl)
    );
    assert_eq!(
        StoreConfig::new(86_400_001, 1),
        Err(StoreConfigError::InvalidLeaseTtl)
    );
    assert_eq!(
        StoreConfig::new(1, 0),
        Err(StoreConfigError::InvalidRollbackWindow)
    );
    assert_eq!(
        StoreConfig::new(1, 2_592_000_001),
        Err(StoreConfigError::InvalidRollbackWindow)
    );
}

#[test]
fn raw_lease_capability_is_validated_and_never_debugged() {
    let token = LeaseToken::parse(&"a".repeat(64)).unwrap();
    assert_eq!(format!("{token:?}"), "LeaseToken([REDACTED])");
    for invalid in ["a".repeat(63), "A".repeat(64), "g".repeat(64)] {
        let error = LeaseToken::parse(&invalid).unwrap_err();
        assert!(!error.to_string().contains(&invalid));
    }
}

#[test]
fn lease_digest_accepts_only_exact_lowercase_sha256_without_echoing_it() {
    let digest = LeaseDigest::parse(&"a".repeat(64)).unwrap();
    assert_eq!(digest.as_str(), "a".repeat(64));
    for invalid in ["a".repeat(63), "A".repeat(64), "g".repeat(64)] {
        let error = LeaseDigest::parse(&invalid).unwrap_err();
        assert!(!error.to_string().contains(&invalid));
    }
}

#[test]
fn writer_fence_is_an_embeddable_same_statement_predicate() {
    assert!(WRITER_FENCE_PREDICATE_SQL.starts_with("converact_authority_writer_fence("));
    assert!(WRITER_FENCE_PREDICATE_SQL.contains("$1, $2, $3"));
    assert!(WRITER_FENCE_PREDICATE_SQL.contains("$4::text::numeric"));
    assert!(WRITER_FENCE_PREDICATE_SQL.contains("$5::text::numeric"));
    assert!(WRITER_FENCE_PREDICATE_SQL.ends_with(')'));
    assert!(!WRITER_FENCE_PREDICATE_SQL.contains(';'));
}

#[test]
fn lease_renewal_calls_only_the_exact_database_clock_function() {
    assert_eq!(
        LEASE_RENEWAL_SQL,
        "SELECT converact_authority_renew_lease($1, $2, $3, $4::text::numeric, $5::text::numeric, $6, $7::bigint)"
    );
}

#[test]
fn active_work_claims_use_closed_same_statement_functions() {
    assert!(
        CLAIM_GENERATION_WORK_SQL.starts_with("SELECT converact_authority_claim_generation_work(")
    );
    assert!(
        RELEASE_GENERATION_WORK_SQL
            .starts_with("SELECT converact_authority_release_generation_work(")
    );
    assert!(!CLAIM_GENERATION_WORK_SQL.contains(';'));
    assert!(!RELEASE_GENERATION_WORK_SQL.contains(';'));
}
