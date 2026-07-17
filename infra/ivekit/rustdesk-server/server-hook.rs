use hbb_common::{
    log,
    tokio::{
        self,
        time::{interval, Duration},
    },
};
use ivekit_component_hook::{
    Authorization, AuthorizationRequest, Authorizer, Guard, Operation, Request,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    error::Error as StdError,
    fmt::{Display, Formatter},
    sync::{Arc, Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

static REGISTRY: OnceLock<Arc<RelayOwnerRegistry>> = OnceLock::new();

#[derive(Clone, Debug, Eq, PartialEq)]
struct Placement {
    interaction_id: String,
    reservation_id: String,
    owner_node_id: String,
    owner_epoch: String,
}

struct RelayOwner {
    placement: Placement,
    guard: Guard<HttpAuthorizer>,
}

struct RelayOwnerRegistry {
    enabled: bool,
    required: bool,
    node_id: String,
    component_endpoint: String,
    component_token: String,
    broker: BrokerClient,
    refresh_interval: Duration,
    owners: Mutex<HashMap<String, Arc<RelayOwner>>>,
}

#[derive(Clone)]
struct BrokerClient {
    endpoint: String,
    token: String,
    timeout_seconds: u64,
}

#[derive(Clone)]
struct HttpAuthorizer {
    endpoint: String,
    token: String,
    timeout_seconds: u64,
}

#[derive(Debug)]
struct OwnerError(String);

impl Display for OwnerError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl StdError for OwnerError {}

pub async fn claim_relay(target_id: &str, relay_uuid: &str) -> Result<(), String> {
    let registry = registry()?;
    if !registry.enabled {
        return Ok(());
    }
    let target_id = target_id.to_owned();
    let relay_uuid = relay_uuid.to_owned();
    tokio::task::spawn_blocking(
        move || match registry.broker.claim(&target_id, &relay_uuid) {
            Ok(_) => Ok(()),
            Err(error) if !registry.required && error.0 == "rustdesk_pending_binding_not_found" => {
                Ok(())
            }
            Err(error) => Err(error.to_string()),
        },
    )
    .await
    .map_err(|error| error.to_string())?
}

pub async fn open_or_assert_relay(relay_uuid: &str) -> Result<(), String> {
    let registry = registry()?;
    if !registry.enabled {
        return Ok(());
    }
    let relay_uuid = relay_uuid.to_owned();
    tokio::task::spawn_blocking(move || registry.open_or_assert(&relay_uuid))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

pub async fn close_relay(relay_uuid: &str) {
    let Ok(registry) = registry() else {
        return;
    };
    if !registry.enabled {
        return;
    }
    let relay_uuid = relay_uuid.to_owned();
    let _ = tokio::task::spawn_blocking(move || registry.close(&relay_uuid)).await;
}

pub fn assert_relay(relay_uuid: &str) -> Result<(), String> {
    let registry = registry()?;
    if !registry.enabled {
        return Ok(());
    }
    let owner = registry
        .owner(relay_uuid)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "rustdesk_relay_owner_missing".to_owned())?;
    owner
        .guard
        .assert_current(now_unix_ms())
        .map_err(|error| error.to_string())
}

pub fn start_relay_owner_refresh() -> Result<(), String> {
    let registry = registry()?;
    if !registry.enabled {
        return Ok(());
    }
    tokio::spawn(async move {
        let mut ticker = interval(registry.refresh_interval);
        loop {
            ticker.tick().await;
            let current = registry.clone();
            if let Ok(lost) = tokio::task::spawn_blocking(move || current.refresh()).await {
                for relay_uuid in lost {
                    log::warn!(
                        "ivekit RustDesk relay owner lost: relay_uuid={}",
                        relay_uuid
                    );
                }
            }
        }
    });
    Ok(())
}

fn registry() -> Result<Arc<RelayOwnerRegistry>, String> {
    if let Some(registry) = REGISTRY.get() {
        return Ok(registry.clone());
    }
    let registry = Arc::new(RelayOwnerRegistry::from_env()?);
    let _ = REGISTRY.set(registry);
    Ok(REGISTRY
        .get()
        .expect("ivekit RustDesk owner registry")
        .clone())
}

impl RelayOwnerRegistry {
    fn from_env() -> Result<Self, String> {
        let required = bool_env("IVEKIT_OWNER_GUARD_REQUIRED")?;
        let node_id = env("IVEKIT_COMPONENT_NODE_ID");
        let component_endpoint = env("IVEKIT_COMPONENT_NODE_ENDPOINT");
        let component_token = env("IVEKIT_COMPONENT_NODE_TOKEN");
        let broker_endpoint = env("IVEKIT_RUSTDESK_OWNER_BINDING_ENDPOINT");
        let broker_token = env("IVEKIT_RUSTDESK_OWNER_BINDING_TOKEN");
        let configuration = [
            &node_id,
            &component_endpoint,
            &component_token,
            &broker_endpoint,
            &broker_token,
        ];
        let enabled = required || configuration.iter().any(|value| !value.is_empty());
        if enabled && configuration.iter().any(|value| value.is_empty()) {
            return Err("ivekit RustDesk owner guard configuration is incomplete".to_owned());
        }
        let timeout_ms = integer_env("IVEKIT_OWNER_REFRESH_TIMEOUT_MS", 1_000, 100, 30_000)?;
        let refresh_ms = integer_env("IVEKIT_OWNER_REFRESH_INTERVAL_MS", 3_000, 100, 60_000)?;
        Ok(Self {
            enabled,
            required,
            node_id,
            component_endpoint,
            component_token,
            broker: BrokerClient {
                endpoint: broker_endpoint,
                token: broker_token,
                timeout_seconds: (timeout_ms + 999) / 1_000,
            },
            refresh_interval: Duration::from_millis(refresh_ms),
            owners: Mutex::new(HashMap::new()),
        })
    }

    fn open_or_assert(&self, relay_uuid: &str) -> Result<(), OwnerError> {
        if let Some(owner) = self.owner(relay_uuid)? {
            return owner
                .guard
                .assert_current(now_unix_ms())
                .map_err(owner_error);
        }
        let placement = match self.broker.resolve(relay_uuid) {
            Ok(value) => value,
            Err(error) if !self.required && error.0 == "rustdesk_relay_binding_not_found" => {
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        if placement.owner_node_id != self.node_id {
            return Err(OwnerError("rustdesk_owner_node_mismatch".to_owned()));
        }
        let authorizer = HttpAuthorizer {
            endpoint: self.component_endpoint.clone(),
            token: self.component_token.clone(),
            timeout_seconds: self.broker.timeout_seconds,
        };
        let guard = Guard::new(authorizer);
        guard
            .open(
                Request {
                    reservation_id: placement.reservation_id.clone(),
                    interaction_id: placement.interaction_id.clone(),
                    owner_epoch: placement.owner_epoch.clone(),
                },
                now_unix_ms(),
            )
            .map_err(owner_error)?;
        let snapshot = guard.snapshot().map_err(owner_error)?;
        if snapshot.component != "rustdesk" || snapshot.node_id != self.node_id {
            return Err(OwnerError(
                "rustdesk_owner_authorization_mismatch".to_owned(),
            ));
        }
        let owner = Arc::new(RelayOwner { placement, guard });
        let mut owners = self
            .owners
            .lock()
            .map_err(|_| OwnerError("rustdesk_owner_registry_poisoned".to_owned()))?;
        if let Some(existing) = owners.get(relay_uuid) {
            return existing
                .guard
                .assert_current(now_unix_ms())
                .map_err(owner_error);
        }
        owners.insert(relay_uuid.to_owned(), owner);
        Ok(())
    }

    fn refresh(&self) -> Vec<String> {
        let owners = match self.owners.lock() {
            Ok(owners) => owners
                .iter()
                .map(|(relay_uuid, owner)| (relay_uuid.clone(), owner.clone()))
                .collect::<Vec<_>>(),
            Err(_) => return Vec::new(),
        };
        let mut lost = Vec::new();
        for (relay_uuid, owner) in owners {
            if owner.guard.refresh(now_unix_ms()).is_err() {
                lost.push(relay_uuid);
            }
        }
        lost
    }

    fn close(&self, relay_uuid: &str) -> Result<(), OwnerError> {
        let owner = self
            .owners
            .lock()
            .map_err(|_| OwnerError("rustdesk_owner_registry_poisoned".to_owned()))?
            .remove(relay_uuid);
        if let Some(owner) = owner {
            owner.guard.close().map_err(owner_error)?;
        }
        self.broker.close(relay_uuid)?;
        Ok(())
    }

    fn owner(&self, relay_uuid: &str) -> Result<Option<Arc<RelayOwner>>, OwnerError> {
        self.owners
            .lock()
            .map(|owners| owners.get(relay_uuid).cloned())
            .map_err(|_| OwnerError("rustdesk_owner_registry_poisoned".to_owned()))
    }
}

impl BrokerClient {
    fn claim(&self, target_id: &str, relay_uuid: &str) -> Result<Placement, OwnerError> {
        self.request(
            "/v1/bindings/claim",
            json!({ "target_id": target_id, "relay_uuid": relay_uuid }),
        )
    }

    fn resolve(&self, relay_uuid: &str) -> Result<Placement, OwnerError> {
        self.request("/v1/relays/resolve", json!({ "relay_uuid": relay_uuid }))
    }

    fn close(&self, relay_uuid: &str) -> Result<(), OwnerError> {
        let _: Value = post_json(
            &self.endpoint,
            "/v1/relays/close",
            &self.token,
            self.timeout_seconds,
            json!({ "relay_uuid": relay_uuid }),
        )?;
        Ok(())
    }

    fn request(&self, path: &str, body: Value) -> Result<Placement, OwnerError> {
        let value = post_json(
            &self.endpoint,
            path,
            &self.token,
            self.timeout_seconds,
            body,
        )?;
        Ok(Placement {
            interaction_id: string_field(&value, "interaction_id")?,
            reservation_id: string_field(&value, "reservation_id")?,
            owner_node_id: string_field(&value, "owner_node_id")?,
            owner_epoch: string_field(&value, "owner_epoch")?,
        })
    }
}

impl Authorizer for HttpAuthorizer {
    fn authorize(
        &self,
        request: AuthorizationRequest,
    ) -> Result<Authorization, Box<dyn StdError + Send + Sync>> {
        let operation = match request.operation {
            Operation::Open => "open",
            Operation::Mutate => "mutate",
            Operation::Close => "close",
        };
        let value = post_json(
            &self.endpoint,
            "/v1/authorize",
            &self.token,
            self.timeout_seconds,
            json!({
                "reservation_id": request.request.reservation_id,
                "interaction_id": request.request.interaction_id,
                "owner_epoch": request.request.owner_epoch,
                "operation": operation,
            }),
        )?;
        Ok(Authorization {
            allowed: bool_field(&value, "allowed")?,
            component: string_field(&value, "component")?,
            node_id: string_field(&value, "node_id")?,
            cell_lease_epoch: u64_field(&value, "cell_lease_epoch")?,
            owner_epoch: string_field(&value, "owner_epoch")?,
            state_sequence: u64_field(&value, "state_sequence")?,
            lease_expires_unix_ms: u64_field(&value, "lease_expires_unix_ms")?,
        })
    }
}

fn post_json(
    endpoint: &str,
    path: &str,
    token: &str,
    timeout_seconds: u64,
    body: Value,
) -> Result<Value, OwnerError> {
    let authorization = format!("Bearer {token}");
    let response = minreq::post(format!("{}{}", endpoint.trim_end_matches('/'), path))
        .with_header("Authorization", authorization.as_str())
        .with_header("Content-Type", "application/json")
        .with_timeout(timeout_seconds)
        .with_body(body.to_string())
        .send()
        .map_err(|error| OwnerError(error.to_string()))?;
    let payload: Value = serde_json::from_str(
        response
            .as_str()
            .map_err(|error| OwnerError(error.to_string()))?,
    )
    .map_err(|error| OwnerError(error.to_string()))?;
    if !(200..300).contains(&response.status_code) {
        let code = payload
            .get("error")
            .and_then(|value| value.get("code"))
            .and_then(Value::as_str)
            .unwrap_or("rustdesk_owner_request_failed");
        return Err(OwnerError(code.to_owned()));
    }
    payload
        .get("data")
        .cloned()
        .ok_or_else(|| OwnerError("rustdesk_owner_response_invalid".to_owned()))
}

fn string_field(value: &Value, field: &str) -> Result<String, OwnerError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| OwnerError("rustdesk_owner_response_invalid".to_owned()))
}

fn bool_field(value: &Value, field: &str) -> Result<bool, OwnerError> {
    value
        .get(field)
        .and_then(Value::as_bool)
        .ok_or_else(|| OwnerError("rustdesk_owner_response_invalid".to_owned()))
}

fn u64_field(value: &Value, field: &str) -> Result<u64, OwnerError> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .ok_or_else(|| OwnerError("rustdesk_owner_response_invalid".to_owned()))
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_default().trim().to_owned()
}

fn bool_env(name: &str) -> Result<bool, String> {
    match env(name).to_ascii_lowercase().as_str() {
        "" | "0" | "false" | "no" => Ok(false),
        "1" | "true" | "yes" => Ok(true),
        _ => Err(format!("{name} must be boolean")),
    }
}

fn integer_env(name: &str, default: u64, minimum: u64, maximum: u64) -> Result<u64, String> {
    let value = env(name);
    let parsed = if value.is_empty() {
        default
    } else {
        value
            .parse()
            .map_err(|_| format!("{name} must be an integer"))?
    };
    if parsed < minimum || parsed > maximum {
        return Err(format!("{name} is out of range"));
    }
    Ok(parsed)
}

fn owner_error(error: ivekit_component_hook::GuardError) -> OwnerError {
    OwnerError(error.to_string())
}
