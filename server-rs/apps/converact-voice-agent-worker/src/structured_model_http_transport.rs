use std::{collections::BTreeMap, error::Error, fmt, net::IpAddr};

use reqwest::{Client, Response, StatusCode, header};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use url::{Host, Url};

use crate::{
    ContextualIntentCandidateOutput, ContextualIntentClassifierOutput,
    ContextualIntentClassifierPort, ContextualIntentClassifierPortError,
    ContextualIntentClassifierRequest, FastIntentCandidateOutput, FastIntentClassifierOutput,
    FastIntentClassifierPort, FastIntentClassifierPortError, FastIntentClassifierRequest,
    TextEmotionCandidateOutput, TextEmotionClassifierOutput, TextEmotionClassifierPort,
    TextEmotionClassifierPortError, TextEmotionClassifierRequest,
};

const WIRE_SCHEMA_VERSION: u16 = 1;
const MIN_BODY_BYTES: usize = 64;
const MAX_REQUEST_BYTES: usize = 2_097_152;
const MAX_RESPONSE_BYTES: usize = 1_048_576;
const USER_AGENT: &str = "converact-structured-model-http/1";

/// Invalid bounded endpoint/body policy without endpoint or credential detail.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ModelInferenceHttpConfigError {
    InvalidEndpoint,
    InvalidRequestLimit,
    InvalidResponseLimit,
}

impl ModelInferenceHttpConfigError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidEndpoint => "model_inference_endpoint_invalid",
            Self::InvalidRequestLimit => "model_inference_request_limit_invalid",
            Self::InvalidResponseLimit => "model_inference_response_limit_invalid",
        }
    }
}

impl fmt::Display for ModelInferenceHttpConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for ModelInferenceHttpConfigError {}

/// Validated immutable transport policy. Debug output deliberately omits the endpoint.
#[derive(Clone)]
pub struct ModelInferenceHttpConfig {
    endpoint: Url,
    max_request_bytes: usize,
    max_response_bytes: usize,
}

impl ModelInferenceHttpConfig {
    /// Parses one model-runtime base URL and bounded body policy.
    ///
    /// # Errors
    ///
    /// Rejects URL credentials, non-root paths, query/fragment data, non-HTTP schemes,
    /// non-loopback plaintext and body limits outside the closed bounds.
    pub fn new(
        endpoint: impl AsRef<str>,
        max_request_bytes: usize,
        max_response_bytes: usize,
    ) -> Result<Self, ModelInferenceHttpConfigError> {
        let endpoint =
            Url::parse(endpoint.as_ref()).map_err(|_| invalid_endpoint_configuration())?;
        if !matches!(endpoint.scheme(), "http" | "https")
            || endpoint.cannot_be_a_base()
            || endpoint.host().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || endpoint.path() != "/"
            || (endpoint.scheme() == "http" && !loopback_endpoint(&endpoint))
        {
            return Err(invalid_endpoint_configuration());
        }
        if !(MIN_BODY_BYTES..=MAX_REQUEST_BYTES).contains(&max_request_bytes) {
            return Err(ModelInferenceHttpConfigError::InvalidRequestLimit);
        }
        if !(MIN_BODY_BYTES..=MAX_RESPONSE_BYTES).contains(&max_response_bytes) {
            return Err(ModelInferenceHttpConfigError::InvalidResponseLimit);
        }
        Ok(Self {
            endpoint,
            max_request_bytes,
            max_response_bytes,
        })
    }
}

impl fmt::Debug for ModelInferenceHttpConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ModelInferenceHttpConfig")
            .field("endpoint", &"[REDACTED]")
            .field("max_request_bytes", &self.max_request_bytes)
            .field("max_response_bytes", &self.max_response_bytes)
            .finish()
    }
}

/// Shared production-shaped HTTP adapter for the bounded structured text model ports.
///
/// TLS, mTLS and authentication are supplied by the injected Client. This type owns no secret,
/// retry policy, queue, model artifact or business authority.
pub struct ModelInferenceHttpTransport {
    client: Client,
    config: ModelInferenceHttpConfig,
}

impl ModelInferenceHttpTransport {
    #[must_use]
    pub const fn new(client: Client, config: ModelInferenceHttpConfig) -> Self {
        Self { client, config }
    }

