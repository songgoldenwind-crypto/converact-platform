use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    sync::atomic::{AtomicU64, Ordering},
};

use converact_voice_agent_worker::{
    VoiceAgentStartupError, load_rs256_platform_verifier, parse_local_database_config,
};

const RS256_FIXTURE: &str = include_str!("../../../tests/fixtures/platform-rs256-v1.json");
static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(1);

#[test]
fn owner_controlled_regular_jwks_builds_redacted_verifier() {
    let directory = test_directory();
    let path = directory.join("platform.jwks.json");
    fs::write(&path, jwks_document()).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

    let verifier =
        load_rs256_platform_verifier(&path, "converact-platform", "voice-agent-worker", 1, 0)
            .unwrap();

    assert_eq!(
        format!("{verifier:?}"),
        "Rs256PlatformTokenVerifier([REDACTED])"
    );
    fs::remove_file(path).unwrap();
    fs::remove_dir(directory).unwrap();
}

#[test]
fn symlinked_jwks_and_non_local_database_transport_fail_closed() {
    let directory = test_directory();
    let target = directory.join("target.jwks.json");
    let linked = directory.join("linked.jwks.json");
    fs::write(&target, jwks_document()).unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).unwrap();
    symlink(&target, &linked).unwrap();
    assert_eq!(
        load_rs256_platform_verifier(&linked, "converact-platform", "voice-agent-worker", 1, 0,)
            .unwrap_err(),
        VoiceAgentStartupError::PlatformJwksUnavailable
    );

    assert!(
        parse_local_database_config(
            "host=/private/tmp user=converact dbname=converact sslmode=disable"
        )
        .is_ok()
    );
    for rejected in [
        "host=127.0.0.1 user=converact dbname=converact sslmode=disable",
        "host=/private/tmp user=converact password=inline dbname=converact sslmode=disable",
        "host=/private/tmp user=converact dbname=converact sslmode=require",
    ] {
        assert_eq!(
            parse_local_database_config(rejected).unwrap_err(),
            VoiceAgentStartupError::DatabaseConfigurationInvalid
        );
    }
    fs::remove_file(linked).unwrap();
    fs::remove_file(target).unwrap();
    fs::remove_dir(directory).unwrap();
}

fn jwks_document() -> String {
    let fixture: serde_json::Value = serde_json::from_str(RS256_FIXTURE).unwrap();
    serde_json::json!({ "keys": [fixture["public_jwk"].clone()] }).to_string()
}

fn test_directory() -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "converact-voice-bootstrap-{}-{}",
        std::process::id(),
        NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&path).unwrap();
    path
}
