use std::sync::Arc;

use axum::{
    body::Body,
    extract::{rejection::JsonRejection, DefaultBodyLimit, Path, State},
    http::{header, HeaderMap, HeaderValue, Response, StatusCode},
    routing::post,
    Extension, Json, Router,
};
use converact_ai_outbound_core::{
    publish_agent, AgentDraft, CampaignCommand, CampaignSchedule, CampaignTransition,
    CreateCampaign, DialPolicyRevision, DialPolicyRevisionInput, ImportContact, ImportContactInput,
    ImportContacts, RecordingMode, ReleaseComponentDigests,
};
use converact_voice_agent_contracts::{
    AgentDefinitionId, AgentReleaseId, CallAttemptId, CampaignContactId, CampaignId,
    IdempotencyKey, InteractionId,
};
use serde::{Deserialize, Serialize};

use crate::campaign_admin::CampaignAdminErrorKind;
use crate::{
    AdminMutationResource, AgentReleaseToolManifest, AuthenticatedTenant, CampaignAdminAccess,
    CampaignAdminError, CampaignAdminPort,
};

const MAX_ADMIN_BODY_BYTES: usize = 2 * 1024 * 1024;

/// Builds tenant/capability/idempotency-gated Campaign authoring routes.
pub fn campaign_admin_router<P: CampaignAdminPort>(port: Arc<P>) -> Router {
    Router::new()
        .route(
            "/internal/v1/voice-agent/admin/releases",
            post(publish_release::<P>),
        )
        .route(
            "/internal/v1/voice-agent/admin/campaigns",
            post(create_campaign::<P>),
        )
        .route(
            "/internal/v1/voice-agent/admin/campaigns/{id}/contacts:import",
            post(import_contacts::<P>),
        )
        .route(
            "/internal/v1/voice-agent/admin/campaigns/{id}/transitions",
            post(transition_campaign::<P>),
        )
        .layer(DefaultBodyLimit::max(MAX_ADMIN_BODY_BYTES))
        .with_state(AdminHttpState { port })
}

async fn publish_release<P: CampaignAdminPort>(
    State(state): State<AdminHttpState<P>>,
    tenant: Option<Extension<AuthenticatedTenant>>,
    access: Option<Extension<CampaignAdminAccess>>,
    headers: HeaderMap,
    body: Result<Json<PublishAgentBody>, JsonRejection>,
) -> Response<Body> {
    let Some(tenant) = authenticated_tenant(tenant) else {
        return error_response(StatusCode::UNAUTHORIZED, "authentication_required");
    };
    if !authorized(access, CampaignAdminAccess::can_publish_agent) {
        return error_response(StatusCode::FORBIDDEN, "agent_publish_forbidden");
    }
    let Some(idempotency_key) = idempotency_key(&headers) else {
        return error_response(
            StatusCode::BAD_REQUEST,
            "idempotency_key_required_or_invalid",
        );
    };
    let Ok(Json(body)) = body else {
        return error_response(StatusCode::BAD_REQUEST, "request_body_invalid");
    };
    let Ok(definition_id) = AgentDefinitionId::parse(body.definition_id) else {
        return error_response(StatusCode::BAD_REQUEST, "request_body_invalid");
    };
    let Ok(release_id) = AgentReleaseId::parse(body.release_id) else {
        return error_response(StatusCode::BAD_REQUEST, "request_body_invalid");
    };
    let Ok(draft) = AgentDraft::try_new(definition_id, release_id, body.name, body.language) else {
        return error_response(StatusCode::BAD_REQUEST, "request_body_invalid");
    };
    let Ok(release) = publish_agent(draft, body.components.into()) else {
        return error_response(StatusCode::BAD_REQUEST, "request_body_invalid");
    };
    let Ok(tool_manifest) = AgentReleaseToolManifest::try_new(&release, body.tool_manifest) else {
        return error_response(StatusCode::BAD_REQUEST, "request_body_invalid");
    };
    match state
        .port
        .publish_agent(&tenant, &release, &tool_manifest, &idempotency_key)
        .await
    {
        Ok(resource) => mutation_response(&resource, StatusCode::CREATED),
        Err(error) => admin_error_response(error),
    }
}

