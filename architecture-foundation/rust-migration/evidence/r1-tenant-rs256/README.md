# RM01 R1 — external RS256 platform token verifier evidence

Status: `implemented_offline_default_disabled`, not production eligible.

This slice joins the immutable `Rs256JwksSnapshot` to a bounded RS256
signature verifier inside `converact-tenant-auth`. It verifies one compact
external platform token using public RSA components, applies the shared tenant
identity policy, and returns the same opaque authenticated identity as the
local HS256 path. It does not fetch keys, own cache freshness, read a clock,
inspect a certificate, expose an HTTP/WebSocket route or change a running
service.

## Current and target behavior

The 13-case signed-token corpus is bound to the exact active
`src/middleware/auth.ts#verifyJwt+validatePlatformJwtPayload` SHA-256. Its
test-only 2,048-bit RSA private key was generated once in Node 24, discarded,
and is not stored. Only the public JWK and frozen signatures are checked in.

Node 24 replays every token through the active `resolveAuthContext`; Rust
replays the same bytes through `Rs256PlatformTokenVerifier`. There are exactly
two intentional target security differences:

- current TypeScript accepts a signed RS256 bearer whose claims say
  `credential_strength=mtls`; the Rust target rejects it because a bearer
  signature cannot prove a mutually authenticated transport peer;
- current `JSON.parse` accepts a payload containing the same security field
  twice and keeps the last value; Rust's typed payload parser rejects the
  duplicate field.

Current and target outcomes are recorded separately. No caller route moves in
this slice, so current production behavior is unchanged.

## Verification boundary

- Tokens are limited to 65,536 bytes and exactly three non-empty canonical,
  unpadded base64url components.
- Only `alg=RS256`, `typ=JWT` and an exact `kid` from the immutable bounded
  snapshot are accepted. There is no algorithm fallback.
- The signature length must exactly equal the selected modulus length.
- The original compact-token byte prefix is passed directly to verification;
  the signing input is not reconstructed or normalized.
- The selected provider operation is exactly RSA PKCS#1 v1.5 with SHA-256 for
  2,048–8,192-bit keys. The preceding JWKS boundary further limits accepted
  keys to canonical odd 2,048–6,144-bit moduli and bounded odd exponents.
- Signature verification completes before payload authorization. Issuer,
  audience, key, subject, tenant aliases, role, timestamps, policy epoch,
  revocation epoch, capabilities, purpose and credential strength reuse the
  shared fail-closed policy.
- Errors are closed and value-free. Verifier, key components and authenticated
  identity debug output are redacted.
- The module owns no network client, environment, filesystem, async runtime,
  task, global cache or clock.

## Provider and native-source decision

`ring 0.17.14` is pinned exactly with default features disabled and only
`alloc` enabled. The crate API used by product code is limited to
`RsaPublicKeyComponents::verify` plus
`RSA_PKCS1_2048_8192_SHA256`; private-key, signing, decryption and random APIs
are statically excluded from the verifier source.

The provider is intentionally hidden behind the existing vendor-neutral JWK
component boundary. The alternative stable RustCrypto `rsa` package was not
selected because RustSec RUSTSEC-2023-0071 still reports no patched version
for its private-key timing issue. `ring 0.17.14` is newer than the
RUSTSEC-2025-0009 patched floor (`0.17.12`), is outside the pre-0.17 scope of
RUSTSEC-2025-0010, and RUSTSEC-2025-0007 is withdrawn. Exact URLs and the
2026-08-22 review result are frozen in `dependency-review.json`.

This is not a claim that the native provider was independently or exhaustively
audited. The downloaded registry archive checksum, package licenses, complete
new lockfile package set, feature selection, build script and native build
shape were inspected. The packaged build uses checked-in C/pregenerated
assembly and the Rust `cc` build dependency to create a static library. An
independent exact-source review, automated full-lockfile advisory scan and
target-matrix builds remain `not_run`; therefore the slice is not production
eligible and cannot be routed.

No Docker daemon, remote host, running service, container, load test or
performance campaign was used or changed. The historical G03 dirty evidence
README remained untouched and unstaged.

## Remaining gates (`not_run`)

- independent exact-tree security/maintainability and native-source review;
- automated full-lockfile advisory scan and non-macOS target build matrix;
- issuer URL canonicalization, HTTPS/loopback policy, DNS/rebinding and proxy
  threat review;
- bounded JWKS fetch cancellation, timeout and content-type enforcement;
- monotonic TTL, single-flight refresh, unknown-key refresh floor, readiness,
  last-known-good and stale-key fail-closed policy;
- provider key inventory, rotation overlap, duplicate/reorder/outage/fault and
  rolling tests;
- mTLS transport peer verification and certificate-to-workload mapping;
- HTTP/WebSocket extraction, status compatibility, shadow routing,
  unauthorized-side-effect proof, drain, active-zero and legacy deletion;
- fleet, capacity, performance and production qualification.
