//! Legacy-compatible runtime health wire types.

use serde::{Deserialize, Serialize};

/// Overall readiness derived from all checks.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadinessStatus {
    Ready,
    NotReady,
}

/// Database readiness state.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseStatus {
    Ok,
    Failed,
}

/// Migration readiness state.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MigrationStatus {
    Ok,
    Failed,
}

/// Configuration readiness state.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfigurationStatus {
    Ok,
    Failed,
}

/// Notification provider readiness state.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationProviderStatus {
    Ok,
    Degraded,
    NotConfigured,
    Unknown,
}

/// Runtime heartbeat readiness state.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeHeartbeatStatus {
    Ok,
    Disabled,
    Missing,
    Stale,
    Draining,
    Unknown,
}

/// Placement snapshot readiness state.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlacementSnapshotStatus {
    Ok,
    Disabled,
    Missing,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseCheck {
    pub status: DatabaseStatus,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MigrationCheck {
    pub status: MigrationStatus,
    pub missing: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigurationCheck {
    pub status: ConfigurationStatus,
    pub missing_or_invalid: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NotificationProviderCheck {
    pub status: NotificationProviderStatus,
    pub active: u64,
    pub unhealthy: u64,
    pub blocking: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeHeartbeatCheck {
    pub status: RuntimeHeartbeatStatus,
    pub instance_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PlacementSnapshotCheck {
    pub status: PlacementSnapshotStatus,
    pub snapshot_version: u64,
    pub error_code: String,
}

/// Legacy readiness checks in frozen TypeScript field order.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReadinessChecks {
    pub database: DatabaseCheck,
    pub migrations: MigrationCheck,
    pub configuration: ConfigurationCheck,
    pub notification_providers: NotificationProviderCheck,
    pub runtime_heartbeat: RuntimeHeartbeatCheck,
    pub placement_snapshot: PlacementSnapshotCheck,
}

/// Legacy `/readyz` and `/health` response.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReadinessResult {
    pub status: ReadinessStatus,
    pub checks: ReadinessChecks,
}
