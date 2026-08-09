# G03 `.61` sealed peer-ingress controlled evidence

Campaign ID: `converact-g03-peer-ingress-proof-701475a-07`

Captured: `2026-08-09T21:55:40Z`
Production eligible: `false`

## Scope

This bundle binds the incremental `.61` exact-source patch to the peer-message
provenance boundary inside rsipstack. Network `TransactionEvent::Received`
events require an opaque, zero-sized proof minted only by the private Endpoint
transport-ingress path. Client response and server ACK tests enter through the
Endpoint path; server-dialog ACK forwarding consumes the proof once; external
code cannot invoke the ingress function or replace the transaction receiver.

The slice adds no heap allocation, global map, global lock or per-message task.
It does **not** prove a live RustPBX endpoint, a release image, a remote SIP
peer, production traffic, long calls, crash recovery, N/N+1 activation, fault
behavior or capacity. Those states remain `not_run`.

## Final controlled results

| Check | Exact result | Artifact |
| --- | --- | --- |
| rsipstack Linux library suite | `303 passed; 0 failed` | `server-rsipstack-peer-ingress-r2.log` |
| rsipstack Linux compile-fail/doctest suite | `67 passed; 0 failed` | `server-rsipstack-peer-ingress-r2.log` |
| RustPBX Linux library suite | `2,002 passed; 0 failed; 8 ignored` | `server-rustpbx-peer-ingress-r2.log` |
| fresh `.60` baseline + `.61` incremental replay | patch applies and reproduces all six exact final files | `verification.txt` |
| old-service preservation postflight | old services stopped and retained; only isolated G03 PostgreSQL running | `host-manifest.txt` |

The eight ignored RustPBX tests require separately selected external
prerequisites and are not counted as proof. No PostgreSQL behavior changed in
this slice, so prior PostgreSQL evidence is not inherited as `.61` evidence.

## Attempt history retained

- rsipstack `r1`: the isolated offline Cargo cache lacked `base64`; no source
  test compiled;
- rsipstack `r2`: the same exact source populated the isolated cache, then
  passed `303/303` library tests and `67/67` doctests;
- RustPBX `r1`: compilation was stopped before tests when a rebuildable
  current-code `target` cache exhausted the system disk;
- RustPBX `r2`: after deleting only that test compilation cache, a clean rebuild
  of the same exact source passed `2,002/0/8`.

The cache deletion did not touch an old service, container, database, release,
source tree or user artifact. It removed only rebuildable files under the
current G03 test copy's `rustpbx/target` directory.

`remote-artifacts.sha256` binds every retained log. No credentials,
authorization headers, private keys or environment dumps are included.

## Server isolation disclosure

During the campaign, pre-existing Metafate MySQL/Mongo containers, nginx and
two PM2 applications were started again by an external mechanism. They were
stopped again using only service-stop operations. No old container, image,
volume, database, service definition, restart policy or source was deleted or
edited. The final listener check exposed SSH only; the isolated PostgreSQL
container has no host-published port.

## Honest boundary

This closes only the component-level ability for ordinary application code to
forge a peer ingress proof. Automatic 200-to-CANCEL, UAS-Core 2xx ACK
ownership, stale nonterminal recovery, live Endpoint composition, transport
flow-generation binding, mixed-version activation, real peer, long-call,
fault/OOM and capacity campaigns remain `not_run`. `G03-E15-REVIEW`,
`G03-E16-NATIVE-AUTHORITY` and production eligibility are not promoted.
