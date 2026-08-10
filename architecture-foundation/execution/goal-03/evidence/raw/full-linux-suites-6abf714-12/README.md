# G03 `.70` exact-source Linux suite evidence

Campaign ID: `converact-g03-full-linux-suites-6abf714-12`

Captured: `2026-08-10T08:30:16Z`
Production eligible: `false`

## Scope

This controlled bundle binds Converact Platform source
`6abf714ea8b71817e91fa9493e882c360050cf7f`, RustPBX
`6c49ee76baa54fdbf8f98020cc9bee158c7c15de`, rsipstack
`8318e97b1170de4e5245b120afec1cdf53e3d716` and rustrtc
`166c6d22984429eb6b509920c14fcd69f974f0b3` to patchset `ivekit.70`.

The exact patched sources were built and tested on `ubuntu@101.42.7.139` with
Rust `1.94.1`, two CPU cores, a 6,500 MiB memory/swap ceiling and a 1,024 PID
ceiling. The existing isolated PostgreSQL 16.14 test dependency remained
healthy and had no host port. No old application container, source tree,
database, image, volume or user data was changed or deleted.

## Exact results

| Suite | Exact result | Container exit | OOM |
| --- | --- | --- | --- |
| RustPBX library | `2,016 passed; 0 failed; 9 ignored`; `2,025` total; test phase `227.82s` | `0` | `false` |
| rsipstack library | `311 passed; 0 failed; 0 ignored`; `3.46s` | `0` | `false` |
| rsipstack compile-fail/doctest target | `67 passed; 0 failed; 0 ignored`; `4.10s` | `0` | `false` |

RustPBX command:

```text
cargo test --quiet --locked --offline --manifest-path /build/rustpbx/Cargo.toml --lib
```

rsipstack command:

```text
cargo test --quiet --locked --offline --manifest-path /build/rsipstack/Cargo.toml
```

The first rsipstack offline attempt stopped before compilation because the
pre-existing RustPBX vendor contained `async-trait 0.1.89` while rsipstack's
exact lock requires `0.1.91`. Two isolated online attempts were then stopped
after crates.io sparse-index requests repeatedly timed out; their exit `137`
was operator stop with `OOMKilled=false`, not a test result. The successful run
used a new isolated hard-linked vendor copy. All 47 missing `.crate` archives
were downloaded over IPv4 and checked against their exact Cargo.lock SHA-256
before extraction. The original vendor and both lock files were unchanged.

## Evidence integrity

The exact container metadata, summaries and Docker log-stream hashes are in
`server-suite-results.txt`. The missing-package manifest and its verification
are in `dependency-vendor-verification.txt`. `SHA256SUMS` binds this bundle.

## Honest boundary

These are exact-source component suites. They prove that the `.70` patch chain
compiles and that its complete RustPBX library and rsipstack test targets pass
on the controlled Linux host. They do not prove live Native Call/Leg or
SipEffect authority activation, live Endpoint composition, a real observer
process crash, two-node takeover, mixed-binary activation, UAS-owner crash
recovery, fault/OOM isolation, latency, allocations, throughput, multi-core
scaling, image/wire requalification or production eligibility.

`G03-E10-FAULT`, `G03-E13-PERFORMANCE`, `G03-E15-REVIEW`,
`G03-E16-NATIVE-AUTHORITY` and production eligibility remain `not_run`/false.

No credential, authorization header, private key, token, database URL, secret
value or environment dump is retained in this bundle.