    async fn post<T, R>(&self, route: &str, request: &T) -> Result<R, TransportError>
    where
        T: Serialize + Sync,
        R: DeserializeOwned,
    {
        let body = serde_json::to_vec(request).map_err(|_| TransportError::RequestInvalid)?;
        if body.len() > self.config.max_request_bytes {
            return Err(TransportError::RequestInvalid);
        }
        let endpoint = endpoint_url(&self.config.endpoint, route)?;
        let response = self
            .client
            .post(endpoint)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ACCEPT, "application/json")
            .header(header::USER_AGENT, USER_AGENT)
            .body(body)
            .send()
            .await
            .map_err(|_| TransportError::Unavailable)?;
        validate_status(response.status())?;
        if !json_content_type(&response) {
            return Err(TransportError::ResponseInvalid);
        }
        let body = collect_bounded(response, self.config.max_response_bytes).await?;
        serde_json::from_slice(&body).map_err(|_| TransportError::ResponseInvalid)
    }
}

impl Clone for ModelInferenceHttpTransport {
    fn clone(&self) -> Self {
        Self {
            client: self.client.clone(),
            config: self.config.clone(),
        }
    }
}

impl fmt::Debug for ModelInferenceHttpTransport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ModelInferenceHttpTransport")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl FastIntentClassifierPort for ModelInferenceHttpTransport {
    async fn classify<'a>(
        &'a self,
        request: FastIntentClassifierRequest<'a>,
    ) -> Result<FastIntentClassifierOutput, FastIntentClassifierPortError> {
        let output: FastIntentResponse = self
            .post(
                "fast-intent",
                &FastIntentRequest {
                    schema_version: WIRE_SCHEMA_VERSION,
                    artifact_revision: request.artifact_revision(),
                    language: request.language(),
                    text: request.text(),
                    max_candidates: request.max_candidates(),
                },
            )
            .await
            .map_err(map_fast_error)?;
        if output.schema_version != WIRE_SCHEMA_VERSION {
            return Err(map_fast_error(TransportError::ResponseInvalid));
        }
        Ok(FastIntentClassifierOutput {
            served_artifact_revision: output.served_artifact_revision,
            candidates: output
                .candidates
                .into_iter()
                .map(|candidate| FastIntentCandidateOutput {
                    code: candidate.code,
                    confidence_bps: candidate.confidence_bps,
                })
                .collect(),
        })
    }
}

impl ContextualIntentClassifierPort for ModelInferenceHttpTransport {
    async fn classify<'a>(
        &'a self,
        request: ContextualIntentClassifierRequest<'a>,
    ) -> Result<ContextualIntentClassifierOutput, ContextualIntentClassifierPortError> {
        let turns = request
            .turns()
            .iter()
            .map(|turn| ContextualIntentRequestTurn {
                speaker: turn.speaker().as_str(),
                language: turn.language(),
                text: turn.text(),
            })
            .collect::<Vec<_>>();
        let output: ContextualIntentResponse = self
            .post(
                "contextual-intent",
                &ContextualIntentRequest {
                    schema_version: WIRE_SCHEMA_VERSION,
                    artifact_revision: request.artifact_revision(),
                    turns,
                    max_candidates: request.max_candidates(),
                    max_slots: request.max_slots(),
                },
            )
            .await
            .map_err(map_contextual_error)?;
        if output.schema_version != WIRE_SCHEMA_VERSION {
            return Err(map_contextual_error(TransportError::ResponseInvalid));
        }
        Ok(ContextualIntentClassifierOutput {
            served_artifact_revision: output.served_artifact_revision,
            candidates: output
                .candidates
                .into_iter()
                .map(|candidate| ContextualIntentCandidateOutput {
                    code: candidate.code,
                    confidence_bps: candidate.confidence_bps,
                })
                .collect(),
            slots: output.slots,
        })
    }
}

impl TextEmotionClassifierPort for ModelInferenceHttpTransport {
    async fn classify<'a>(
        &'a self,
        request: TextEmotionClassifierRequest<'a>,
    ) -> Result<TextEmotionClassifierOutput, TextEmotionClassifierPortError> {
        let output: TextEmotionResponse = self
            .post(
                "text-emotion",
                &TextEmotionRequest {
                    schema_version: WIRE_SCHEMA_VERSION,
                    artifact_revision: request.artifact_revision(),
                    language: request.language(),
                    text: request.text(),
                    max_candidates: request.max_candidates(),
                },
            )
            .await
            .map_err(map_text_emotion_error)?;
        if output.schema_version != WIRE_SCHEMA_VERSION {
            return Err(map_text_emotion_error(TransportError::ResponseInvalid));
        }
        Ok(TextEmotionClassifierOutput {
            served_artifact_revision: output.served_artifact_revision,
            candidates: output
                .candidates
                .into_iter()
                .map(|candidate| TextEmotionCandidateOutput {
                    code: candidate.code,
                    confidence_bps: candidate.confidence_bps,
                    intensity: candidate.intensity,
                })
                .collect(),
        })
    }
}

