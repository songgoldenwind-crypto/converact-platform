# RM01 R1 — local HS256 platform token verifier evidence

Status: `implemented_offline_default_disabled`, not production eligible.

This slice gives `converact-tenant-auth` the first credential verifier that can
construct its otherwise opaque verified identity. It verifies one local HS256
platform token, binds its issuer, audience, key, subject, tenant and clock
claims, applies the frozen tenant access policy, and returns one bounded
authenticated identity. No HTTP route, token issuer, environment reader,
clock, key loader, background task or running service uses it.

## Current and target behavior

The checked-in corpus is bound to the exact active
`src/middleware/auth.ts` SHA-256. Node 24 signs or replays every vector through
the current `resolveAuthContext`; Rust independently signs or replays the same
bytes through `Hs256PlatformTokenVerifier`.

There is one explicit security divergence:

- current TypeScript accepts an otherwise valid HS256 token whose signed
  strings say `identity_kind=service` and `credential_strength=mtls`;
- the Rust target rejects that token as `platform_token_claims_invalid`.

A bearer HMAC secret cannot prove possession of a client certificate. Only a
future certificate-to-workload mapper may produce mTLS credential strength.
The fixture records current `allowed` and target `denied` separately and both
test suites assert that this is the only intentional divergence. No route may
move until legacy-token/configuration inventory proves that cutover will not
silently strand a supported caller.

## Verification boundary

- Compact tokens are limited to 65,536 bytes and exactly three non-empty
  canonical unpadded base64url components.
- The verifier checks HMAC-SHA256 in constant time before interpreting
  attacker-controlled header or payload authorization data.
- `alg=HS256`, `typ=JWT`, header `kid`, payload `key_id`, both issuer fields,
  both audience sets, subject/identity, tenant aliases and integer/ISO clock
  mirrors must agree exactly.
- Claim text, sets, JavaScript-safe integers, canonical timestamps,
  policy/revocation epochs, role, capability, purpose and expiry reuse the
  already frozen bounded policy. Duplicate or oversized sets fail closed.
- Errors are a closed value-free set. Verifier and authenticated-identity
  `Debug` output is fully redacted.
- The verifier owns no runtime I/O or clock. Its caller supplies an
  already-loaded UTF-8 key and the exact wall-clock milliseconds, which keeps
  this module deterministic and inert.
- The constructor currently accepts 1–4,096 key bytes only to preserve the
  active local-HS256 configuration envelope. A production minimum-strength
  policy, secret source, rotation, memory zeroization and crash/core-dump
  policy are separate gates and remain `not_run`.
- Rust JSON rejects wire strings it cannot represent as Unicode, including
  lone-surrogate forms. The earlier internal policy-projection compatibility
  type remains separate; no wire route has been cut over.

## Dependency and runtime review

The crate uses workspace-resolved `base64 0.22.1`, `hmac 0.13.0` and
`sha2 0.11.0`. They were already present in the lockfile, add no external
native library, unsafe block, network client or filesystem API, and resolve no
new package. The verifier source is statically guarded against environment,
system-clock, Tokio, HTTP, TCP and file-open dependencies.

The shared corpus covers valid input, algorithm/type/key mismatch, issuer,
tenant and audience mismatch, expiry, stale policy, missing required claims,
the mTLS-confusion case, invalid signature and non-canonical signature. The
existing 26-case access-policy corpus continues to cover the complete bounded
tenant policy below this verifier.

No Docker daemon, remote host, running service, container, load test or
performance campaign was used or changed. The historical G03 dirty evidence
README remained untouched and unstaged.

## Remaining gates (`not_run`)

- independent exact-tree security/maintainability review;
- active key-strength and legacy-token inventory;
- production secret loading, rotation, revocation distribution, zeroization
  and core-dump policy;
- local token issuance and refresh/session revocation behavior;
- RS256/JWKS verification, bounded refresh/cache lifecycle and outage tests;
- mTLS transport peer verification and certificate-to-workload mapping;
- HTTP/WebSocket extraction, status/error compatibility and runtime wiring;
- tenant membership/RBAC lookup and physical PostgreSQL RLS composition;
- shadow routing, unauthorized-side-effect proof, writer route commit, drain,
  active-zero and legacy-source deletion;
- fleet, rolling, fault, capacity, performance and production qualification.
