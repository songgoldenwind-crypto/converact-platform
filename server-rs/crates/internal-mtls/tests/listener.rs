use std::{sync::Arc, time::Duration};

use axum::serve::Listener;
use converact_internal_mtls::{
    InternalMtlsListener, InternalMtlsListenerPolicy, InternalMtlsListenerPolicyError,
    InternalMtlsServerConfig, MtlsMaterialPolicy,
};
use converact_tenant_auth::SpiffeTrustDomain;
use rcgen::{
    BasicConstraints, CertificateParams, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
    KeyUsagePurpose, SanType, string::Ia5String,
};
use rustls::{
    ClientConfig, RootCertStore,
    pki_types::{CertificateDer, PrivateKeyDer, ServerName},
};
use tokio::{io::AsyncWriteExt, net::TcpStream, task::JoinHandle, time};
use tokio_rustls::TlsConnector;

const TRUST_DOMAIN: &str = "identity.converact.test";
const VALID_SPIFFE_ID: &str =
    "spiffe://identity.converact.test/cells/cell-a/fault-domains/az-1/nodes/node-1";
const TLS12_ONLY: [&rustls::SupportedProtocolVersion; 1] = [&rustls::version::TLS12];
const TLS13_ONLY: [&rustls::SupportedProtocolVersion; 1] = [&rustls::version::TLS13];
const DEFAULT_VERSIONS: [&rustls::SupportedProtocolVersion; 2] =
    [&rustls::version::TLS13, &rustls::version::TLS12];

