# Rust Internal mTLS Transport R1

| Field | Value |
| --- | --- |
| Scope | RM01 R1/R3 shared tenant/auth transport foundation |
| Current state | TypeScript dialog-shadow owns online mTLS; Rust peer mapper is offline |
| Target state | Reusable bounded Rust mTLS listener projects one verified SPIFFE peer into Axum |
| Production eligible | No |
| Runtime rollout | Forbidden in this design slice |

## 1. Decision

Create one `converact-internal-mtls` adapter crate inside the existing
`server-rs` Workspace. It terminates internal HTTPS with rustls, requires and
verifies a client certificate, extracts bounded URI SAN values from the
verified leaf certificate, and delegates workload naming to
`converact-tenant-auth::MtlsPeerIdentity`.

The crate is transport infrastructure, not an identity or authorization
Authority. It cannot grant tenant permissions, select a Cell, read business
state, route a command, publish an event or write a database. Axum handlers
receive only an immutable `Arc<MtlsPeerIdentity>` and remote socket address;
they never receive raw certificates, private keys or rustls types.

The first implementation is offline and constructed only from injected DER
material. It does not change `converact-api` main, bind a new port, read a
secret file, change deployment manifests or route traffic. Secret-file/config
loading, PKI rotation and runtime cutover remain separately evidenced slices.

## 2. Alternatives considered

### Selected: reusable bounded rustls listener

A Workspace adapter crate keeps certificate verification, DER parsing,
handshake admission and Axum connection identity in one reviewable boundary.
All future Rust server binaries can reuse it without copying TLS logic. The
domain crate remains free of runtime and certificate dependencies.

### Rejected: embed TLS directly in `converact-api`

This is smaller for one binary but would couple key material, certificate
parsing and handshake lifecycle to the health API. Each later binary would
either duplicate the implementation or depend on an application package.

### Rejected: trust identity headers from a proxy

An external TLS terminator plus identity headers introduces another signing or
socket-trust protocol and a confused-deputy boundary. It also fails to prove
that the Rust listener itself requires a verified client certificate. A proxy
may still exist at the edge, but it cannot mint internal workload identity for
this contract.

## 3. Module boundaries

```text
injected DER server chain/key + client roots
                    |
                    v
        BoundedClientCertVerifier
        rustls chain/time/EKU/signature verification
                    |
                    v
            InternalMtlsListener
      bounded concurrent handshake admission
                    |
                    v
           leaf URI SAN projection
     exact DER parse + count/byte constraints
                    |
                    v
       tenant-auth::MtlsPeerIdentity
     trust-domain + Cell/fault-domain/node grammar
                    |
                    v
       InternalMtlsConnectionInfo
        Arc identity + remote SocketAddr
                    |
                    v
               Axum handler
```

Files have one responsibility:

- `crates/internal-mtls/src/material.rs`: validate injected certificate, key,
  root and CRL material and build rustls server configuration;
- `crates/internal-mtls/src/peer_certificate.rs`: parse only the verified leaf
  DER and return a bounded `MtlsPeerIdentity`;
- `crates/internal-mtls/src/listener.rs`: own bounded handshake concurrency,
  timeout, invalid-peer rejection and Axum `Listener` integration;
- `crates/internal-mtls/src/lib.rs`: expose stable adapter types only;
- `apps/converact-api/src/lib.rs`: later add a generic listener-preserving
  server core while keeping the existing TCP wrappers byte-compatible.

`tenant-auth` remains the sole owner of SPIFFE workload-path grammar. The new
crate must not duplicate its regular expression or reconstruct its fields.

## 4. Verification and identity flow

1. The TCP listener accepts only while the configured handshake set has a
   free slot. When full, the process stops accepting and relies on the bounded
   kernel backlog rather than allocating more futures or tasks.
2. Each accepted socket receives one monotonic handshake deadline. Timeout,
   protocol error, absent client certificate and untrusted chain close only
   that connection and produce a stable value-free outcome.
3. A wrapper around rustls `WebPkiClientVerifier` rejects a chain over the
   configured certificate count, per-certificate bytes or total bytes before
   delegating cryptographic verification. Anonymous clients are never allowed.
4. After rustls reports a successful handshake, the adapter reads the verified
   peer chain. It requires one leaf and applies the same chain bounds again at
   the projection boundary.
5. The DER parser consumes the complete leaf certificate, rejects duplicate
   subjectAltName extensions and projects only URI general names. It permits at
   most 64 URI SANs and 2,048 bytes per URI. DNS, IP, email and other SAN forms
   do not become workload identities.
6. `MtlsPeerIdentity::from_tls_peer(true, ...)` requires exactly one lowercase
   `spiffe://` identity in the configured trust domain and exact
   Cell/fault-domain/node grammar.
7. The accepted connection exposes an immutable `Arc<MtlsPeerIdentity>`.
   Request handlers may clone the Arc but cannot access raw DER or key material.

The Boolean `authorized` compatibility input is not exposed by the new
listener API. Only a successfully completed rustls verifier path calls the
mapper with `true`; no HTTP header, bearer claim or request body can select it.

