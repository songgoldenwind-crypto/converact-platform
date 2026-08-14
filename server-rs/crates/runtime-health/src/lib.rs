//! Fail-closed runtime health state for Converact Rust processes.

use std::{
    error::Error,
    fmt,
    future::Future,
    sync::{Arc, RwLock},
    time::{Duration, Instant},
};

use converact_contracts::health::{
    ConfigurationCheck, ConfigurationStatus, DatabaseCheck, DatabaseStatus, MigrationCheck,
    MigrationStatus, NotificationProviderCheck, NotificationProviderStatus, PlacementSnapshotCheck,
    PlacementSnapshotStatus, ReadinessChecks, ReadinessResult, ReadinessStatus,
    RuntimeHeartbeatCheck, RuntimeHeartbeatStatus,
};
use tokio::{sync::watch, task::JoinSet, time::timeout};

const MAX_DIAGNOSTIC_ITEMS: usize = 256;
const MAX_DIAGNOSTIC_BYTES: usize = 255;
const MAX_HEALTH_TASKS: usize = 64;
const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const DEFAULT_PUBLICATION_TTL: Duration = Duration::from_secs(5);
const MIN_PUBLICATION_TTL: Duration = Duration::from_millis(1);
const MAX_PUBLICATION_TTL: Duration = Duration::from_secs(30);

/// A bounded health-state validation or storage failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HealthError {
    /// A diagnostic collection or value is malformed or oversized.
    InvalidDiagnostic,
    /// Build identity is malformed or not exact-source.
    InvalidBuildIdentity,
    /// The in-process state lock was poisoned and readiness failed closed.
    StateUnavailable,
    /// The publication freshness period is zero, unbounded or overflows.
    InvalidPublicationTtl,
}

impl fmt::Display for HealthError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidDiagnostic => "runtime_health_diagnostic_invalid",
            Self::InvalidBuildIdentity => "runtime_build_identity_invalid",
            Self::StateUnavailable => "runtime_health_state_unavailable",
            Self::InvalidPublicationTtl => "runtime_health_publication_ttl_invalid",
        })
    }
}

impl Error for HealthError {}

/// Exact build/source identity used by telemetry and evidence adapters.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BuildIdentity {
    service_name: Box<str>,
    build_version: Box<str>,
    source_commit: Box<str>,
}

impl BuildIdentity {
    /// Creates a bounded identity with an exact 40-character source commit.
    ///
    /// # Errors
    ///
    /// Returns [`HealthError::InvalidBuildIdentity`] for an invalid service,
    /// version or source commit.
    pub fn new(
        service_name: &str,
        build_version: &str,
        source_commit: &str,
    ) -> Result<Self, HealthError> {
        if !component(service_name, 100)
            || !component(build_version, 100)
            || source_commit.len() != 40
            || !source_commit.bytes().all(|byte| byte.is_ascii_hexdigit())
            || source_commit.bytes().any(|byte| byte.is_ascii_uppercase())
        {
            return Err(HealthError::InvalidBuildIdentity);
        }
        Ok(Self {
            service_name: service_name.into(),
            build_version: build_version.into(),
            source_commit: source_commit.into(),
        })
    }

    /// Verifies the runtime declaration against a build-time embedded source.
    ///
    /// # Errors
    ///
    /// Returns [`HealthError::InvalidBuildIdentity`] when the build did not
    /// embed a source commit, the declaration differs, or the identity is not
    /// canonical.
    pub fn verified(
        service_name: &str,
        build_version: &str,
        declared_source_commit: &str,
        embedded_source_commit: Option<&str>,
    ) -> Result<Self, HealthError> {
        let embedded_source_commit =
            embedded_source_commit.ok_or(HealthError::InvalidBuildIdentity)?;
        if declared_source_commit != embedded_source_commit {
            return Err(HealthError::InvalidBuildIdentity);
        }
        Self::new(service_name, build_version, embedded_source_commit)
    }

    #[must_use]
    pub fn service_name(&self) -> &str {
        &self.service_name
    }

    #[must_use]
    pub fn build_version(&self) -> &str {
        &self.build_version
    }

    #[must_use]
    pub fn source_commit(&self) -> &str {
        &self.source_commit
    }
}

/// Atomically published health checks shared by low-volume health handlers.
#[derive(Clone)]
pub struct RuntimeHealth {
    state: Arc<RwLock<PublishedChecks>>,
    clock: Arc<dyn HealthClock>,
}

impl RuntimeHealth {
    /// Starts in a fail-closed state without contacting any dependency.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Creates fail-closed state with an injected monotonic clock.
    #[must_use]
    pub fn with_clock(clock: Arc<dyn HealthClock>) -> Self {
        Self {
            state: Arc::new(RwLock::new(PublishedChecks {
                checks: failed_checks(),
                expires_at: None,
            })),
            clock,
        }
    }

