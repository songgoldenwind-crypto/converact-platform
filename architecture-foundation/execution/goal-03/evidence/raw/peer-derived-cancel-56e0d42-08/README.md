# G03 `.62` peer-derived CANCEL controlled evidence

Campaign ID: `converact-g03-peer-derived-cancel-56e0d42-08`

Captured: `2026-08-09T23:08:58Z`
Production eligible: `false`

## Scope

This bundle binds candidate `56e0d429c22b4b428433f774c35e0da19784d631`
and the two incremental `.62` exact-source patches to the matched
server-INVITE CANCEL response path. A pre-registered, bounded
`ServerInviteCancelOk` capability and an opaque Endpoint peer-ingress proof are
both required before the transaction can send one durable 200 response.

The component path verifies the server transaction, CANCEL and response
headers, exact finalized bytes and transport binding. It consumes the
capability once, freezes one stable To-tag and response image for duplicate
CANCEL replay, records transport ambiguity as Unknown exactly once and keeps
`transport_completed` distinct from peer `protocol_observed`. It reuses the
existing fixed-shard queues, semaphores and atomic prepare-for-send boundary;
it adds no per-effect task, global scan, unbounded channel or media-path work.

It does **not** prove a live Call Core capability holder, live Endpoint
composition, restart/reconcile resumption, UAS-Core 2xx ownership, exact `.62`
release image, remote SIP peer, production traffic, long call, rolling
activation, fault/OOM behavior or capacity. Those states remain `not_run`.

## Final controlled results

| Check | Exact result | Artifact |
| --- | --- | --- |
| `.61` server baseline + `.62` incremental replay | both patches pass dry-run, apply once and reproduce all five expected final source hashes | `server-incremental-patch-apply.log` |
| rsipstack Linux library suite | `306 passed; 0 failed` | `server-rsipstack-full.log` |
| rsipstack Linux compile-fail/doctest suite | `67 passed; 0 failed` | `server-rsipstack-full.log` |
| RustPBX Linux library suite | `2,006 passed; 0 failed; 8 ignored` | `server-rustpbx-lib.log` |
| focused RustPBX peer-derived path | all four capability, mismatch, replay and commit-ambiguity tests passed inside the full suite | `server-rustpbx-lib.log` |
| old-service preservation postflight | all old application containers/services stopped and retained; only isolated G03 PostgreSQL running | `host-manifest.txt` |

The eight ignored RustPBX tests require separately selected external
prerequisites and are not counted as proof. This slice changes no PostgreSQL
schema or physical transition implementation, so earlier PostgreSQL results
are not inherited as `.62` evidence.

## Execution disclosure

Both Rust suites ran only in temporary `--rm` containers on
`ubuntu@101.42.7.139`, using the pinned Rust 1.94.1 image and the isolated
current-code source. The server had a cold Cargo registry, so dependency fetch
and linking dominated elapsed wall time. The RustPBX test binary emitted its
complete success summary and the container exited before the local streaming
session was closed; the retained server-side log and its SHA-256, rather than
that client stream's exit status, are the evidence.

The build reused only the rebuildable G03 Cargo target cache. After all raw
logs and hashes were frozen, `cargo clean` removed that task-only cache
(`14,965` generated files; Cargo reported `9.1 GiB`) and restored server disk
use from 97% to 86%. The cache is recoverable from the retained exact source.
No old service, container, image, volume, database, release, restart policy,
configuration, source tree or user artifact was deleted or edited. nginx and
all four PM2 applications remained stopped. The only externally bound TCP
listener at postflight was SSH; the isolated PostgreSQL container publishes no
host port.

`remote-artifacts.sha256` binds every retained raw log. No credentials,
authorization headers, private keys, secret values or environment dumps are
included.

## Honest boundary

This closes only component-level ownership and exact-source behavior for the
matched CANCEL 200 response. Call Core registration, live Endpoint composition
and durable resume after reconciliation remain absent, so the path stays
default-disabled. UAS-Core 2xx ACK ownership, parent-Unknown and stale
nonterminal recovery, flow-generation binding, mixed-binary activation,
real-peer, long-call, fault/OOM and capacity campaigns remain `not_run`.
`G03-E15-REVIEW`, `G03-E16-NATIVE-AUTHORITY` and production eligibility are
not promoted.