async fn create_campaign<P: CampaignAdminPort>(
    State(state): State<AdminHttpState<P>>,
    tenant: Option<Extension<AuthenticatedTenant>>,
    access: Option<Extension<CampaignAdminAccess>>,
    headers: HeaderMap,
    body: Result<Json<CreateCampaignBody>, JsonRejection>,
) -> Response<Body> {
    let Some(tenant) = authenticated_tenant(tenant) else {
        return error_response(StatusCode::UNAUTHORIZED, "authentication_required");
    };
    if !authorized(access, CampaignAdminAccess::can_manage_campaign) {
        return error_response(StatusCode::FORBIDDEN, "campaign_write_forbidden");
    }
    let Some(idempotency_key) = idempotency_key(&headers) else {
        return error_response(
            StatusCode::BAD_REQUEST,
            "idempotency_key_required_or_invalid",
        );
    };
    let Ok(Json(body)) = body else {
        return error_response(StatusCode::BAD_REQUEST, "request_body_invalid");
    };
    let Ok(campaign_id) = CampaignId::parse(body.campaign_id) else {
        return error_response(StatusCode::BAD_REQUEST, "request_body_invalid");
    };
    let Ok(release_id) = AgentReleaseId::parse(body.agent_release_id) else {
        return error_response(StatusCode::BAD_REQUEST, "request_body_invalid");
    };
    let Ok(schedule) =
        CampaignSchedule::try_new(body.schedule.starts_at_ms, &body.schedule.time_zone)
    else {
        return error_response(StatusCode::BAD_REQUEST, "request_body_invalid");
    };
    let Ok(dial_policy) = DialPolicyRevision::try_new(DialPolicyRevisionInput {
        revision_id: body.dial_policy_revision,
        caller_id: body.dial_policy.caller_id,
        timeout_secs: body.dial_policy.timeout_secs,
        trunk: body.dial_policy.trunk,
    }) else {
        return error_response(StatusCode::BAD_REQUEST, "request_body_invalid");
    };
    let Ok(campaign) = CreateCampaign::try_new(
        campaign_id,
        release_id,
        &body.audience_id,
        dial_policy,
        schedule,
    ) else {
        return error_response(StatusCode::BAD_REQUEST, "request_body_invalid");
    };
    match state
        .port
        .create_campaign(&tenant, &campaign, &idempotency_key)
        .await
    {
        Ok(resource) => mutation_response(&resource, StatusCode::CREATED),
        Err(error) => admin_error_response(error),
    }
}

async fn import_contacts<P: CampaignAdminPort>(
    State(state): State<AdminHttpState<P>>,
    tenant: Option<Extension<AuthenticatedTenant>>,
    access: Option<Extension<CampaignAdminAccess>>,
    Path(campaign_id): Path<String>,
    headers: HeaderMap,
    body: Result<Json<ImportContactsBody>, JsonRejection>,
) -> Response<Body> {
    let Some(tenant) = authenticated_tenant(tenant) else {
        return error_response(StatusCode::UNAUTHORIZED, "authentication_required");
    };
    if !authorized(access, CampaignAdminAccess::can_import_contacts) {
        return error_response(StatusCode::FORBIDDEN, "contact_import_forbidden");
    }
    let Some(idempotency_key) = idempotency_key(&headers) else {
        return error_response(
            StatusCode::BAD_REQUEST,
            "idempotency_key_required_or_invalid",
        );
    };
    let Ok(Json(body)) = body else {
        return error_response(StatusCode::BAD_REQUEST, "request_body_invalid");
    };
    if body.contacts.is_empty() || body.contacts.len() > 500 {
        return error_response(StatusCode::BAD_REQUEST, "request_body_invalid");
    }
    let Ok(campaign_id) = CampaignId::parse(campaign_id) else {
        return error_response(StatusCode::BAD_REQUEST, "request_body_invalid");
    };
    let contacts: Result<Vec<_>, _> = body.contacts.into_iter().map(parse_contact).collect();
    let Ok(contacts) = contacts else {
        return error_response(StatusCode::BAD_REQUEST, "request_body_invalid");
    };
    let Ok(command) = ImportContacts::try_new(
        campaign_id,
        body.expected_campaign_revision,
        idempotency_key,
        contacts,
    ) else {
        return error_response(StatusCode::BAD_REQUEST, "request_body_invalid");
    };
    match state.port.import_contacts(&tenant, &command).await {
        Ok(resource) => mutation_response(&resource, StatusCode::OK),
        Err(error) => admin_error_response(error),
    }
}

