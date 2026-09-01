use std::sync::{Arc, Once};

use axum::{Json, Router, extract::State, routing::post};
use converact_conversation_result_core::{
    TranscriptSegment, TranscriptSegmentInput, TranscriptSpeaker,
};
use converact_conversation_understanding_core::{
    EmotionCatalog, EmotionCatalogInput, EmotionDefinitionInput, EmotionValence, IntentCatalog,
    IntentCatalogInput, IntentDefinitionInput,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CallId, CampaignContactId, CampaignId, ChannelAgentSessionId,
    EmotionCatalogRevisionId, EnvelopeContext, EnvelopeContextInput, EventId, ExecutionGeneration,
    IntentCatalogRevisionId, InteractionId, TranscriptSegmentId, VOICE_AGENT_SCHEMA_VERSION,
};
use converact_voice_agent_worker::{
    ContextualIntentArtifactInput, ContextualIntentClassifierProvider,
    ContextualIntentClassifierProviderError, FastIntentClassifierArtifactInput,
    FastIntentClassifierProvider, FastIntentClassifierProviderError, ModelInferenceHttpConfig,
    ModelInferenceHttpTransport, TextEmotionClassifierArtifactInput, TextEmotionClassifierProvider,
};
use serde_json::{Value, json};
use tokio::{net::TcpListener, sync::Mutex};

#[tokio::test]
async fn structured_text_models_use_fixed_bounded_http_contracts() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let app = Router::new()
        .route("/v1/inference/fast-intent", post(serve_fast_intent))
        .route(
            "/v1/inference/contextual-intent",
            post(serve_contextual_intent),
        )
        .route("/v1/inference/text-emotion", post(serve_text_emotion))
        .with_state(Arc::clone(&requests));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let config =
        ModelInferenceHttpConfig::new(format!("http://{address}/"), 65_536, 65_536).unwrap();
    let transport = ModelInferenceHttpTransport::new(http_client(), config);
    let catalog = catalog();
    let provider =
        FastIntentClassifierProvider::try_new(artifact(), &catalog, transport.clone()).unwrap();

    let observation = provider.observe(&segment(), 1).await.unwrap().unwrap();

    let contextual = ContextualIntentClassifierProvider::try_new(
        contextual_artifact(),
        &catalog,
        transport.clone(),
    )
    .unwrap();
    let contextual_observation = contextual.observe(&history(), 2).await.unwrap().unwrap();

    let emotion_catalog = emotion_catalog();
    let emotion = TextEmotionClassifierProvider::try_new(
        text_emotion_artifact(),
        &emotion_catalog,
        transport,
    )
    .unwrap();
    let emotion_observation = emotion.observe(&segment(), 1).await.unwrap().unwrap();

    assert_eq!(observation.primary().unwrap().code(), "sales.interested");
    assert_eq!(observation.primary().unwrap().confidence_bps(), 9_200);
    assert_eq!(
        contextual_observation.primary().unwrap().code(),
        "callback.specific_time"
    );
    assert_eq!(
        emotion_observation.primary().unwrap().code(),
        "customer.frustrated"
    );
    let requests = requests.lock().await;
    assert_eq!(requests.len(), 3);
    let fast = captured(&requests, "fast-intent");
    assert_eq!(fast["schema_version"], 1);
    assert_eq!(fast["artifact_revision"], provider.artifact_revision());
    assert_eq!(fast["language"], "zh-CN");
    assert_eq!(fast["text"], "这个方案不错，我有兴趣。");
    assert_eq!(fast["max_candidates"], 5);
    let contextual_request = captured(&requests, "contextual-intent");
    assert_eq!(contextual_request["schema_version"], 1);
    assert_eq!(contextual_request["turns"].as_array().unwrap().len(), 2);
    assert_eq!(contextual_request["turns"][0]["speaker"], "ai_agent");
    assert_eq!(contextual_request["turns"][1]["speaker"], "customer");
    let emotion_request = captured(&requests, "text-emotion");
    assert_eq!(emotion_request["schema_version"], 1);
    assert_eq!(emotion_request["text"], "这个方案不错，我有兴趣。");
    assert!(!format!("{provider:?}").contains(&address.to_string()));
    assert!(!format!("{provider:?}").contains("这个方案"));
    server.abort();
}

