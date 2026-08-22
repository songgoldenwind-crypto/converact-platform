# RM01 R1 — bounded JWKS lifecycle evidence

Status: `implemented_offline_default_disabled`, not production eligible.

This slice freezes the active TypeScript JWKS cache timing behavior and adds
one issuer-local Rust `Rs256JwksCache` state machine. It owns exactly one
last-known-good immutable key snapshot, one in-flight refresh generation and
one bounded on-demand retry clock. It performs no fetch, scheduling, token
verification, environment access or runtime routing.

## Current and target behavior

The 12-step corpus is bound to the exact active
`src/middleware/auth.ts#jwksCache+fetchJwks+queueJwksRefresh+jwksCacheAgeMs`
source SHA-256. Node 24 drives the active synchronous authentication lookup
with an injected key set, controlled monotonic time and failed/pending fetches.
Rust executes the same sequences against the pure cache state machine.

Both paths preserve these semantics:

- a snapshot is fresh while age is strictly less than 300,000 milliseconds;
- an expired, unwarmed or unknown-key lookup denies synchronously;
- the first denied lookup may start one asynchronous refresh;
- repeated on-demand refreshes are suppressed for 5,000 milliseconds, with
  the exact boundary allowing another attempt;
- a pending refresh suppresses all other refresh starts;
- refresh failure preserves the last-known-good snapshot, but an expired
  snapshot remains unusable;
- a fresh known key remains usable while a periodic refresh is in flight.

There is one explicit target security difference. Current TypeScript clamps a
regressed monotonic age to zero and treats the key as fresh. Rust fails that
lookup closed as `ClockRegressed`; once the caller supplies a non-regressed
time, the last-known-good state can be used again. The corpus records current
and target outcomes separately and both runtimes assert this sole difference.

## Target lifecycle guarantees

- Timing policy is explicit: freshness is 1 millisecond through 24 hours, and
  the positive on-demand floor cannot exceed freshness. The default exactly
  matches the current 300,000/5,000 millisecond behavior.
- One cache instance represents one configured issuer. It contains no global
  issuer map, global lock, task or unbounded collection.
- Scheduled startup/periodic refresh bypasses only the on-demand retry floor;
  all paths share one single-flight gate.
- Every started refresh receives an opaque increasing generation lease.
  Success or failure may complete only the exact in-flight lease. A stale or
  reordered completion cannot clear or replace newer work.
- A successful exact completion replaces the complete validated snapshot in
  one state transition. No partial key-set mutation is possible.
- A failed completion never deletes the last-known-good snapshot.
- A completion with regressed monotonic time clears its exact in-flight lease
  but cannot install a new snapshot, preventing both stale freshness and a
  permanently stuck single-flight gate.
- Refresh generation exhaustion fails closed.
- Resolution output does not expose key material or a retainable snapshot.
  Cache/debug errors and state contain only closed reasons and booleans.
- The state machine owns no wall clock. Token claim time remains a separate
  wall-clock domain; cache freshness uses caller-supplied monotonic
  milliseconds only.

## Scope boundaries

The current TypeScript global maps and network fetch path remain active and
unchanged. This slice does not yet join the cache to the Rust verifier, fetch
an issuer URL, enforce DNS/redirect/proxy policy, publish readiness or start a
background lifecycle. Those require a bounded runtime facade so key material
never escapes freshness checks and remain `not_run`.

No dependency or lockfile changed. No Docker daemon, remote host, running
service, container, load test or performance campaign was used or changed.
The historical G03 dirty evidence README remained untouched and unstaged.

## Remaining gates (`not_run`)

- independent exact-tree security/maintainability review;
- combined cache-plus-verifier facade with concurrency and cancellation
  behavior that cannot retain stale key material;
- issuer URL canonicalization, HTTPS/explicit-loopback policy,
  DNS/rebinding, redirect and proxy threat review;
- bounded fetch body/content-type/status/timeout/cancellation adapter;
- startup warm/readiness, periodic scheduling, shutdown and refresh metrics;
- provider inventory, overlapping key rotation, outage and rolling tests;
- mTLS peer mapping and HTTP/WebSocket runtime integration;
- shadow routing, unauthorized-side-effect proof, drain, active-zero and
  legacy source/deployment deletion;
- fleet, capacity, performance and production qualification.
