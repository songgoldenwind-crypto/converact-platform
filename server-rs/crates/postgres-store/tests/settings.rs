use std::time::Duration;

use converact_postgres_store::{PostgresRuntimeLimits, PostgresRuntimeSettings, SettingsError};

#[test]
fn runtime_limits_are_explicit_bounded_and_internally_ordered() {
    let settings = PostgresRuntimeSettings::new(valid_limits()).expect("valid settings");
    assert_eq!(settings.max_connections(), 8);
    assert_eq!(settings.max_waiters(), 16);
    assert_eq!(settings.pool_wait_timeout(), Duration::from_millis(250));
    assert_eq!(settings.connect_timeout(), Duration::from_secs(2));
    assert_eq!(settings.recycle_timeout(), Duration::from_millis(250));
    assert_eq!(settings.statement_timeout(), Duration::from_secs(2));
    assert_eq!(settings.lock_timeout(), Duration::from_millis(500));
    assert_eq!(settings.transaction_timeout(), Duration::from_secs(3));
    assert_eq!(settings.rollback_timeout(), Duration::from_millis(500));
}

#[test]
fn stable_errors_never_debug_domain_values() {
    let error = converact_postgres_store::TransactionError::Work("never-print-me");
    assert_eq!(error.to_string(), "postgres_transaction_work_failed");
    assert!(!format!("{error:?}").contains("never-print-me"));
}

#[test]
fn zero_oversize_and_inverted_limits_fail_closed() {
    for max_connections in [0, 257] {
        assert_eq!(
            PostgresRuntimeSettings::new(PostgresRuntimeLimits {
                max_connections,
                ..valid_limits()
            }),
            Err(SettingsError::InvalidMaxConnections)
        );
    }
    assert_eq!(
        PostgresRuntimeSettings::new(PostgresRuntimeLimits {
            max_waiters: 1_025,
            ..valid_limits()
        }),
        Err(SettingsError::InvalidMaxWaiters)
    );

    let mutations: [fn(&mut PostgresRuntimeLimits); 7] = [
        |limits: &mut PostgresRuntimeLimits| limits.pool_wait_timeout = Duration::ZERO,
        |limits: &mut PostgresRuntimeLimits| limits.connect_timeout = Duration::from_secs(31),
        |limits: &mut PostgresRuntimeLimits| limits.recycle_timeout = Duration::ZERO,
        |limits: &mut PostgresRuntimeLimits| limits.statement_timeout = Duration::from_secs(61),
        |limits: &mut PostgresRuntimeLimits| limits.lock_timeout = Duration::from_secs(3),
        |limits: &mut PostgresRuntimeLimits| limits.transaction_timeout = Duration::from_secs(2),
        |limits: &mut PostgresRuntimeLimits| limits.rollback_timeout = Duration::from_secs(6),
    ];
    for mutate in mutations {
        let mut limits = valid_limits();
        mutate(&mut limits);
        assert_eq!(
            PostgresRuntimeSettings::new(limits),
            Err(SettingsError::InvalidTimeout)
        );
    }
}

fn valid_limits() -> PostgresRuntimeLimits {
    PostgresRuntimeLimits {
        max_connections: 8,
        max_waiters: 16,
        pool_wait_timeout: Duration::from_millis(250),
        connect_timeout: Duration::from_secs(2),
        recycle_timeout: Duration::from_millis(250),
        statement_timeout: Duration::from_secs(2),
        lock_timeout: Duration::from_millis(500),
        transaction_timeout: Duration::from_secs(3),
        rollback_timeout: Duration::from_millis(500),
    }
}