    /// Validates and publishes a complete immutable check set.
    ///
    /// # Errors
    ///
    /// Returns [`HealthError`] for malformed diagnostics or poisoned state.
    pub fn publish(&self, checks: ReadinessChecks) -> Result<(), HealthError> {
        self.publish_for(checks, DEFAULT_PUBLICATION_TTL)
    }

    /// Publishes a complete snapshot with an explicit bounded freshness period.
    ///
    /// # Errors
    ///
    /// Returns [`HealthError`] for malformed diagnostics, invalid freshness or
    /// poisoned state.
    pub fn publish_for(
        &self,
        checks: ReadinessChecks,
        time_to_live: Duration,
    ) -> Result<(), HealthError> {
        validate(&checks)?;
        if !(MIN_PUBLICATION_TTL..=MAX_PUBLICATION_TTL).contains(&time_to_live) {
            return Err(HealthError::InvalidPublicationTtl);
        }
        let expires_at = self
            .clock
            .now()
            .checked_add(time_to_live)
            .ok_or(HealthError::InvalidPublicationTtl)?;
        *self
            .state
            .write()
            .map_err(|_| HealthError::StateUnavailable)? = PublishedChecks {
            checks,
            expires_at: Some(expires_at),
        };
        Ok(())
    }

    /// Returns one self-consistent snapshot and derives overall readiness.
    #[must_use]
    pub fn snapshot(&self) -> ReadinessResult {
        self.snapshot_with_failure_codes().0
    }

    /// Returns one self-consistent snapshot and its stable, bounded failure codes.
    #[must_use]
    pub fn snapshot_with_failure_codes(&self) -> (ReadinessResult, Vec<String>) {
        let published = self
            .state
            .read()
            .map_or_else(|_| None, |state| Some(state.clone()));
        let checks = published.map_or_else(failed_checks, |published| {
            if published
                .expires_at
                .is_some_and(|expires_at| self.clock.now() >= expires_at)
            {
                stale_checks()
            } else {
                published.checks
            }
        });
        let failures = failure_codes(&checks);
        (
            ReadinessResult {
                status: if failures.is_empty() {
                    ReadinessStatus::Ready
                } else {
                    ReadinessStatus::NotReady
                },
                checks,
            },
            failures,
        )
    }

    /// Returns stable failure codes for the current state.
    #[must_use]
    pub fn failure_codes(&self) -> Vec<String> {
        self.snapshot_with_failure_codes().1
    }
}

impl Default for RuntimeHealth {
    fn default() -> Self {
        Self::with_clock(Arc::new(SystemHealthClock::new()))
    }
}

impl fmt::Debug for RuntimeHealth {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RuntimeHealth")
            .finish_non_exhaustive()
    }
}

/// Monotonic time source for readiness freshness decisions.
pub trait HealthClock: Send + Sync {
    /// Returns a monotonic duration from an arbitrary process-local origin.
    fn now(&self) -> Duration;
}

#[derive(Clone)]
struct PublishedChecks {
    checks: ReadinessChecks,
    expires_at: Option<Duration>,
}

struct SystemHealthClock(Instant);

impl SystemHealthClock {
    fn new() -> Self {
        Self(Instant::now())
    }
}

impl HealthClock for SystemHealthClock {
    fn now(&self) -> Duration {
        self.0.elapsed()
    }
}

/// A bounded health-task lifecycle failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskGroupError {
    /// Capacity must be non-zero and within the fixed process limit.
    InvalidCapacity,
    /// The fixed task capacity has already been consumed.
    AtCapacity,
    /// Shutdown has started and no new task may enter the group.
    Closed,
}

impl fmt::Display for TaskGroupError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidCapacity => "runtime_health_task_capacity_invalid",
            Self::AtCapacity => "runtime_health_task_capacity_exhausted",
            Self::Closed => "runtime_health_task_group_closed",
        })
    }
}

impl Error for TaskGroupError {}

/// Whether all child tasks cooperated or required bounded forced cancellation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskShutdown {
    /// Every child observed shutdown and exited before the deadline.
    Cooperative,
    /// The deadline expired and the remaining children were aborted and drained.
    Forced { aborted: usize },
}

/// Fixed-capacity task ownership for dependency probes and health publishers.
pub struct HealthTaskGroup {
    capacity: usize,
    closed: bool,
    shutdown: watch::Sender<bool>,
    tasks: JoinSet<()>,
}

