use std::{sync::Arc, time::Duration};

use axum::serve::Listener;
use converact_internal_mtls::{
    InternalMtlsConfigCandidate, InternalMtlsConfigFingerprint, InternalMtlsConfigPublishOutcome,
    InternalMtlsConfigSlot, InternalMtlsListener, InternalMtlsListenerPolicy,
    InternalMtlsServerConfig, MtlsMaterialError, MtlsMaterialPolicy,
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
use tokio::{net::TcpStream, time};
use tokio_rustls::TlsConnector;

const TRUST_DOMAIN: &str = "identity.converact.test";
const SERVER_NAME: &str = "internal.converact.test";
const CLIENT_SPIFFE_ID: &str =
    "spiffe://identity.converact.test/cells/cell-a/fault-domains/az-1/nodes/node-1";

#[test]
fn slot_is_idempotent_retains_valid_state_and_increments_checked_revision() {
    let material = TestMaterial::new();
    let slot = InternalMtlsConfigSlot::new(candidate(material.server_config(0), fingerprint(1)));

    assert_eq!(slot.current_revision(), 1);
    assert_eq!(
        slot.publish(candidate(material.server_config(1), fingerprint(1)))
            .unwrap(),
        InternalMtlsConfigPublishOutcome::Unchanged { revision: 1 }
    );
    assert_eq!(slot.current_revision(), 1);

    assert_eq!(
        InternalMtlsServerConfig::from_der(
            &[material.servers[1].certificate.as_slice()],
            &[1],
            &[material.ca_der.as_slice()],
            &[],
            &MtlsMaterialPolicy::strict(),
        )
        .unwrap_err(),
        MtlsMaterialError::PrivateKeyInvalid
    );
    assert_eq!(slot.current_revision(), 1);

    assert_eq!(
        slot.publish(candidate(material.server_config(1), fingerprint(2)))
            .unwrap(),
        InternalMtlsConfigPublishOutcome::Published { revision: 2 }
    );
    assert_eq!(slot.current_revision(), 2);
    assert_eq!(format!("{slot:?}"), "InternalMtlsConfigSlot([REDACTED])");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accepted_socket_keeps_old_generation_while_later_socket_uses_new_generation() {
    let material = TestMaterial::new();
    let slot = InternalMtlsConfigSlot::new(candidate(material.server_config(0), fingerprint(1)));
    let listener = InternalMtlsListener::bind_with_config_slot(
        "127.0.0.1:0".parse().unwrap(),
        &slot,
        trust_domain(),
        InternalMtlsListenerPolicy::new(2, Duration::from_secs(2)).unwrap(),
    )
    .await
    .unwrap();
    let address = Listener::local_addr(&listener).unwrap();
    let stats = listener.stats();
    let accepted = tokio::spawn(async move {
        let mut listener = listener;
        for _ in 0..2 {
            let _ = Listener::accept(&mut listener).await;
        }
    });

    let old_socket = TcpStream::connect(address).await.unwrap();
    wait_for(|| stats.in_flight_handshakes() == 1).await;
    assert_eq!(
        slot.publish(candidate(material.server_config(1), fingerprint(2)))
            .unwrap(),
        InternalMtlsConfigPublishOutcome::Published { revision: 2 }
    );

    let old_certificate = handshake_socket(old_socket, material.client_config())
        .await
        .unwrap();
    let new_certificate = handshake_address(address, material.client_config())
        .await
        .unwrap();

    assert_eq!(old_certificate, material.servers[0].certificate);
    assert_eq!(new_certificate, material.servers[1].certificate);
    accepted.await.unwrap();
}

fn candidate(
    config: InternalMtlsServerConfig,
    fingerprint: InternalMtlsConfigFingerprint,
) -> InternalMtlsConfigCandidate {
    InternalMtlsConfigCandidate::new(config, fingerprint)
}

fn fingerprint(marker: u8) -> InternalMtlsConfigFingerprint {
    InternalMtlsConfigFingerprint::from_sha256([marker; 32])
}

async fn handshake_address(
    address: std::net::SocketAddr,
    config: Arc<ClientConfig>,
) -> Result<Vec<u8>, ()> {
    let socket = TcpStream::connect(address).await.map_err(|_| ())?;
    handshake_socket(socket, config).await
}

async fn handshake_socket(socket: TcpStream, config: Arc<ClientConfig>) -> Result<Vec<u8>, ()> {
    let server_name = ServerName::try_from(SERVER_NAME.to_owned()).map_err(|_| ())?;
    let stream = time::timeout(
        Duration::from_secs(2),
        TlsConnector::from(config).connect(server_name, socket),
    )
    .await
    .map_err(|_| ())?
    .map_err(|_| ())?;
    stream
        .get_ref()
        .1
        .peer_certificates()
        .and_then(|certificates| certificates.first())
        .map(|certificate| certificate.as_ref().to_vec())
        .ok_or(())
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

fn trust_domain() -> SpiffeTrustDomain {
    SpiffeTrustDomain::parse(TRUST_DOMAIN).unwrap()
}

struct ServerIdentity {
    certificate: Vec<u8>,
    key: Vec<u8>,
}

struct TestMaterial {
    ca_der: Vec<u8>,
    servers: [ServerIdentity; 2],
    client: ServerIdentity,
}

impl TestMaterial {
    fn new() -> Self {
        let ca_key = KeyPair::generate().unwrap();
        let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
        ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        ca_params.key_usages = vec![KeyUsagePurpose::KeyCertSign];
        let ca = ca_params.self_signed(&ca_key).unwrap();
        let issuer = Issuer::from_params(&ca_params, &ca_key);
        let servers = [server_identity(&issuer), server_identity(&issuer)];
        let client = client_identity(&issuer);
        Self {
            ca_der: ca.der().to_vec(),
            servers,
            client,
        }
    }

    fn server_config(&self, index: usize) -> InternalMtlsServerConfig {
        InternalMtlsServerConfig::from_der(
            &[
                self.servers[index].certificate.as_slice(),
                self.ca_der.as_slice(),
            ],
            &self.servers[index].key,
            &[self.ca_der.as_slice()],
            &[],
            &MtlsMaterialPolicy::strict(),
        )
        .unwrap()
    }

    fn client_config(&self) -> Arc<ClientConfig> {
        let mut roots = RootCertStore::empty();
        roots
            .add(CertificateDer::from(self.ca_der.clone()))
            .unwrap();
        let config =
            ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
                .unwrap()
                .with_root_certificates(roots)
                .with_client_auth_cert(
                    vec![CertificateDer::from(self.client.certificate.clone())],
                    PrivateKeyDer::try_from(self.client.key.clone()).unwrap(),
                )
                .unwrap();
        Arc::new(config)
    }
}

fn server_identity(issuer: &Issuer<'_, impl rcgen::SigningKey>) -> ServerIdentity {
    let key = KeyPair::generate().unwrap();
    let mut params = CertificateParams::new(vec![SERVER_NAME.to_owned()]).unwrap();
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let certificate = params.signed_by(&key, issuer).unwrap();
    ServerIdentity {
        certificate: certificate.der().to_vec(),
        key: key.serialize_der(),
    }
}

fn client_identity(issuer: &Issuer<'_, impl rcgen::SigningKey>) -> ServerIdentity {
    let key = KeyPair::generate().unwrap();
    let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
    params.subject_alt_names = vec![SanType::URI(Ia5String::try_from(CLIENT_SPIFFE_ID).unwrap())];
    let certificate = params.signed_by(&key, issuer).unwrap();
    ServerIdentity {
        certificate: certificate.der().to_vec(),
        key: key.serialize_der(),
    }
}
