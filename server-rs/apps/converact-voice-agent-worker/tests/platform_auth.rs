use std::{
    future::Future,
    sync::{Arc, Mutex},
};

use axum::{
    body::Body,
    http::{Method, Request, StatusCode},
    Router,
};
use converact_ai_outbound_core::{
    AgentRelease, CampaignTransition, CreateCampaign, ImportContacts,
};
use converact_contracts::canonical_sha256_with_max_bytes;
use converact_postgres_store::PostgresAgentToolSchema;
use converact_runtime_health::RuntimeHealth;
use converact_tenant_auth::Hs256PlatformTokenVerifier;
use converact_voice_agent_contracts::IdempotencyKey;
use converact_voice_agent_worker::{
    router_with_campaign_admin_and_platform_auth, router_with_platform_auth, AdminMutationResource,
    AdmissionReadiness, AgentReleaseResource, AgentReleaseToolManifest, AttemptResource,
    AuthenticatedTenant, CampaignAdminError, CampaignAdminPort, CampaignResource, FixedWallClock,
    ReconcileReceipt, RepositoryError, ShutdownToken, VoiceAgentRepository, WorkerConfig,
};
use serde_json::{json, Value};
use tower::ServiceExt;

const FIXTURE: &str = include_str!("../../../tests/fixtures/platform-hs256-v1.json");
const VIEWER_TOKEN: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImlkZW50aXR5LWtleS12NyJ9.eyJzdWIiOiJ1c2VyLTEiLCJ0aWQiOiJ0ZW5hbnQtMSIsInRlbmFudF9pZCI6InRlbmFudC0xIiwiaWRlbnRpdHlfaWQiOiJ1c2VyLTEiLCJpZGVudGl0eV9raW5kIjoiaHVtYW4iLCJzZXNzaW9uX2lkIjoic2Vzc2lvbi0xIiwidG9rZW5faWQiOiJ0b2tlbi0xIiwiaXNzIjoiaHR0cHM6Ly9pZGVudGl0eS5leGFtcGxlLnRlc3QiLCJpc3N1ZXIiOiJodHRwczovL2lkZW50aXR5LmV4YW1wbGUudGVzdCIsImF1ZCI6WyJjb252ZXJhY3QtY29yZSJdLCJhdWRpZW5jZSI6WyJjb252ZXJhY3QtY29yZSJdLCJrZXlfaWQiOiJpZGVudGl0eS1rZXktdjciLCJyb2xlIjoidmlld2VyIiwiaWF0IjowLCJuYmYiOjAsImV4cCI6NDEwMjQ0NDgwMCwiaXNzdWVkX2F0IjoiMTk3MC0wMS0wMVQwMDowMDowMC4wMDBaIiwibm90X2JlZm9yZSI6IjE5NzAtMDEtMDFUMDA6MDA6MDAuMDAwWiIsImV4cGlyZXNfYXQiOiIyMTAwLTAxLTAxVDAwOjAwOjAwLjAwMFoiLCJwb2xpY3lfdmVyc2lvbiI6MTIsInJldm9jYXRpb25fZXBvY2giOjQsImNhcGFiaWxpdGllcyI6WyJwbGF0Zm9ybS5hcGkiXSwicHVycG9zZSI6WyJwcm9kdWN0X29wZXJhdGlvbiJdLCJjcmVkZW50aWFsX3N0cmVuZ3RoIjoic2lnbmVkX3Rva2VuIn0.INBahMWiVa6QEslUyTalAegmj4_CajP9Uq30g7nN7nU";
const CAMPAIGN_ADMIN_TOKEN: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImlkZW50aXR5LWtleS12NyJ9.eyJzdWIiOiJ1c2VyLTEiLCJ0aWQiOiJ0ZW5hbnQtMSIsInRlbmFudF9pZCI6InRlbmFudC0xIiwiaWRlbnRpdHlfaWQiOiJ1c2VyLTEiLCJpZGVudGl0eV9raW5kIjoiaHVtYW4iLCJzZXNzaW9uX2lkIjoic2Vzc2lvbi0xIiwidG9rZW5faWQiOiJ0b2tlbi0xIiwiaXNzIjoiaHR0cHM6Ly9pZGVudGl0eS5leGFtcGxlLnRlc3QiLCJpc3N1ZXIiOiJodHRwczovL2lkZW50aXR5LmV4YW1wbGUudGVzdCIsImF1ZCI6WyJjb252ZXJhY3QtY29yZSJdLCJhdWRpZW5jZSI6WyJjb252ZXJhY3QtY29yZSJdLCJrZXlfaWQiOiJpZGVudGl0eS1rZXktdjciLCJyb2xlIjoib3BlcmF0b3IiLCJpYXQiOjAsIm5iZiI6MCwiZXhwIjo0MTAyNDQ0ODAwLCJpc3N1ZWRfYXQiOiIxOTcwLTAxLTAxVDAwOjAwOjAwLjAwMFoiLCJub3RfYmVmb3JlIjoiMTk3MC0wMS0wMVQwMDowMDowMC4wMDBaIiwiZXhwaXJlc19hdCI6IjIxMDAtMDEtMDFUMDA6MDA6MDAuMDAwWiIsInBvbGljeV92ZXJzaW9uIjoxMiwicmV2b2NhdGlvbl9lcG9jaCI6NCwiY2FwYWJpbGl0aWVzIjpbInBsYXRmb3JtLmFwaSIsInZvaWNlX2FnZW50LmFnZW50LnB1Ymxpc2giLCJ2b2ljZV9hZ2VudC5jYW1wYWlnbi5tYW5hZ2UiLCJ2b2ljZV9hZ2VudC5jb250YWN0cy5pbXBvcnQiXSwicHVycG9zZSI6WyJwcm9kdWN0X29wZXJhdGlvbiJdLCJjcmVkZW50aWFsX3N0cmVuZ3RoIjoic2lnbmVkX3Rva2VuIn0.eArKIhPGSiaEsmPT8_OtoSHOazGwZISd1n5MaGIUiRw";

