use std::{error::Error, fmt, sync::Arc, time::Duration};

use converact_active_call_adapter::{ActiveCallClient, ActiveCallSessionState};
use converact_ai_outbound_store::AiOutboundStore;
use converact_contracts::health::{
    ConfigurationCheck, ConfigurationStatus, DatabaseCheck, DatabaseStatus, MigrationCheck,
    MigrationStatus, NotificationProviderCheck, NotificationProviderStatus, PlacementSnapshotCheck,
    PlacementSnapshotStatus, ReadinessChecks, RuntimeHeartbeatCheck, RuntimeHeartbeatStatus,
};
use converact_post_call_finalization_store::FinalizationSqlStore;
use converact_postgres_store::{
    PostgresActiveCallArtifactStore, PostgresAiOutboundAttemptStore,
    PostgresAiOutboundCompliancePort, PostgresCampaignAdminStore, PostgresRuntime,
    PostgresVoiceAgentStore,
};
use converact_runtime_health::RuntimeHealth;
use converact_rustpbx_rwi_adapter::{FileRwiSecretResolver, RustPbxRwiClient, RustPbxTelephony};
use converact_voice_agent_contracts::ChannelAgentSessionId;
use converact_voice_agent_worker::{
    ActiveCallChannelAgent, ActiveCallPlaybookResolver, AdmissionReadiness, AuthenticatedTenant,
    ClaimSupervisor, DatabaseTransport, PostgresAttemptClaimSource, PostgresCampaignAdminPort,
    PostgresVoiceAgentRepository, ShutdownToken, SystemLeaseTokenDigestSource, SystemWallClock,
    VoiceAgentClaimExecutor, VoiceAgentRepository, VoiceAgentRuntimeConfig,
    load_rs256_platform_verifier, parse_local_database_config,
    router_with_campaign_admin_and_platform_auth, serve_worker_http,
};
use tokio::{net::TcpListener, time::sleep};
use tokio_postgres::NoTls;

const CONFIG_ENVIRONMENT: &str = "CONVERACT_VOICE_AGENT_RUNTIME_CONFIG_JSON";
const READINESS_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProcessError {
    RuntimeConfigUnavailable,
    RuntimeConfigInvalid,
    PlatformAuthInvalid,
    DatabaseConfigUnavailable,
    DatabaseConfigInvalid,
    DatabaseRuntimeInvalid,
    ActiveCallInvalid,
    RustPbxInvalid,
    ListenerUnavailable,
    WorkerFailed,
    HttpFailed,
}

impl fmt::Display for ProcessError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::RuntimeConfigUnavailable => "voice_agent_runtime_config_unavailable",
            Self::RuntimeConfigInvalid => "voice_agent_runtime_config_invalid",
            Self::PlatformAuthInvalid => "voice_agent_platform_auth_invalid",
            Self::DatabaseConfigUnavailable => "voice_agent_database_config_unavailable",
            Self::DatabaseConfigInvalid => "voice_agent_database_config_invalid",
            Self::DatabaseRuntimeInvalid => "voice_agent_database_runtime_invalid",
            Self::ActiveCallInvalid => "voice_agent_active_call_invalid",
            Self::RustPbxInvalid => "voice_agent_rustpbx_invalid",
            Self::ListenerUnavailable => "voice_agent_listener_unavailable",
            Self::WorkerFailed => "voice_agent_worker_failed",
            Self::HttpFailed => "voice_agent_http_failed",
        })
    }
}

impl Error for ProcessError {}

#[tokio::main]
async fn main() -> Result<(), ProcessError> {
    let document =
        std::env::var(CONFIG_ENVIRONMENT).map_err(|_| ProcessError::RuntimeConfigUnavailable)?;
    let config = VoiceAgentRuntimeConfig::from_json(&document)
        .map_err(|_| ProcessError::RuntimeConfigInvalid)?;
    run(config).await
}

