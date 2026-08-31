use std::{
    collections::HashSet,
    future::{Future, ready},
    sync::{Arc, Mutex},
};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Method, Request, Response, header},
};
use converact_ai_outbound_core::{
    AgentRelease, CampaignTransition, CreateCampaign, ImportContacts,
};
use converact_voice_agent_contracts::IdempotencyKey;
use converact_voice_agent_worker::{
    AdminMutationResource, AuthenticatedTenant, CampaignAdminAccess, CampaignAdminError,
    CampaignAdminPort, campaign_admin_router,
};
use serde_json::{Value, json};
use tower::ServiceExt;

#[tokio::test]
async fn writes_require_tenant_capability_and_idempotency_before_port_invocation() {
    let (app, port) = app();
    let body = publish_body();

    assert_eq!(
        request(
            &app,
            Method::POST,
            "/internal/v1/voice-agent/admin/releases",
            body.clone(),
            None,
            None,
            None
        )
        .await
        .status(),
        401
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/internal/v1/voice-agent/admin/releases",
            body.clone(),
            Some("tenant-a"),
            Some(CampaignAdminAccess::new(false, false, false)),
            Some("publish-release-001"),
        )
        .await
        .status(),
        403
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/internal/v1/voice-agent/admin/releases",
            body,
            Some("tenant-a"),
            Some(CampaignAdminAccess::new(true, false, false)),
            None,
        )
        .await
        .status(),
        400
    );
    assert_eq!(port.calls(), 0);
}

#[tokio::test]
async fn agent_campaign_contact_and_schedule_workflow_is_callable_and_replay_safe() {
    let (app, port) = app();
    let access = CampaignAdminAccess::new(true, true, true);

    let published = request(
        &app,
        Method::POST,
        "/internal/v1/voice-agent/admin/releases",
        publish_body(),
        Some("tenant-a"),
        Some(access),
        Some("publish-release-001"),
    )
    .await;
    assert_eq!(published.status(), 201);
    assert_eq!(json_body(published).await["state"], "published");

    let created = request(
        &app,
        Method::POST,
        "/internal/v1/voice-agent/admin/campaigns",
        create_campaign_body(),
        Some("tenant-a"),
        Some(access),
        Some("create-campaign-001"),
    )
    .await;
    assert_eq!(created.status(), 201);
    assert_eq!(json_body(created).await["state"], "draft");

    let imported = request(
        &app,
        Method::POST,
        "/internal/v1/voice-agent/admin/campaigns/campaign-001/contacts:import",
        import_body(2),
        Some("tenant-a"),
        Some(access),
        Some("import-campaign-001-001"),
    )
    .await;
    assert_eq!(imported.status(), 200);
    let imported = json_body(imported).await;
    assert_eq!(imported["accepted_count"], 2);
    assert!(!imported.to_string().contains("+8613800000000"));
    assert!(!imported.to_string().contains("consent-001"));

    let scheduled = request(
        &app,
        Method::POST,
        "/internal/v1/voice-agent/admin/campaigns/campaign-001/transitions",
        json!({"command":"schedule","expected_revision":2}),
        Some("tenant-a"),
        Some(access),
        Some("campaign-001-schedule-2"),
    )
    .await;
    assert_eq!(scheduled.status(), 200);
    assert_eq!(json_body(scheduled).await["state"], "scheduled");

    let replay = request(
        &app,
        Method::POST,
        "/internal/v1/voice-agent/admin/campaigns",
        create_campaign_body(),
        Some("tenant-a"),
        Some(access),
        Some("create-campaign-001"),
    )
    .await;
    assert_eq!(replay.status(), 200);
    assert_eq!(json_body(replay).await["replayed"], true);
    assert_eq!(port.calls(), 5);
}

#[tokio::test]
async fn oversized_contact_batch_is_rejected_before_the_port() {
    let (app, port) = app();
    let response = request(
        &app,
        Method::POST,
        "/internal/v1/voice-agent/admin/campaigns/campaign-001/contacts:import",
        import_body(501),
        Some("tenant-a"),
        Some(CampaignAdminAccess::new(false, false, true)),
        Some("import-campaign-001-large"),
    )
    .await;

    assert_eq!(response.status(), 400);
    assert_eq!(port.calls(), 0);
}

#[test]
fn campaign_admin_has_no_realtime_call_or_media_authority() {
    let sources = [
        include_str!("../src/campaign_admin.rs"),
        include_str!("../src/campaign_admin_http.rs"),
    ]
    .join("\n");
    for forbidden in [
        "TelephonyPort",
        "originate",
        "MediaEngine",
        "ActiveCall",
        "ChannelAgentPort",
    ] {
        assert!(
            !sources.contains(forbidden),
            "unexpected authority {forbidden}"
        );
    }
}

#[derive(Default)]
struct FakeAdmin {
    state: Mutex<FakeState>,
}

#[derive(Default)]
struct FakeState {
    calls: usize,
    receipts: HashSet<String>,
}

impl FakeAdmin {
    fn calls(&self) -> usize {
        self.state.lock().unwrap().calls
    }

