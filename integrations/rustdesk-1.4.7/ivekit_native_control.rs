#![cfg(windows)]

use hbb_common::log;
use hbb_common::tokio::{
    io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    net::windows::named_pipe::{NamedPipeServer, ServerOptions},
    runtime::Builder,
    time::{sleep, Duration},
};
use serde_derive::{Deserialize, Serialize};
use std::{ffi::c_void, io, ptr::null_mut, sync::Once};

const PIPE_PATH: &str = r"\\.\pipe\ivekit-rustdesk-native-control-v2";
const MAX_REQUEST_BYTES: usize = 16 * 1024;
const PIPE_SDDL: &str = "D:P(A;;GA;;;SY)(A;;GA;;;BA)";
static START: Once = Once::new();

#[repr(C)]
struct SecurityAttributes {
    length: u32,
    security_descriptor: *mut c_void,
    inherit_handle: i32,
}

struct LocalSecurityDescriptor(*mut c_void);

impl Drop for LocalSecurityDescriptor {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

#[link(name = "advapi32")]
extern "system" {
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
        security_descriptor: *const u16,
        revision: u32,
        descriptor: *mut *mut c_void,
        descriptor_size: *mut u32,
    ) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn LocalFree(memory: *mut c_void) -> *mut c_void;
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    schema_version: u8,
    operation: String,
    command_id: String,
    external_id: String,
    target_id: String,
    rustdesk_id: String,
    controller_rustdesk_id: String,
    reason: String,
    interaction_id: String,
    reservation_id: String,
    owner_epoch: String,
}

#[derive(Serialize)]
struct Response<'a> {
    schema_version: u8,
    command_id: &'a str,
    native_session_id: &'a str,
    interaction_id: &'a str,
    reservation_id: &'a str,
    owner_epoch: &'a str,
    status: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<&'a str>,
}

pub fn start_once() {
    START.call_once(|| {
        if let Err(error) = std::thread::Builder::new()
            .name("ivekit-native-control".to_owned())
            .spawn(|| {
                let runtime = Builder::new_current_thread().enable_all().build();
                match runtime {
                    Ok(runtime) => {
                        if let Err(error) = runtime.block_on(serve()) {
                            log::error!("iveKit native control stopped: {error}");
                        }
                    }
                    Err(error) => log::error!("iveKit native control runtime failed: {error}"),
                }
            })
        {
            log::error!("iveKit native control thread failed: {error}");
        }
    });
}

async fn serve() -> io::Result<()> {
    let mut first = true;
    loop {
        let server = create_secure_server(first)?;
        first = false;
        server.connect().await?;
        hbb_common::tokio::spawn(async move {
            if let Err(error) = handle(server).await {
                log::warn!("iveKit native control request failed: {error}");
            }
        });
    }
}

fn create_secure_server(first: bool) -> io::Result<NamedPipeServer> {
    let wide_sddl: Vec<u16> = PIPE_SDDL.encode_utf16().chain(Some(0)).collect();
    let mut raw_descriptor = null_mut();
    let converted = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide_sddl.as_ptr(),
            1,
            &mut raw_descriptor,
            null_mut(),
        )
    };
    if converted == 0 || raw_descriptor.is_null() {
        return Err(io::Error::last_os_error());
    }
    let descriptor = LocalSecurityDescriptor(raw_descriptor);
    let mut attributes = SecurityAttributes {
        length: std::mem::size_of::<SecurityAttributes>() as u32,
        security_descriptor: descriptor.0,
        inherit_handle: 0,
    };
    let mut options = ServerOptions::new();
    options
        .first_pipe_instance(first)
        .reject_remote_clients(true);
    unsafe {
        options.create_with_security_attributes_raw(
            PIPE_PATH,
            &mut attributes as *mut SecurityAttributes as *mut c_void,
        )
    }
}

