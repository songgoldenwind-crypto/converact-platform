#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
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
  const hasSessionField = source.includes(sessionField);
  const hasQueryHandler = source.includes(queryHandler);
  if (hasSessionField && hasQueryHandler) return source;
  if (hasSessionField || hasQueryHandler) {
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

const MAX_PLATFORM_SESSION_ID_BYTES: usize = 255;

fn valid_platform_session_id(value: &str) -> bool {
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
    pending.insert(
        session_id.clone(),
        (playbook_val, std::time::Instant::now()),
    );

    Json(RunPlaybookResponse { session_id }).into_response()
}

pub async fn get_playbook_reservation(
    Path(session_id): Path<String>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    if !valid_platform_session_id(&session_id) {
        return (StatusCode::BAD_REQUEST, "invalid session identity").into_response();
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

#[cfg(test)]
mod converact_reservation_tests {
    use super::{
        PlaybookSource, RunPlaybookParams, get_playbook_reservation, run_playbook,
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
}
`,
    'reservation handlers'
  );
  return patched;
}

export function patchRouter(source) {
  const route = '"/api/playbook/reservations/{session_id}",';
  if (source.includes(route)) return source;
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
        .route("/api/records", get(playbook::list_records))
`,
    'reservation query route'
  );
}

function patchFile(path, transform) {
  const source = readFileSync(path, 'utf8');
  const patched = transform(source);
  if (patched !== source) writeFileSync(path, patched);
}

export function applyActiveCallOverlay(sourceRoot) {
  const root = resolve(sourceRoot);
  assertPinnedSource(root);
  patchFile(join(root, 'src/handler/playbook.rs'), patchPlaybookHandler);
  patchFile(join(root, 'src/handler/handler.rs'), patchRouter);
  return {
    commit: ACTIVE_CALL_UPSTREAM_COMMIT,
    tree: ACTIVE_CALL_UPSTREAM_TREE,
    files: ['src/handler/playbook.rs', 'src/handler/handler.rs']
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
