# RM01 R1 — bounded JWKS response evidence

Status: `implemented_offline_default_disabled`, not production eligible.

This slice freezes the active TypeScript JWKS HTTP-response behavior and adds
one pure Rust `Rs256JwksResponseCollector`. The collector validates a response
head before body allocation, incrementally enforces the existing 128 KiB
budget, and hands strict UTF-8 JSON to the existing bounded RS256 key-set
parser. It does not open a socket, resolve DNS, follow redirects, select a
proxy, own a timeout or mutate a cache.

## Current and target behavior

The 16-case corpus is bound to the exact active
`src/middleware/auth.ts#fetchAndValidateJwks+readBoundedJwksBody+cancelUnreadJwksBody`
source SHA-256
`a9300059a63c42a6fd32511dc62c6ccdfac67336a5bcaa29a92e1d90a5f77b7c`.
Node 24 invokes the active exported JWKS warm path with synthetic response
heads and bodies. Rust feeds the same logical bodies in 8,191-byte chunks.

Both paths accept a valid key set at exactly 131,072 bytes and reject failed
status, non-canonical or oversized declared length, streamed overflow, invalid
UTF-8, malformed JSON and an empty body.

Four target differences are explicit in the corpus:

- target requires Content-Type instead of accepting a missing header;
- target accepts only `application/json` or `application/jwk-set+json`, with
  an optional UTF-8 charset, instead of accepting arbitrary media types;
- target requires status 200 instead of accepting every 2xx response;
- target requires an advertised Content-Length to equal the bytes delivered,
  instead of ignoring truncation or excess.

## Target guarantees

- Status, Content-Type and Content-Length are checked before body allocation.
- Content-Type and Content-Length inputs are themselves bounded. Multiple
  media values, unsupported parameters, non-decimal/leading-zero lengths and
  values over 128 KiB fail closed.
- Every chunk is checked before copying. The collector never grows beyond
  131,072 bytes and rejects a chunk as soon as it exceeds either the global or
  declared length.
- Finalization checks exact declared length, strict UTF-8, JSON shape, key
  count, duplicate key IDs, canonical RSA components and supported metadata
  through the already-authoritative `Rs256JwksSnapshot` parser.
- Errors are a closed value-free enum. Collector debug output exposes only
  byte count and whether a length was declared, never body or key content.
- The module has no clock, task, lock, network, filesystem or environment
  authority and introduces no dependency or lockfile change.

## Scope boundaries

The active TypeScript response path remains unchanged. Its existing tests
continue to prove that failed heads, oversized declarations and streamed
overflow cancel the body and abort the request. The Rust collector cannot make
that transport guarantee by itself: the forthcoming HTTP/TLS adapter must
drop/cancel the response on every head or chunk error, enforce the total
deadline, disable redirects and proxies, and pin only policy-approved resolved
addresses. Those items remain `not_run`.

No Docker daemon, remote host, running service, container, load test or
performance campaign was used or changed. The historical G03 dirty evidence
README remained untouched and unstaged.

## Remaining gates (`not_run`)

- independent exact-tree security and maintainability review;
- HTTP/TLS transport, DNS/resolved-IP and rebinding policy;
- redirect/proxy denial, total timeout, caller cancellation and shutdown;
- cache/verifier facade, startup warm/readiness and periodic refresh;
- provider inventory, overlapping key rotation, outage and rolling tests;
- mTLS peer mapping and HTTP/WebSocket runtime integration;
- shadow routing, unauthorized-side-effect proof, drain, active-zero and
  legacy source/deployment deletion;
- fleet, capacity, performance and production qualification.
