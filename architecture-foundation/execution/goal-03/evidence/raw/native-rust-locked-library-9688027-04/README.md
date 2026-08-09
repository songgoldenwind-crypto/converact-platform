# Native Rust locked-library verification

- Status: `verified_controlled`
- Captured: `2026-08-09T05:40:13Z`
- Validation host: `ubuntu@101.42.7.139`
- Canonical parent commit: `9688027e5b72011f38f6b375c1ba59c47375998c`
- Patch SHA-256: `18b7b9ca1248eb63a0c75d83ac231efcb3db4ed9c8c52ec255fd303dbea10f1f`
- Corrected Cargo.lock SHA-256: `ae2fa0bd8475d2d86e810c2288c52bfa59f3cc72e8fde5433eda173652501a9c`

The exact patched RustPBX source was reconstructed from the pinned upstream
commits in a new validation directory. The first strict run stopped before
compilation because the repository copy of `Cargo.lock` did not match the
dependency graph. `pre-lock-fix.log` retains that fail-closed result.

The corrected lock is byte-identical to the lock used by the earlier successful
Linux candidate. With that exact lock, adapter and domain source hashes, and
the same repair-batch patch, `cargo test --locked --lib` completed under the
pinned Rust 1.94 image and 2-CPU/6-GiB limit:

```text
1964 passed; 0 failed; 5 ignored
```

`remote-artifacts.sha256` covers every copied raw output except this local
annotation and itself. The canonical lock and patch remain single-copy build
inputs and are bound by their hashes in `host-manifest.txt` and the repository
contract tests. `verification.txt` records the exact-result checks, and the
value-oriented secret scan found zero sensitive matches.

This evidence proves reproducible locked compilation and the complete native
library suite for the ivekit.53 repair-batch source. It does not prove the four
ignored physical PostgreSQL tests; those remain separately covered by
`native-postgres-repair-batch-9688027-03`. It also does not promote live SIP
authority, real-peer interoperability, long-call, fault/OOM, capacity, Clippy,
or production eligibility.