#[allow(clippy::too_many_lines)]
async fn run(config: VoiceAgentRuntimeConfig) -> Result<(), ProcessError> {
    let auth = config.platform_auth();
    let authenticator = Arc::new(
        load_rs256_platform_verifier(
            auth.jwks_path(),
            auth.expected_issuer(),
            auth.expected_audience(),
            auth.policy_version(),
            auth.revocation_epoch(),
        )
        .map_err(|_| ProcessError::PlatformAuthInvalid)?,
    );

    let database_document = std::env::var(config.database_url_environment())
        .map_err(|_| ProcessError::DatabaseConfigUnavailable)?;
    let database_config = match config.database_transport() {
        DatabaseTransport::LocalNoTls => parse_local_database_config(&database_document)
            .map_err(|_| ProcessError::DatabaseConfigInvalid)?,
    };
    let database = Arc::new(
        PostgresRuntime::build(database_config, NoTls, config.database_settings())
            .map_err(|_| ProcessError::DatabaseRuntimeInvalid)?,
    );
    let finalization_sql = FinalizationSqlStore::new(config.post_call_config());
    let attempt_sql = AiOutboundStore::new(config.attempt_store_config());
    let campaign_admin = Arc::new(PostgresCampaignAdminPort::new(
        PostgresCampaignAdminStore::new(Arc::clone(&database), attempt_sql),
    ));
    let claim_store =
        PostgresAiOutboundAttemptStore::new(Arc::clone(&database), attempt_sql, finalization_sql);
    let source = PostgresAttemptClaimSource::try_new(
        claim_store,
        config.tenant_id().clone(),
        config.instance_id(),
        SystemLeaseTokenDigestSource::new(),
    )
    .map_err(|_| ProcessError::RuntimeConfigInvalid)?;
    let repository = Arc::new(PostgresVoiceAgentRepository::new(
        PostgresVoiceAgentStore::new(Arc::clone(&database), finalization_sql),
    ));
    let compliance = Arc::new(PostgresAiOutboundCompliancePort::new(Arc::clone(&database)));

    let active_call_client = Arc::new(
        ActiveCallClient::connect(config.active_call().client_config())
            .map_err(|_| ProcessError::ActiveCallInvalid)?,
    );
    let artifact_store = PostgresActiveCallArtifactStore::new(
        Arc::clone(&database),
        config.active_call().artifact_config(),
    );
    let artifact_resolver =
        ActiveCallPlaybookResolver::new(artifact_store, config.active_call().compiler_revision())
            .map_err(|_| ProcessError::ActiveCallInvalid)?;
    let channel_agent = Arc::new(ActiveCallChannelAgent::new(
        Arc::clone(&active_call_client),
        artifact_resolver,
        config.active_call().channel_agent_config(),
    ));

    let rwi_client_config = config
        .rustpbx()
        .client_config(Arc::new(FileRwiSecretResolver))
        .map_err(|_| ProcessError::RustPbxInvalid)?;
    let rwi_client = Arc::new(
        RustPbxRwiClient::connect(rwi_client_config)
            .await
            .map_err(|_| ProcessError::RustPbxInvalid)?,
    );
    let telephony = Arc::new(RustPbxTelephony::new(
        Arc::clone(&rwi_client),
        config.rustpbx().telephony_config(),
    ));

    let health = RuntimeHealth::new();
    let readiness = AdmissionReadiness::new(health.clone());
    let shutdown = ShutdownToken::default();
    let executor = Arc::new(VoiceAgentClaimExecutor::new(
        compliance,
        channel_agent,
        telephony,
        Arc::clone(&repository),
        config.worker_config(),
        readiness.clone(),
        shutdown.clone(),
    ));
    let supervisor = ClaimSupervisor::new(
        source,
        executor,
        config.worker_config(),
        readiness.clone(),
        shutdown.clone(),
    );
    let app = router_with_campaign_admin_and_platform_auth(
        Arc::clone(&repository),
        campaign_admin,
        readiness.clone(),
        config.worker_config(),
        shutdown.clone(),
        authenticator,
        SystemWallClock,
    );
    let listener = TcpListener::bind(config.bind_address())
        .await
        .map_err(|_| ProcessError::ListenerUnavailable)?;

    let probe_tenant =
        AuthenticatedTenant::try_from_verified_tenant_id(config.tenant_id().as_str())
            .map_err(|_| ProcessError::RuntimeConfigInvalid)?;
    let readiness_task = refresh_readiness(
        Arc::clone(&repository),
        active_call_client,
        rwi_client,
        probe_tenant,
        config.instance_id().to_owned(),
        health,
        readiness,
        shutdown.clone(),
    );
    let claim_loop_config = config.claim_loop_config();
    let shutdown_timeout = config.shutdown_timeout();
    let claim_shutdown = shutdown.clone();
    let claim_task = async move {
        let result = supervisor.run_until_shutdown(claim_loop_config).await;
        if result.is_err() {
            claim_shutdown.cancel();
        }
        result
    };
    let http_task = serve_worker_http(listener, app, shutdown, shutdown_signal(), shutdown_timeout);
    let (http_result, claim_result, readiness_result) =
        tokio::join!(http_task, claim_task, readiness_task);
    claim_result.map_err(|_| ProcessError::WorkerFailed)?;
    readiness_result?;
    http_result.map_err(|_| ProcessError::HttpFailed)
}

