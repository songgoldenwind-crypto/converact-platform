# RM01 R1 — bounded mTLS/SPIFFE peer mapping evidence

## Scope and authority

This slice extracts the active dialog-shadow peer mapping into a pure
TypeScript compatibility function and replays that contract in a bounded Rust
module. It maps an already verified TLS peer projection to exactly one SPIFFE
workload identity with Cell, fault-domain and node coordinates.

- **Current Authority:** `dialog-shadow-server.ts` remains the online mTLS
  endpoint and peer-mapping implementation.
- **Target implementation:** `MtlsPeerIdentity` is offline and
  default-disabled. No online process constructs it or routes traffic to it.
- **TLS Authority:** the future transport adapter, not this module, must
  validate the certificate chain and client-auth result before passing
  `authorized = true` and URI SAN values.
- **Production eligibility:** false.

No running server, container, Docker daemon, deployment, database or port was
read or changed. No load or performance campaign was run. The historical G03
dirty evidence README remained untouched and unstaged.

## Contract frozen from the active source

The compatibility corpus records the current dialog-shadow behavior:

- an unauthorized TLS peer is rejected;
- non-SPIFFE URI SANs are ignored;
- exactly one case-sensitive `spiffe://` URI SAN is required;
- the parsed URI must use the configured lowercase trust domain and contain no
  user information, port, query, fragment or percent-encoded path;
- the path is exactly
  `/cells/{cell}/fault-domains/{fault-domain}/nodes/{node}`;
- each coordinate starts with an ASCII alphanumeric and contains at most 128
  ASCII alphanumeric, dot, underscore, colon or hyphen bytes.

The extraction is a compatibility refactor: the server still reads
`TLSSocket.authorized` and the certificate subject-alt-name string, then calls
the pure helper with the same parsed URI SAN values. The existing server and
HTTP regression suites pass without an intended behavior change.

The corpus also freezes a subtle current behavior: uppercase authority text in
a custom `spiffe:` URL is rejected rather than canonicalized. Node's URL parser
and Rust's `url` parser both preserve that custom-scheme host spelling, which
does not equal the lowercase configured trust domain.

## Target-only safety bounds

Before URL parsing or identity allocation, Rust accepts at most 64 projected
URI SAN values and at most 2,048 bytes per value. Exceeding either limit returns
the stable value-free `platform_mtls_peer_sans_invalid` error. This is an
intentional target hardening beyond the active pure TypeScript helper and is
tested separately rather than represented as current parity.

The parser performs one bounded scan and fixed-position path parsing. It does
not allocate an intermediate segment vector. Successful mapping owns only the
four final identity strings. There is no registry, global lock, task, network,
filesystem, database, policy lookup or certificate parser in this module.
Identity and trust-domain debug output is redacted, and errors contain only
stable codes.

## Direct evidence

- 3/3 focused Rust tests pass across current contract replay, exact error
  categories, SAN/count/size bounds, trust-domain bounds, value hiding and the
  pure-source boundary.
- The active TypeScript implementation passes all 15 shared corpus cases and
  the source-boundary test proves unauthorized sockets return before
  certificate retrieval.
- The two existing dialog-shadow server tests and five existing HTTP tests
  pass after the compatibility extraction.
- The full locked Rust Workspace and all targets pass. Three pre-existing
  physical PostgreSQL tests remain explicitly ignored by their existing gate.
- Workspace Clippy with `-D warnings`, rustdoc with warnings denied and format
  check pass.
- Node 24 passes the 14 selected active JWKS, tenant-auth, mTLS and
  dialog-shadow compatibility/regression tests.
- The repository TypeScript typecheck passes.
- Cargo manifests, `Cargo.lock` and external dependencies are unchanged.

These are offline functional and structural results. They are not certificate,
transport, availability, capacity, latency, fleet or production claims.

## Remaining gates (`not_run`)

- independent exact-tree security and maintainability review;
- Rust TLS adapter, client-certificate chain/client-auth verification and
  bounded x509 URI SAN extraction;
- CA/SPIFFE trust-bundle distribution, issuer and purpose validation,
  certificate expiry, revocation and rotation;
- HTTP/WebSocket route integration, readiness/status mapping and observable
  value-free rejection metrics;
- physical certificates, target-platform matrix, rolling compatibility,
  crash/outage and fleet fault tests;
- shadow routing, unauthorized-side-effect proof, drain, active-zero and
  TypeScript route/source/deployment deletion;
- capacity, performance and production qualification.
