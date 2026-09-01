#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ACTIVE_CALL_UPSTREAM_COMMIT =
  '6224d948cc0941ac48b4a5426477aeaf639c2e98';
export const ACTIVE_CALL_UPSTREAM_TREE =
  '9521ad341fb992ba6d491eb217983df8cf85d2cf';

function replaceOnce(source, search, replacement, label) {
  const matches = source.split(search).length - 1;
  if (matches !== 1) {
    throw new Error(
      `Active Call ${label} anchor mismatch: expected 1, got ${matches}`
    );
  }
  return source.replace(search, replacement);
}

function assertPinnedSource(sourceRoot) {
  const commit = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8'
  }).trim();
  const tree = execFileSync(
    'git',
    ['-C', sourceRoot, 'rev-parse', 'HEAD^{tree}'],
    { encoding: 'utf8' }
  ).trim();
  if (commit !== ACTIVE_CALL_UPSTREAM_COMMIT || tree !== ACTIVE_CALL_UPSTREAM_TREE) {
    throw new Error('Active Call source identity mismatch');
  }
}

export function patchPlaybookHandler(source) {
  const sessionField = '    pub session_id: Option<String>,\n';
  const queryHandler = 'pub async fn get_playbook_reservation(';
  const startHandler = 'pub async fn start_playbook_conversation(';
  const lifecycleHandler = 'pub(crate) async fn observe_platform_lifecycle(';
  const hasSessionField = source.includes(sessionField);
  const hasQueryHandler = source.includes(queryHandler);
  const hasStartHandler = source.includes(startHandler);
  const hasLifecycleHandler = source.includes(lifecycleHandler);
  if (hasSessionField && hasQueryHandler && hasStartHandler && hasLifecycleHandler) return source;
  if (hasSessionField || hasQueryHandler || hasStartHandler || hasLifecycleHandler) {
    throw new Error('Active Call Playbook overlay is partially applied');
  }

  let patched = replaceOnce(
    source,
    'use std::fs;\nuse std::path::PathBuf;\n',
    'use std::{fs, path::PathBuf};\n',
    'Playbook imports'
  );
  patched = replaceOnce(
    patched,
    '    pub r#type: Option<String>,\n    pub to: Option<String>,\n',
    '    pub r#type: Option<String>,\n    pub to: Option<String>,\n' +
      '    /// Optional platform-owned idempotent reservation/session identity.\n' +
      '    pub session_id: Option<String>,\n',
    'reservation request field'
  );
  patched = replaceOnce(
    patched,
    `#[derive(Serialize)]
pub struct RunPlaybookResponse {
    pub session_id: String,
}
`,
    `#[derive(Serialize)]
pub struct RunPlaybookResponse {
    pub session_id: String,
}

#[derive(Serialize)]
pub struct PlaybookReservationResponse {
    pub session_id: String,
    pub state: &'static str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PlatformPlaybookState {
    Pending,
    Attached,
    MediaReady,
    DisclosureCompleted,
    Started,
    Terminal,
}

pub(crate) struct PlatformPlaybookGate {
    pub state: PlatformPlaybookState,
    pub start_tx: tokio::sync::watch::Sender<bool>,
    pub updated_at: std::time::Instant,
}

const MAX_PLATFORM_SESSION_ID_BYTES: usize = 255;

pub(crate) fn valid_platform_session_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= MAX_PLATFORM_SESSION_ID_BYTES
        && first.is_ascii_alphanumeric()
        && remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}
`,
    'reservation response and validation'
  );
  patched = replaceOnce(
    patched,
    `pub async fn run_playbook(
    State(state): State<AppState>,
    Json(params): Json<RunPlaybookParams>,
) -> impl IntoResponse {
    let playbook_val = match params.source {
        PlaybookSource::File { playbook } => playbook,
        PlaybookSource::Content { content } => content,
    };

    let session_id = format!("s.{}", Uuid::new_v4().to_string());

    state.pending_playbooks.lock().await.insert(
        session_id.clone(),
        (playbook_val, std::time::Instant::now()),
    );

    Json(RunPlaybookResponse { session_id }).into_response()
}
`,
    `pub async fn run_playbook(
    State(state): State<AppState>,
    Json(params): Json<RunPlaybookParams>,
) -> impl IntoResponse {
    let playbook_val = match params.source {
        PlaybookSource::File { playbook } => playbook,
        PlaybookSource::Content { content } => content,
    };

    let platform_owned = params.session_id.is_some();
    let session_id = match params.session_id {
        Some(session_id) if valid_platform_session_id(&session_id) => session_id,
        Some(_) => {
            return (StatusCode::BAD_REQUEST, "invalid session identity").into_response();
        }
        None => format!("s.{}", Uuid::new_v4()),
    };

    if state.active_calls.lock().unwrap().contains_key(&session_id) {
        return (StatusCode::CONFLICT, "session identity already active").into_response();
    }

    let mut pending = state.pending_playbooks.lock().await;
    if let Some((existing, _)) = pending.get(&session_id) {
        if existing == &playbook_val {
            return Json(RunPlaybookResponse { session_id }).into_response();
        }
        return (StatusCode::CONFLICT, "session identity payload conflict").into_response();
    }
    let mut gates = state.platform_playbook_gates.lock().await;
    if gates.contains_key(&session_id) {
        return (StatusCode::CONFLICT, "session identity state conflict").into_response();
    }
    pending.insert(
        session_id.clone(),
        (playbook_val, std::time::Instant::now()),
    );
    if platform_owned {
        let (start_tx, _) = tokio::sync::watch::channel(false);
        gates.insert(
            session_id.clone(),
            PlatformPlaybookGate {
                state: PlatformPlaybookState::Pending,
                start_tx,
                updated_at: std::time::Instant::now(),
            },
        );
    }

    Json(RunPlaybookResponse { session_id }).into_response()
}

pub async fn get_playbook_reservation(
    Path(session_id): Path<String>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    if !valid_platform_session_id(&session_id) {
        return (StatusCode::BAD_REQUEST, "invalid session identity").into_response();
    }
    if let Some(gate) = state.platform_playbook_gates.lock().await.get(&session_id) {
        let state = match gate.state {
            PlatformPlaybookState::Pending => "pending",
            PlatformPlaybookState::Attached => "attached",
            PlatformPlaybookState::MediaReady => "media_ready",
            PlatformPlaybookState::DisclosureCompleted => "disclosure_completed",
            PlatformPlaybookState::Started => "started",
            PlatformPlaybookState::Terminal => "terminal",
        };
        return Json(PlaybookReservationResponse {
            session_id,
            state,
        })
        .into_response();
    }
    if state.active_calls.lock().unwrap().contains_key(&session_id) {
        return Json(PlaybookReservationResponse {
            session_id,
            state: "active",
        })
        .into_response();
    }
    if state
        .pending_playbooks
        .lock()
        .await
        .contains_key(&session_id)
    {
        return Json(PlaybookReservationResponse {
            session_id,
            state: "pending",
        })
        .into_response();
    }
    (StatusCode::NOT_FOUND, "reservation not found").into_response()
}

pub(crate) async fn claim_platform_playbook(
    state: &AppState,
    session_id: &str,
) -> Option<String> {
    let mut pending = state.pending_playbooks.lock().await;
    let (content, created_at) = pending.get_mut(session_id)?;
    let mut gates = state.platform_playbook_gates.lock().await;
    let gate = gates.get_mut(session_id)?;
    if gate.state != PlatformPlaybookState::Pending {
        return None;
    }
    gate.state = PlatformPlaybookState::Attached;
    gate.updated_at = std::time::Instant::now();
    *created_at = std::time::Instant::now();
    Some(content.clone())
}

pub(crate) async fn observe_platform_lifecycle(
    state: &AppState,
    session_id: &str,
    event: &crate::event::SessionEvent,
) {
    let mut gates = state.platform_playbook_gates.lock().await;
    let Some(gate) = gates.get_mut(session_id) else {
        return;
    };
    let next = match event {
        crate::event::SessionEvent::MediaReady { .. }
            if gate.state == PlatformPlaybookState::Attached =>
        {
            Some(PlatformPlaybookState::MediaReady)
        }
        crate::event::SessionEvent::TrackEnd {
            duration,
            play_id: Some(play_id),
            ..
        } if gate.state == PlatformPlaybookState::MediaReady
            && *duration > 0
            && play_id == session_id =>
        {
            Some(PlatformPlaybookState::DisclosureCompleted)
        }
        crate::event::SessionEvent::Hangup { .. } => Some(PlatformPlaybookState::Terminal),
        _ => None,
    };
    if let Some(next) = next {
        gate.state = next;
        gate.updated_at = std::time::Instant::now();
    }
}

pub(crate) async fn mark_platform_terminal(state: &AppState, session_id: &str) {
    let mut gates = state.platform_playbook_gates.lock().await;
    if let Some(gate) = gates.get_mut(session_id) {
        gate.state = PlatformPlaybookState::Terminal;
        gate.updated_at = std::time::Instant::now();
    }
}

pub async fn start_playbook_conversation(
    Path(session_id): Path<String>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    if !valid_platform_session_id(&session_id) {
        return (StatusCode::BAD_REQUEST, "invalid session identity").into_response();
    }
    let mut gates = state.platform_playbook_gates.lock().await;
    let Some(gate) = gates.get_mut(&session_id) else {
        return (StatusCode::NOT_FOUND, "reservation not found").into_response();
    };
    match gate.state {
        PlatformPlaybookState::DisclosureCompleted => {
            gate.state = PlatformPlaybookState::Started;
            gate.updated_at = std::time::Instant::now();
            gate.start_tx.send_replace(true);
        }
        PlatformPlaybookState::Started => {}
        PlatformPlaybookState::Pending
        | PlatformPlaybookState::Attached
        | PlatformPlaybookState::MediaReady => {
            return (StatusCode::CONFLICT, "disclosure is not complete").into_response();
        }
        PlatformPlaybookState::Terminal => {
            return (StatusCode::CONFLICT, "session is terminal").into_response();
        }
    }
    Json(PlaybookReservationResponse {
        session_id,
        state: "started",
    })
    .into_response()
}

#[cfg(test)]
mod converact_reservation_tests {
    use super::{
        PlaybookSource, RunPlaybookParams, claim_platform_playbook, get_playbook_reservation,
        observe_platform_lifecycle, run_playbook, start_playbook_conversation,
        valid_platform_session_id,
    };
    use crate::{app::AppStateBuilder, config::Config};
    use axum::{
        Json,
        extract::{Path, State},
        http::StatusCode,
        response::IntoResponse,
    };

    #[test]
    fn platform_session_identity_is_bounded_and_canonical() {
        assert!(valid_platform_session_id("agent:attempt-001:g1"));
        assert!(!valid_platform_session_id(""));
        assert!(!valid_platform_session_id("bad/session"));
        assert!(!valid_platform_session_id(&"x".repeat(256)));
    }

    #[tokio::test]
    async fn stable_session_replays_same_content_and_conflicts_on_drift() {
        let mut config = Config::default();
        config.udp_port = 0;
        let state = AppStateBuilder::new()
            .with_config(config)
            .build()
            .await
            .expect("test state");

        let request = |content: &str| RunPlaybookParams {
            source: PlaybookSource::Content {
                content: content.to_owned(),
            },
            r#type: None,
            to: None,
            session_id: Some("agent:attempt-001:g1".to_owned()),
        };
        assert_eq!(
            run_playbook(State(state.clone()), Json(request("---\\nname: r1")))
                .await
                .into_response()
                .status(),
            StatusCode::OK,
        );
        assert_eq!(
            run_playbook(State(state.clone()), Json(request("---\\nname: r1")))
                .await
                .into_response()
                .status(),
            StatusCode::OK,
        );
        assert_eq!(
            run_playbook(State(state.clone()), Json(request("---\\nname: r2")))
                .await
                .into_response()
                .status(),
            StatusCode::CONFLICT,
        );
        assert_eq!(
            get_playbook_reservation(Path("agent:attempt-001:g1".to_owned()), State(state),)
                .await
                .into_response()
                .status(),
            StatusCode::OK,
        );
    }

    #[tokio::test]
    async fn platform_session_cannot_start_before_attach_and_start_is_idempotent() {
        let mut config = Config::default();
        config.udp_port = 0;
        let state = AppStateBuilder::new()
            .with_config(config)
            .build()
            .await
            .expect("test state");
        let session_id = "agent:attempt-002:g1".to_owned();
        let request = RunPlaybookParams {
            source: PlaybookSource::Content {
                content: "---\\nname: r1".to_owned(),
            },
            r#type: None,
            to: None,
            session_id: Some(session_id.clone()),
        };
        assert_eq!(
            run_playbook(State(state.clone()), Json(request))
                .await
                .into_response()
                .status(),
            StatusCode::OK,
        );
        assert_eq!(
            start_playbook_conversation(Path(session_id.clone()), State(state.clone()))
                .await
                .into_response()
                .status(),
            StatusCode::CONFLICT,
        );
        assert_eq!(
            claim_platform_playbook(&state, &session_id).await.as_deref(),
            Some("---\\nname: r1"),
        );
        assert!(claim_platform_playbook(&state, &session_id).await.is_none());
        let mut receiver = state
            .platform_playbook_gates
            .lock()
            .await
            .get(&session_id)
            .expect("platform gate")
            .start_tx
            .subscribe();
        assert!(!*receiver.borrow());
        observe_platform_lifecycle(
            &state,
            &session_id,
            &crate::event::SessionEvent::MediaReady {
                track_id: session_id.clone(),
                timestamp: 1,
            },
        )
        .await;
        assert_eq!(
            start_playbook_conversation(Path(session_id.clone()), State(state.clone()))
                .await
                .into_response()
                .status(),
            StatusCode::CONFLICT,
        );
        for (duration, play_id) in [(640, "different-session"), (0, session_id.as_str())] {
            observe_platform_lifecycle(
                &state,
                &session_id,
                &crate::event::SessionEvent::TrackEnd {
                    track_id: session_id.clone(),
                    timestamp: 2,
                    duration,
                    ssrc: 7,
                    play_id: Some(play_id.to_string()),
                    auto_hangup: None,
                },
            )
            .await;
            assert_eq!(
                start_playbook_conversation(Path(session_id.clone()), State(state.clone()))
                    .await
                    .into_response()
                    .status(),
                StatusCode::CONFLICT,
            );
        }
        observe_platform_lifecycle(
            &state,
            &session_id,
            &crate::event::SessionEvent::TrackEnd {
                track_id: session_id.clone(),
                timestamp: 2,
                duration: 640,
                ssrc: 7,
                play_id: Some(session_id.clone()),
                auto_hangup: None,
            },
        )
        .await;
        assert_eq!(
            start_playbook_conversation(Path(session_id.clone()), State(state.clone()))
                .await
                .into_response()
                .status(),
            StatusCode::OK,
        );
        receiver.changed().await.expect("start signal");
        assert!(*receiver.borrow());
        assert_eq!(
            start_playbook_conversation(Path(session_id), State(state))
                .await
                .into_response()
                .status(),
            StatusCode::OK,
        );
    }
}
`,
    'reservation handlers'
  );
  return patched;
}

