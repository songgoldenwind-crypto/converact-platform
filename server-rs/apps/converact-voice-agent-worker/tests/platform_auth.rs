use std::sync::{Arc, Mutex};

use axum::{
    Router,
    body::Body,
    http::{Method, Request, StatusCode},
};
use converact_runtime_health::RuntimeHealth;
use converact_tenant_auth::Hs256PlatformTokenVerifier;
use converact_voice_agent_contracts::IdempotencyKey;
use converact_voice_agent_worker::{
    AdmissionReadiness, AgentReleaseResource, AttemptResource, AuthenticatedTenant,
    CampaignResource, FixedWallClock, ReconcileReceipt, RepositoryError, ShutdownToken,
    VoiceAgentRepository, WorkerConfig, router_with_platform_auth,
};
use serde_json::Value;
use tower::ServiceExt;

const FIXTURE: &str = include_str!("../../../tests/fixtures/platform-hs256-v1.json");
const VIEWER_TOKEN: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImlkZW50aXR5LWtleS12NyJ9.eyJzdWIiOiJ1c2VyLTEiLCJ0aWQiOiJ0ZW5hbnQtMSIsInRlbmFudF9pZCI6InRlbmFudC0xIiwiaWRlbnRpdHlfaWQiOiJ1c2VyLTEiLCJpZGVudGl0eV9raW5kIjoiaHVtYW4iLCJzZXNzaW9uX2lkIjoic2Vzc2lvbi0xIiwidG9rZW5faWQiOiJ0b2tlbi0xIiwiaXNzIjoiaHR0cHM6Ly9pZGVudGl0eS5leGFtcGxlLnRlc3QiLCJpc3N1ZXIiOiJodHRwczovL2lkZW50aXR5LmV4YW1wbGUudGVzdCIsImF1ZCI6WyJjb252ZXJhY3QtY29yZSJdLCJhdWRpZW5jZSI6WyJjb252ZXJhY3QtY29yZSJdLCJrZXlfaWQiOiJpZGVudGl0eS1rZXktdjciLCJyb2xlIjoidmlld2VyIiwiaWF0IjowLCJuYmYiOjAsImV4cCI6NDEwMjQ0NDgwMCwiaXNzdWVkX2F0IjoiMTk3MC0wMS0wMVQwMDowMDowMC4wMDBaIiwibm90X2JlZm9yZSI6IjE5NzAtMDEtMDFUMDA6MDA6MDAuMDAwWiIsImV4cGlyZXNfYXQiOiIyMTAwLTAxLTAxVDAwOjAwOjAwLjAwMFoiLCJwb2xpY3lfdmVyc2lvbiI6MTIsInJldm9jYXRpb25fZXBvY2giOjQsImNhcGFiaWxpdGllcyI6WyJwbGF0Zm9ybS5hcGkiXSwicHVycG9zZSI6WyJwcm9kdWN0X29wZXJhdGlvbiJdLCJjcmVkZW50aWFsX3N0cmVuZ3RoIjoic2lnbmVkX3Rva2VuIn0.INBahMWiVa6QEslUyTalAegmj4_CajP9Uq30g7nN7nU";

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
