# RM01 R1 — validated JWKS issuer boundary evidence

Status: `implemented_offline_default_disabled`, not production eligible.

This slice freezes the active TypeScript issuer-to-JWKS URL behavior and adds
one pure Rust `ValidatedJwksIssuer` boundary. It validates an exact issuer
claim, preserves that exact string for JWT `iss` comparison, and separately
derives one canonical JWKS endpoint. It performs no fetch, DNS lookup,
redirect, proxy selection, environment access, scheduling or runtime routing.

## Current and target behavior

The 22-case corpus is bound to the exact active
`src/middleware/auth.ts#jwksUrl` source SHA-256
`a9300059a63c42a6fd32511dc62c6ccdfac67336a5bcaa29a92e1d90a5f77b7c`.
Node 24 calls the exported active JWKS warm path with a mocked fetch and
records whether it reaches the network boundary and which URL it derives.
Rust replays each vector against the target parser.

Both paths preserve HTTPS root/path handling, trailing-slash removal, default
and non-default ports, Unicode-domain IDNA canonicalization, IPv4/localhost
development endpoints, and rejection of remote HTTP, FTP, relative and empty
issuers.

Nine differences are deliberate and represented separately as current and
target results in the corpus:

- target rejects query and fragment data instead of silently stripping it;
- target rejects credentials and even empty user information;
- target rejects leading or embedded whitespace instead of accepting a URL
  after WHATWG whitespace removal;
- target rejects trailing-dot domains and port zero;
- target requires an explicit development policy for loopback HTTP;
- target recognizes parsed IPv6 loopback, correcting the current string-shape
  mismatch that rejects `[::1]`.

## Target guarantees

- Input is non-empty, contains at most 2,048 UTF-8 bytes and contains no raw
  whitespace.
- Only a hierarchical URL with an authority and host is accepted. User
  information, query, fragment, zero port and trailing-dot domain forms fail
  closed under one stable value-free error.
- HTTPS is the default transport. HTTP is accepted only when the composition
  root explicitly selects `ExplicitLoopbackHttp` and the parsed host is
  `localhost`, IPv4 loopback or IPv6 loopback.
- The original issuer text is retained exactly for signed-claim comparison;
  only the network endpoint is canonicalized.
- `/.well-known/jwks.json` is appended through URL path-segment operations,
  avoiding handwritten percent-encoding or authority parsing.
- Debug output is fully redacted. The value and error expose no credentials,
  tenant path or key material.
- The module owns no clock, global map, lock, task, I/O handle or ambient
  configuration.

## Parser and supply-chain decision

The target uses exact-pinned `url 2.5.8` with default features disabled and
only `std` enabled. This adds 25 resolved Rust packages, primarily the IDNA and
ICU4X canonicalization path. The additional dependency surface is accepted at
this security boundary because standards-based domain, Unicode, IPv4 and IPv6
canonicalization is safer and more maintainable than a local authority parser.
This code runs at issuer configuration/warmup boundaries, not per RTP packet or
other media hot paths.

Every newly downloaded crate archive SHA-256 matched its `Cargo.lock`
checksum. Metadata reported only MIT, Apache-2.0 and Unicode-3.0 license
families. A lexical scan of all 25 unpacked package trees found no build script,
C/C++/assembly/header file, or `unsafe` keyword. The RustSec advisory database
at commit `bf5c0d245a92671908518d7e765914d437954ed6` matched three historical
package advisories; selected `idna 1.1.0`, `zerovec 0.11.8` and
`zerovec-derive 0.11.6` are all within their published patched ranges. A full
automated lockfile audit remains `not_run` because `cargo-audit` is not
installed; no audit tool was installed during this slice.

## Scope boundaries

The TypeScript authentication runtime remains active and unchanged. The Rust
issuer value is not yet wired to a network client or verifier facade. DNS and
resolved-IP policy, rebinding, redirects, proxy behavior, response status and
content-type checks, body limits, timeouts, cancellation, startup readiness,
refresh scheduling and shutdown remain separate gates. Parser validation alone
does not authorize a fetch destination.

No Docker daemon, remote host, running service, container, load test or
performance campaign was used or changed. The historical G03 dirty evidence
README remained untouched and unstaged.

## Remaining gates (`not_run`)

- independent exact-tree security and maintainability review;
- bounded fetch adapter with DNS/resolved-IP, redirect and proxy policy;
- cache/verifier facade, startup warm/readiness, periodic refresh and shutdown;
- provider inventory, overlapping key rotation, outage and rolling tests;
- mTLS peer mapping and HTTP/WebSocket runtime integration;
- shadow routing, unauthorized-side-effect proof, drain, active-zero and
  legacy source/deployment deletion;
- fleet, capacity, performance and production qualification.