export function patchRouter(source) {
  const queryRoute = '"/api/playbook/reservations/{session_id}",';
  const startRoute = '"/api/playbook/reservations/{session_id}/start",';
  const hasQueryRoute = source.includes(queryRoute);
  const hasStartRoute = source.includes(startRoute);
  if (hasQueryRoute && hasStartRoute) return source;
  if (hasQueryRoute || hasStartRoute) {
    throw new Error('Active Call router overlay is partially applied');
  }
  return replaceOnce(
    source,
    `        .route(
            "/api/playbook/run",
            axum::routing::post(playbook::run_playbook),
        )
        .route("/api/records", get(playbook::list_records))
`,
    `        .route(
            "/api/playbook/run",
            axum::routing::post(playbook::run_playbook),
        )
        .route(
            "/api/playbook/reservations/{session_id}",
            get(playbook::get_playbook_reservation),
        )
        .route(
            "/api/playbook/reservations/{session_id}/start",
            axum::routing::post(playbook::start_playbook_conversation),
        )
        .route("/api/records", get(playbook::list_records))
`,
    'reservation query route'
  );
}

export function patchAppState(source) {
  const field = '    pub(crate) platform_playbook_gates:';
  if (source.includes(field)) return source;
  let patched = replaceOnce(
    source,
    '    pub pending_playbooks: Arc<Mutex<HashMap<String, (String, Instant)>>>,\n',
    '    pub pending_playbooks: Arc<Mutex<HashMap<String, (String, Instant)>>>,\n' +
      '    pub(crate) platform_playbook_gates: Arc<Mutex<HashMap<String, crate::handler::playbook::PlatformPlaybookGate>>>,\n',
    'platform Playbook gate field'
  );
  patched = replaceOnce(
    patched,
    '            pending_playbooks: Arc::new(Mutex::new(HashMap::new())),\n',
    '            pending_playbooks: Arc::new(Mutex::new(HashMap::new())),\n' +
      '            platform_playbook_gates: Arc::new(Mutex::new(HashMap::new())),\n',
    'platform Playbook gate initialization'
  );
  patched = replaceOnce(
    patched,
    `                        pending.retain(|_, (_, created_at)| created_at.elapsed() < ttl);
                        let removed = before - pending.len();
                        if removed > 0 {
                            info!(removed, remaining = pending.len(), "cleaned up stale pending_playbooks entries");
                        }
`,
    `                        pending.retain(|_, (_, created_at)| created_at.elapsed() < ttl);
                        let removed = before - pending.len();
                        let mut gates = pending_cleanup_state.platform_playbook_gates.lock().await;
                        let active_calls = pending_cleanup_state.active_calls.lock().unwrap();
                        gates.retain(|session_id, gate| {
                            pending.contains_key(session_id)
                                || active_calls.contains_key(session_id)
                                || gate.updated_at.elapsed() < ttl
                        });
                        if removed > 0 {
                            info!(removed, remaining = pending.len(), "cleaned up stale pending_playbooks entries");
                        }
`,
    'stale platform Playbook gate cleanup'
  );
  return patched;
}