## 5. Bounds and failure behavior

The first contract fixes these values:

| Bound | Range/default |
| --- | --- |
| concurrent TLS handshakes | configurable `1..=256`, default `64` |
| handshake timeout | configurable `100 ms..=10 s`, default `3 s` |
| certificates in client chain | maximum `8` |
| one certificate DER | maximum `64 KiB` |
| complete client chain DER | maximum `256 KiB` |
| server certificate chain / client trust roots | maximum `8` entries, `64 KiB` each and `256 KiB` total |
| server private key DER | maximum `64 KiB` |
| client CRLs | maximum `8` entries, `256 KiB` each and `1 MiB` total |
| URI SAN entries | maximum `64` |
| one URI SAN | maximum `2,048` bytes |

The listener owns one bounded `JoinSet` containing handshake-only tasks. It
never spawns beyond the configured limit. Dropping the listener aborts the set;
handshake tasks hold no business state or durable side effect. Established HTTP
connections remain owned and drained by the existing Axum server lifecycle.

Accept failures use the existing Axum policy: connection-reset/refused/aborted
errors retry without a delay, while resource/system errors wait one second.
Handshake failures do not create an immediate reconnect task or retry loop.

Public errors and logs contain only stable categories such as
`internal_mtls_handshake_timeout`, `internal_mtls_peer_untrusted`,
`internal_mtls_peer_certificate_invalid` and
`internal_mtls_peer_identity_invalid`. Certificate bytes, SAN values, trust
roots, private keys and remote-provided text never enter Debug or Display.

## 6. Cryptography and supply chain

- rustls `0.23.43` with the existing ring provider remains the TLS and
  certificate-chain verifier;
- tokio-rustls `0.26.4` with default features disabled and only `ring` plus
  `tls12` enabled provides asynchronous server handshakes without AWS-LC;
- RustCrypto x509-cert `0.3.0` with default features disabled parses the
  verified leaf certificate only and does not perform a second signature
  verification;
- rcgen `0.14.8` is test-only and generates isolated CA/server/client material
  in memory.

All versions are exact-pinned. The dependency delta, archive checksums,
licenses, advisories, build scripts, native source and unsafe boundaries must
be recorded before implementation evidence is promoted. Workspace-owned code
continues to forbid unsafe code. No OpenSSL library or C/C++ TLS binding is
introduced.

The server configuration uses TLS 1.2 and 1.3, fixes ALPN to `h2` and
`http/1.1`, requires client authentication, and accepts injected CRLs. Session
storage and TLS 1.3 tickets are disabled in this first contract so trust or CRL
rotation cannot inherit an earlier authenticated session. This slice does not
claim revocation completeness until a later runtime config requires a current
CRL or an approved short-lived SPIFFE certificate policy.

## 7. HTTP lifecycle integration

The existing `serve` and `serve_runtime` TCP entrypoints remain available and
their tests remain unchanged. A generic internal server core accepts any Axum
`Listener` and make-service pair. The mTLS path passes
`Router::into_make_service_with_connect_info::<InternalMtlsConnectionInfo>()`;
the ordinary TCP compatibility wrappers continue passing the Router directly.

Graceful shutdown has one deadline for HTTP drain and runtime child tasks, as
today. The mTLS listener adds no independent process supervisor and no second
shutdown clock. Connections still handshaking are abortable and have no
business effect; established HTTP requests use the existing drain path.

## 8. Test and evidence contract

Tests are local loopback functional tests, not load or production evidence.
They must prove:

- valid CA/server/client material completes TLS and exposes the exact SPIFFE
  Cell/fault-domain/node identity to an Axum handler;
- no client certificate, wrong CA, wrong EKU, expired/not-yet-valid material,
  wrong trust domain, missing/two SPIFFE URIs, duplicate SAN extension,
  malformed DER and oversized projection fail closed before the handler;
- a stalled TCP client is closed at the monotonic handshake deadline;
- handshake admission never exceeds the configured capacity;
- one failed handshake does not affect a simultaneous valid connection;
- listener drop cancels outstanding handshake tasks;
- existing plain TCP health and shutdown tests still pass;
- Debug/Display and structural scans disclose no key, certificate or SAN data.

Anything not directly run remains `not_run`, including physical PKI, mounted
secret loading, root/CRL rotation, fleet fault recovery, runtime routing,
shadow comparison, drain/active-zero, target-host validation, performance and
production eligibility.

## 9. Rollout sequence

1. Add and review the offline parser/config/listener crate with generated
   certificates and no application wiring.
2. Generalize the existing API serve core without changing the TCP wrappers.
3. Add bounded file/secret loading and readiness in a separate slice.
4. Add an internal mTLS-only route in shadow mode with no authoritative side
   effects.
5. Prove rotation, failure, rolling compatibility and exact status behavior.
6. Route new internal work, drain old TypeScript connections, prove
   active-zero and only then delete the legacy listener.

No step may create durable dual-write or make Human Communication depend on
this migration before its route commits.