async fn transition_campaign<P: CampaignAdminPort>(
    State(state): State<AdminHttpState<P>>,
    tenant: Option<Extension<AuthenticatedTenant>>,
    access: Option<Extension<CampaignAdminAccess>>,
    Path(campaign_id): Path<String>,
    headers: HeaderMap,
    body: Result<Json<TransitionCampaignBody>, JsonRejection>,
) -> Response<Body> {
    let Some(tenant) = authenticated_tenant(tenant) else {
        return error_response(StatusCode::UNAUTHORIZED, "authentication_required");
    };
    if !authorized(access, CampaignAdminAccess::can_manage_campaign) {
        return error_response(StatusCode::FORBIDDEN, "campaign_write_forbidden");
    }
    let Some(idempotency_key) = idempotency_key(&headers) else {
        return error_response(
            StatusCode::BAD_REQUEST,
            "idempotency_key_required_or_invalid",
        );
    };
    let Ok(Json(body)) = body else {
        return error_response(StatusCode::BAD_REQUEST, "request_body_invalid");
    };
    let Ok(campaign_id) = CampaignId::parse(campaign_id) else {
        return error_response(StatusCode::BAD_REQUEST, "request_body_invalid");
    };
    let Some(command) = parse_campaign_command(&body.command) else {
        return error_response(StatusCode::BAD_REQUEST, "request_body_invalid");
    };
    let Ok(command) = CampaignTransition::try_new(
        campaign_id,
        command,
        body.expected_revision,
        idempotency_key,
    ) else {
        return error_response(StatusCode::BAD_REQUEST, "request_body_invalid");
    };
    match state.port.transition_campaign(&tenant, &command).await {
        Ok(resource) => mutation_response(&resource, StatusCode::OK),
        Err(error) => admin_error_response(error),
    }
}

fn parse_contact(body: ImportContactBody) -> Result<ImportContact, ()> {
    let recording_mode = match body.recording_mode.as_str() {
        "disabled" => RecordingMode::Disabled,
        "always" => RecordingMode::Always,
        "after_disclosure" => RecordingMode::AfterDisclosure,
        "on_demand" => RecordingMode::OnDemand,
        _ => return Err(()),
    };
    ImportContact::try_new(ImportContactInput {
        contact_id: CampaignContactId::parse(body.contact_id).map_err(|_| ())?,
        external_contact_id: body.external_contact_id,
        destination: body.destination,
        consent_id: body.consent_id,
        recording_mode,
        retention_until_ms: body.retention_until_ms,
        scheduled_for_ms: body.scheduled_for_ms,
        attempt_id: CallAttemptId::parse(body.attempt_id).map_err(|_| ())?,
        interaction_id: InteractionId::parse(body.interaction_id).map_err(|_| ())?,
        idempotency_key: IdempotencyKey::parse(body.attempt_idempotency_key).map_err(|_| ())?,
    })
    .map_err(|_| ())
}

fn parse_campaign_command(value: &str) -> Option<CampaignCommand> {
    match value {
        "schedule" => Some(CampaignCommand::Schedule),
        "start" => Some(CampaignCommand::Start),
        "pause" => Some(CampaignCommand::Pause),
        "resume" => Some(CampaignCommand::Resume),
        "drain" => Some(CampaignCommand::Drain),
        "complete" => Some(CampaignCommand::Complete),
        "cancel" => Some(CampaignCommand::Cancel),
        "archive" => Some(CampaignCommand::Archive),
        _ => None,
    }
}

fn authenticated_tenant(
    tenant: Option<Extension<AuthenticatedTenant>>,
) -> Option<AuthenticatedTenant> {
    tenant.map(|Extension(tenant)| tenant)
}

fn authorized(
    access: Option<Extension<CampaignAdminAccess>>,
    capability: impl FnOnce(CampaignAdminAccess) -> bool,
) -> bool {
    access.is_some_and(|Extension(access)| capability(access))
}

fn idempotency_key(headers: &HeaderMap) -> Option<IdempotencyKey> {
    headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| IdempotencyKey::parse(value).ok())
}

