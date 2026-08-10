# G03 `.71` exact-source Linux suite evidence

Campaign ID: `converact-g03-full-linux-suites-1ebbd76-13`

Captured: `2026-08-10T10:43:17Z`
Production eligible: `false`

## Scope

This controlled bundle binds Converact Platform source
`1ebbd765c3e88ef157fde54bed9e4680aa708da3`, RustPBX
`6c49ee76baa54fdbf8f98020cc9bee158c7c15de`, rsipstack
`8318e97b1170de4e5245b120afec1cdf53e3d716` and rustrtc
`166c6d22984429eb6b509920c14fcd69f974f0b3` to patchset `ivekit.71`.
The complete patch-set SHA-256 is
`c2418d9f593072494e65a7b147e728a56437cf6d532b2e7d28a7a56d337bf8cc`;
the incremental fixed-observer patch SHA-256 is
`2696e60841b554c327d1fedc619f6fed3f8e391daa03f5528759c4ea0f8c2047`.

The exact patched sources were compiled and tested on `101.42.7.139` with
Rust `1.94.1`, two CPU cores, a 6,500 MiB memory/swap ceiling and a 1,024 PID
ceiling. The pinned builder was
`rust:1.94-bookworm@sha256:6ae102bdbf528294bc79ad6e1fae682f6f7c2a6e6621506ba959f9685b308a55`.
No test container exposed a host port.

## Exact results

| Suite | Exact result | Exit | OOM |
| --- | --- | --- | --- |
| scoped Rust formatting | passed for all RustPBX and rsipstack files selected by the committed `.71` build script | `0` | `false` while observed |
| RustPBX `cargo check` | passed; `6m 28s` | `0` | `false` while observed |
| RustPBX Clippy gate | passed the committed non-deny `--no-deps` gate; `216` warnings; `2m 23s` | `0` | `false` while observed |
| RustPBX library | `2,022 passed; 0 failed; 9 ignored`; `2,031` total; `262.35s` | `0` | `false` while observed |
| three focused RustPBX regressions | `3 passed; 0 failed` | `0` | `false` while observed |
| dialog-shadow integration | `20 passed; 0 failed`; `0.32s` | `0` | `false` while observed |
| rsipstack library | `311 passed; 0 failed; 0 ignored`; `4.39s` | `0` | `false` |
| rsipstack compile-fail/doctest | `67 passed; 0 failed; 0 ignored`; `5.40s` | `0` | `false` |

The committed verify-only build script completed formatting, `cargo check`,
the configured Clippy gate, the complete RustPBX library suite, the three
focused regressions and the dialog-shadow integration suite. It then removed
`11,567` target files (`9.9 GiB`) and stopped with exit `101` because the first
isolated offline cache omitted the public archive `zerocopy-derive 0.8.55`.
That is a dependency-cache failure after the listed successful suites, not a
RustPBX or rsipstack test failure.

The exact missing archive was fetched against rsipstack's committed
`Cargo.lock`; its Cargo checksum is
`0fe976fb70c78cd64cccfe3a6fc142244e8a77b70959b30faf9d0ac37ee228eb`.
A local `cargo fetch --locked` then closed the exact lock set with one new
download. The server reran the final rsipstack target in the same pinned image,
with the same source commit, 18 patches in committed build-script order,
lockfile, resource limits and now-complete cache. That run was fully offline
and exited `0` with the results above.

A redundant whole-script retry was operator-stopped with exit `137` while a
fresh ephemeral builder waited for the network-only `rustfmt/clippy` component
download. It had not reached formatting or compilation and was not an OOM or
test result. Its raw log is retained rather than hidden.

## Evidence integrity

The three secret-scanned raw logs are retained as `.xz` files. Their
uncompressed and compressed SHA-256 values, exact container metadata and test
summaries are in `server-suite-results.txt`. `cargo-cache-manifest.sha256`
binds all 1,145 public `.crate` archives used by the controlled run;
`dependency-cache-verification.txt` binds the source bundles, locks and cache
repair. `SHA256SUMS` binds the complete evidence directory.

## Honest boundary

This is an exact-source, default-disabled component requalification. It proves
that the `.71` patch chain compiles on the controlled Linux host and that its
complete RustPBX library, selected integration and rsipstack test targets pass.
The committed Clippy command does not use `-D warnings`; 216 existing warnings
mean this evidence must not be described as strict warning-free Clippy.

This campaign does not prove live Call Core intent/capability registration,
live Endpoint composition, reconciler supervision, a real observer or UAS
owner process crash, parent-Unknown recovery, two-node takeover, mixed-binary
activation, image/wire requalification, fault/OOM isolation, latency,
allocations, throughput, long-call behavior, multi-core scaling or production
eligibility.

`G03-E10-FAULT`, `G03-E13-PERFORMANCE`, `G03-E15-REVIEW`,
`G03-E16-NATIVE-AUTHORITY` and production eligibility remain `not_run`/false.

No credential, authorization header, private key, token value, database URL,
secret value or environment dump is retained in this bundle.