export function patchEventJournalAppState(source) {
  const field = '    pub(crate) platform_event_journals:';
  if (source.includes(field)) return source;
  if (!source.includes('    pub(crate) platform_playbook_gates:')) {
    throw new Error('Active Call event journal requires the Playbook gate overlay');
  }
  let patched = replaceOnce(
    source,
    '    pub(crate) platform_playbook_gates: Arc<Mutex<HashMap<String, crate::handler::playbook::PlatformPlaybookGate>>>,\n',
    '    pub(crate) platform_playbook_gates: Arc<Mutex<HashMap<String, crate::handler::playbook::PlatformPlaybookGate>>>,\n' +
      '    pub(crate) platform_event_journals: Arc<std::sync::Mutex<crate::handler::platform_event_journal::PlatformEventJournals>>,\n',
    'platform event journal field'
  );
  patched = replaceOnce(
    patched,
    '            platform_playbook_gates: Arc::new(Mutex::new(HashMap::new())),\n',
    '            platform_playbook_gates: Arc::new(Mutex::new(HashMap::new())),\n' +
      '            platform_event_journals: Arc::new(std::sync::Mutex::new(HashMap::new())),\n',
    'platform event journal initialization'
  );
  patched = replaceOnce(
    patched,
    `                        gates.retain(|session_id, gate| {
                            pending.contains_key(session_id)
                                || active_calls.contains_key(session_id)
                                || gate.updated_at.elapsed() < ttl
                        });
                        if removed > 0 {
`,
    `                        gates.retain(|session_id, gate| {
                            pending.contains_key(session_id)
                                || active_calls.contains_key(session_id)
                                || gate.updated_at.elapsed() < ttl
                        });
                        let mut journals = pending_cleanup_state
                            .platform_event_journals
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        crate::handler::platform_event_journal::retain_platform_event_journals(
                            &mut journals,
                            ttl,
                            |session_id| {
                                pending.contains_key(session_id)
                                    || active_calls.contains_key(session_id)
                            },
                        );
                        if removed > 0 {
`,
    'stale platform event journal cleanup'
  );
  return patched;
}

