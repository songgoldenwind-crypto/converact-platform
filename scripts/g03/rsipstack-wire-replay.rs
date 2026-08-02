use std::{env, fmt::Write as _, fs, process};

use rsipstack::sip::{HasHeaders, SipMessage};
use sha2::{Digest, Sha256};

fn main() {
    let mut arguments = env::args_os();
    let _program = arguments.next();
    let Some(path) = arguments.next() else {
        eprintln!("usage: converact_wire_replay WIRE_FILE");
        process::exit(64);
    };
    if arguments.next().is_some() {
        eprintln!("usage: converact_wire_replay WIRE_FILE");
        process::exit(64);
    }
    let wire = match fs::read(path) {
        Ok(wire) => wire,
        Err(_) => {
            eprintln!("wire file could not be read");
            process::exit(66);
        }
    };
    let wire_sha256 = hex_digest(Sha256::digest(&wire));

    match SipMessage::try_from(wire.as_slice()) {
        Ok(message) => print_accepted(&wire_sha256, wire.len(), message),
        Err(_) => print_rejected(&wire_sha256, wire.len()),
    }
}

fn print_accepted(wire_sha256: &str, wire_length: usize, message: SipMessage) {
    let (message_kind, method_or_status, request_uri_sha256, body, reserialized) = match &message {
        SipMessage::Request(request) => (
            "request",
            request.method.to_string(),
            Some(hex_digest(Sha256::digest(request.uri.to_string().as_bytes()))),
            request.body.as_slice(),
            request.to_bytes(),
        ),
        SipMessage::Response(response) => (
            "response",
            response.status_code.code().to_string(),
            None,
            response.body.as_slice(),
            response.to_bytes(),
        ),
    };
    let header_names = json_array(
        message
            .headers()
            .iter()
            .map(|header| header.name().to_ascii_lowercase()),
    );
    let header_value_sha256 = json_array(message.headers().iter().map(|header| {
        hex_digest(Sha256::digest(header.value().as_bytes()))
    }));
    let body_sha256 = hex_digest(Sha256::digest(body));
    let reserialized_sha256 = hex_digest(Sha256::digest(&reserialized));
    let request_uri = request_uri_sha256
        .map(|digest| format!("\"{digest}\""))
        .unwrap_or_else(|| "null".to_string());

    println!(
        "{{\"schema_id\":\"converact-rsipstack-wire-replay-v1\",\"schema_version\":\"1.0.0\",\"wire_sha256\":\"{wire_sha256}\",\"wire_length_bytes\":{wire_length},\"parse_status\":\"accept\",\"message_kind\":\"{message_kind}\",\"method_or_status\":\"{method_or_status}\",\"request_uri_sha256\":{request_uri},\"header_names\":{header_names},\"header_value_sha256\":{header_value_sha256},\"body_length_bytes\":{},\"body_sha256\":\"{body_sha256}\",\"reserialized_sha256\":\"{reserialized_sha256}\",\"parser_error_class\":null}}",
        body.len(),
    );
}

fn print_rejected(wire_sha256: &str, wire_length: usize) {
    println!(
        "{{\"schema_id\":\"converact-rsipstack-wire-replay-v1\",\"schema_version\":\"1.0.0\",\"wire_sha256\":\"{wire_sha256}\",\"wire_length_bytes\":{wire_length},\"parse_status\":\"reject\",\"message_kind\":null,\"method_or_status\":null,\"request_uri_sha256\":null,\"header_names\":[],\"header_value_sha256\":[],\"body_length_bytes\":null,\"body_sha256\":null,\"reserialized_sha256\":null,\"parser_error_class\":\"parse_error\"}}"
    );
}

fn json_array(values: impl Iterator<Item = String>) -> String {
    let mut output = String::from("[");
    for (index, value) in values.enumerate() {
        if index > 0 {
            output.push(',');
        }
        write!(output, "\"{value}\"").expect("writing to String cannot fail");
    }
    output.push(']');
    output
}

fn hex_digest(digest: impl AsRef<[u8]>) -> String {
    let bytes = digest.as_ref();
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(output, "{byte:02x}").expect("writing to String cannot fail");
    }
    output
}