impl HealthTaskGroup {
    /// Creates one fixed-capacity task group.
    ///
    /// # Errors
    ///
    /// Returns [`TaskGroupError::InvalidCapacity`] outside the supported range.
    pub fn new(capacity: usize) -> Result<Self, TaskGroupError> {
        if !(1..=MAX_HEALTH_TASKS).contains(&capacity) {
            return Err(TaskGroupError::InvalidCapacity);
        }
        let (shutdown, _) = watch::channel(false);
        Ok(Self {
            capacity,
            closed: false,
            shutdown,
            tasks: JoinSet::new(),
        })
    }

    /// Starts one owned child with a cooperative shutdown receiver.
    ///
    /// # Errors
    ///
    /// Returns a stable error when the group is closed or at capacity.
    pub fn spawn<Create, Task>(&mut self, create: Create) -> Result<(), TaskGroupError>
    where
        Create: FnOnce(watch::Receiver<bool>) -> Task,
        Task: Future<Output = ()> + Send + 'static,
    {
        if self.closed {
            return Err(TaskGroupError::Closed);
        }
        if self.tasks.len() >= self.capacity {
            return Err(TaskGroupError::AtCapacity);
        }
        self.tasks.spawn(create(self.shutdown.subscribe()));
        Ok(())
    }

    /// Returns the number of owned tasks that have not yet been joined.
    #[must_use]
    pub fn active_tasks(&self) -> usize {
        self.tasks.len()
    }

    /// Signals every task, aborts stragglers at the deadline and drains all joins.
    pub async fn shutdown(&mut self, deadline: Duration) -> TaskShutdown {
        self.closed = true;
        self.shutdown.send_replace(true);
        let completed = timeout(deadline, async {
            while self.tasks.join_next().await.is_some() {}
        })
        .await
        .is_ok();
        if completed {
            return TaskShutdown::Cooperative;
        }

        let aborted = self.tasks.len();
        self.tasks.abort_all();
        while self.tasks.join_next().await.is_some() {}
        TaskShutdown::Forced { aborted }
    }
}

fn failure_codes(checks: &ReadinessChecks) -> Vec<String> {
    let mut failures = Vec::with_capacity(6);
    if checks.database.status != DatabaseStatus::Ok {
        failures.push("database_failed".to_owned());
    }
    if checks.migrations.status != MigrationStatus::Ok {
        failures.push("migrations_failed".to_owned());
    }
    if checks.configuration.status != ConfigurationStatus::Ok {
        failures.push("configuration_failed".to_owned());
    }
    if checks.notification_providers.blocking {
        let failure = match checks.notification_providers.status {
            NotificationProviderStatus::Ok => None,
            NotificationProviderStatus::Degraded => Some("notification_provider_degraded"),
            NotificationProviderStatus::NotConfigured => {
                Some("notification_provider_not_configured")
            }
            NotificationProviderStatus::Unknown => Some("notification_provider_unknown"),
        };
        failures.extend(failure.map(str::to_owned));
    }
    let heartbeat_failure = match checks.runtime_heartbeat.status {
        RuntimeHeartbeatStatus::Ok | RuntimeHeartbeatStatus::Disabled => None,
        RuntimeHeartbeatStatus::Missing => Some("runtime_heartbeat_missing"),
        RuntimeHeartbeatStatus::Stale => Some("runtime_heartbeat_stale"),
        RuntimeHeartbeatStatus::Draining => Some("runtime_heartbeat_draining"),
        RuntimeHeartbeatStatus::Unknown => Some("runtime_heartbeat_unknown"),
    };
    failures.extend(heartbeat_failure.map(str::to_owned));
    let placement_failure = match checks.placement_snapshot.status {
        PlacementSnapshotStatus::Ok | PlacementSnapshotStatus::Disabled => None,
        PlacementSnapshotStatus::Missing => Some("placement_snapshot_missing"),
        PlacementSnapshotStatus::Failed => Some("placement_snapshot_failed"),
    };
    failures.extend(placement_failure.map(str::to_owned));
    failures
}

fn validate(checks: &ReadinessChecks) -> Result<(), HealthError> {
    validate_identifiers(&checks.migrations.missing, migration_identifier)?;
    validate_identifiers(
        &checks.configuration.missing_or_invalid,
        configuration_identifier,
    )?;
    if !optional_instance_id(&checks.runtime_heartbeat.instance_id)
        || !optional_error_code(&checks.placement_snapshot.error_code)
        || checks.notification_providers.active > MAX_JAVASCRIPT_SAFE_INTEGER
        || checks.notification_providers.unhealthy > checks.notification_providers.active
        || checks.placement_snapshot.snapshot_version > MAX_JAVASCRIPT_SAFE_INTEGER
        || !migration_state_consistent(checks)
        || !configuration_state_consistent(checks)
        || !provider_state_consistent(checks)
        || !heartbeat_state_consistent(checks)
        || !placement_state_consistent(checks)
    {
        return Err(HealthError::InvalidDiagnostic);
    }
    Ok(())
}

