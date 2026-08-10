# G03 `.72` focused Linux SipEffect evidence

Campaign ID: `focused-linux-sip-effect-b3c9da0-14`

Captured: `2026-08-10T13:57:26Z`
Production eligible: `false`

## Scope

This controlled bundle binds Converact Platform commit
`b3c9da0930c30ca89c1ab3883113c045f9dc6625` and patchset `ivekit.72` to
the pinned RustPBX `6c49ee76baa54fdbf8f98020cc9bee158c7c15de`, rsipstack
`8318e97b1170de4e5245b120afec1cdf53e3d716` and rustrtc
`166c6d22984429eb6b509920c14fcd69f974f0b3` source chain. The incremental
fixed-observer patch SHA-256 is
`2696e60841b554c327d1fedc619f6fed3f8e391daa03f5528759c4ea0f8c2047`;
the incremental exact-target reconciler patch SHA-256 is
`d44e26c6346634dff00cc014f5c3ae5f5ef33a762268f25482e9a0b70176fa75`.
`source-sha256.txt` binds the four affected Rust files and the committed
`Cargo.lock` after both patches were applied.

The tests ran offline on `101.42.7.139` in
`converact/rust-builder-g03-66-tools:1.94.1`, image ID
`sha256:4df8cb252e4a2785eedd5051bcb2a6a14af3c7cb0d6cb8f3ca3e39e66d256eab`.
The container had two CPUs, a 6 GiB memory ceiling, a 2,048 PID ceiling and
no network. No host port was exposed. The root-filesystem stop floor was
3 GiB; 6,114,258,944 bytes remained after the successful run.

## Exact results

| Target | Exact result | Exit | OOM |
| --- | --- | --- | --- |
| scoped Rust formatting | the four `.72` Rust files passed | `0` | `false` |
| reconciler supervisor | `28 passed; 0 failed; 0 ignored` | `0` | `false` |
| affected SipEffect suite | `87 passed; 0 failed; 8 ignored` | `0` | `false` |

The eight ignored tests all retain their explicit isolated migrated
PostgreSQL prerequisite. This campaign did not silently convert them into a
pass or inherit earlier database evidence.

The first container exited `101` before compilation because it mounted the
server's rsproxy source-only cache as `CARGO_HOME`; offline Cargo therefore
could not resolve `anyhow`. `focused-linux.log` and
`container-r1-state.txt` retain that environmental preflight failure. The
second container mounted the complete Rust 1.94 crates.io cache, remained
offline, compiled the exact local RustPBX/rsipstack/rustrtc sources and exited
`0`. It was not an OOM retry and did not use network fallback.

## Evidence integrity

`focused-linux-r2.log` is the complete successful output and
`focused-linux-r2.log.xz` is its compressed copy. `server-suite-results.txt`,
the two container-state files, `server-postflight.txt` and
`source-sha256.txt` preserve the summary, environment and exact-source facts.
`SHA256SUMS` binds every downloaded raw artifact. A local
`sha256sum -c SHA256SUMS` passed before this bundle was committed.

## Honest boundary

This is focused, default-disabled component requalification only. It proves
the `.72` reconciler and affected SipEffect tests compile and pass on the
authorized Linux host. It is not the committed full verify-only suite and
does not prove the durable grant issuer, physical PostgreSQL exact-target
claim/rollback, durable completion sink, live Endpoint activation, process
crash, two-node takeover, fault/OOM campaign, performance, capacity or
production eligibility.

`G03-E10-FAULT`, `G03-E13-PERFORMANCE`, `G03-E15-REVIEW`,
`G03-E16-NATIVE-AUTHORITY` and production eligibility remain
`not_run`/false.

The authorized server's older OPC, RustPBX, LiveKit and related application
containers remained stopped. The isolated Goal 03 PostgreSQL test container
remained healthy. No credential, authorization header, private key, token,
database URL, secret value or environment dump is retained in this bundle.
