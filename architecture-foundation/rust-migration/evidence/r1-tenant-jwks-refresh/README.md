# RM01 R1 — cancellation-safe JWKS refresh driver evidence

## Scope and authority

This slice composes one existing `Rs256JwksRefreshLease`, the validated
`JwksFetcher` boundary and the cached verifier into one cancellation-safe
refresh attempt. It does not own issuer lookup, configuration, task spawning,
retry, scheduling, metrics, readiness publication, HTTP extraction or runtime
routing.

- **Current Authority:** `src/middleware/auth.ts` remains the online JWKS
  lifecycle and token-verification implementation.
- **Target implementation:** `Rs256JwksRefreshDriver` is offline and
  default-disabled. It is not routed to traffic.
- **Production eligibility:** false.

No running server, container, Docker daemon, deployment, database or port was
read or changed. No load or performance campaign was run. The historical G03
dirty evidence README remained untouched and unstaged.

## Closed refresh behavior

One caller first obtains the sole generation-bound lease from the existing
issuer-local verifier. Calling `refresh` then follows one bounded sequence:

1. synchronously arm a private RAII guard before returning the future;
2. issue exactly one fetch through the already-bounded resolver/HTTP/TLS
   adapter;
3. on success, install the complete validated snapshot only through the exact
   lease and the caller-owned monotonic completion clock;
4. on fetch failure, complete that exact lease as failed and retain any
   last-known-good snapshot;
5. on lifecycle conflict, report the fenced lifecycle result instead of
   misreporting a fetch outcome.

There is no automatic retry, detached task or hidden queue. The driver is
generic only over one snapshot fetch boundary and one monotonic clock. The
production `JwksFetcher` satisfies that boundary without exposing Reqwest,
Rustls or DNS types to the cache/verifier crate.

## Cancellation and time

The refresh guard is constructed at the synchronous call boundary, not inside
the async body. Dropping an unpolled future therefore releases the exact lease.
Dropping or aborting a polled pending future does the same. `Drop` never starts
new work and can only attempt `complete_failure` for the guard's generation.

The system clock is process-local `Instant` elapsed milliseconds; it does not
read wall time or configuration. Completion clock regression cannot install a
new snapshot, clears the exact lease through the verifier lifecycle, and
leaves a fresh last-known-good snapshot usable at a later monotonic time.

## Direct evidence

- 8/8 refresh-driver tests pass: successful install, fetch failure, last-known-
  good retention, polled cancellation, unpolled cancellation, clock
  regression, stale lease precedence and inert/value-free source boundaries.
- All 28 tenant-auth-runtime integration tests pass across pinned address
  validation, bounded fetch and the new refresh driver.
- All locked Rust Workspace targets pass. Existing physical PostgreSQL tests
  remain explicitly ignored by their pre-existing gates.
- Workspace Clippy with `-D warnings`, rustdoc without dependencies and format
  check pass.
- Node 24 passes the five active TypeScript JWKS/tenant-auth replay suites.
- No Cargo manifest or lockfile changed; no dependency, feature, native source
  or build script was added.
- Production source contains no task spawn, retry loop, issuer registry,
  ambient configuration, wall clock, unsafe or global mutable state.

These are offline functional and structural results. They are not throughput,
latency, fairness, availability, capacity or production claims.

## Remaining gates (`not_run`)

- independent exact-tree security, cancellation and maintainability review;
- bounded issuer cardinality and configuration-to-issuer binding;
- startup warm, periodic scheduling/jitter, refresh metrics and readiness
  publication;
- one shared clock owner across verification, scheduling and completion;
- end-to-end cancellation with a positive external HTTPS provider and target
  platform matrix;
- provider inventory, overlapping real-key rotation, outage and rolling tests;
- mTLS peer mapping and HTTP/WebSocket extraction/status compatibility;
- shadow routing, unauthorized-side-effect proof, drain, active-zero and
  legacy source/deployment deletion;
- fleet, fault, capacity, performance and production qualification.