    fn receipt(
        &self,
        key: &IdempotencyKey,
        resource_id: &str,
        state: &str,
        revision: u64,
        accepted_count: u16,
    ) -> Result<AdminMutationResource, CampaignAdminError> {
        let mut inner = self.state.lock().unwrap();
        inner.calls += 1;
        let replayed = !inner.receipts.insert(key.as_str().to_owned());
        AdminMutationResource::try_new(resource_id, state, revision, accepted_count, replayed)
    }
}

impl CampaignAdminPort for FakeAdmin {
    fn publish_agent(
        &self,
        _tenant: &AuthenticatedTenant,
        release: &AgentRelease,
        idempotency_key: &IdempotencyKey,
    ) -> impl Future<Output = Result<AdminMutationResource, CampaignAdminError>> + Send {
        ready(self.receipt(idempotency_key, release.id().as_str(), "published", 1, 0))
    }

    fn create_campaign(
        &self,
        _tenant: &AuthenticatedTenant,
        campaign: &CreateCampaign,
        idempotency_key: &IdempotencyKey,
    ) -> impl Future<Output = Result<AdminMutationResource, CampaignAdminError>> + Send {
        ready(self.receipt(
            idempotency_key,
            campaign.campaign_id().as_str(),
            "draft",
            1,
            0,
        ))
    }

    fn import_contacts(
        &self,
        _tenant: &AuthenticatedTenant,
        command: &ImportContacts,
    ) -> impl Future<Output = Result<AdminMutationResource, CampaignAdminError>> + Send {
        ready(self.receipt(
            command.idempotency_key(),
            command.campaign_id().as_str(),
            "draft",
            command.expected_campaign_revision() + 1,
            u16::try_from(command.contacts().len()).unwrap(),
        ))
    }

    fn transition_campaign(
        &self,
        _tenant: &AuthenticatedTenant,
        command: &CampaignTransition,
    ) -> impl Future<Output = Result<AdminMutationResource, CampaignAdminError>> + Send {
        ready(self.receipt(
            command.idempotency_key(),
            command.campaign_id().as_str(),
            match command.command() {
                converact_ai_outbound_core::CampaignCommand::Schedule => "scheduled",
                _ => "changed",
            },
            command.expected_revision() + 1,
            0,
        ))
    }
}

fn app() -> (Router, Arc<FakeAdmin>) {
    let port = Arc::new(FakeAdmin::default());
    (campaign_admin_router(Arc::clone(&port)), port)
}

async fn request(
    app: &Router,
    method: Method,
    path: &str,
    body: Value,
    tenant: Option<&str>,
    access: Option<CampaignAdminAccess>,
    idempotency_key: Option<&str>,
) -> Response<Body> {
    let bytes = serde_json::to_vec(&body).unwrap();
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(key) = idempotency_key {
        builder = builder.header("idempotency-key", key);
    }
    let mut request = builder.body(Body::from(bytes)).unwrap();
    if let Some(tenant) = tenant {
        request
            .extensions_mut()
            .insert(AuthenticatedTenant::try_from_verified_tenant_id(tenant).unwrap());
    }
    if let Some(access) = access {
        request.extensions_mut().insert(access);
    }
    app.clone().oneshot(request).await.unwrap()
}

async fn json_body(response: Response<Body>) -> Value {
    let bytes = to_bytes(response.into_body(), 32 * 1024).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

fn publish_body() -> Value {
    json!({
        "definition_id":"agent-001",
        "release_id":"release-001",
        "name":"General service agent",
        "language":"zh-CN",
        "components":{
            "prompt_revision_hash":"1".repeat(64),
            "conversation_flow_revision_hash":"2".repeat(64),
            "knowledge_revision_hash":"3".repeat(64),
            "tool_schema_hash":"4".repeat(64),
            "speech_profile_hash":"5".repeat(64),
            "compliance_policy_hash":"6".repeat(64),
            "outcome_schema_hash":"7".repeat(64),
            "evaluation_rubric_hash":"8".repeat(64)
        }
    })
}

fn create_campaign_body() -> Value {
    json!({
        "campaign_id":"campaign-001",
        "agent_release_id":"release-001",
        "audience_id":"audience-001",
        "dial_policy_revision":"dial-policy-r1",
        "schedule":{"starts_at_ms":1_800_000_000_000_u64,"time_zone":"Asia/Shanghai"}
    })
}

fn import_body(count: usize) -> Value {
    let contacts: Vec<_> = (0..count)
        .map(|index| {
            json!({
                "contact_id":format!("contact-{index:03}"),
                "external_contact_id":format!("external-{index:03}"),
                "destination":format!("+861380000{index:04}"),
                "consent_id":"consent-001",
                "recording_mode":"after_disclosure",
                "retention_until_ms":1_900_000_000_000_u64,
                "scheduled_for_ms":1_800_000_000_000_u64,
                "attempt_id":format!("attempt-{index:03}"),
                "interaction_id":format!("interaction-{index:03}"),
                "attempt_idempotency_key":format!("dial:attempt-{index:03}")
            })
        })
        .collect();
    json!({"expected_campaign_revision":1,"contacts":contacts})
}