#[tokio::test]
async fn protected_routes_require_one_valid_bearer_and_inject_its_tenant() {
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    let repository = Arc::new(ProbeRepository::default());
    let app = authenticated_app(Arc::clone(&repository), &fixture);

    assert_eq!(
        request(&app, "/internal/v1/voice-agent/releases/release-001", None)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &app,
            "/internal/v1/voice-agent/releases/release-001",
            Some("Bearer malformed"),
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert!(repository.tenants.lock().unwrap().is_empty());

    let bearer = format!("Bearer {}", fixture["frozen_valid_token"].as_str().unwrap());
    assert_eq!(
        request(
            &app,
            "/internal/v1/voice-agent/releases/release-001",
            Some(&bearer),
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(repository.tenants.lock().unwrap().as_slice(), ["tenant-1"]);
}

#[tokio::test]
async fn health_routes_remain_public_and_do_not_invoke_authentication() {
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    let repository = Arc::new(ProbeRepository::default());
    let app = authenticated_app(Arc::clone(&repository), &fixture);

    assert_eq!(request(&app, "/livez", None).await.status(), StatusCode::OK);
    assert_eq!(
        request(&app, "/readyz", None).await.status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert!(repository.tenants.lock().unwrap().is_empty());
}

#[tokio::test]
async fn viewer_identity_can_inspect_but_cannot_request_reconciliation() {
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    let repository = Arc::new(ProbeRepository::default());
    let app = authenticated_app(repository, &fixture);
    let bearer = format!("Bearer {VIEWER_TOKEN}");

    assert_eq!(
        request_with_method(
            &app,
            Method::GET,
            "/internal/v1/voice-agent/releases/release-001",
            Some(&bearer),
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request_with_method(
            &app,
            Method::POST,
            "/internal/v1/voice-agent/attempts/attempt-001/reconcile",
            Some(&bearer),
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn campaign_admin_routes_require_the_exact_signed_capability() {
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    let admin = Arc::new(ProbeAdmin::default());
    let app = authenticated_admin_app(Arc::clone(&admin), &fixture);
    let ordinary = format!("Bearer {}", fixture["frozen_valid_token"].as_str().unwrap());

    assert_eq!(
        publish_request(&app, &ordinary).await.status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(admin.calls(), 0);

    let privileged = format!("Bearer {CAMPAIGN_ADMIN_TOKEN}");
    assert_eq!(
        publish_request(&app, &privileged).await.status(),
        StatusCode::CREATED
    );
    assert_eq!(admin.calls(), 1);
}

fn authenticated_app(repository: Arc<ProbeRepository>, fixture: &Value) -> Router {
    let policy = &fixture["policy"];
    let verifier = Hs256PlatformTokenVerifier::new(
        fixture["test_key_utf8"].as_str().unwrap(),
        policy["expected_issuer"].as_str().unwrap(),
        policy["expected_audience"].as_str().unwrap(),
        policy["expected_key_id"].as_str().unwrap(),
        policy["current_policy_version"].as_u64().unwrap(),
        policy["current_revocation_epoch"].as_u64().unwrap(),
    )
    .unwrap();
    router_with_platform_auth(
        repository,
        AdmissionReadiness::new(RuntimeHealth::new()),
        WorkerConfig::new(2, 8).unwrap(),
        ShutdownToken::default(),
        Arc::new(verifier),
        FixedWallClock::new(policy["wall_now_epoch_ms"].as_i64().unwrap()),
    )
}

fn authenticated_admin_app(admin: Arc<ProbeAdmin>, fixture: &Value) -> Router {
    let policy = &fixture["policy"];
    let verifier = Hs256PlatformTokenVerifier::new(
        fixture["test_key_utf8"].as_str().unwrap(),
        policy["expected_issuer"].as_str().unwrap(),
        policy["expected_audience"].as_str().unwrap(),
        policy["expected_key_id"].as_str().unwrap(),
        policy["current_policy_version"].as_u64().unwrap(),
        policy["current_revocation_epoch"].as_u64().unwrap(),
    )
    .unwrap();
    router_with_campaign_admin_and_platform_auth(
        Arc::new(ProbeRepository::default()),
        admin,
        AdmissionReadiness::new(RuntimeHealth::new()),
        WorkerConfig::new(2, 8).unwrap(),
        ShutdownToken::default(),
        Arc::new(verifier),
        FixedWallClock::new(policy["wall_now_epoch_ms"].as_i64().unwrap()),
    )
}

async fn publish_request(app: &Router, authorization: &str) -> axum::response::Response {
    let tool_manifest = tool_manifest();
    let tool_schema_hash = canonical_sha256_with_max_bytes(&tool_manifest, 65_536).unwrap();
    let body = json!({
        "definition_id":"agent-001",
        "release_id":"release-001",
        "name":"General service agent",
        "language":"zh-CN",
        "components":{
            "prompt_revision_hash":"1".repeat(64),
            "conversation_flow_revision_hash":"2".repeat(64),
            "knowledge_revision_hash":"3".repeat(64),
            "tool_schema_hash":tool_schema_hash,
            "speech_profile_hash":"5".repeat(64),
            "compliance_policy_hash":"6".repeat(64),
            "outcome_schema_hash":"7".repeat(64),
            "evaluation_rubric_hash":"8".repeat(64)
        },
        "tool_manifest":tool_manifest
    });
    app.clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/internal/v1/voice-agent/admin/releases")
                .header("authorization", authorization)
                .header("idempotency-key", "publish-release-001")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn request(
    app: &Router,
    path: &str,
    authorization: Option<&str>,
) -> axum::response::Response {
    request_with_method(app, Method::GET, path, authorization).await
}

async fn request_with_method(
    app: &Router,
    method: Method,
    path: &str,
    authorization: Option<&str>,
) -> axum::response::Response {
    let mut request = Request::builder().method(method).uri(path);
    if let Some(value) = authorization {
        request = request.header("authorization", value);
    }
    app.clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap()
}

#[derive(Default)]
struct ProbeRepository {
    tenants: Mutex<Vec<String>>,
}

#[derive(Default)]
struct ProbeAdmin {
    calls: Mutex<usize>,
}

impl ProbeAdmin {
    fn calls(&self) -> usize {
        *self.calls.lock().unwrap()
    }
}

impl CampaignAdminPort for ProbeAdmin {
    async fn publish_agent(
        &self,
        _tenant: &AuthenticatedTenant,
        release: &AgentRelease,
        _tool_manifest: &AgentReleaseToolManifest,
        _idempotency_key: &IdempotencyKey,
    ) -> Result<AdminMutationResource, CampaignAdminError> {
        *self.calls.lock().unwrap() += 1;
        AdminMutationResource::try_new(release.id().as_str(), "published", 1, 0, false)
    }

    fn create_campaign(
        &self,
        _tenant: &AuthenticatedTenant,
        _campaign: &CreateCampaign,
        _idempotency_key: &IdempotencyKey,
    ) -> impl Future<Output = Result<AdminMutationResource, CampaignAdminError>> + Send {
        std::future::ready(Err(CampaignAdminError::unavailable()))
    }

    fn import_contacts(
        &self,
        _tenant: &AuthenticatedTenant,
        _command: &ImportContacts,
    ) -> impl Future<Output = Result<AdminMutationResource, CampaignAdminError>> + Send {
        std::future::ready(Err(CampaignAdminError::unavailable()))
    }

    fn transition_campaign(
        &self,
        _tenant: &AuthenticatedTenant,
        _command: &CampaignTransition,
    ) -> impl Future<Output = Result<AdminMutationResource, CampaignAdminError>> + Send {
        std::future::ready(Err(CampaignAdminError::unavailable()))
    }
}

fn tool_manifest() -> Value {
    let schemas = PostgresAgentToolSchema::new();
    json!([
        {
            "name": "customer.lookup",
            "revision_id": "customer.lookup-r1",
            "schema_hash": schemas.schema_hash("customer.lookup").unwrap(),
            "arguments_schema": schemas.schema_document("customer.lookup").unwrap(),
            "effect_class": "query",
            "risk": "low",
            "action_capability": "customer.lookup",
            "policy_decision": "allowed",
            "deadline_after_ms": 5_000,
        },
        {
            "name": "task.create_follow_up",
            "revision_id": "task.create_follow_up-r1",
            "schema_hash": schemas.schema_hash("task.create_follow_up").unwrap(),
            "arguments_schema": schemas
                .schema_document("task.create_follow_up")
                .unwrap(),
            "effect_class": "mutation",
            "risk": "low",
            "action_capability": "task.create_follow_up",
            "policy_decision": "allowed",
            "deadline_after_ms": 5_000,
        }
    ])
}

impl VoiceAgentRepository for ProbeRepository {
    async fn release(
        &self,
        tenant: &AuthenticatedTenant,
        _id: &str,
    ) -> Result<Option<AgentReleaseResource>, RepositoryError> {
        self.tenants
            .lock()
            .unwrap()
            .push(tenant.as_str().to_owned());
        Ok(None)
    }

    async fn campaign(
        &self,
        _tenant: &AuthenticatedTenant,
        _id: &str,
    ) -> Result<Option<CampaignResource>, RepositoryError> {
        Ok(None)
    }

    async fn attempt(
        &self,
        _tenant: &AuthenticatedTenant,
        _id: &str,
    ) -> Result<Option<AttemptResource>, RepositoryError> {
        Ok(None)
    }

    async fn request_reconcile(
        &self,
        _tenant: &AuthenticatedTenant,
        _attempt_id: &str,
        _idempotency_key: &IdempotencyKey,
    ) -> Result<Option<ReconcileReceipt>, RepositoryError> {
        Ok(None)
    }
}