export function patchHandlerModule(source) {
  const marker = 'pub(crate) mod platform_event_journal;';
  if (source.includes(marker)) return source;
  return replaceOnce(
    source,
    'pub mod peer;\n',
    'pub mod peer;\n' + marker + '\n',
    'platform event journal module'
  );
}

export function patchInvitationHandler(source) {
  const marker = 'const PLATFORM_SESSION_HEADER: &str = "X-Converact-Agent-Session";';
  if (source.includes(marker)) return source;
  let patched = replaceOnce(
    source,
    `        extras
    }
}

#[async_trait]
`,
    `        extras
    }

    fn platform_session_identity(
        headers: &rsipstack::rsip::Headers,
    ) -> Result<Option<String>> {
        const PLATFORM_SESSION_HEADER: &str = "X-Converact-Agent-Session";
        let mut identity = None;
        for header in headers.iter() {
            if let rsipstack::rsip::Header::Other(name, value) = header
                && name.to_string().eq_ignore_ascii_case(PLATFORM_SESSION_HEADER)
            {
                let value = value.to_string();
                if identity.is_some()
                    || !crate::handler::playbook::valid_platform_session_id(&value)
                {
                    return Err(anyhow!("invalid platform session identity"));
                }
                identity = Some(value);
            }
        }
        Ok(identity)
    }
}

#[async_trait]
`,
    'SIP platform session header parser'
  );
  patched = replaceOnce(
    patched,
    `        match self.match_playbook(&caller, &callee) {
            Some(playbook) => {
`,
    `        let platform_session_identity =
            match Self::platform_session_identity(&invite_request.headers) {
                Ok(identity) => identity,
                Err(error) => {
                    warn!(dialog_id, %error, "rejecting invalid platform session identity");
                    dialog.reject(
                        Some(rsipstack::rsip::StatusCode::BadRequest),
                        Some("Invalid Agent Session".to_string()),
                    )?;
                    return Ok(());
                }
            };
        let selected_playbook = if let Some(session_id) = platform_session_identity.as_ref() {
            let reserved = crate::handler::playbook::claim_platform_playbook(
                &self.app_state,
                session_id,
            )
            .await;
            if reserved.is_none() {
                warn!(dialog_id, session_id, "rejecting SIP leg without matching reservation");
                dialog.reject(
                    Some(rsipstack::rsip::StatusCode::ServiceUnavailable),
                    Some("Agent Session Not Reserved".to_string()),
                )?;
                return Ok(());
            }
            reserved
        } else {
            self.match_playbook(&caller, &callee)
        };

        match selected_playbook {
            Some(playbook) => {
`,
    'SIP reserved Playbook selection'
  );
  patched = replaceOnce(
    patched,
    `                // Extract custom headers
                let mut extras = Self::extract_custom_headers(&invite_request.headers);
`,
    `                // Extract tenant-approved custom headers, but never expose the control identity
                // to Playbook rendering or the dialogue model.
                let mut extras = Self::extract_custom_headers(&invite_request.headers);
                extras.retain(|name, _| !name.eq_ignore_ascii_case("X-Converact-Agent-Session"));
`,
    'SIP control header redaction'
  );
  patched = replaceOnce(
    patched,
    `                let app_state = self.app_state.clone();
                let session_id = dialog_id.clone();
                let cancel_token_clone = cancel_token.clone();
`,
    `                let app_state = self.app_state.clone();
                let platform_owned = platform_session_identity.is_some();
                let session_id = platform_session_identity.unwrap_or_else(|| dialog_id.clone());
                let cancel_token_clone = cancel_token.clone();
`,
    'SIP platform session binding'
  );
  patched = replaceOnce(
    patched,
    `                    let extras_for_call = extras_opt;
                    let playbook_for_call = playbook;
`,
    `                    let extras_for_call = extras_opt;
                    let playbook_for_call = if platform_owned { None } else { Some(playbook) };
`,
    'reserved Playbook ownership'
  );
  patched = replaceOnce(
    patched,
    `                                extras_for_call,
                                Some(playbook_for_call),
`,
    `                                extras_for_call,
                                playbook_for_call, // reserved Playbook is consumed by session identity
`,
    'reserved Playbook call binding'
  );
  return patched;
}

