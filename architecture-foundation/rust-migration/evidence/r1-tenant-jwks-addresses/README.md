# RM01 R1 — bounded JWKS resolved-address evidence

Status: `implemented_offline_default_disabled`, not production eligible.

This slice creates the transport-facing `converact-tenant-auth-runtime` crate
and gives it one pure resolved-address policy. The existing `tenant-auth`
domain crate remains free of HTTP, TLS and asynchronous runtime dependencies.
It now exposes only vendor-neutral endpoint coordinates from an already
validated issuer: canonical domain or parsed IP, explicit/default port and
whether TLS is required.

The active TypeScript authentication path remains unchanged. No DNS lookup,
socket or HTTP request is performed by this slice.

## Address policy

One DNS answer is a single atomic security decision:

- at most 16 raw addresses are inspected; duplicate answers still consume the
  raw-answer budget;
- every result must satisfy the selected policy, otherwise the whole answer is
  rejected rather than silently retaining a subset;
- accepted addresses are deduplicated and bound to the validated endpoint
  port for the request generation;
- an empty answer and port zero fail closed;
- value/debug errors contain no domain, IP or URL.

`PublicInternet` conservatively accepts native IPv6 global unicast and ordinary
public IPv4 while rejecting the special-purpose, private, shared, loopback,
link-local, documentation, benchmark, multicast and reserved families. It
also accepts the well-known `64:ff9b::/96` NAT64 prefix only when the embedded
IPv4 address independently passes the public policy. The complete
`192.0.0.0/24` and `2001::/23` parent reservations are rejected even though
IANA records a few more-specific globally reachable anycast assignments; this
deliberately favors a closed JWKS destination boundary over uncommon anycast
identity endpoints.

`LoopbackDevelopment` accepts only IPv4/IPv6 loopback and must be selected
explicitly by the future composition root. It does not admit RFC1918, shared,
link-local or ULA addresses.

The classification was checked on 2026-08-24 against the official IANA IPv4
and IPv6 Special-Purpose Address Space registries, both last updated
2025-10-09:

- https://www.iana.org/assignments/iana-ipv4-special-registry/
- https://www.iana.org/assignments/iana-ipv6-special-registry/

The source is an intentionally conservative reviewed snapshot, not a claim
that runtime policy follows future registry changes automatically.

## TDD and verification boundary

The first focused compilations failed because neither the endpoint-coordinate
API nor address policy existed. The implemented tests cover public IPv4/IPv6,
NAT64 embedded-address validation, every rejected address family, atomic mixed
answers, explicit loopback, empty/oversized answers, port zero, deduplication,
redaction and a no-I/O source guard.

The new Cargo package resolves only the existing internal `tenant-auth` crate;
no external dependency, build script, native source or lockfile registry
package was added. Workspace-owned code continues to forbid unsafe code.

No Docker daemon, remote host, running service, container, load test or
performance campaign was used or changed. The historical G03 dirty evidence
README remained untouched and unstaged.

## Remaining gates (`not_run`)

- independent exact-tree security and maintainability review;
- explicit bounded enterprise-private IdP destination allowlist, if required;
- actual bounded DNS resolver and one-generation address pinning;
- HTTP/TLS adapter, certificate/hostname validation, proxy/redirect/retry
  denial, total timeout, cancellation and shutdown;
- cache/verifier facade, startup warm/readiness and periodic refresh;
- mTLS peer mapping and HTTP/WebSocket runtime integration;
- shadow routing, unauthorized-side-effect proof, drain, active-zero and
  legacy source/deployment deletion;
- fleet, fault, capacity, performance and production qualification.
