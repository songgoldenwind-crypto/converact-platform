use std::{collections::BTreeMap, future::ready, sync::Arc};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Method, Request, Response},
};
use converact_conversation_result_store::{
    BadCaseView, ConversationEvaluationView, ConversationResultView, EntityCursor, QueryLimit,
    QueryPage, TranscriptSegmentView,
};
use converact_voice_agent_contracts::InteractionId;
use converact_voice_agent_worker::{
    AuthenticatedTenant, ConversationQualityAccess, ConversationQualityQueryError,
    ConversationQualityQueryPort, conversation_quality_router,
};
use tower::ServiceExt;

#[tokio::test]
async fn quality_reads_require_tenant_and_explicit_capability() {
    let app = app();
    let path = "/internal/voice-agent/interactions/interaction-001/result";

    assert_eq!(request(&app, path, None, None).await.status(), 401);
    assert_eq!(
        request(
            &app,
            path,
            Some("tenant-a"),
            Some(ConversationQualityAccess::new(false, false, false)),
        )
        .await
        .status(),
        403
    );
    assert_eq!(
        request(
            &app,
            path,
            Some("tenant-b"),
            Some(ConversationQualityAccess::new(true, false, false)),
        )
        .await
        .status(),
        404
    );
    assert_eq!(
        request(
            &app,
            path,
            Some("tenant-a"),
            Some(ConversationQualityAccess::new(true, false, false)),
        )
        .await
        .status(),
        200
    );
}

#[tokio::test]
async fn transcript_text_needs_its_separate_capability() {
    let app = app();
    let path = "/internal/voice-agent/interactions/interaction-001/transcript?limit=25";

    assert_eq!(
        request(
            &app,
            path,
            Some("tenant-a"),
            Some(ConversationQualityAccess::new(true, false, true)),
        )
        .await
        .status(),
        403
    );
    let response = request(
        &app,
        path,
        Some("tenant-a"),
        Some(ConversationQualityAccess::new(false, true, false)),
    )
    .await;
    assert_eq!(response.status(), 200);
    assert!(body(response).await.contains("secret transcript"));
}

#[tokio::test]
async fn pagination_is_bounded_before_the_query_port() {
    let app = app();
    let access = Some(ConversationQualityAccess::new(false, true, false));

    assert_eq!(
        request(
            &app,
            "/internal/voice-agent/interactions/interaction-001/transcript?limit=101",
            Some("tenant-a"),
            access,
        )
        .await
        .status(),
        400
    );
    assert_eq!(
        request(
            &app,
            "/internal/voice-agent/interactions/interaction-001/transcript?cursor=bad/cursor",
            Some("tenant-a"),
            access,
        )
        .await
        .status(),
        400
    );
    assert_eq!(
        request(
            &app,
            "/internal/voice-agent/interactions/interaction-001/transcript?cursor=missing-cursor",
            Some("tenant-a"),
            access,
        )
        .await
        .status(),
        400
    );
}

#[tokio::test]
async fn result_and_quality_lists_never_return_transcript_text() {
    let app = app();
    let access = Some(ConversationQualityAccess::new(true, false, true));
    for path in [
        "/internal/voice-agent/interactions/interaction-001/result",
        "/internal/voice-agent/interactions/interaction-001/evaluations",
        "/internal/voice-agent/quality/bad-cases",
    ] {
        let response = request(&app, path, Some("tenant-a"), access).await;
        assert_eq!(response.status(), 200, "unexpected status for {path}");
        let body = body(response).await;
        assert!(
            !body.contains("secret transcript"),
            "leaked text from {path}"
        );
        assert!(
            !body.contains("transcript_text"),
            "leaked field from {path}"
        );
    }
}

fn app() -> Router {
    conversation_quality_router(Arc::new(FakeQualityQuery))
}

