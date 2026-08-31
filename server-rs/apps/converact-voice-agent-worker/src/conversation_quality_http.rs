use std::sync::Arc;

use axum::{
    Extension, Router,
    body::Body,
    extract::{Path, Query, State, rejection::QueryRejection},
    http::{HeaderValue, Response, StatusCode, header},
    routing::get,
};
use converact_conversation_result_store::{EntityCursor, QueryLimit};
use converact_voice_agent_contracts::InteractionId;
use serde::{Deserialize, Serialize};

use crate::{
    AuthenticatedTenant, ConversationQualityAccess, ConversationQualityQueryError,
    ConversationQualityQueryPort,
};

const DEFAULT_QUERY_LIMIT: u16 = 50;

/// Builds fail-closed tenant-scoped conversation result and quality read routes.
pub fn conversation_quality_router<Q: ConversationQualityQueryPort>(query: Arc<Q>) -> Router {
    Router::new()
        .route(
            "/internal/voice-agent/interactions/{id}/result",
            get(latest_result::<Q>),
        )
        .route(
            "/internal/voice-agent/interactions/{id}/transcript",
            get(transcript::<Q>),
        )
        .route(
            "/internal/voice-agent/interactions/{id}/evaluations",
            get(evaluations::<Q>),
        )
        .route(
            "/internal/voice-agent/quality/bad-cases",
            get(bad_cases::<Q>),
        )
        .with_state(QualityHttpState { query })
}

async fn latest_result<Q: ConversationQualityQueryPort>(
    State(state): State<QualityHttpState<Q>>,
    tenant: Option<Extension<AuthenticatedTenant>>,
    access: Option<Extension<ConversationQualityAccess>>,
    Path(id): Path<String>,
) -> Response<Body> {
    let Some(tenant) = authenticated_tenant(tenant) else {
        return error_response(StatusCode::UNAUTHORIZED, "authentication_required");
    };
    if !authorized(access, ConversationQualityAccess::can_read_result) {
        return error_response(StatusCode::FORBIDDEN, "result_read_forbidden");
    }
    let Ok(interaction_id) = InteractionId::parse(id) else {
        return error_response(StatusCode::NOT_FOUND, "resource_not_found");
    };
    match state
        .query
        .load_latest_result(&tenant, &interaction_id)
        .await
    {
        Ok(Some(result)) => json_response(StatusCode::OK, &result),
        Ok(None) => error_response(StatusCode::NOT_FOUND, "resource_not_found"),
        Err(error) => query_error_response(error),
    }
}

async fn transcript<Q: ConversationQualityQueryPort>(
    State(state): State<QualityHttpState<Q>>,
    tenant: Option<Extension<AuthenticatedTenant>>,
    access: Option<Extension<ConversationQualityAccess>>,
    Path(id): Path<String>,
    query: Result<Query<PageQuery>, QueryRejection>,
) -> Response<Body> {
    let Some(tenant) = authenticated_tenant(tenant) else {
        return error_response(StatusCode::UNAUTHORIZED, "authentication_required");
    };
    if !authorized(access, ConversationQualityAccess::can_read_transcript_text) {
        return error_response(StatusCode::FORBIDDEN, "transcript_read_forbidden");
    }
    let Ok(interaction_id) = InteractionId::parse(id) else {
        return error_response(StatusCode::NOT_FOUND, "resource_not_found");
    };
    let Ok((cursor, limit)) = bounded_page(query) else {
        return error_response(StatusCode::BAD_REQUEST, "query_invalid");
    };
    match state
        .query
        .list_transcript(&tenant, &interaction_id, cursor, limit)
        .await
    {
        Ok(page) => json_response(StatusCode::OK, &page),
        Err(error) => query_error_response(error),
    }
}

async fn evaluations<Q: ConversationQualityQueryPort>(
    State(state): State<QualityHttpState<Q>>,
    tenant: Option<Extension<AuthenticatedTenant>>,
    access: Option<Extension<ConversationQualityAccess>>,
    Path(id): Path<String>,
    query: Result<Query<PageQuery>, QueryRejection>,
) -> Response<Body> {
    let Some(tenant) = authenticated_tenant(tenant) else {
        return error_response(StatusCode::UNAUTHORIZED, "authentication_required");
    };
    if !authorized(access, ConversationQualityAccess::can_read_quality) {
        return error_response(StatusCode::FORBIDDEN, "quality_read_forbidden");
    }
    let Ok(interaction_id) = InteractionId::parse(id) else {
        return error_response(StatusCode::NOT_FOUND, "resource_not_found");
    };
    let Ok((cursor, limit)) = bounded_page(query) else {
        return error_response(StatusCode::BAD_REQUEST, "query_invalid");
    };
    match state
        .query
        .list_evaluations(&tenant, &interaction_id, cursor, limit)
        .await
    {
        Ok(page) => json_response(StatusCode::OK, &page),
        Err(error) => query_error_response(error),
    }
}

async fn bad_cases<Q: ConversationQualityQueryPort>(
    State(state): State<QualityHttpState<Q>>,
    tenant: Option<Extension<AuthenticatedTenant>>,
    access: Option<Extension<ConversationQualityAccess>>,
    query: Result<Query<PageQuery>, QueryRejection>,
) -> Response<Body> {
    let Some(tenant) = authenticated_tenant(tenant) else {
        return error_response(StatusCode::UNAUTHORIZED, "authentication_required");
    };
    if !authorized(access, ConversationQualityAccess::can_read_quality) {
        return error_response(StatusCode::FORBIDDEN, "quality_read_forbidden");
    }
    let Ok((cursor, limit)) = bounded_page(query) else {
        return error_response(StatusCode::BAD_REQUEST, "query_invalid");
    };
    match state.query.list_bad_cases(&tenant, cursor, limit).await {
        Ok(page) => json_response(StatusCode::OK, &page),
        Err(error) => query_error_response(error),
    }
}

fn bounded_page(
    query: Result<Query<PageQuery>, QueryRejection>,
) -> Result<(Option<EntityCursor>, QueryLimit), ()> {
    let Query(query) = query.map_err(|_| ())?;
    let cursor = query
        .cursor
        .as_deref()
        .map(EntityCursor::parse)
        .transpose()
        .map_err(|_| ())?;
    let limit = QueryLimit::new(query.limit.unwrap_or(DEFAULT_QUERY_LIMIT)).map_err(|_| ())?;
    Ok((cursor, limit))
}

fn authenticated_tenant(
    tenant: Option<Extension<AuthenticatedTenant>>,
) -> Option<AuthenticatedTenant> {
    tenant.map(|Extension(tenant)| tenant)
}

fn authorized(
    access: Option<Extension<ConversationQualityAccess>>,
    capability: impl FnOnce(ConversationQualityAccess) -> bool,
) -> bool {
    access.is_some_and(|Extension(access)| capability(access))
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

fn query_error_response(error: ConversationQualityQueryError) -> Response<Body> {
    if error.is_invalid_query() {
        error_response(StatusCode::BAD_REQUEST, "query_invalid")
    } else {
        error_response(StatusCode::SERVICE_UNAVAILABLE, "quality_query_unavailable")
    }
}

struct QualityHttpState<Q> {
    query: Arc<Q>,
}

impl<Q> Clone for QualityHttpState<Q> {
    fn clone(&self) -> Self {
        Self {
            query: Arc::clone(&self.query),
        }
    }
}

#[derive(Deserialize)]
struct PageQuery {
    cursor: Option<String>,
    limit: Option<u16>,
}

#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
}