#[tokio::test]
async fn endpoint_and_response_drift_fail_closed_without_content() {
    assert!(ModelInferenceHttpConfig::new("http://model.internal/", 1_024, 1_024).is_err());
    assert!(
        ModelInferenceHttpConfig::new("https://user:secret@model.internal/", 1_024, 1_024).is_err()
    );
    assert!(ModelInferenceHttpConfig::new("https://model.internal/base", 1_024, 1_024).is_err());

    let app = Router::new()
        .route("/v1/inference/fast-intent", post(serve_invalid_response))
        .route(
            "/v1/inference/contextual-intent",
            post(serve_invalid_response),
        );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let config =
        ModelInferenceHttpConfig::new(format!("http://{address}/"), 65_536, 65_536).unwrap();
    let transport = ModelInferenceHttpTransport::new(http_client(), config);
    let catalog = catalog();
    let provider =
        FastIntentClassifierProvider::try_new(artifact(), &catalog, transport.clone()).unwrap();

    let error = provider.observe(&segment(), 1).await.unwrap_err();

    assert_eq!(
        error,
        FastIntentClassifierProviderError::ClassifierOutputInvalid
    );
    let diagnostics = format!("{error:?}");
    assert!(!diagnostics.contains("private response"));
    assert!(!diagnostics.contains(&address.to_string()));
    assert!(!diagnostics.contains("这个方案"));
    let contextual =
        ContextualIntentClassifierProvider::try_new(contextual_artifact(), &catalog, transport)
            .unwrap();
    assert_eq!(
        contextual.observe(&history(), 2).await.unwrap_err(),
        ContextualIntentClassifierProviderError::ClassifierOutputInvalid
    );
    server.abort();
}