#[test]
fn listener_policy_rejects_unbounded_capacity_and_deadlines() {
    for (capacity, timeout) in [
        (0, Duration::from_millis(100)),
        (257, Duration::from_millis(100)),
        (1, Duration::from_millis(99)),
        (1, Duration::from_millis(10_001)),
    ] {
        assert_eq!(
            InternalMtlsListenerPolicy::new(capacity, timeout).unwrap_err(),
            InternalMtlsListenerPolicyError::Invalid
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn valid_tls12_and_tls13_clients_expose_the_exact_peer_identity() {
    let material = material();

    for versions in [&TLS12_ONLY[..], &TLS13_ONLY[..]] {
        let (address, _stats, accepted) = spawn_accept(
            &material,
            InternalMtlsListenerPolicy::new(4, Duration::from_secs(1)).unwrap(),
        )
        .await;

        assert!(
            handshake(
                address,
                client_config(&material, Some(&material.valid_client), versions),
            )
            .await
            .is_ok()
        );
        let info = accepted.await.unwrap();
        assert!(!format!("{info:?}").contains(VALID_SPIFFE_ID));
        assert_eq!(info.peer_identity().spiffe_id(), VALID_SPIFFE_ID);
        assert_eq!(info.peer_identity().cell_id(), "cell-a");
        assert_eq!(info.peer_identity().fault_domain(), "az-1");
        assert_eq!(info.peer_identity().node_id(), "node-1");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn absent_and_wrong_ca_clients_fail_without_poisoning_a_valid_handshake() {
    let material = material();
    let (address, stats, accepted) = spawn_accept(
        &material,
        InternalMtlsListenerPolicy::new(4, Duration::from_secs(1)).unwrap(),
    )
    .await;

    let _ = handshake(address, client_config(&material, None, default_versions())).await;
    wait_for(|| stats.failed_handshakes() == 1).await;
    let _ = handshake(
        address,
        client_config(
            &material,
            Some(&material.untrusted_client),
            default_versions(),
        ),
    )
    .await;
    wait_for(|| stats.failed_handshakes() == 2).await;
    let _ = handshake(
        address,
        client_config(
            &material,
            Some(&material.invalid_identity_client),
            default_versions(),
        ),
    )
    .await;
    wait_for(|| stats.failed_handshakes() == 3).await;
    let legacy = async {
        let mut socket = TcpStream::connect(address).await.unwrap();
        socket.write_all(&tls11_client_hello()).await.unwrap();
    };
    let valid = handshake(
        address,
        client_config(&material, Some(&material.valid_client), default_versions()),
    );
    let ((), valid_result) = tokio::join!(legacy, valid);
    wait_for(|| stats.failed_handshakes() == 4).await;
    assert_eq!(stats.timed_out_handshakes(), 0);
    assert!(valid_result.is_ok());
    assert_eq!(accepted.await.unwrap().peer_identity().node_id(), "node-1");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stalled_handshakes_never_exceed_capacity_and_a_later_client_recovers() {
    let material = material();
    let (address, stats, accepted) = spawn_accept(
        &material,
        InternalMtlsListenerPolicy::new(2, Duration::from_millis(100)).unwrap(),
    )
    .await;
    let mut stalled = Vec::new();
    for _ in 0..4 {
        stalled.push(TcpStream::connect(address).await.unwrap());
    }
    wait_for(|| stats.maximum_in_flight_handshakes() == 2).await;
    assert!(stats.in_flight_handshakes() <= 2);

    assert!(
        handshake(
            address,
            client_config(&material, Some(&material.valid_client), default_versions(),),
        )
        .await
        .is_ok()
    );
    assert_eq!(accepted.await.unwrap().peer_identity().cell_id(), "cell-a");
    assert_eq!(stats.maximum_in_flight_handshakes(), 2);
    assert!(stats.timed_out_handshakes() >= 2);
    drop(stalled);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_listener_cancels_an_in_flight_handshake() {
    let material = material();
    let config = server_config(&material);
    let listener = InternalMtlsListener::bind(
        "127.0.0.1:0".parse().unwrap(),
        config,
        trust_domain(),
        InternalMtlsListenerPolicy::new(1, Duration::from_secs(10)).unwrap(),
    )
    .await
    .unwrap();
    let address = Listener::local_addr(&listener).unwrap();
    let stats = listener.stats();
    let task = tokio::spawn(async move {
        let mut listener = listener;
        Listener::accept(&mut listener).await
    });
    let stalled = TcpStream::connect(address).await.unwrap();
    wait_for(|| stats.in_flight_handshakes() == 1).await;

    task.abort();
    let _ = task.await;
    wait_for(|| stats.in_flight_handshakes() == 0).await;
    drop(stalled);
}

async fn spawn_accept(
    material: &TestMaterial,
    policy: InternalMtlsListenerPolicy,
) -> (
    std::net::SocketAddr,
    converact_internal_mtls::InternalMtlsListenerStats,
    JoinHandle<converact_internal_mtls::InternalMtlsConnectionInfo>,
) {
    let listener = InternalMtlsListener::bind(
        "127.0.0.1:0".parse().unwrap(),
        server_config(material),
        trust_domain(),
        policy,
    )
    .await
    .unwrap();
    let address = Listener::local_addr(&listener).unwrap();
    let stats = listener.stats();
    let accepted = tokio::spawn(async move {
        let mut listener = listener;
        let (stream, _) = Listener::accept(&mut listener).await;
        let connection_info = stream.connection_info().clone();
        time::sleep(Duration::from_millis(100)).await;
        connection_info
    });
    (address, stats, accepted)
}

async fn handshake(address: std::net::SocketAddr, config: Arc<ClientConfig>) -> Result<(), ()> {
    let socket = TcpStream::connect(address).await.map_err(|_| ())?;
    let server_name =
        ServerName::try_from(String::from("internal.converact.test")).map_err(|_| ())?;
    time::timeout(
        Duration::from_secs(2),
        TlsConnector::from(config).connect(server_name, socket),
    )
    .await
    .map_err(|_| ())?
    .map(|_| ())
    .map_err(|_| ())
}

async fn wait_for(predicate: impl Fn() -> bool) {
    time::timeout(Duration::from_secs(2), async {
        while !predicate() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

fn server_config(material: &TestMaterial) -> InternalMtlsServerConfig {
    InternalMtlsServerConfig::from_der(
        &[
            material.server_certificate.as_slice(),
            material.ca_der.as_slice(),
        ],
        &material.server_key,
        &[material.ca_der.as_slice()],
        &[],
        &MtlsMaterialPolicy::strict(),
    )
    .unwrap()
}

fn client_config(
    material: &TestMaterial,
    identity: Option<&ClientIdentity>,
    versions: &[&'static rustls::SupportedProtocolVersion],
) -> Arc<ClientConfig> {
    let mut roots = RootCertStore::empty();
    roots
        .add(CertificateDer::from(material.ca_der.clone()))
        .unwrap();
    let builder =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_protocol_versions(versions)
            .unwrap()
            .with_root_certificates(roots);
    let mut config = match identity {
        Some(identity) => builder
            .with_client_auth_cert(
                vec![CertificateDer::from(identity.certificate.clone())],
                PrivateKeyDer::try_from(identity.key.clone()).unwrap(),
            )
            .unwrap(),
        None => builder.with_no_client_auth(),
    };
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Arc::new(config)
}

fn default_versions() -> &'static [&'static rustls::SupportedProtocolVersion] {
    &DEFAULT_VERSIONS
}

fn trust_domain() -> SpiffeTrustDomain {
    SpiffeTrustDomain::parse(TRUST_DOMAIN).unwrap()
}

fn tls11_client_hello() -> Vec<u8> {
    let mut message = vec![
        0x16, 0x03, 0x02, 0x00, 0x2d, 0x01, 0x00, 0x00, 0x29, 0x03, 0x02,
    ];
    message.extend_from_slice(&[0; 32]);
    message.extend_from_slice(&[0x00, 0x00, 0x02, 0x00, 0x2f, 0x01, 0x00]);
    message
}

struct ClientIdentity {
    certificate: Vec<u8>,
    key: Vec<u8>,
}

struct TestMaterial {
    ca_der: Vec<u8>,
    server_certificate: Vec<u8>,
    server_key: Vec<u8>,
    valid_client: ClientIdentity,
    untrusted_client: ClientIdentity,
    invalid_identity_client: ClientIdentity,
}

fn material() -> TestMaterial {
    let (ca_params, ca_key, ca_der) = certificate_authority();
    let issuer = Issuer::from_params(&ca_params, &ca_key);
    let server_key = KeyPair::generate().unwrap();
    let mut server_params =
        CertificateParams::new(vec!["internal.converact.test".to_owned()]).unwrap();
    server_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let server = server_params.signed_by(&server_key, &issuer).unwrap();
    let valid_client = client_identity(&issuer, VALID_SPIFFE_ID);
    let invalid_identity_client = client_identity(
        &issuer,
        "spiffe://other.converact.test/cells/cell-a/fault-domains/az-1/nodes/node-1",
    );

    let (untrusted_params, untrusted_key, _) = certificate_authority();
    let untrusted_issuer = Issuer::from_params(&untrusted_params, &untrusted_key);
    let untrusted_client = client_identity(&untrusted_issuer, VALID_SPIFFE_ID);

    TestMaterial {
        ca_der,
        server_certificate: server.der().to_vec(),
        server_key: server_key.serialize_der(),
        valid_client,
        untrusted_client,
        invalid_identity_client,
    }
}

fn certificate_authority() -> (CertificateParams, KeyPair, Vec<u8>) {
    let key = KeyPair::generate().unwrap();
    let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign];
    let certificate = params.self_signed(&key).unwrap();
    (params, key, certificate.der().to_vec())
}

fn client_identity(issuer: &Issuer<'_, impl rcgen::SigningKey>, spiffe_id: &str) -> ClientIdentity {
    let key = KeyPair::generate().unwrap();
    let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
    params.subject_alt_names = vec![SanType::URI(Ia5String::try_from(spiffe_id).unwrap())];
    let certificate = params.signed_by(&key, issuer).unwrap();
    ClientIdentity {
        certificate: certificate.der().to_vec(),
        key: key.serialize_der(),
    }
}