export function patchCallHandler(source) {
  const marker = 'PlaybookRunner::new_with_start_gate(';
  const lifecycleMarker = 'observe_platform_lifecycle(';
  const hasRunnerGate = source.includes(marker);
  const hasLifecycle = source.includes(lifecycleMarker);
  if (hasRunnerGate && hasLifecycle) return source;
  if (hasRunnerGate || hasLifecycle) {
    throw new Error('Active Call call-handler overlay is partially applied');
  }
  let patched = replaceOnce(
    source,
    `        let name_or_content = playbook_name.or_else(|| {
            app_state
                .pending_playbooks
                .try_lock()
                .ok()
                .and_then(|mut pending| pending.remove(&session_id).map(|(val, _)| val))
        });
`,
    `        let (name_or_content, platform_start_gate) = if let Some(playbook_name) = playbook_name {
            (Some(playbook_name), None)
        } else {
            let mut pending = app_state.pending_playbooks.lock().await;
            let name_or_content = pending.remove(&session_id).map(|(value, _)| value);
            let platform_start_gate = if name_or_content.is_some() {
                let mut gates = app_state.platform_playbook_gates.lock().await;
                match gates.get_mut(&session_id) {
                    Some(gate)
                        if gate.state
                            == crate::handler::playbook::PlatformPlaybookState::Pending =>
                    {
                        gate.state = crate::handler::playbook::PlatformPlaybookState::Attached;
                        gate.updated_at = std::time::Instant::now();
                        Some(gate.start_tx.subscribe())
                    }
                    Some(gate)
                        if gate.state
                            == crate::handler::playbook::PlatformPlaybookState::Attached =>
                    {
                        Some(gate.start_tx.subscribe())
                    }
                    Some(_) => {
                        warn!(session_id, "platform Playbook gate is not pending");
                        return None;
                    }
                    None => None,
                }
            } else {
                None
            };
            (name_or_content, platform_start_gate)
        };
`,
    'atomic reserved Playbook consumption'
  );
  patched = replaceOnce(
    patched,
    '                    match PlaybookRunner::new(playbook, active_call.clone()) {\n',
    `                    match PlaybookRunner::new_with_start_gate(
                        playbook,
                        active_call.clone(),
                        platform_start_gate,
                    ) {
`,
    'armed Playbook runner construction'
  );
  patched = replaceOnce(
    patched,
    `                        Err(e) => {
                            let display_name = if name_or_content.trim().starts_with("---") {
                                "custom content"
                            } else {
                                &name_or_content
                            };
                            warn!(
                                session_id,
                                "Failed to create runner {}: {}", display_name, e
                            )
                        }
`,
    `                        Err(e) => {
                            let display_name = if name_or_content.trim().starts_with("---") {
                                "custom content"
                            } else {
                                &name_or_content
                            };
                            warn!(
                                session_id,
                                "Failed to create runner {}: {}", display_name, e
                            );
                            app_state.platform_playbook_gates.lock().await.remove(&session_id);
                            return None;
                        }
`,
    'runner construction failure cleanup'
  );
  patched = replaceOnce(
    patched,
    `                    event_sender_to_client.send(event).ok();
                    return None;
`,
    `                    event_sender_to_client.send(event).ok();
                    app_state.platform_playbook_gates.lock().await.remove(&session_id);
                    return None;
`,
    'Playbook parse failure cleanup'
  );
  patched = replaceOnce(
    patched,
    `    let mut event_receiver = active_call.event_sender.subscribe();
    let send_events_loop = async {
        loop {
            match event_receiver.recv().await {
                Ok(event) => {
                    if let Err(_) = event_sender_to_client.send(event) {
`,
    `    let mut event_receiver = active_call.event_sender.subscribe();
    let lifecycle_app_state = app_state.clone();
    let lifecycle_session_id = session_id.clone();
    let send_events_loop = async {
        loop {
            match event_receiver.recv().await {
                Ok(event) => {
                    crate::handler::playbook::observe_platform_lifecycle(
                        &lifecycle_app_state,
                        &lifecycle_session_id,
                        &event,
                    )
                    .await;
                    if let Err(_) = event_sender_to_client.send(event) {
`,
    'platform lifecycle observation'
  );
  patched = replaceOnce(
    patched,
    `    active_call.cleanup().await.ok();
    debug!(session_id, "Call handler core completed");
`,
    `    active_call.cleanup().await.ok();
    crate::handler::playbook::mark_platform_terminal(&app_state, &session_id).await;
    debug!(session_id, "Call handler core completed");
`,
    'platform Playbook gate terminal cleanup'
  );
  return patched;
}

