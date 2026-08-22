# RM01 R1 — bounded RS256 JWKS snapshot evidence

Status: `implemented_offline_default_disabled`, not production eligible.

This slice freezes the active TypeScript JWKS decoder and adds an immutable
Rust `Rs256JwksSnapshot`. It validates one complete key-set response and makes
vendor-neutral RSA public components available to a later signature provider.
It does not fetch a URL, verify a JWT signature, own freshness state, schedule
refreshes or route authentication traffic.

## Current and target contract

The 21-case corpus is bound to the exact active
`src/middleware/auth.ts#decodeJwks` source hash. Node 24 sends each document
through the exported JWKS warm path with an in-memory fetch response. Rust
builds the same documents and parses them directly.

Both paths enforce a 1–64 key set, exact RSA key type, bounded ASCII key IDs,
unique `kid`, optional `use=sig`, optional `alg=RS256`, and the existing
encoded modulus/exponent envelope. Unknown provider extension fields remain
ignored for interoperability.

The target additionally rejects seven inputs that the current decoder admits
to its cache:

- a modulus below 2,048 bits;
- non-canonical base64url modulus encoding;
- an even modulus;
- zero, even or greater-than-32-bit exponents;
- `key_ops` that does not authorize verification.

These are cache-admission differences, not claims that current Node would
successfully authenticate every admitted key. The fixture records current and
target decisions separately and both suites assert the exact seven-item list.
No route may move until provider key inventory proves compatibility.

## Bounded key snapshot

- Input is capped at 131,072 UTF-8 bytes before JSON parsing.
- Every accepted modulus is canonical unpadded base64url, odd and 2,048–6,144
  bits. The 6,144-bit upper bound follows the active 1,024-character wire cap.
- Every exponent is canonical, minimally encoded, odd, at least three and no
  larger than `u32::MAX`.
- A present `key_ops` must be exactly `verify`; omitted `key_ops` remains
  compatible with common providers.
- The snapshot is immutable and contains at most 64 keys. Exact `kid` lookup
  is therefore bounded and cannot become a repository/global scan.
- `Rs256PublicKeyComponents` exposes only modulus bytes and exponent, so a
  later crypto provider cannot leak a library-specific type into domain APIs.
- Snapshot debug output contains only the bounded key count; component debug
  output is redacted. Errors are one stable value-free category.
- The parser owns no environment, filesystem, network, system clock, async
  runtime, task or global cache.

## Crypto-provider gate

No RSA implementation was added in this slice. Dependency inspection found a
real choice that requires an explicit source/safety decision: the stable pure
Rust candidate publishes a security warning (although this use would be
public-key verification only), while common production alternatives bring a
native/unsafe supply chain. Implementing RSA arithmetic locally is forbidden.
RS256 verification remains `not_run` until one provider is pinned, reviewed
and tested behind the vendor-neutral component boundary.

No Docker daemon, remote host, running service, container, load test or
performance campaign was used or changed. The historical G03 dirty evidence
README remained untouched and unstaged.

## Remaining gates (`not_run`)

- independent exact-tree security/maintainability review;
- pinned RSA signature provider, license/advisory/native-source review and
  frozen RS256 signed-token corpus;
- issuer URL canonicalization, HTTPS/loopback policy, DNS/rebinding and proxy
  threat review;
- bounded fetch/decode cancellation, timeout and content-type behavior;
- monotonic TTL, single-flight refresh, unknown-key refresh floor, readiness,
  last-known-good and stale-key fail-closed policy;
- provider key inventory, rotation overlap, duplicate/reorder/outage/fault and
  rolling tests;
- mTLS peer mapping and HTTP/WebSocket runtime wiring;
- shadow routing, unauthorized-side-effect proof, drain, active-zero and
  legacy-source deletion;
- fleet, capacity, performance and production qualification.
