const MANIFEST: &str = include_str!("../Cargo.toml");

#[test]
fn pure_contract_has_no_runtime_transport_or_storage_dependency() {
    for forbidden in [
        "async-nats",
        "axum",
        "deadpool",
        "nats",
        "reqwest",
        "sqlx",
        "tokio",
        "tokio-postgres",
        "tonic",
    ] {
        assert!(
            !MANIFEST.contains(forbidden),
            "pure outbox contract must not depend on {forbidden}"
        );
    }
}