export function patchEventJournalCallHandler(source) {
  const marker = 'attach_platform_event_journal(';
  if (source.includes(marker)) return source;
  if (!source.includes('PlaybookRunner::new_with_start_gate(')) {
    throw new Error('Active Call event journal requires the call-handler gate overlay');
  }
  return replaceOnce(
    source,
    `    }));

    // Load playbook: prefer direct parameter, fall back to pending_playbooks
`,
    `    }));

    crate::handler::platform_event_journal::attach_platform_event_journal(
        &app_state,
        &session_id,
        active_call.event_sender.subscribe(),
    )
    .await;

    // Load playbook: prefer direct parameter, fall back to pending_playbooks
`,
    'platform event journal recorder attachment'
  );
}

export function patchEventStream(source) {
  const marker = 'last_event_cursor(&headers)';
  if (source.includes(marker)) return source;
  return replaceOnce(
    source,
    `pub(crate) async fn stream_events(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Response {
`,
    `pub(crate) async fn stream_events(
    Path(id): Path<String>,
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Response {
    // Last-Event-ID opts platform workers into the bounded semantic replay journal.
    let resume_cursor = match crate::handler::platform_event_journal::last_event_cursor(&headers) {
        Ok(cursor) => cursor,
        Err(status) => return (status, "invalid Last-Event-ID").into_response(),
    };
    if let Some(cursor) = resume_cursor {
        return crate::handler::platform_event_journal::stream_platform_events(
            state,
            id,
            cursor,
        )
        .await;
    }
`,
    'platform resumable event stream'
  );
}

