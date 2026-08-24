# RM01 R1 — issuer-local JWKS verifier facade evidence

## Scope and authority

This slice composes the existing bounded RS256 parser/verifier and
`Rs256JwksCache` into one pure Rust, issuer-local concurrent facade. It owns no
network client, clock, task, issuer registry, HTTP route or runtime readiness
publisher.

- **Current Authority:** `src/middleware/auth.ts` remains the online token,
  JWKS cache and refresh implementation.
- **Target implementation:** `Rs256CachedTokenVerifier` is offline and
  default-disabled. It is not routed to traffic.
- **Production eligibility:** false.

No server, container, Docker daemon, deployment or running program was read or
changed. No load or performance campaign was run. The historical G03 dirty
evidence README remained untouched and unstaged.

## Closed request behavior

Each request follows one bounded sequence:

1. split the compact token, decode the exact RS256/JWT header and canonical
   signature, and validate the bounded `kid` before touching shared state;
2. reject a regressed caller-supplied monotonic timestamp through one atomic
   issuer-local high-water mark;
3. clone one fresh immutable `Arc<Rs256JwksSnapshot>` under a short shared
   lock;
4. release every cache lock before bounded key lookup, RSA verification and
   claim-policy evaluation;
5. only for an unwarmed, expired or unknown-key state, enter the short write
   path and ask the existing cache for its sole fenced refresh lease.

Malformed input and known-key signature/claim failures are rejected and never
start refresh work. Unknown keys deny synchronously; concurrent unknown-key
requests share the same cache single-flight gate and at most one receives a
lease. A successful refresh atomically replaces the complete snapshot. A
failed refresh retains last-known-good keys, but expiration still fails closed.

The facade distinguishes a permanent request rejection from temporary key
unavailability. All errors and debug surfaces are value-free; key, issuer,
token and claim values are not included.

## Readiness and time

The value-only readiness observation is ready exactly when one complete
snapshot is warmed and fresh. A periodic refresh in flight does not withdraw a
fresh last-known-good snapshot. Unwarmed, expired, regressed-time or poisoned
state is not ready. An unknown key on one request does not change issuer
readiness.

The caller owns both wall and monotonic clocks. Wall time is used only for JWT
claim policy. Monotonic milliseconds control cache lifecycle. Concurrent calls
share an atomic high-water mark; a regressed successful completion clears only
its exact in-flight lease and cannot install a snapshot or leave refresh stuck.

## Bounded target hardening

The active TypeScript implementation accepts any decoded string `kid` before
cache lookup. The Rust target reuses the already-frozen JWK key-id grammar:
1–256 ASCII bytes from the closed alphanumeric/`._:/-` set. An oversized or
invalid identifier is `HeaderInvalid` before cache access. This preserves every
currently valid token while preventing untrusted oversized identifiers from
driving repeated bounded-cache comparisons or refresh attempts.

The original immutable `Rs256PlatformTokenVerifier` delegates to the same
prepare/verify functions. Its existing public error contract and frozen corpus
remain green; an unknown valid-shaped key still maps to `HeaderInvalid` there.

## Direct evidence

- 9/9 facade tests pass, including malformed-before-refresh, unwarmed
  single-flight, valid/invalid signatures, unknown key, readiness/expiry,
  failed refresh, fixed concurrent callers and monotonic regression recovery.
- All tenant-auth tests and all locked Workspace targets pass. Existing
  physical PostgreSQL tests remain explicitly ignored by their pre-existing
  gates.
- Workspace Clippy with `-D warnings`, rustdoc without dependencies and format
  check pass.
- Node 24 passes the five active TypeScript JWKS/tenant-auth replay suites.
- No Cargo manifest or lockfile changed; no dependency, native source, build
  script or feature was added.
- Production source contains no runtime I/O/task dependency and no
  `unwrap`/`expect`/panic/TODO path.

The fixed-thread tests are functional concurrency evidence only. They are not
throughput, latency, fairness or capacity claims.

## Remaining gates (`not_run`)

- independent exact-tree security, concurrency and maintainability review;
- cancellation while a real fetch is driven from a lease and shutdown
  ownership;
- bounded issuer cardinality and configuration-to-issuer binding;
- startup warm, periodic refresh, jitter, metrics and runtime readiness wiring;
- provider inventory, overlapping real-key rotation, outage and rolling tests;
- positive TLS hostname/non-macOS target and enterprise trust policy;
- mTLS peer mapping and HTTP/WebSocket extraction/status compatibility;
- shadow routing, unauthorized-side-effect proof, drain, active-zero and
  legacy source/deployment deletion;
- fleet, fault, capacity, performance and production qualification.
