mod support;

use converact_rustpbx_rwi_adapter::{ClientError, CommandOutcome, RustPbxRwiClient};
use support::{FakeRwiServer, client_config};

#[tokio::test]
async fn endpoint_policy_rejects_credentials_wrong_path_and_public_plaintext() {
    assert!(matches!(
        client_config("ws://user:secret@127.0.0.1/rwi/v1"),
        Err(ClientError::ConfigInvalid)
    ));
    assert!(matches!(
        client_config("ws://127.0.0.1/not-rwi"),
        Err(ClientError::ConfigInvalid)
    ));
    let public_plaintext = client_config("ws://10.0.0.8/rwi/v1").unwrap();
    assert_eq!(
        RustPbxRwiClient::connect(public_plaintext)
            .await
            .unwrap_err(),
        ClientError::PlaintextRejected
    );
}

#[tokio::test]
async fn matching_action_receipt_completes_the_command() {
    let server = FakeRwiServer::success().await;
    let client = RustPbxRwiClient::connect(server.config()).await.unwrap();
    assert!(client.is_connected());
    let outcome = client
        .originate(FakeRwiServer::originate_request())
        .await
        .unwrap();

    assert!(matches!(outcome, CommandOutcome::Succeeded { .. }));
}

#[tokio::test]
async fn reader_exit_closes_readiness_without_waiting_for_a_command() {
    let server = FakeRwiServer::success().await;
    let client = RustPbxRwiClient::connect(server.config()).await.unwrap();
    drop(server);

    tokio::time::timeout(std::time::Duration::from_millis(100), async {
        while client.is_connected() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("reader exit must close readiness");
}

#[tokio::test]
async fn timeout_is_uncertain_and_not_safe_to_replay() {
    let server = FakeRwiServer::without_receipt().await;
    let config = server.config().with_command_timeout_ms(25).unwrap();
    let client = RustPbxRwiClient::connect(config).await.unwrap();
    let outcome = client
        .originate(FakeRwiServer::originate_request())
        .await
        .unwrap();

    assert!(matches!(outcome, CommandOutcome::Uncertain { .. }));
    assert_eq!(server.action_count(), 1);
}
