use std::collections::HashMap;

use serde::Deserialize;
use serde_json::Value;

/// Private mirror of only the pinned Active Call events accepted by this slice.
#[derive(Debug, Deserialize)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum UpstreamEvent {
    MediaReady {
        track_id: String,
        timestamp: u64,
    },
    AsrFinal {
        track_id: String,
        timestamp: u64,
        index: u32,
        start_time: Option<u64>,
        end_time: Option<u64>,
        text: String,
        is_filler: Option<bool>,
        confidence: Option<f32>,
        refer: Option<bool>,
    },
    AsrDelta {
        track_id: String,
        timestamp: u64,
        index: u32,
        start_time: Option<u64>,
        end_time: Option<u64>,
        text: String,
        is_filler: Option<bool>,
        confidence: Option<f32>,
        refer: Option<bool>,
    },
    Speaking {
        track_id: String,
        timestamp: u64,
        start_time: u64,
        is_filler: Option<bool>,
        confidence: Option<f32>,
    },
    Eou {
        track_id: String,
        timestamp: u64,
        completed: bool,
    },
    Interruption {
        track_id: String,
        timestamp: u64,
        total_duration: u32,
        current: u32,
    },
    Dtmf {
        track_id: String,
        timestamp: u64,
        digit: String,
    },
    Hold {
        track_id: String,
        timestamp: u64,
        on_hold: bool,
    },
    Inactivity {
        track_id: String,
        timestamp: u64,
    },
    FunctionCall {
        track_id: String,
        call_id: String,
        name: String,
        arguments: String,
        timestamp: u64,
    },
    Hangup {
        track_id: String,
        timestamp: u64,
        start_time: String,
        hangup_time: String,
        extra: Option<HashMap<String, Value>>,
    },
}