fn migration_state_consistent(checks: &ReadinessChecks) -> bool {
    checks.migrations.status != MigrationStatus::Ok || checks.migrations.missing.is_empty()
}

fn configuration_state_consistent(checks: &ReadinessChecks) -> bool {
    (checks.configuration.status == ConfigurationStatus::Ok)
        == checks.configuration.missing_or_invalid.is_empty()
}

fn provider_state_consistent(checks: &ReadinessChecks) -> bool {
    let provider = &checks.notification_providers;
    match provider.status {
        NotificationProviderStatus::Ok => provider.active > 0 && provider.unhealthy == 0,
        NotificationProviderStatus::Degraded => {
            provider.active > 0 && provider.unhealthy > 0 && provider.unhealthy <= provider.active
        }
        NotificationProviderStatus::NotConfigured | NotificationProviderStatus::Unknown => {
            provider.active == 0 && provider.unhealthy == 0
        }
    }
}

fn heartbeat_state_consistent(checks: &ReadinessChecks) -> bool {
    let heartbeat = &checks.runtime_heartbeat;
    match heartbeat.status {
        RuntimeHeartbeatStatus::Disabled => heartbeat.instance_id.is_empty(),
        RuntimeHeartbeatStatus::Ok
        | RuntimeHeartbeatStatus::Stale
        | RuntimeHeartbeatStatus::Draining => !heartbeat.instance_id.is_empty(),
        RuntimeHeartbeatStatus::Missing | RuntimeHeartbeatStatus::Unknown => true,
    }
}

fn placement_state_consistent(checks: &ReadinessChecks) -> bool {
    let placement = &checks.placement_snapshot;
    match placement.status {
        PlacementSnapshotStatus::Ok => {
            placement.snapshot_version > 0 && placement.error_code.is_empty()
        }
        PlacementSnapshotStatus::Disabled => {
            placement.snapshot_version == 0 && placement.error_code.is_empty()
        }
        PlacementSnapshotStatus::Missing | PlacementSnapshotStatus::Failed => {
            placement.snapshot_version == 0 && !placement.error_code.is_empty()
        }
    }
}

fn validate_identifiers(
    values: &[String],
    identifier: fn(&str) -> bool,
) -> Result<(), HealthError> {
    if values.len() > MAX_DIAGNOSTIC_ITEMS || values.iter().any(|value| !identifier(value)) {
        return Err(HealthError::InvalidDiagnostic);
    }
    Ok(())
}

fn migration_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_DIAGNOSTIC_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

fn configuration_identifier(value: &str) -> bool {
    let Some((&first, remainder)) = value.as_bytes().split_first() else {
        return false;
    };
    value.len() <= MAX_DIAGNOSTIC_BYTES
        && first.is_ascii_uppercase()
        && remainder
            .iter()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == &b'_')
}

fn optional_instance_id(value: &str) -> bool {
    if value.is_empty() {
        return true;
    }
    let Some((&first, remainder)) = value.as_bytes().split_first() else {
        return false;
    };
    value.len() <= MAX_DIAGNOSTIC_BYTES
        && first.is_ascii_alphanumeric()
        && remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn optional_error_code(value: &str) -> bool {
    value.is_empty()
        || (value.len() <= 128
            && value.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
            && value
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'))
}

fn component(value: &str, max_bytes: usize) -> bool {
    let Some((&first, remainder)) = value.as_bytes().split_first() else {
        return false;
    };
    value.len() <= max_bytes
        && first.is_ascii_alphanumeric()
        && remainder.iter().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-' | b'+')
        })
}

fn failed_checks() -> ReadinessChecks {
    ReadinessChecks {
        database: DatabaseCheck {
            status: DatabaseStatus::Failed,
        },
        migrations: MigrationCheck {
            status: MigrationStatus::Failed,
            missing: vec![],
        },
        configuration: ConfigurationCheck {
            status: ConfigurationStatus::Failed,
            missing_or_invalid: vec![],
        },
        notification_providers: NotificationProviderCheck {
            status: NotificationProviderStatus::Unknown,
            active: 0,
            unhealthy: 0,
            blocking: false,
        },
        runtime_heartbeat: RuntimeHeartbeatCheck {
            status: RuntimeHeartbeatStatus::Unknown,
            instance_id: String::new(),
        },
        placement_snapshot: PlacementSnapshotCheck {
            status: PlacementSnapshotStatus::Missing,
            snapshot_version: 0,
            error_code: "placement_probe_missing".to_owned(),
        },
    }
}

fn stale_checks() -> ReadinessChecks {
    let mut checks = failed_checks();
    checks.runtime_heartbeat.status = RuntimeHeartbeatStatus::Stale;
    checks
}