#[derive(Serialize)]
struct FastIntentRequest<'a> {
    schema_version: u16,
    artifact_revision: &'a str,
    language: &'a str,
    text: &'a str,
    max_candidates: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FastIntentResponse {
    schema_version: u16,
    served_artifact_revision: String,
    candidates: Vec<IntentCandidateResponse>,
}

#[derive(Serialize)]
struct ContextualIntentRequest<'a> {
    schema_version: u16,
    artifact_revision: &'a str,
    turns: Vec<ContextualIntentRequestTurn<'a>>,
    max_candidates: usize,
    max_slots: usize,
}

#[derive(Serialize)]
struct ContextualIntentRequestTurn<'a> {
    speaker: &'a str,
    language: &'a str,
    text: &'a str,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ContextualIntentResponse {
    schema_version: u16,
    served_artifact_revision: String,
    candidates: Vec<IntentCandidateResponse>,
    slots: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IntentCandidateResponse {
    code: String,
    confidence_bps: u16,
}

#[derive(Serialize)]
struct TextEmotionRequest<'a> {
    schema_version: u16,
    artifact_revision: &'a str,
    language: &'a str,
    text: &'a str,
    max_candidates: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TextEmotionResponse {
    schema_version: u16,
    served_artifact_revision: String,
    candidates: Vec<TextEmotionCandidateResponse>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TextEmotionCandidateResponse {
    code: String,
    confidence_bps: u16,
    intensity: u8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TransportError {
    RequestInvalid,
    Unavailable,
    Rejected,
    ResponseInvalid,
}

impl TransportError {
    const fn code(self) -> &'static str {
        match self {
            Self::RequestInvalid => "model_inference_request_invalid",
            Self::Unavailable => "model_inference_transport_unavailable",
            Self::Rejected => "model_inference_request_rejected",
            Self::ResponseInvalid => "model_inference_response_invalid",
        }
    }
}

fn endpoint_url(base: &Url, route: &str) -> Result<Url, TransportError> {
    let mut endpoint = base.clone();
    endpoint
        .path_segments_mut()
        .map_err(|()| TransportError::RequestInvalid)?
        .extend(["v1", "inference", route]);
    Ok(endpoint)
}

fn validate_status(status: StatusCode) -> Result<(), TransportError> {
    if status.is_success() {
        Ok(())
    } else if status == StatusCode::REQUEST_TIMEOUT
        || status == StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
    {
        Err(TransportError::Unavailable)
    } else {
        Err(TransportError::Rejected)
    }
}

fn json_content_type(response: &Response) -> bool {
    response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
}

async fn collect_bounded(
    mut response: Response,
    max_bytes: usize,
) -> Result<Vec<u8>, TransportError> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(TransportError::ResponseInvalid);
    }
    let mut body = Vec::with_capacity(
        response
            .content_length()
            .and_then(|length| usize::try_from(length).ok())
            .unwrap_or(0)
            .min(max_bytes),
    );
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| TransportError::ResponseInvalid)?
    {
        if body.len().saturating_add(chunk.len()) > max_bytes {
            return Err(TransportError::ResponseInvalid);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn loopback_endpoint(endpoint: &Url) -> bool {
    match endpoint.host() {
        Some(Host::Ipv4(address)) => IpAddr::V4(address).is_loopback(),
        Some(Host::Ipv6(address)) => IpAddr::V6(address).is_loopback(),
        Some(Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        None => false,
    }
}

const fn invalid_endpoint_configuration() -> ModelInferenceHttpConfigError {
    ModelInferenceHttpConfigError::InvalidEndpoint
}

const fn map_fast_error(error: TransportError) -> FastIntentClassifierPortError {
    match error {
        TransportError::Unavailable => FastIntentClassifierPortError::new(error.code()),
        TransportError::RequestInvalid
        | TransportError::Rejected
        | TransportError::ResponseInvalid => {
            FastIntentClassifierPortError::contract_invalid(error.code())
        }
    }
}

const fn map_contextual_error(error: TransportError) -> ContextualIntentClassifierPortError {
    match error {
        TransportError::Unavailable => ContextualIntentClassifierPortError::new(error.code()),
        TransportError::RequestInvalid
        | TransportError::Rejected
        | TransportError::ResponseInvalid => {
            ContextualIntentClassifierPortError::contract_invalid(error.code())
        }
    }
}

const fn map_text_emotion_error(error: TransportError) -> TextEmotionClassifierPortError {
    match error {
        TransportError::Unavailable => TextEmotionClassifierPortError::new(error.code()),
        TransportError::RequestInvalid
        | TransportError::Rejected
        | TransportError::ResponseInvalid => {
            TextEmotionClassifierPortError::contract_invalid(error.code())
        }
    }
}
