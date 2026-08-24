# RM01 R1 — bounded JWKS refresh scheduler evidence

## Scope and authority

This slice adds one caller-owned periodic future around the existing
single-issuer JWKS lifecycle. The scheduler validates its period and
deterministic jitter against that lifecycle's exact cache freshness window,
publishes only the latest value-free attempt status, and cooperates with the
existing process task-group shutdown channel.

- **Current Authority:** `src/middleware/auth.ts` remains the online JWKS
  lifecycle and token-verification implementation.
- **Target implementation:** `Rs256JwksRefreshScheduler` is offline and
  default-disabled. It is not constructed by an online process or routed to
  traffic.
- **Production eligibility:** false.

No running server, container, Docker daemon, deployment, database or port was
read or changed. No load or performance campaign was run. The historical G03
dirty evidence README remained untouched and unstaged.

## Design choice

The selected design places an unspawned scheduler future in
`tenant-auth-runtime`; the process's existing fixed-capacity task group must
own and stop it. A raw loop inside the API process was rejected because it
would couple HTTP and authentication lifecycle ownership. A generic timing
framework was rejected because this slice needs only one bounded monotonic
delay primitive and no second use case justifies that abstraction.

Startup warm remains an explicit fail-closed lifecycle gate. The scheduler
waits a complete first slot and does not make an unwarmed runtime ready. It
owns no issuer registry, token Authority, route, task spawn or retry queue.

## Bounded scheduling

Configuration enforces all of the following before a future can run:

- period is between one second and 24 hours;
- jitter is non-zero and at most half the base period;
- `period + jitter` is strictly less than the lifecycle's cache freshness
  window;
- the caller supplies a non-zero stable instance seed.

Each attempt gets a deterministic SplitMix64-derived delay in
`[period - jitter, period + jitter]`. The seed is private and debug output is
redacted. The algorithm is distribution-only, not a security primitive. A
process configuration adapter must later derive a different stable seed from
bounded runtime identity so fleet members do not refresh in lockstep.

There is no catch-up or immediate retry burst. A failure, or an existing
single-flight owner, is published to a Tokio `watch` latest-value channel and
the next attempt waits its complete next slot. The channel retains one value;
it cannot build a queue.

## Shutdown and cancellation

The future accepts the same monotonic boolean `watch` receiver supplied by the
existing fixed-capacity runtime task group. Shutdown while sleeping starts no
fetch. Shutdown while fetching drops the cancellation-safe refresh future, so
its exact cache lease is released. A pre-closed receiver or a dropped sender
exits without work. The scheduler never calls `tokio::spawn`; callers retain
task ownership and deadline enforcement.

## Direct evidence

- 8/8 scheduler tests pass: configuration bounds, 10,000 deterministic jitter
  samples, slot timing, status publication, failure recovery, existing
  single-flight observation, sleeping shutdown, active-fetch shutdown and
  pre-closed/dropped shutdown channels.
- All 43 tenant-auth-runtime integration tests pass across resolved-address
  validation, bounded HTTPS fetch, cancellation-safe refresh, single-issuer
  lifecycle and scheduler behavior.
- All locked Rust Workspace targets pass. Existing physical PostgreSQL tests
  remain explicitly ignored by their pre-existing gates.
- Workspace Clippy with `-D warnings`, rustdoc with warnings denied and format
  check pass.
- Node 24 passes the five active TypeScript JWKS/tenant-auth replay suites.
- `Cargo.lock` and production dependencies are unchanged. The only manifest
  change enables Tokio virtual-time test support in dev dependencies.
- Production source contains no task spawn, mpsc queue, registry, ambient
  configuration, wall clock, unsafe block or global lock.

These are offline functional and structural results. They are not throughput,
latency, fairness, availability, capacity or production claims.

## Remaining gates (`not_run`)

- independent exact-tree security, cancellation and maintainability review;
- configuration parsing and stable per-instance seed derivation;
- fixed-capacity process task-group wiring and shutdown-deadline integration;
- runtime readiness and metrics adapters over lifecycle/status observations;
- bounded configured issuer cardinality if more than one issuer is approved;
- positive external HTTPS provider, real-key rotation, outage, rolling and
  target-platform matrix tests;
- mTLS peer mapping and HTTP/WebSocket extraction/status compatibility;
- shadow routing, unauthorized-side-effect proof, drain, active-zero and
  legacy source/deployment deletion;
- fleet, fault, capacity, performance and production qualification.
