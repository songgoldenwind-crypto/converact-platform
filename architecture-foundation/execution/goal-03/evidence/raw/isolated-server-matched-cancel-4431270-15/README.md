# G03 `.73` isolated matched-CANCEL functional evidence

Campaign ID: `converact-g03-73-4431270-functional`

Captured: `2026-08-13T17:24:01Z`
Production eligible: `false`
Performance evidence: `false`

## Scope

This controlled functional bundle binds Converact Platform commit
`4431270bb775458803a2252cb892254afc7aaae7` and patchset `ivekit.73` to the
pinned RustPBX, rsipstack and rustrtc source identities. The incremental
rsipstack matched-CANCEL patch SHA-256 is
`6175c959d7dde6172efa097bdd98e708c589eceb1273db77a86a3a714102e7f4`;
the RustPBX Native Call capability patch SHA-256 is
`61d4b66d1a6ebe92d7f451449d461d2f6b9e2c20a6dc5d67e4c982a41d36a15a`.

The exact patches were applied only to a temporary overlay above the retained
`.72` source tree on `101.42.7.139`. The lower source tree was mounted
read-only through overlayfs and its selected-file manifest was hashed before
and after the run. Cargo used a separate overlay above the existing read-only
cache. The test container used Rust `1.94.1`, one CPU, a 2,560 MiB
memory/swap ceiling, a 512 PID ceiling, no network, no host port, a read-only
root filesystem, `no-new-privileges` and no Linux capabilities. It did not
join, restart or mutate any existing service.

## Exact functional result

| Target | Exact result | Classification |
| --- | --- | --- |
| rsipstack server transaction tests | `32 passed; 0 failed; 282 filtered out` | passed |
| RustPBX Native matched-CANCEL capability tests | no test executed; the RustPBX lib-test binary was not produced because `rustc` received `SIGKILL` at the 2,560 MiB isolated memory ceiling | `not_run` |
| RustPBX durable gate tests | command not reached after the preceding compile termination | `not_run` |
| RustPBX Active Call registry tests | command not reached after the preceding compile termination | `not_run` |
| RustPBX default-disabled builder test | command not reached after the preceding compile termination | `not_run` |

The campaign therefore exited `101`. This is not a RustPBX assertion failure
and is not reported as a complete server pass. The local exact-source RustPBX
library result remains `2063 passed / 0 failed / 9 ignored`; this bundle adds
only the isolated Linux rsipstack `32/32` component result.

The resource ceiling was deliberately not raised after the compile
termination. Protecting the already-running server workload takes precedence
over obtaining an additional test result. No load, CPS, concurrency,
capacity, soak, latency or performance command ran.

## Zero-impact postflight

The preflight and postflight snapshots of all running containers, listeners
and active system services have the same SHA-256
`93c583e335516911fd1a08a3944d05a4b319f3e543466c997535135b87b9936d`.
The retained lower-source manifests have the same SHA-256
`7cdeec68770c2de2c6823ebad07e9a9ffbb119019f524ad2ac4a3efff05c57f5`.
The pre-existing `converact-g03-current-pg-7f4cd00c` container remained
running and healthy with the same container identity, image, start time and
restart count. After cleanup the campaign container and both overlay mounts
were absent, and the campaign-owned overlay directory had been removed.

No existing container, process, deployed source, configuration, database,
volume, image, listener or occupied port was stopped, restarted, overwritten
or deleted.

## Evidence integrity

`functional.log.xz` is the exact secret-scanned server log. Its uncompressed
size is 18,669 bytes with SHA-256
`9fc37ee069b7e3e9deef8d460febd997bf4148bad23bccb88c23625e5a013680`;
the compressed file SHA-256 is
`e92f79e60412d579e888c11273251fc0df641b3ff171f893e3db0cf402a51b3f`.
`server-suite-results.txt` records the result without interpreting the
RustPBX compile termination as a test failure. `server-postflight.txt` binds
the zero-impact checks. The exact pre/post server snapshots and lower-source
manifests are retained as the four `*.raw.*` files; each pair is byte-identical.
`SHA256SUMS` binds every retained file in this bundle.

## Honest boundary

This evidence proves the exact `.73` rsipstack server-transaction component on
the isolated Linux host and proves that the campaign left the existing server
state and retained lower source unchanged. It does not prove the RustPBX
focused targets on that host, physical PostgreSQL, TCP/WS/TLS/WSS
interoperability, successor-safe cleanup, restart reconstruction, live
Endpoint or product activation, process-crash/two-node recovery, performance
or production eligibility. Those items remain `not_run`.