fn mutation_response(
    resource: &AdminMutationResource,
    created_status: StatusCode,
) -> Response<Body> {
    json_response(
        if resource.replayed() {
            StatusCode::OK
        } else {
            created_status
        },
        resource,
    )
}

fn admin_error_response(error: CampaignAdminError) -> Response<Body> {
    let status = match error.kind() {
        CampaignAdminErrorKind::Invalid => StatusCode::BAD_REQUEST,
        CampaignAdminErrorKind::NotFound => StatusCode::NOT_FOUND,
        CampaignAdminErrorKind::Conflict | CampaignAdminErrorKind::NotAllowed => {
            StatusCode::CONFLICT
        }
        CampaignAdminErrorKind::Stale => StatusCode::PRECONDITION_FAILED,
        CampaignAdminErrorKind::Unavailable | CampaignAdminErrorKind::OutcomeUnknown => {
            StatusCode::SERVICE_UNAVAILABLE
        }
    };
    error_response(status, error.code())
}

fn json_response<T: Serialize>(status: StatusCode, value: &T) -> Response<Body> {
    let bytes = serde_json::to_vec(value)
        .unwrap_or_else(|_| br#"{"error":"response_encoding_failed"}"#.to_vec());
    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response
}

fn error_response(status: StatusCode, code: &'static str) -> Response<Body> {
    json_response(status, &ErrorBody { error: code })
}

struct AdminHttpState<P> {
    port: Arc<P>,
}

impl<P> Clone for AdminHttpState<P> {
    fn clone(&self) -> Self {
        Self {
            port: Arc::clone(&self.port),
        }
    }
}

#[derive(Deserialize)]
struct PublishAgentBody {
    definition_id: String,
    release_id: String,
    name: String,
    language: String,
    components: ReleaseComponentsBody,
    tool_manifest: serde_json::Value,
}

#[derive(Deserialize)]
struct ReleaseComponentsBody {
    #[serde(rename = "prompt_revision_hash")]
    prompt_revision: String,
    #[serde(rename = "conversation_flow_revision_hash")]
    conversation_flow_revision: String,
    #[serde(rename = "knowledge_revision_hash")]
    knowledge_revision: String,
    #[serde(rename = "tool_schema_hash")]
    tool_schema: String,
    #[serde(rename = "speech_profile_hash")]
    speech_profile: String,
    #[serde(rename = "compliance_policy_hash")]
    compliance_policy: String,
    #[serde(rename = "outcome_schema_hash")]
    outcome_schema: String,
    #[serde(rename = "evaluation_rubric_hash")]
    evaluation_rubric: String,
}

impl From<ReleaseComponentsBody> for ReleaseComponentDigests {
    fn from(body: ReleaseComponentsBody) -> Self {
        Self {
            prompt_revision_hash: body.prompt_revision,
            conversation_flow_revision_hash: body.conversation_flow_revision,
            knowledge_revision_hash: body.knowledge_revision,
            tool_schema_hash: body.tool_schema,
            speech_profile_hash: body.speech_profile,
            compliance_policy_hash: body.compliance_policy,
            outcome_schema_hash: body.outcome_schema,
            evaluation_rubric_hash: body.evaluation_rubric,
        }
    }
}

#[derive(Deserialize)]
struct CreateCampaignBody {
    campaign_id: String,
    agent_release_id: String,
    audience_id: String,
    dial_policy_revision: String,
    dial_policy: DialPolicyBody,
    schedule: CampaignScheduleBody,
}

#[derive(Deserialize)]
struct DialPolicyBody {
    caller_id: Option<String>,
    timeout_secs: u32,
    trunk: Option<String>,
}

#[derive(Deserialize)]
struct CampaignScheduleBody {
    starts_at_ms: u64,
    time_zone: String,
}

#[derive(Deserialize)]
struct ImportContactsBody {
    expected_campaign_revision: u64,
    contacts: Vec<ImportContactBody>,
}

#[derive(Deserialize)]
struct ImportContactBody {
    contact_id: String,
    external_contact_id: String,
    destination: String,
    consent_id: String,
    recording_mode: String,
    retention_until_ms: u64,
    scheduled_for_ms: u64,
    attempt_id: String,
    interaction_id: String,
    attempt_idempotency_key: String,
}

#[derive(Deserialize)]
struct TransitionCampaignBody {
    command: String,
    expected_revision: u64,
}

#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
}
