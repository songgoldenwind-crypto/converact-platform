# Rust Internal mTLS Transport R1 Implementation Plan

**Goal:** Add an offline, bounded Rust mTLS listener that exposes exactly one
verified SPIFFE workload identity to Axum without changing any online route.

**Architecture:** A new `converact-internal-mtls` adapter crate composes rustls
client-certificate verification, bounded leaf DER URI-SAN projection and the
existing `MtlsPeerIdentity` domain mapper. A fixed-capacity handshake set
prevents unbounded work; a generic API serve core preserves the current HTTP
drain behavior for both TCP and future mTLS listeners.

**Tech stack:** Rust 1.94.1, Tokio 1.53.1, Axum 0.8.9, rustls 0.23.43,
tokio-rustls 0.26.4, RustCrypto x509-cert 0.3.0, rcgen 0.14.8 for tests only.

---

## File map

- Create `server-rs/crates/internal-mtls/Cargo.toml`: one adapter package with
  exact Workspace dependencies.
- Create `server-rs/crates/internal-mtls/src/lib.rs`: stable exports and closed
  public error taxonomy.
- Create `server-rs/crates/internal-mtls/src/peer_certificate.rs`: bounded
  verified-leaf DER to `MtlsPeerIdentity` projection.
- Create `server-rs/crates/internal-mtls/src/material.rs`: bounded verifier and
  rustls server configuration from injected DER material.
- Create `server-rs/crates/internal-mtls/src/listener.rs`: bounded concurrent
  handshake listener and connection info.
- Create `server-rs/crates/internal-mtls/tests/peer_certificate.rs`: parser and
  identity tests generated from isolated in-memory certificates.
- Create `server-rs/crates/internal-mtls/tests/material.rs`: chain, purpose,
  bound and redaction tests.
- Create `server-rs/crates/internal-mtls/tests/listener.rs`: loopback TLS,
  timeout, capacity, isolation and cancellation tests.
- Modify `server-rs/Cargo.toml`: add the package and exact dependency pins.
- Modify `server-rs/Cargo.lock`: lock only the reviewed exact dependency tree.
- Modify `server-rs/apps/converact-api/src/lib.rs`: extract a generic serve core
  while preserving the public TCP functions.
- Modify `server-rs/apps/converact-api/tests/runtime.rs`: prove the old TCP
  lifecycle and new generic listener share the exact shutdown behavior.
- Create
  `architecture-foundation/rust-migration/evidence/r1-internal-mtls-transport/`:
  exact TDD, dependency, source and verification evidence.

### Task 1: Freeze dependency and public-boundary RED tests

- [x] Add `crates/internal-mtls` as an empty Workspace member and exact-pin
  `tokio-rustls = { version = "=0.26.4", default-features = false, features = ["ring", "tls12"] }`,
  `x509-cert = { version = "=0.3.0", default-features = false }` and
  test-only `rcgen = "=0.14.8"` in Workspace dependencies.
- [x] Write `tests/peer_certificate.rs` importing
  `peer_identity_from_verified_leaf_der`, `MtlsCertificatePolicy` and the
  stable error enum before those exports exist.
- [x] Generate in-memory client certificates containing URI, DNS and duplicate
  URI SAN values; assert exact allowed/rejected outcomes and value-free error
  strings.
- [x] Run
  `cargo test -p converact-internal-mtls --test peer_certificate --locked` and
  record the compile failure caused by the missing public types.
- [x] Inspect all newly resolved archives, licenses, advisories, build scripts,
  native source and unsafe occurrences; stop if the selected dependency tree
  introduces an unreviewed native/FFI boundary.

### Task 2: Implement bounded verified-leaf projection

- [x] Implement `MtlsCertificatePolicy::strict` with the fixed verified-leaf,
  URI count and URI byte bounds from the design. Chain bounds belong to the
  material/verifier policy in Task 3.
- [x] Parse the complete DER input with RustCrypto x509-cert, reject trailing
  bytes and anything other than one subjectAltName extension, and collect at
  most 64 URI general names without copying non-URI SANs.
- [x] Call `MtlsPeerIdentity::from_tls_peer(true, &uri_sans, trust_domain)`;
  map its value-free errors without exposing DER or URI values.
