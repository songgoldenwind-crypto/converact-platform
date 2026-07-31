# iveKit RustDesk Server 1.1.16 Owner Overlay

This exact-release overlay keeps the upstream RustDesk rendezvous and relay
protocol intact while adding Cell ownership at connection establishment:

- hbbs claims the prepared target binding before forwarding `RequestRelay`;
- hbbr opens or checks the relay owner before UUID pairing;
- the accepted owner epoch and node lease stay in process memory;
- RustDesk's existing three-second relay timer checks only that in-process
  cache and terminates a stale relay without parsing remote-control traffic;
- the relay byte-copy loop does not call HTTP, PostgreSQL, NATS, Redis, or the
  binding broker;
- pending UUID timeouts and completed relay sessions close their exact owner.

The owner hook is opt-in. With all `IVEKIT_*` owner variables unset and
`IVEKIT_OWNER_GUARD_REQUIRED=0`, hbbs and hbbr preserve upstream behavior and
perform no owner-broker or component-node requests. A partial owner
configuration fails startup instead of silently running without fencing.

The stable RustDesk node is one paired hbbs/hbbr pod. Placement returns that
pod's public ID and relay endpoints; a random load-balanced RustDesk service is
not an ownership boundary.

The overlay is pinned to root tag `1.1.16`, commit
`73523b31cfd25d77dee862e6fc9f5e1fb5e485ef`, and `libs/hbb_common` commit
`83419b6549636ee39dacef7776c473f5802e08d6`. On a clean checkout, the owner
overlay plus `patches/rustdesk-server-ivekit-relay-hot-path.patch` applies
idempotently and `cargo test --locked --all-features` passes against the exact root and
submodule identities.

The 1.1.16 rebase also carries the upstream unauthenticated UDP punch-hole
reflection/amplification fix. The iveKit overlay does not weaken or bypass that
upstream validation path.

The relay hot-path patch makes two bounded changes:

- `USAGE` registers one `Arc<UsageCounters>` per paired relay, then relay
  timers update sequence-fenced atomics without taking the global session-map
  write lock or cloning the session ID;
- raw TCP freezes its receive buffer and WebSocket keeps its incoming `Vec`;
  same-protocol forwarding moves that owned frame, while mixed-protocol
  forwarding converts only at the protocol boundary.

The patch retains owner checks, timeout, limiter, blacklist, file-traffic and
management snapshot semantics. Run the operation-only benchmark with:

```bash
infra/converact/rustdesk-server/bench/run.sh
```

Three Apple M5 runs against the superseded 1.1.15 source measured the global usage-map lower bound at
`34.14-35.41 ns/op` versus `3.53-3.59 ns/op` for the sequence-fenced counters,
and a 64 KiB WebSocket receive-and-forward allocation path at
`4003.95-4084.75 ns/op` versus `1029.67-1168.72 ns/op` for owned frames. The
baseline uses a standard-library lock and therefore understates the cost of
the old asynchronous global write. These are operation-level measurements,
not relay throughput, node density, Cell capacity, Windows correctness, or a
1.1.16 benchmark. They remain historical optimization evidence only.

The repository now defines the candidate image
`ghcr.io/songgoldenwind-crypto/opc-rustdesk-server:1.1.16-ivekit.1-73523b31`.
Its workflow verifies the exact root and submodule identities, builds and tests
the source, performs binary smoke checks, publishes by digest, and delegates
SBOM, Trivy, Cosign and provenance checks to the shared OCI release gate. That
workflow and registry publication have not run yet, so no immutable digest or
1.1.16 image result is claimed. The Dockerfile runs as UID/GID `10001`, and the
Compose/Helm contracts mount writable state at `/data`.

The previous local 1.1.15 arm64 image and its digest remain superseded
historical evidence; they are not deployable proof for this release. Registry
digest, SBOM/signature/provenance, two-Windows relay acceptance, real
desktop/file traces, reconnect and physical capacity remain `not_run`.