async fn request(
    app: &Router,
    path: &str,
    tenant: Option<&str>,
    access: Option<ConversationQualityAccess>,
) -> Response<Body> {
    let mut request = Request::builder()
        .method(Method::GET)
        .uri(path)
        .body(Body::empty())
        .unwrap();
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

async fn body(response: Response<Body>) -> String {
    let bytes = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    String::from_utf8(bytes.to_vec()).unwrap()
}

#[derive(Clone, Copy)]
struct FakeQualityQuery;

impl ConversationQualityQueryPort for FakeQualityQuery {
    fn load_latest_result(
        &self,
        tenant: &AuthenticatedTenant,
        _interaction_id: &InteractionId,
    ) -> impl Future<Output = Result<Option<ConversationResultView>, ConversationQualityQueryError>> + Send
    {
        ready(Ok((tenant.as_str() == "tenant-a").then(result)))
    }

    fn list_transcript(
        &self,
        _tenant: &AuthenticatedTenant,
        _interaction_id: &InteractionId,
        cursor: Option<EntityCursor>,
        _limit: QueryLimit,
    ) -> impl Future<
        Output = Result<QueryPage<TranscriptSegmentView>, ConversationQualityQueryError>,
    > + Send {
        if cursor
            .as_ref()
            .is_some_and(|cursor| cursor.as_str() == "missing-cursor")
        {
            ready(Err(ConversationQualityQueryError::invalid_query()))
        } else {
            ready(Ok(QueryPage::try_new(vec![segment()], None).unwrap()))
        }
    }

    fn list_evaluations(
        &self,
        _tenant: &AuthenticatedTenant,
        _interaction_id: &InteractionId,
        _cursor: Option<EntityCursor>,
        _limit: QueryLimit,
    ) -> impl Future<
        Output = Result<QueryPage<ConversationEvaluationView>, ConversationQualityQueryError>,
    > + Send {
        ready(Ok(QueryPage::try_new(vec![evaluation()], None).unwrap()))
    }

    fn list_bad_cases(
        &self,
        _tenant: &AuthenticatedTenant,
        _cursor: Option<EntityCursor>,
        _limit: QueryLimit,
    ) -> impl Future<Output = Result<QueryPage<BadCaseView>, ConversationQualityQueryError>> + Send
    {
        ready(Ok(QueryPage::try_new(vec![bad_case()], None).unwrap()))
    }
}

fn result() -> ConversationResultView {
    ConversationResultView {
        result_id: "result-001".to_owned(),
        interaction_id: "interaction-001".to_owned(),
        result_revision: 1,
        agent_release_id: "agent-r1".to_owned(),
        outcome_schema_revision_id: "outcome-r1".to_owned(),
        transcript_snapshot_digest: "a".repeat(64),
        summary_artifact_ref: "artifact://summary-001".to_owned(),
        intent: "interested".to_owned(),
        disposition: "follow_up".to_owned(),
        outcome_code: "qualified".to_owned(),
        confidence_bps: 9_000,
        attributes: BTreeMap::new(),
        created_at_ms: 1_000,
    }
}

fn segment() -> TranscriptSegmentView {
    TranscriptSegmentView {
        segment_id: "segment-001".to_owned(),
        execution_generation: 1,
        segment_sequence: 1,
        speaker: "customer".to_owned(),
        language: "zh-CN".to_owned(),
        text: "secret transcript".to_owned(),
        start_offset_ms: 0,
        end_offset_ms: 900,
        observed_at_ms: 1_000,
        historical: false,
    }
}

fn evaluation() -> ConversationEvaluationView {
    ConversationEvaluationView {
        evaluation_id: "evaluation-001".to_owned(),
        result_id: "result-001".to_owned(),
        result_revision: 1,
        evaluator_release_id: "evaluator-r1".to_owned(),
        evaluation_rubric_revision_id: "rubric-r1".to_owned(),
        dimension_scores_bps: BTreeMap::from([("policy".to_owned(), 8_500)]),
        evidence_segment_ids: vec!["segment-001".to_owned()],
        violation_codes: Vec::new(),
        overall_score_bps: 8_500,
        quality_grade: "pass".to_owned(),
        bad_case_reasons: Vec::new(),
        created_at_ms: 1_100,
    }
}

fn bad_case() -> BadCaseView {
    BadCaseView {
        bad_case_id: "bad-case-001".to_owned(),
        interaction_id: "interaction-001".to_owned(),
        evaluation_id: "evaluation-001".to_owned(),
        bad_case_reasons: vec!["policy".to_owned()],
        review_state: "pending".to_owned(),
        created_at_ms: 1_100,
    }
}
