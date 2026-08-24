use std::{future::pending, sync::Arc, time::Duration};

use axum::{Router, extract::ConnectInfo, routing::get, serve::Listener};
use converact_api::serve_with_listener_runtime;
use converact_internal_mtls::{
    InternalMtlsConnectionInfo, InternalMtlsListener, InternalMtlsListenerPolicy,
    InternalMtlsServerConfig, MtlsMaterialPolicy,
};
use converact_runtime_health::{HealthTaskGroup, TaskShutdown};
use converact_tenant_auth::SpiffeTrustDomain;
use rcgen::{
    BasicConstraints, CertificateParams, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
    KeyUsagePurpose, SanType, string::Ia5String,
};
use rustls::{
    ClientConfig, RootCertStore,
    pki_types::{CertificateDer, PrivateKeyDer, ServerName},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::oneshot,
    time::timeout,
};
use tokio_rustls::TlsConnector;

const TRUST_DOMAIN: &str = "identity.converact.test";
const VALID_SPIFFE_ID: &str =
    "spiffe://identity.converact.test/cells/cell-a/fault-domains/az-1/nodes/node-1";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shared_runtime_serves_only_the_verified_mtls_connect_info_and_drains() {
    let material = material();
    let listener = InternalMtlsListener::bind(
        "127.0.0.1:0".parse().unwrap(),
        server_config(&material),
        SpiffeTrustDomain::parse(TRUST_DOMAIN).unwrap(),
        InternalMtlsListenerPolicy::default(),
    )
    .await
    .unwrap();
    let address = Listener::local_addr(&listener).unwrap();
    let app = Router::new().route("/identity", get(identity));
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let mut tasks = HealthTaskGroup::new(1).unwrap();
    tasks
        .spawn(|_| async move { pending::<()>().await })
        .unwrap();
    let task = tokio::spawn(serve_with_listener_runtime(
        listener,
        app.into_make_service_with_connect_info::<InternalMtlsConnectionInfo>(),
        tasks,
        async move {
            let _ = shutdown_rx.await;
        },
        Duration::from_millis(25),
    ));

    let socket = TcpStream::connect(address).await.unwrap();
    let server_name = ServerName::try_from(String::from("internal.converact.test")).unwrap();
    let mut tls = TlsConnector::from(client_config(&material))
        .connect(server_name, socket)
        .await
        .unwrap();
    tls.write_all(
        b"GET /identity HTTP/1.1\r\nHost: internal.converact.test\r\nConnection: close\r\n\r\n",
    )
    .await
    .unwrap();
    let mut response = Vec::new();
    timeout(Duration::from_secs(2), tls.read_to_end(&mut response))
        .await
        .unwrap()
        .unwrap();

    assert!(String::from_utf8(response).unwrap().ends_with("node-1"));
    shutdown_tx.send(()).unwrap();
    assert_eq!(
        task.await.unwrap().unwrap(),
        TaskShutdown::Forced { aborted: 1 }
    );
}

async fn identity(ConnectInfo(info): ConnectInfo<InternalMtlsConnectionInfo>) -> String {
    info.peer_identity().node_id().to_owned()
}

struct TestMaterial {
    ca: Vec<u8>,
    server_certificate: Vec<u8>,
    server_key: Vec<u8>,
    client_certificate: Vec<u8>,
    client_key: Vec<u8>,
}

fn material() -> TestMaterial {
    let ca_key = KeyPair::generate().unwrap();
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.key_usages = vec![KeyUsagePurpose::KeyCertSign];
    let ca = ca_params.self_signed(&ca_key).unwrap();
    let issuer = Issuer::from_params(&ca_params, &ca_key);

    let server_key = KeyPair::generate().unwrap();
    let mut server_params =
        CertificateParams::new(vec!["internal.converact.test".to_owned()]).unwrap();
    server_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let server = server_params.signed_by(&server_key, &issuer).unwrap();

    let client_key = KeyPair::generate().unwrap();
    let mut client_params = CertificateParams::new(Vec::<String>::new()).unwrap();
    client_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
    client_params.subject_alt_names =
        vec![SanType::URI(Ia5String::try_from(VALID_SPIFFE_ID).unwrap())];
    let client = client_params.signed_by(&client_key, &issuer).unwrap();

    TestMaterial {
        ca: ca.der().to_vec(),
        server_certificate: server.der().to_vec(),
        server_key: server_key.serialize_der(),
        client_certificate: client.der().to_vec(),
        client_key: client_key.serialize_der(),
    }
}

fn server_config(material: &TestMaterial) -> InternalMtlsServerConfig {
    InternalMtlsServerConfig::from_der(
        &[
            material.server_certificate.as_slice(),
            material.ca.as_slice(),
        ],
        &material.server_key,
        &[material.ca.as_slice()],
        &[],
        &MtlsMaterialPolicy::strict(),
    )
    .unwrap()
}

fn client_config(material: &TestMaterial) -> Arc<ClientConfig> {
    let mut roots = RootCertStore::empty();
    roots
        .add(CertificateDer::from(material.ca.clone()))
        .unwrap();
    let mut config =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
            .unwrap()
            .with_root_certificates(roots)
            .with_client_auth_cert(
                vec![CertificateDer::from(material.client_certificate.clone())],
                PrivateKeyDer::try_from(material.client_key.clone()).unwrap(),
            )
            .unwrap();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Arc::new(config)
}
