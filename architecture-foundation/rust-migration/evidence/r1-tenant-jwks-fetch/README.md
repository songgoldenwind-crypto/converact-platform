# RM01 R1 — bounded JWKS fetch adapter evidence

Status: `implemented_offline_default_disabled`, not production eligible.

This slice adds the first I/O authority to `converact-tenant-auth-runtime`:
one bounded asynchronous resolver and HTTP/TLS adapter for the already
validated issuer, resolved-address policy and response collector. The active
TypeScript authentication path remains unchanged. No route, cache, readiness
state, server, container or deployment was changed.

## Current, target and production state

- **Current Authority:** `src/middleware/auth.ts` remains the online JWKS
  fetch/cache/verifier. Its exact source SHA-256 is
  `a9300059a63c42a6fd32511dc62c6ccdfac67336a5bcaa29a92e1d90a5f77b7c`.
- **Target implementation:** the new Rust fetcher is callable only by an
  explicit in-process owner. Nothing composes it into startup or request
  handling yet.
- **Production eligibility:** false. Cache/verifier composition, provider and
  private-CA inventory, readiness, shadow comparison, fleet fault evidence,
  independent review, drain and active-zero remain `not_run`.

The active path's five-second timeout and 128 KiB body budget are preserved.
Target differences frozen by the preceding issuer/response slices remain in
force: the target permits only validated HTTPS or explicit loopback HTTP,
requires status 200 and an accepted media type, checks exact advertised
length, and applies the resolved-address policy before connecting.

## One bounded refresh generation

One call to `JwksFetcher::fetch` performs the following sequence under one
Tokio monotonic deadline:

1. resolve a domain once, or use the already parsed literal IP;
2. inspect at most 17 resolver outputs so the 16-answer policy can reject an
   oversized set without collecting the remainder;
3. validate the complete answer atomically and bind every accepted IP to the
   issuer port;
4. build a fresh non-pooled client and pin that exact address generation;
5. issue one HTTP/1.1 GET with redirects, proxies and retries disabled;
6. validate the response head before allocating the body and stream at most
   131,072 bytes through the existing strict collector;
7. drop the client, address set and connection generation on completion.

The adapter starts no background task and owns no global map or lock. The
future's caller owns admission and cancellation. A later cache facade must
provide bounded issuer cardinality and single-flight refresh; this slice does
not claim those gates.

DNS errors, rejected addresses, elapsed deadlines, transport failures and
response failures map to closed value-free reasons. Debug output does not
contain issuer, URL, host, IP, response body or key material. The local tests
prove that a response-head rejection, total-deadline expiry and caller task
cancellation close or reset the socket, and that a transport failure is not
retried.

## TLS and trust decision

HTTPS uses exact-pinned Rustls 0.23.43 with an explicit ring provider and the
exact-pinned `webpki-roots` 1.0.9 Mozilla root snapshot. Hostname verification
remains enabled. No operating-system root store, proxy setting, key log,
automatic decompression or ambient Reqwest client is used by the product
path.

Reqwest's public `rustls-no-provider` feature necessarily compiles
`rustls-platform-verifier`, including platform-conditional native bindings.
The adapter does not invoke it: `tls_backend_preconfigured` selects Reqwest's
`BuiltRustls` branch with the complete local-root configuration. This choice
is source-guarded and exact-version pinned. It avoids the Apple platform
verifier path, whose upstream source states that its test-root evaluation does
not limit online revocation fetching or root download. The compiled-but-unused
dependency surface is recorded rather than hidden.

This fixed public-root policy intentionally does not yet support an enterprise
private CA and does not claim live certificate revocation checking. Provider
inventory, an explicit bounded private-root injection contract if needed,
root-update operations and revocation policy remain `not_run`. A positive
offline TLS handshake corpus and the non-macOS target build matrix also remain
`not_run`; standard Rustls chain/name construction plus source guards are not
promoted into physical fleet evidence.

## Offline TDD and verification

The focused fetch suite contains 13 cases covering bounded deadline policy,
redaction, closed resolver failure, resolver cancellation, one pinned
loopback generation, mixed-answer rejection before connect, direct-IP DNS
bypass, redirect denial, no retry, response-head cancellation, stalled-body
deadline, caller cancellation and dependency/source guards. The seven prior
resolved-address tests remain green. The caller-cancellation case was repeated
five consecutive times after correcting the assertion to accept both normal
EOF and TCP reset as valid connection closure.

The five existing Node 24 cross-runtime JWKS/tenant-auth suites remain green,
and the full pinned Rust Workspace test, Clippy, rustdoc and format gates pass.
Physical PostgreSQL tests remain explicitly ignored by their existing gates.

The dependency review covers all 38 newly resolved registry packages, exact
archive checksums, licenses, target-conditional native/unsafe boundaries,
feature expansion and every matching advisory in the current RustSec database
commit. `cargo-audit` and `cargo-deny` are not installed and were not installed
for this slice; a full automated lockfile audit remains `not_run`.

No Docker daemon, remote host, running service, container, load test or
performance campaign was used or changed. The historical G03 dirty evidence
README remained untouched and unstaged.

## Remaining gates (`not_run`)

- independent exact-tree security, maintainability and native-boundary review;
- positive offline TLS chain/hostname rejection corpus and Linux target build;
- provider/private-CA/root-update/revocation policy and rolling validation;
- bounded cache/verifier facade, issuer cardinality, startup warm/readiness,
  periodic refresh and shutdown ownership;
- overlapping key rotation, outage, stale-key and rolling-provider tests;
- mTLS peer mapping and HTTP/WebSocket runtime integration;
- shadow routing, unauthorized-side-effect proof, drain, active-zero and
  legacy source/deployment deletion;
- fleet, fault, capacity, performance and production qualification.
