# RM01 R1 — single-issuer JWKS lifecycle evidence

## Scope and authority

This slice composes one validated issuer, one cached verifier, one bounded
refresh driver and one shared monotonic clock into an inert issuer-local
lifecycle. It adds explicit startup warm, caller-owned refresh, cached token
verification, request-lease driving and readiness inspection. It does not own
configuration loading, task spawning, retry, periodic scheduling, jitter,
metrics publication, HTTP extraction or runtime routing.

- **Current Authority:** `src/middleware/auth.ts` remains the online JWKS
  lifecycle and token-verification implementation.
- **Target implementation:** `Rs256JwksIssuerLifecycle` is offline and
  default-disabled. It is not routed to traffic.
- **Production eligibility:** false.

No running server, container, Docker daemon, deployment, database or port was
read or changed. No load or performance campaign was run. The historical G03
dirty evidence README remained untouched and unstaged.

## One issuer and one time domain

The lifecycle derives the verifier's expected token issuer directly from the
same `ValidatedJwksIssuer` used by the fetch driver. A caller cannot configure a
fetch issuer and a different claim issuer through this constructor. The
verifier, refresh driver, verification path and readiness path all share one
injected `Arc<Clock>`; no wall clock or ambient configuration is consulted.

Construction starts no I/O and no task. `warm` performs one explicit refresh
and remains fail-closed unless the resulting complete snapshot is ready on the
shared clock. `refresh_now` uses the verifier's existing single-flight gate and
reports an already-owned refresh as `InFlight`; it does not queue or retry.
Callers own and may cancel all returned futures.

## Refresh-lease isolation

TDD exposed a cross-instance fencing flaw in the prior opaque refresh lease:
two independent caches beginning at generation one produced equal leases, so a
lease from one cache could complete the other cache's refresh. The lease now
contains a private, process-local non-zero cache namespace in addition to its
generation.

The namespace is allocated once at cache construction using one relaxed atomic
operation. It is not a hot-path lock, scan or allocation, is not exposed by the
public API or debug output, and is never reused. Namespace or generation
exhaustion fails closed through the existing lifecycle error. Tests prove both
the raw cache and composed lifecycle reject foreign leases while their own
leases remain usable.

## Direct evidence

- 7/7 lifecycle tests pass across exact issuer binding, shared clock, startup
  warm, request-driven refresh, cross-instance fencing, concurrent refresh,
  cancellation recovery, failed-warm recovery and exact expiry boundary.
- 5/5 cache lifecycle tests pass, including the new raw cross-cache lease
  rejection.
- All 35 tenant-auth-runtime integration tests and all 34 tenant-auth tests
  pass.
- All locked Rust Workspace targets pass. Existing physical PostgreSQL tests
  remain explicitly ignored by their pre-existing gates.
- Workspace Clippy with `-D warnings`, rustdoc with warnings denied and format
  check pass.
- Node 24 passes the five active TypeScript JWKS/tenant-auth replay suites.
- No Cargo manifest or lockfile changed; no dependency, feature, native source
  or build script was added.
- Production source contains no scheduler, detached task, issuer registry,
  retry loop, ambient configuration, wall clock, unsafe block or global lock.

These are offline functional and structural results. They are not throughput,
latency, fairness, availability, capacity or production claims.

## Remaining gates (`not_run`)

- independent exact-tree security, cancellation and maintainability review;
- owned periodic scheduler, bounded jitter, shutdown and retry policy;
- bounded configured issuer cardinality if more than one issuer is approved;
- runtime readiness and metrics publication;
- positive external HTTPS provider, real-key rotation, outage, rolling and
  target-platform matrix tests;
- mTLS peer mapping and HTTP/WebSocket extraction/status compatibility;
- shadow routing, unauthorized-side-effect proof, drain, active-zero and
  legacy source/deployment deletion;
- fleet, fault, capacity, performance and production qualification.
