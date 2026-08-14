# G03 `.78` durable SIP runtime composition — functional evidence

- Campaign: `converact-g03-78-2ecfb72-functional`
- Canonical base HEAD: `2ecfb72f9618e8466814edd738769a2303d2085d`
- Candidate patchset: `ivekit.78`
- RustPBX source: `6c49ee76baa54fdbf8f98020cc9bee158c7c15de`
- rsipstack source: `8318e97b1170de4e5245b120afec1cdf53e3d716`
- rustrtc source: `166c6d22984429eb6b509920c14fcd69f974f0b3`
- Rust toolchain: `1.94.1-aarch64-apple-darwin`
- Production eligible: `false`
- Performance evidence: `false`

## Proven scope

The exact `.78` patch replays byte-for-byte onto the `.77` RustPBX source. The
Rust app builds one default-disabled durable SIP effect runtime before SIP
startup, uses one `Arc<PostgresSipEffectStore>` for the egress Gate,
observation supervisor and recovery Oracle, retains the supervisor for the
server lifetime, and rejects malformed, partial, duplicate and live-reloaded
configuration. Disabled mode performs no database work and there is no
in-memory or TypeScript server fallback. PostgreSQL table privileges are
checked as separate all-required `SELECT` and `INSERT` capabilities. The
one-time cold startup scan has a bounded 2 s deadline; the 250 ms per-Call
store ceiling is unchanged.

Local exact-source functional results:

- scoped rustfmt: passed;
- locked Rust library check: passed;
- SipEffect component tests: 133 passed, 0 failed, 11 physical tests ignored;
- Native SIP effect composition tests: 38 passed, 0 failed, 1 physical test ignored;
- patchset/static contract tests: 213 passed, 0 failed;
- G03 closed machine-contract tests: 9 passed, 0 failed;
- repository TypeScript typecheck: passed;
- exact patch replay and seven-file SHA comparison: passed.

The exact ignored Rust/PostgreSQL startup-contract test was then selected by
its fully qualified name and passed `1 / 0` against PostgreSQL 16 with the full
ordered migration chain through 116 and the v2 writer elected.

## Server boundary

The authorized server had only about 4.1 GiB free on `/`, so no Linux RustPBX
compile was attempted. Instead, the already-present exact PostgreSQL 16 image
created one independently labelled temporary container with a 1 GiB memory
limit, one CPU, 768 MiB tmpfs data, bounded logs, no restart policy and no
host-published port. The local exact-source Rust test connected through an SSH
tunnel to the container-private address. The container ran migrations 001–116,
elected schema v2/writer, passed the exact physical adapter test, and was then
destroyed by exact ID/name/label checks.

Before and after the retained successful run, the pre-existing container was
the same full ID
`17d46406fdf328b51ccd39cca5e0f2a48d349a4ebd75771cd3480065fdaac3e6`,
healthy, with zero restarts. Cleanup left one running container and zero `.78`
temporary containers. No existing service process, deployed code, config,
data, volume, image or occupied port was stopped, restarted, overwritten or
deleted. Earlier setup attempts and one pre-fix `PoolTimeout` run ended before
the retained pass and were cleaned; they are not claimed as passing evidence.

Recovered-Call invocation, live Endpoint activation, Linux RustPBX process
execution, real process crash/two-node recovery, production and all load, CPS,
latency, concurrency, capacity, soak, 10K/100K and performance work remain
`not_run`.
