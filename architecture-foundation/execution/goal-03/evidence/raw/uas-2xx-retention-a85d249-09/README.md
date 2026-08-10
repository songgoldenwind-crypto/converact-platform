# G03 `.64` UAS 2xx owner-retention controlled evidence

Campaign ID: `converact-g03-uas-2xx-retention-a85d249-09`

Captured: `2026-08-10T00:52:03Z`
Production eligible: `false`

## Scope

This bundle binds candidate `a85d24965f00767bb79a7c0546be71f97d1d8e45`
and the two incremental `.64` exact-source patches to the server-INVITE 2xx
owner-retention path. It supersedes the rejected `.63` host candidate, whose
full RustPBX build exposed an uncovered `Uas2xxDeadlineExpired` outcome.

The component path retains one application-authorized `ServerInvite2xxOwner`
through the RustPBX transaction lifetime, returns a typed deadline outcome and
terminates an initial 2xx transport failure as `TransportError`. It continues
to use the shared rsipstack timer heap and the existing bounded durable effect
adapter. It adds no per-call task, unbounded queue, global scan, duplicate wire
allocation or media-path work.

It does **not** prove live Call Core capability registration, live Endpoint
composition, process-crash recovery of the in-memory owner, reconciliation
resumption, an exact `.64` release image, remote SIP peer, production traffic,
long call, rolling activation, fault/OOM behavior or capacity. Those states
remain `not_run`.

## Final controlled results

| Check | Exact result | Artifact |
| --- | --- | --- |
| `.63` server source + `.64` incremental replay | both patches pass dry-run, apply once and reproduce all six expected final source hashes | `server-incremental-patch-apply.log` |
| rsipstack Linux library suite | `311 passed; 0 failed` | `server-rsipstack-full.log` |
| rsipstack Linux compile-fail/doctest suite | `67 passed; 0 failed` | `server-rsipstack-full.log` |
| RustPBX Linux library suite | `2,008 passed; 0 failed; 8 ignored` | `server-rustpbx-lib.log` |
| old-service preservation postflight | all old application containers/services stopped and retained; only the isolated current-G03 PostgreSQL remained running | `host-manifest.txt` |

The eight ignored RustPBX tests require separately selected external
prerequisites and are not counted as proof. This slice changes no PostgreSQL
schema or durable transition implementation, so earlier PostgreSQL results are
not inherited as `.64` evidence.

## Execution disclosure

Both Rust suites ran only in temporary `--rm` containers on
`ubuntu@101.42.7.139`, using the pinned Rust 1.94.1 image and isolated `.64`
current-code source. RustPBX reused only the rebuildable current-G03 Cargo
target cache; no old application source or service volume was mounted.

After the raw test summaries were frozen, the target contained `7,443`
generated files and `4,953,681,609` bytes. `cargo clean` removed all generated
contents, then returned exit `101` because Docker correctly refused its final
attempt to remove `/shared-target`, which was the active bind-mount root. A
read-only postcheck found `0` files and `0` bytes in the target and server disk
use fell from 92% to 86%. No follow-up `rm` was used.

No old service, container, image, volume, database, release, restart policy,
configuration, source tree or user artifact was deleted or edited. nginx and
all four PM2 applications remained stopped. The only externally bound TCP
listener at postflight was SSH; the isolated PostgreSQL container publishes no
host port.

`remote-artifacts.sha256` binds every retained raw log. No credentials,
authorization headers, private keys, secret values or environment dumps are
included.

## Honest boundary

This closes only exact-source compilation and component behavior for retaining
the UAS 2xx owner through the product transaction. The native durable gate is
still default-disabled. Live Call Core/Endpoint composition, stale
`send_attempted`/`transport_accepted` recovery, UAS-owner crash recovery,
transport-flow-generation binding, mixed-binary activation, real-peer,
long-call, fault/OOM and capacity campaigns remain `not_run`.
`G03-E15-REVIEW`, `G03-E16-NATIVE-AUTHORITY` and production eligibility are
not promoted.