#[tokio::test]
async fn response_body_limit_is_enforced_before_decoding() {
    let app = Router::new().route(
        "/v1/inference/fast-intent",
        post(|| async {
            Json(json!({
                "schema_version": 1,
                "served_artifact_revision": "x".repeat(1_024),
                "candidates": []
            }))
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let config = ModelInferenceHttpConfig::new(format!("http://{address}/"), 65_536, 64).unwrap();
    let transport = ModelInferenceHttpTransport::new(http_client(), config);
    let catalog = catalog();
    let provider = FastIntentClassifierProvider::try_new(artifact(), &catalog, transport).unwrap();

    assert_eq!(
        provider.observe(&segment(), 1).await.unwrap_err(),
        FastIntentClassifierProviderError::ClassifierOutputInvalid
    );
    server.abort();
}

async fn serve_fast_intent(
    State(requests): State<CapturedRequests>,
    Json(request): Json<Value>,
) -> Json<Value> {
    let artifact_revision = request["artifact_revision"].clone();
    requests
        .lock()
        .await
        .push(("fast-intent".to_owned(), request));
    Json(json!({
        "schema_version": 1,
        "served_artifact_revision": artifact_revision,
        "candidates": [
            {"code": "sales.interested", "confidence_bps": 9200},
            {"code": "callback.later", "confidence_bps": 3000}
        ]
    }))
}

async fn serve_invalid_response() -> Json<Value> {
    Json(json!({
        "schema_version": 2,
        "served_artifact_revision": "untrusted",
        "candidates": [],
        "unexpected": "private response"
    }))
}

async fn serve_contextual_intent(
    State(requests): State<CapturedRequests>,
    Json(request): Json<Value>,
) -> Json<Value> {
    let artifact_revision = request["artifact_revision"].clone();
    requests
        .lock()
        .await
        .push(("contextual-intent".to_owned(), request));
    Json(json!({
        "schema_version": 1,
        "served_artifact_revision": artifact_revision,
        "candidates": [
            {"code": "callback.specific_time", "confidence_bps": 9300},
            {"code": "sales.interested", "confidence_bps": 2000}
        ],
        "slots": {"callback_time": "tomorrow-15:00"}
    }))
}

async fn serve_text_emotion(
    State(requests): State<CapturedRequests>,
    Json(request): Json<Value>,
) -> Json<Value> {
    let artifact_revision = request["artifact_revision"].clone();
    requests
        .lock()
        .await
        .push(("text-emotion".to_owned(), request));
    Json(json!({
        "schema_version": 1,
        "served_artifact_revision": artifact_revision,
        "candidates": [
            {"code": "customer.frustrated", "confidence_bps": 8900, "intensity": 3}
        ]
    }))
}

type CapturedRequests = Arc<Mutex<Vec<(String, Value)>>>;

fn captured<'a>(requests: &'a [(String, Value)], route: &str) -> &'a Value {
    &requests
        .iter()
        .find(|(candidate, _)| candidate == route)
        .unwrap()
        .1
}

fn http_client() -> reqwest::Client {
    static PROVIDER: Once = Once::new();
    PROVIDER.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
    reqwest::Client::builder().build().unwrap()
}

fn artifact() -> FastIntentClassifierArtifactInput {
    FastIntentClassifierArtifactInput {
        agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
        intent_catalog_revision_id: IntentCatalogRevisionId::parse("intent-catalog-001").unwrap(),
        model_sha256: "1".repeat(64),
        tokenizer_sha256: "2".repeat(64),
        label_map_sha256: "3".repeat(64),
        calibration_sha256: "4".repeat(64),
        supported_languages: vec!["zh-CN".to_owned()],
        max_input_bytes: 4_096,
        max_candidates: 5,
        inference_deadline_ms: 1_000,
    }
}

fn contextual_artifact() -> ContextualIntentArtifactInput {
    ContextualIntentArtifactInput {
        agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
        intent_catalog_revision_id: IntentCatalogRevisionId::parse("intent-catalog-001").unwrap(),
        model_profile_sha256: "1".repeat(64),
        prompt_template_sha256: "2".repeat(64),
        label_map_sha256: "3".repeat(64),
        output_schema_sha256: "4".repeat(64),
        calibration_sha256: "5".repeat(64),
        supported_languages: vec!["zh-CN".to_owned()],
        max_context_segments: 16,
        max_context_bytes: 32_768,
        max_candidates: 5,
        max_slots: 16,
        inference_deadline_ms: 1_000,
    }
}

fn text_emotion_artifact() -> TextEmotionClassifierArtifactInput {
    TextEmotionClassifierArtifactInput {
        agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
        emotion_catalog_revision_id: EmotionCatalogRevisionId::parse("emotion-catalog-001")
            .unwrap(),
        model_sha256: "1".repeat(64),
        tokenizer_sha256: "2".repeat(64),
        label_map_sha256: "3".repeat(64),
        calibration_sha256: "4".repeat(64),
        supported_languages: vec!["zh-CN".to_owned()],
        max_input_bytes: 4_096,
        max_candidates: 5,
        inference_deadline_ms: 1_000,
    }
}

fn catalog() -> IntentCatalog {
    IntentCatalog::try_new(IntentCatalogInput {
        id: IntentCatalogRevisionId::parse("intent-catalog-001").unwrap(),
        agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
        definitions: vec![
            definition("sales", None),
            definition("sales.interested", Some("sales")),
            definition("callback", None),
            definition("callback.later", Some("callback")),
            IntentDefinitionInput {
                code: "callback.specific_time".to_owned(),
                parent_code: Some("callback".to_owned()),
                slot_keys: vec!["callback_time".to_owned()],
                safety_critical: false,
            },
        ],
    })
    .unwrap()
}

fn emotion_catalog() -> EmotionCatalog {
    EmotionCatalog::try_new(EmotionCatalogInput {
        id: EmotionCatalogRevisionId::parse("emotion-catalog-001").unwrap(),
        agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
        definitions: vec![EmotionDefinitionInput {
            code: "customer.frustrated".to_owned(),
            valence: EmotionValence::Negative,
            distress_rank: 3,
        }],
    })
    .unwrap()
}

fn definition(code: &str, parent_code: Option<&str>) -> IntentDefinitionInput {
    IntentDefinitionInput {
        code: code.to_owned(),
        parent_code: parent_code.map(str::to_owned),
        slot_keys: Vec::new(),
        safety_critical: false,
    }
}

fn segment() -> TranscriptSegment {
    transcript_segment(1, TranscriptSpeaker::Customer, "这个方案不错，我有兴趣。")
}

fn history() -> Vec<TranscriptSegment> {
    vec![
        transcript_segment(1, TranscriptSpeaker::AiAgent, "您什么时候方便？"),
        transcript_segment(2, TranscriptSpeaker::Customer, "明天下午再联系我。"),
    ]
}

fn transcript_segment(sequence: u64, speaker: TranscriptSpeaker, text: &str) -> TranscriptSegment {
    TranscriptSegment::try_new(TranscriptSegmentInput {
        id: TranscriptSegmentId::parse(format!("segment-{sequence}")).unwrap(),
        context: context(),
        source_event_id: EventId::parse(format!("event-{sequence}")).unwrap(),
        sequence,
        speaker,
        language: "zh-CN".to_owned(),
        text: text.to_owned(),
        start_offset_ms: sequence * 1_000,
        end_offset_ms: sequence * 1_000 + 500,
        observed_at_ms: sequence * 1_000 + 750,
        retention_policy_ref: "retention-standard-v1".to_owned(),
    })
    .unwrap()
}

fn context() -> EnvelopeContext {
    EnvelopeContext::try_new(EnvelopeContextInput {
        schema_version: VOICE_AGENT_SCHEMA_VERSION,
        tenant_id: "tenant-a".to_owned(),
        interaction_id: InteractionId::parse("interaction-001").unwrap(),
        campaign_id: CampaignId::parse("campaign-001").unwrap(),
        campaign_contact_id: CampaignContactId::parse("contact-001").unwrap(),
        call_attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
        call_id: Some(CallId::parse("call-001").unwrap()),
        agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
        channel_agent_session_id: Some(ChannelAgentSessionId::parse("session-001").unwrap()),
        execution_generation: ExecutionGeneration::new(1).unwrap(),
        trace_id: "trace-001".to_owned(),
    })
    .unwrap()
}