async fn handle(pipe: NamedPipeServer) -> io::Result<()> {
    let (reader, mut writer) = hbb_common::tokio::io::split(pipe);
    let mut reader = BufReader::new(reader);
    let mut line = String::new();
    let bytes = reader.read_line(&mut line).await?;
    if bytes == 0 || bytes > MAX_REQUEST_BYTES {
        return write_error(&mut writer, "", "", "", "", "", "invalid_request").await;
    }
    let request: Request = match serde_json::from_str(line.trim_end()) {
        Ok(value) => value,
        Err(_) => return write_error(&mut writer, "", "", "", "", "", "invalid_request").await,
    };
    if let Err(code) = validate(&request) {
        return write_error(
            &mut writer,
            &request.command_id,
            "",
            &request.interaction_id,
            &request.reservation_id,
            &request.owner_epoch,
            code,
        )
        .await;
    }
    let native_id =
        match crate::ui_cm_interface::ivekit_resolve_connection(&request.controller_rustdesk_id) {
            Ok(value) => value,
            Err(code) => {
                return write_error(
                    &mut writer,
                    &request.command_id,
                    "",
                    &request.interaction_id,
                    &request.reservation_id,
                    &request.owner_epoch,
                    code,
                )
                .await
            }
        };
    let native_session_id = native_id.to_string();
    if !crate::ui_cm_interface::ivekit_connection_matches(
        native_id,
        &request.controller_rustdesk_id,
    ) {
        return write_error(
            &mut writer,
            &request.command_id,
            &native_session_id,
            &request.interaction_id,
            &request.reservation_id,
            &request.owner_epoch,
            "native_session_changed",
        )
        .await;
    }

    crate::ui_cm_interface::close(native_id);
    for _ in 0..50 {
        if !crate::ui_cm_interface::ivekit_connection_matches(
            native_id,
            &request.controller_rustdesk_id,
        ) {
            return write_response(
                &mut writer,
                Response {
                    schema_version: 2,
                    command_id: &request.command_id,
                    native_session_id: &native_session_id,
                    interaction_id: &request.interaction_id,
                    reservation_id: &request.reservation_id,
                    owner_epoch: &request.owner_epoch,
                    status: "disconnected",
                    error_code: None,
                },
            )
            .await;
        }
        sleep(Duration::from_millis(100)).await;
    }
    write_error(
        &mut writer,
        &request.command_id,
        &native_session_id,
        &request.interaction_id,
        &request.reservation_id,
        &request.owner_epoch,
        "disconnect_timeout",
    )
    .await
}

fn validate(request: &Request) -> Result<(), &'static str> {
    if request.schema_version != 2 || request.operation != "disconnect_session" {
        return Err("unsupported_request");
    }
    for value in [
        &request.command_id,
        &request.external_id,
        &request.target_id,
        &request.rustdesk_id,
        &request.controller_rustdesk_id,
        &request.reason,
        &request.interaction_id,
        &request.reservation_id,
        &request.owner_epoch,
    ] {
        if value.is_empty() || value.len() > 500 || value.chars().any(char::is_control) {
            return Err("invalid_request");
        }
    }
    if request
        .owner_epoch
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .is_none()
    {
        return Err("invalid_owner_epoch");
    }
    Ok(())
}

async fn write_error<W: AsyncWrite + Unpin>(
    writer: &mut W,
    command_id: &str,
    native_session_id: &str,
    interaction_id: &str,
    reservation_id: &str,
    owner_epoch: &str,
    code: &'static str,
) -> io::Result<()> {
    write_response(
        writer,
        Response {
            schema_version: 2,
            command_id,
            native_session_id,
            interaction_id,
            reservation_id,
            owner_epoch,
            status: "failed",
            error_code: Some(code),
        },
    )
    .await
}

async fn write_response<W: AsyncWrite + Unpin>(
    writer: &mut W,
    response: Response<'_>,
) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(&response).map_err(io::Error::other)?;
    bytes.push(b'\n');
    writer.write_all(&bytes).await?;
    writer.flush().await
}