export function patchPlaybookRunner(source) {
  const marker = 'wait_for_platform_start';
  if (source.includes(marker)) return source;
  let patched = replaceOnce(
    source,
    `    config: PlaybookConfig,
    event_receiver: EventReceiver,
`,
    `    config: PlaybookConfig,
    event_receiver: EventReceiver,
    platform_start_gate: Option<tokio::sync::watch::Receiver<bool>>,
`,
    'Playbook runner start gate field'
  );
  patched = replaceOnce(
    patched,
    `            config,
            event_receiver,
        }
    }

    pub fn new(playbook: Playbook, call: ActiveCallRef) -> Result<Self> {
`,
    `            config,
            event_receiver,
            platform_start_gate: None,
        }
    }

    pub fn new(playbook: Playbook, call: ActiveCallRef) -> Result<Self> {
        Self::new_with_start_gate(playbook, call, None)
    }

    pub(crate) fn new_with_start_gate(
        playbook: Playbook,
        call: ActiveCallRef,
        platform_start_gate: Option<tokio::sync::watch::Receiver<bool>>,
    ) -> Result<Self> {
`,
    'Playbook runner armed constructor'
  );
  patched = replaceOnce(
    patched,
    `            handler,
            call,
            config: playbook.config,
            event_receiver,
        })
    }

    pub async fn run(mut self) {
`,
    `            handler,
            call,
            config: playbook.config,
            event_receiver,
            platform_start_gate,
        })
    }

    async fn wait_for_platform_start(
        &mut self,
        answered: &mut bool,
        media_ready: &mut bool,
    ) -> bool {
        let Some(start_gate) = self.platform_start_gate.as_mut() else {
            return true;
        };
        loop {
            if *start_gate.borrow() {
                info!("platform authorized Playbook conversation start");
                return true;
            }
            tokio::select! {
                changed = start_gate.changed() => {
                    if changed.is_err() {
                        warn!("platform Playbook start gate closed before authorization");
                        return false;
                    }
                }
                event = self.event_receiver.recv() => {
                    match event {
                        Ok(crate::event::SessionEvent::Answer { .. }) => *answered = true,
                        Ok(crate::event::SessionEvent::MediaReady { .. }) => *media_ready = true,
                        Ok(crate::event::SessionEvent::Hangup { .. }) | Err(_) => return false,
                        _ => {}
                    }
                }
            }
        }
    }

    pub async fn run(mut self) {
`,
    'Playbook runner platform start wait'
  );
  patched = replaceOnce(
    patched,
    `        let mut media_ready = !wait_for_media_ready;

        if let Ok(commands) = self.handler.on_start().await {
`,
    `        let mut media_ready = !wait_for_media_ready;

        if !self
            .wait_for_platform_start(&mut answered, &mut media_ready)
            .await
        {
            return;
        }

        if let Ok(commands) = self.handler.on_start().await {
`,
    'Playbook runner start authorization'
  );
  return patched;
}

