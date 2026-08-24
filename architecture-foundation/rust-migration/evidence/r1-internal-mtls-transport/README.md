# RM01 R1 — bounded internal mTLS transport evidence

## Scope and authority

This checkpoint adds an offline Rust server-side mTLS transport slice. It
loads bounded DER material, requires a verified client certificate, projects
the verified leaf to exactly one bounded SPIFFE Cell/fault-domain/node
identity, and exposes that immutable identity through Axum `ConnectInfo`.

- **Current Authority:** the TypeScript dialog-shadow mTLS endpoint remains the
  only online route. No production or development route was switched.
- **Target implementation:** `converact-internal-mtls` is compiled and tested
  but default-disabled and not constructed by an online process.
- **Runtime lifecycle:** TCP and the target mTLS listener use one generic Axum
  drain and `HealthTaskGroup` shutdown implementation; the existing public TCP
  wrappers retain their signatures.
- **Production eligibility:** false.

No running server, container, Docker daemon, deployment, database or external
port was read or changed. No load or performance campaign was run. The
historical G03 dirty evidence README remained untouched and unstaged.

## Implemented target boundary

The target Rust slice now enforces:

- TLS 1.2 or TLS 1.3 only, mandatory client authentication and fixed ALPN
  `[h2, http/1.1]`;
- the existing ring provider only, with TLS session storage and TLS 1.3 tickets
  disabled for this offline checkpoint;
- bounded server chains, private keys, client roots, CRLs, verified peer
  chains, leaf DER, URI SAN count and URI SAN bytes;
- webpki chain, time, client-auth purpose, signature and configured CRL
  verification before SPIFFE projection;
- one bounded handshake `JoinSet`, capacity `1..=256`, monotonic timeout
  `100 ms..=10 s`, failure isolation and cancellation on listener drop;
- stable value-free public failures and no public raw DER or rustls types;
- exactly one `MtlsPeerIdentity` under the configured trust domain.

The listener stops accepting new sockets while its handshake set is full. It
does not create an unbounded task, queue, registry or retry loop. Successful
request handling owns one `Arc<MtlsPeerIdentity>` projection per connection;
the trust domain and TLS server configuration are shared.

## Direct evidence

- The focused API/internal-mTLS suites pass: existing TCP lifecycle tests,
  exact DER/SAN parsing, bounded material, chain/purpose/time/revocation,
  TLS 1.2/1.3, no certificate, wrong CA, stalled capacity, failure isolation,
  listener-drop cancellation and mTLS Axum identity/drain behavior.
- The mTLS API integration route returns the verified node identity and proves
  the same forced child-task deadline outcome as the current TCP wrapper.
- The full pinned Rust Workspace/all-targets suite exits zero. Twenty existing
  physical PostgreSQL tests remain ignored under their explicit external gates.
- Workspace Clippy with `-D warnings`, rustdoc with warnings denied and the
  formatting check exit zero.
- Node 24 TypeScript typecheck exits zero. Twelve selected active mTLS and
  dialog-shadow compatibility/regression tests pass.
- All checks are local loopback or static/offline checks.

One initial TypeScript test invocation selected `/usr/bin/openssl` through an
overly restrictive PATH and failed because that system LibreSSL lacks
`-copy_extensions`. Re-running the unchanged test with the repository's
available OpenSSL 3.5.0 path passed 12/12. One later focused Cargo invocation
applied the pinned environment only to a preceding formatting command and
therefore selected Rust 1.87; the unchanged test passed immediately under the
required Rust 1.94.1 environment. Neither event was represented as a product
failure or hidden from this evidence.

## Dependency and source conclusion

The production dependency graph uses the already pinned rustls/ring stack plus
RustCrypto `x509-cert` 0.3.0 and its pure-Rust DER/SPKI dependencies. `rcgen`
and its additional lock packages are test-only. No AWS-LC provider was enabled,
and this slice introduced no new C/C++/assembly source or build script. The
exact archive checksums, licenses, local RustSec snapshot and unsafe-code review
are recorded in `dependency-review.json`.

## Remaining gates (`not_run`)

- independent exact-tree security and maintainability review;
- production secret/config loading, file permission validation and atomic
  trust-bundle/certificate rotation;
- online HTTP/WebSocket routing, readiness mapping, metrics integration and
  unauthorized-side-effect proof at the process boundary;
- shadow routing, compatibility soak, new-call cutover, old-call drain,
  active-zero reconciliation and TypeScript route/source/deployment deletion;
- Linux target matrix, physical PKI, multi-node/fleet, crash/OOM/outage and
  rolling-version tests;
- capacity, latency, sustained load, performance optimization and production
  qualification.

These unproved items remain `not_run`; this checkpoint is not a production,
availability, scale, latency or security-certification claim.
