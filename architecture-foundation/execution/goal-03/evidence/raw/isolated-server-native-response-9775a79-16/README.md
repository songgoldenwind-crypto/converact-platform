# G03 `.74` isolated Native response functional attempt

Campaign ID: `converact-g03-74-9775a79-functional`

Captured: `2026-08-13T19:18:55Z`
Production eligible: `false`
Performance evidence: `false`

## Scope

This bundle binds Converact Platform commit
`9775a797c32a5112c8d7cc9239a9947db6753b55` and patchset `ivekit.74` to the
pinned RustPBX, rsipstack and rustrtc source identities. The incremental
rsipstack matched-CANCEL patch SHA-256 is
`6175c959d7dde6172efa097bdd98e708c589eceb1273db77a86a3a714102e7f4`;
the RustPBX matched-CANCEL capability patch SHA-256 is
`61d4b66d1a6ebe92d7f451449d461d2f6b9e2c20a6dc5d67e4c982a41d36a15a`;
the RustPBX ordinary response patch SHA-256 is
`3e21ff23a913a75f0d5ab3c7f1517b5c6cbefc93ccbff41a69a5d80307def5b6`.

The patches were applied only to a temporary overlay above the retained `.72`
source tree on `101.42.7.139`. The lower source tree and Cargo cache were
read-only overlay lower layers and were hashed before and after the attempt.
The test container used pinned Rust `1.94.1`, one CPU, one build job, a 3,584
MiB memory/swap ceiling, a 512 PID ceiling, no network, no host port, a
read-only root filesystem, `no-new-privileges` and no Linux capabilities.
Disk, host-memory and existing-container health floors ran concurrently. No
running service or deployed source was used as a writable test target.

## Exact functional result

| Target | Exact result | Classification |
| --- | --- | --- |
| RustPBX Native ordinary response capability tests | no test executed; the RustPBX lib-test binary was not produced because `rustc` reached the isolated 3,584 MiB memory cgroup and received `SIGKILL` | `not_run` |
| RustPBX Native Call domain tests | command not reached | `not_run` |
| RustPBX Active Call registry tests | command not reached | `not_run` |
| RustPBX durable SIP effect gate tests | command not reached | `not_run` |

The campaign exited `101`. Kernel evidence identifies a cgroup-scoped OOM:
`rustc` had 3,539,508 KiB anonymous RSS when the container memory controller
killed it. This is not a Rust test assertion failure and is not reported as a
server functional pass. The already-recorded local exact-source results remain
the only `.74` functional proof.

The memory ceiling was deliberately not raised. Protecting the existing
server workload takes precedence over obtaining an additional result. No
load, CPS, latency, concurrency, capacity, soak or other performance command
ran.

## Zero-impact postflight

The preflight and postflight snapshots of every running container, listener
and active system service are byte-identical with SHA-256
`f2658ced7ef772f592634eae88ce31c436e9d9cc874ab28a913fd255fc6e6cef`.
The retained lower-source manifests are byte-identical with SHA-256
`a1966c92e08652b7efd25def64200bf2d1d808ec487c0b28c605070ed2b997c6`.
The pre-existing `converact-g03-current-pg-7f4cd00c` container remained
running and healthy with restart count zero and the same start time. The test
container, both overlay mounts and the campaign overlay directory were absent
after cleanup.

Root availability was 4,359,752 KiB before the attempt and 4,357,212 KiB in
the final post-cleanup read-only snapshot. The small retained delta is the
campaign control/result evidence; no existing image, volume, cache or source
was deleted to make room.

No existing container, process, deployed source, configuration, database,
volume, image, listener or occupied port was stopped, restarted, overwritten
or deleted.

## Evidence integrity

`functional.log.xz` is the exact secret-scanned compiler log. Its uncompressed
size is 8,567 bytes with SHA-256
`55ac29f769959808fe6672b4603ef60c1bf9c06d50d315e93572afa7bd0428c1`;
the compressed file SHA-256 is
`fb59e7eebe4a21e87478528ebbdd8d76d463ed7ace04b9527ab172f40e3e9eca`.
`kernel-oom.raw.txt` retains the exact cgroup OOM lines.
`server-suite-results.txt` classifies every unexecuted target as `not_run`.
`server-postflight.txt` and `server-postflight.raw.txt` bind the zero-impact
checks. Raw pre/post server, lower-source, disk and memory snapshots are also
retained. `SHA256SUMS` binds every file in this directory.

## Honest boundary

This evidence proves only that the exact `.74` patches applied in a temporary
isolated Linux overlay and that the failed compile attempt left existing
server state and lower source unchanged. It does not prove any `.74` server
functional test, physical PostgreSQL behavior, TCP/WS/TLS/WSS
interoperability, live Endpoint or product activation, successor/restart
recovery, performance or production eligibility. All remain `not_run`.
