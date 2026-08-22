# RM01 R1 — Rust audit source-IP HMAC evidence

Status: `implemented_offline_default_disabled`, not production eligible and not
wired into any database writer, HTTP route, worker, container or running
service.

This slice moves one final-state privacy boundary into Rust. It parses the
existing 256-bit base64 HMAC key into an opaque type, reproduces the active
TypeScript source-IP normalization rule, and emits only the lowercase SHA-256
HMAC or the existing empty sentinel. The TypeScript service remains the sole
active Audit Authority.

## Frozen compatibility

- The fixture source-hashes the active TypeScript audit service and is replayed
  by both runtimes under Node 24.15.0 and Rust 1.94.1.
- Missing, `null` and empty source IP values produce the existing empty string.
- A forwarded chain uses only its first item and applies the exact ECMAScript
  trim character set.
- IPv4, expanded/mixed-case IPv6, IPv4-mapped IPv6 and scoped IPv6 vectors
  preserve the original textual spelling apart from lowercase. Rust does not
  canonicalize the address before hashing. Scoped suffixes follow Node 24's
  exact `[0-9A-Za-z-.:]+` grammar rather than an assumed interface-name grammar.
- Invalid hosts, ports, bracketed IPv6, empty first forwarded items and invalid
  numeric addresses fail closed.
- The key parser preserves current Node.js acceptance of canonical, unpadded
  and surplus-trailing-padding base64 while rejecting wrong length, non-base64
  prefixes and empty input.
- The key has no public byte accessor and its `Debug` representation is always
  `AuditIpHmacKey([REDACTED])`.

The implementation is synchronous and key decoding is bounded before any
allocation. Raw source-IP size must be bounded by the future runtime/header
boundary. It adds no task, lock, queue, I/O, database access, route, Authority
or native library. The direct
Rust dependencies (`base64`, `hex`, `hmac`, SHA-2 0.11) already existed in the
workspace lockfile; this slice does not introduce a newly resolved package.

## TDD and direct verification

The TypeScript test first failed because the frozen fixture did not exist. The
Rust test then failed to compile because the key, error and HMAC APIs did not
exist. Independent review subsequently exposed a third RED: Node accepts
scoped IPv6 while `std::net::IpAddr` does not. Only after each RED state was
recorded were the corresponding minimal implementation changes added.

On the final exact working tree:

- the affected TypeScript audit suite passed 17/17 under Node 24.15.0;
- TypeScript typecheck passed;
- the focused Rust IP-HMAC suite passed 4/4;
- the entire Rust workspace all-target test command passed; 19 tests requiring
  isolated PostgreSQL retained their explicit existing ignore gates;
- workspace strict Clippy, Rust formatting and `git diff --check` passed.
- independent generated comparison covered 30,082 bare IP cases and 50,108
  scoped/invalid-zone cases against Node 24 `net.isIP`, with zero mismatches.
- independent full-BMP comparison found the same 25 ECMAScript trim code
  points in Node and Rust, with zero mismatches.

An initial expanded TypeScript invocation omitted the repository's mandatory
`explicit-dev-auth.mjs` test preloader, causing only the two HTTP harness tests
to fail. The corrected repository-conformant command passed all 17 affected
tests; this was an invocation correction, not a product-code change.

No Docker, remote host, server mutation, running-service change, load test or
performance campaign was used.

## Remaining gates (`not_run`)

- HMAC key loading/custody and raw-request runtime wiring;
- the fenced PostgreSQL append/list implementation, concurrent chain-tail
  serialization, immutable trigger/RLS and physical database tests;
- shadow comparison, single-writer cutover, drain, reconcile, active-zero and
  TypeScript deletion;
- list cursor and JSONL export migration;
- production image, fleet, fault, performance and production qualification.
