# G03 `.65` Native Call recovery controlled evidence

Campaign ID: `converact-g03-native-call-recovery-1d05333-10`

Captured: `2026-08-10T04:32:05Z`
Production eligible: `false`

## Scope

This bundle binds Converact Platform candidate
`1d05333ba8419b96a480adbe384ef3fd31cec9f3`, RustPBX
`6c49ee76baa54fdbf8f98020cc9bee158c7c15de`, rsipstack
`8318e97b1170de4e5245b120afec1cdf53e3d716` and rustrtc
`166c6d22984429eb6b509920c14fcd69f974f0b3` to patchset `ivekit.65`.

The `.65` slice keeps one authenticated Native Call binding across a reciprocal
two-leg recovery capsule. It preserves tenant, canonical `CallId`, canonical
`InteractionId`, provider call reference, owner epoch, generation and revision;
takeover advances the three fences exactly once. Closed v2 capsules are eligible
to resume this authority. Legacy v1 remains readable but cannot resume it, and an
explicit v1 `native_call_binding: null` is rejected rather than treated as an
absent field.

This bundle also proves that exact-source verification releases only the
temporary RustPBX target after all RustPBX checks, focused tests and the recovery
integration suite have completed, before rsipstack is compiled. That sequencing
reduces peak disk use without deleting any retained server source, service,
container, image, volume, database or user data.

## Final controlled results

| Check | Exact result | Artifact |
| --- | --- | --- |
| exact build process | exit `0`; pinned source replay, rustfmt, `cargo check` and clippy completed | `server-verify.log` |
| RustPBX Linux library suite | `2,015 passed; 0 failed; 8 ignored` | `server-verify.log` |
| focused RustPBX regressions | three independent commands, each `1 passed; 0 failed` | `server-verify.log` |
| reciprocal dialog-shadow integration | `20 passed; 0 failed` | `server-verify.log` |
| rsipstack Linux library suite | `311 passed; 0 failed` | `server-verify.log` |
| rsipstack doctest suite | `67 passed; 0 failed` | `server-verify.log` |
| bounded temporary cleanup | `11,569` generated files and `9.9 GiB` removed after RustPBX verification; rsipstack then completed | `server-verify.log` |
| final old-service state | nginx inactive; all four PM2 applications stopped; only isolated healthy PostgreSQL running with no host port | `server-postflight.txt` |

The eight ignored RustPBX tests require separately selected physical PostgreSQL
prerequisites. They are not counted as passing evidence and are not promoted by
this campaign.

## Environment disclosure

The exact run used a temporary `--rm` Rust 1.94.1 build container on
`ubuntu@101.42.7.139`. The checked-out candidate was retained in the new server
directory `/home/ubuntu/converact-g03-65-1d05333`; older run directories were not
overwritten or deleted. The isolated PostgreSQL container published no host
port. The only externally bound TCP listener in the final capture was SSH.

The first candidate run completed every code test but its top-level command was
rejected because simultaneous RustPBX and rsipstack targets filled the root
filesystem and `tee` returned `No space left on device`. Candidate `1d05333`
therefore added one TDD-locked `cargo clean` at the component boundary. The final
run exited zero and restored root filesystem use to 87%.

During the final run, an external server mechanism restarted nginx and two old
PM2 applications at 12:01 and 12:12 local time. After the run it restarted
nginx, the same PM2 applications, MySQL and MongoDB at about 12:30. Each was
stopped again without deleting or editing it. `server-runtime-drift.txt` records
the journal, Docker and PM2 events. This environmental interference makes the
campaign valid for component correctness only; it is explicitly **not** latency,
throughput, capacity or resource-consumption evidence. The final captured state
is stopped, but a still-external restart mechanism can change that state again.

## Honest boundary

This does not prove a live Native Call Authority wired to production traffic,
real process-crash recovery, two-node takeover, early-dialog recovery,
cross-Adapter recovery, stale `send_attempted`/`transport_accepted` recovery,
transport-flow-generation binding, mixed-binary activation, image/wire
requalification, real peer interoperability, long calls, fault/OOM behavior or
capacity. All remain `not_run`. `G03-E15-REVIEW`,
`G03-E16-NATIVE-AUTHORITY` and production eligibility are not promoted.

`remote-artifacts.sha256` binds every retained raw capture. No credentials,
authorization headers, private keys, tokens, secret values or environment dumps
are included.