- [x] Run the focused projection test and the full `converact-tenant-auth`
  crate tests; both must pass.
- [x] Commit only the parser/package files as
  `feat(rust): project verified mTLS certificates`.

### Task 3: Build bounded rustls client-certificate verification

- [x] Write failing material tests for missing roots, empty or oversized
  chains, wrong client CA, mandatory client authentication, wrong EKU,
  expired material, valid/malformed CRL input, fixed ALPN and redacted errors.
- [x] Implement a `BoundedClientCertVerifier` wrapper that applies chain count,
  per-certificate and total-byte limits before delegating every rustls
  signature and client-certificate verification method to
  `WebPkiClientVerifier`.
- [x] Implement `InternalMtlsServerConfig::from_der` from an injected server
  chain, private key, client roots and CRLs. Require client authentication,
  TLS 1.2/1.3 and ALPN `[h2, http/1.1]`.
- [x] Run focused material tests, Clippy and rustdoc with warnings denied.
- [x] Commit only the material/verifier files as
  `feat(rust): verify bounded mTLS chains`.

### Task 4: Implement bounded concurrent handshakes

- [x] Write failing `tests/listener.rs` cases for one valid client, no client
  certificate, wrong CA, TLS 1.2/1.3 acceptance and older-version rejection,
  stalled handshake timeout, configured capacity, simultaneous failed/valid
  isolation and listener-drop cancellation.
- [x] Implement `InternalMtlsListenerPolicy` with handshake capacity
  `1..=256` and timeout `100 ms..=10 s`.
- [x] Implement an Axum `Listener` owning one bounded `JoinSet`. Accept only
  when a slot exists, apply one monotonic timeout per socket, close rejected
  connections, and return only a successfully projected identity.
- [x] Implement `InternalMtlsConnectionInfo` containing remote `SocketAddr` and
  `Arc<MtlsPeerIdentity>` for accepted connections. Raw DER and rustls types
  must remain private.
- [x] Run focused listener tests repeatedly under Tokio's multi-thread runtime
  and prove the observed in-flight count never exceeds policy.
- [x] Commit only the listener files as
  `feat(rust): accept bounded mTLS handshakes`.

### Task 5: Preserve the existing API lifecycle

- [x] Write a failing API runtime test that passes a test listener and
  make-service through a new generic `serve_with_listener_runtime` core while
  asserting the same drain deadline and child-task outcome as current TCP.
- [x] Extract the shared generic lifecycle; keep `serve` and `serve_runtime`
  signatures and behavior unchanged as TCP compatibility wrappers.
- [x] Add a test-only Axum route using
  `into_make_service_with_connect_info::<InternalMtlsConnectionInfo>()` and
  assert the exact Cell/fault-domain/node identity returned over loopback TLS.
- [x] Run all `converact-api`, `converact-internal-mtls` and active TypeScript
  dialog-shadow contract tests.
- [x] Commit only the generic lifecycle and integration tests as
  `refactor(rust): share listener shutdown lifecycle`.

### Task 6: Verify and record the offline checkpoint

- [x] Run pinned `cargo test --workspace --all-targets --locked`.
- [x] Run pinned `cargo clippy --workspace --all-targets --locked -- -D warnings`.
- [x] Run pinned `RUSTDOCFLAGS=-Dwarnings cargo doc --workspace --no-deps --locked`.
- [x] Run pinned `cargo fmt --all -- --check`.
- [x] Run Node 24 TypeScript typecheck and the active dialog-shadow/mTLS
  differential suites.
- [x] Write README, RED/GREEN log, dependency manifest, source manifest,
  verification and independent-review status under
  `evidence/r1-internal-mtls-transport/`; every physical or runtime claim stays
  `not_run`.
- [x] Parse every JSON artifact, replay every SHA-256, run `git diff --check`,
  and verify the historical G03 README remains unstaged.
- [x] Commit only the clean evidence files as
  `docs(rust): record internal mTLS transport evidence`.

## Self-review result

- Every design boundary maps to one task and an exact file.
- Online config/secret loading, route wiring, PKI rotation, rollout and
  production qualification are deliberately outside this offline checkpoint
  and remain explicit later RM01 work, not implicit completion claims.
- No task changes a running server, uses Docker, performs a load campaign,
  introduces durable dual-write or creates a second identity Authority.