#[allow(clippy::too_many_arguments)]
async fn refresh_readiness(
    repository: Arc<PostgresVoiceAgentRepository>,
    active_call: Arc<ActiveCallClient>,
    rustpbx: Arc<RustPbxRwiClient>,
    tenant: AuthenticatedTenant,
    instance_id: String,
    health: RuntimeHealth,
    readiness: AdmissionReadiness,
    shutdown: ShutdownToken,
) -> Result<(), ProcessError> {
    let probe_session = ChannelAgentSessionId::parse("voice-agent-readiness-probe")
        .expect("static readiness session id");
    loop {
        let probes = async {
            let database_ready = repository
                .campaign(&tenant, "voice-agent-readiness-probe")
                .await
                .is_ok();
            let active_call_ready = matches!(
                active_call.query_session(&probe_session).await,
                Ok(ActiveCallSessionState::Active | ActiveCallSessionState::NotFound)
            );
            (database_ready, active_call_ready)
        };
        let (database_ready, active_call_ready) = tokio::select! {
            () = shutdown.cancelled() => return Ok(()),
            result = probes => result,
        };
        let rustpbx_ready = rustpbx.is_connected();
        readiness.set_durable_store(database_ready);
        readiness.set_agent_reservation(active_call_ready);
        readiness.set_telephony_control(rustpbx_ready);
        if health
            .publish(readiness_checks(
                database_ready,
                active_call_ready,
                rustpbx_ready,
                &instance_id,
            ))
            .is_err()
        {
            shutdown.cancel();
            return Err(ProcessError::WorkerFailed);
        }
        if !rustpbx_ready {
            shutdown.cancel();
            return Err(ProcessError::RustPbxInvalid);
        }
        tokio::select! {
            () = shutdown.cancelled() => return Ok(()),
            () = sleep(READINESS_INTERVAL) => {}
        }
    }
}

fn readiness_checks(
    database_ready: bool,
    active_call_ready: bool,
    rustpbx_ready: bool,
    instance_id: &str,
) -> ReadinessChecks {
    let configuration_ready = active_call_ready && rustpbx_ready;
    let mut missing_or_invalid = Vec::with_capacity(2);
    if !active_call_ready {
        missing_or_invalid.push("active_call_unavailable".to_owned());
    }
    if !rustpbx_ready {
        missing_or_invalid.push("rustpbx_rwi_unavailable".to_owned());
    }
    ReadinessChecks {
        database: DatabaseCheck {
            status: if database_ready {
                DatabaseStatus::Ok
            } else {
                DatabaseStatus::Failed
            },
        },
        migrations: MigrationCheck {
            status: if database_ready {
                MigrationStatus::Ok
            } else {
                MigrationStatus::Failed
            },
            missing: if database_ready {
                Vec::new()
            } else {
                vec!["ai_outbound_schema_unavailable".to_owned()]
            },
        },
        configuration: ConfigurationCheck {
            status: if configuration_ready {
                ConfigurationStatus::Ok
            } else {
                ConfigurationStatus::Failed
            },
            missing_or_invalid,
        },
        notification_providers: NotificationProviderCheck {
            status: NotificationProviderStatus::NotConfigured,
            active: 0,
            unhealthy: 0,
            blocking: false,
        },
        runtime_heartbeat: RuntimeHeartbeatCheck {
            status: RuntimeHeartbeatStatus::Ok,
            instance_id: instance_id.to_owned(),
        },
        placement_snapshot: PlacementSnapshotCheck {
            status: PlacementSnapshotStatus::Disabled,
            snapshot_version: 0,
            error_code: String::new(),
        },
    }
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