function patchFile(path, transform) {
  const source = readFileSync(path, 'utf8');
  const patched = transform(source);
  if (patched !== source) writeFileSync(path, patched);
}

function installPlatformEventJournal(root) {
  const target = join(root, 'src/handler/platform_event_journal.rs');
  const content = readFileSync(
    new URL('./platform-event-journal.rs', import.meta.url),
    'utf8'
  );
  if (existsSync(target)) {
    if (readFileSync(target, 'utf8') !== content) {
      throw new Error('Active Call platform event journal file conflicts with overlay');
    }
    return;
  }
  writeFileSync(target, content);
}

export function applyActiveCallOverlay(sourceRoot) {
  const root = resolve(sourceRoot);
  assertPinnedSource(root);
  patchFile(join(root, 'src/handler/playbook.rs'), patchPlaybookHandler);
  patchFile(join(root, 'src/app.rs'), patchAppState);
  patchFile(join(root, 'src/app.rs'), patchEventJournalAppState);
  patchFile(join(root, 'src/handler/handler.rs'), patchCallHandler);
  patchFile(join(root, 'src/handler/handler.rs'), patchEventJournalCallHandler);
  patchFile(join(root, 'src/handler/handler.rs'), patchEventStream);
  patchFile(join(root, 'src/handler/handler.rs'), patchRouter);
  patchFile(join(root, 'src/handler/mod.rs'), patchHandlerModule);
  installPlatformEventJournal(root);
  patchFile(join(root, 'src/useragent/playbook_handler.rs'), patchInvitationHandler);
  patchFile(join(root, 'src/playbook/runner.rs'), patchPlaybookRunner);
  return {
    commit: ACTIVE_CALL_UPSTREAM_COMMIT,
    tree: ACTIVE_CALL_UPSTREAM_TREE,
    files: [
      'src/app.rs',
      'src/handler/playbook.rs',
      'src/handler/handler.rs',
      'src/handler/mod.rs',
      'src/handler/platform_event_journal.rs',
      'src/playbook/runner.rs',
      'src/useragent/playbook_handler.rs'
    ]
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error('usage: apply-overlay.mjs ACTIVE_CALL_SOURCE_DIRECTORY');
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(applyActiveCallOverlay(process.argv[2])));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
