# RM01 R0 Runtime Health Evidence

This directory records the offline functional evidence for the first Rust
vertical slice. It does not authorize traffic routing or make a production,
capacity, availability, server or performance claim.

## State separation

| State | Result | Evidence |
| --- | --- | --- |
| Current TypeScript contract | `passed` | The active `/livez`, `/readyz` and `/health` implementation produced every frozen vector in `runtime-health-v1.json`. |
| Target Rust contract | `passed` | Rust replay produced the same status, body bytes and explicit legacy headers for every frozen vector. Target-only source/build/failure headers passed separately. |
| Rust process lifecycle | `passed_offline` | HTTP requests and fixed-capacity health child tasks were cancelled and drained within configured test deadlines. |
| Production traffic route | `not_run` | No AuthorityRoute or running deployment was changed. |
| Server/container validation | `not_run` | RM01 forbids touching the running server. |
| Performance/capacity/HA qualification | `not_run` | Deferred to the separate qualification Goal. |

## Frozen boundary

- The legacy adapter preserves the current JSON byte order, status codes and
  explicit response headers.
- The target adapter adds exact build version, exact 40-character source
  commit and stable bounded readiness-failure headers without changing the
  JSON body contract.
- Runtime readiness starts closed. Only a complete validated dependency
  snapshot can make it ready; every publication has a bounded monotonic TTL and
  a stalled publisher automatically fails closed.
- Runtime source identity comes from a build-time embedded commit. A runtime
  declaration is only an attestation and must match the embedded value exactly.
- Wire-visible diagnostics use field-specific identifier grammars, and numeric
  values must round-trip through the TypeScript safe-integer domain.
- Liveness never invokes or depends on PostgreSQL, NATS or object storage.
- Health background work has a fixed task limit. Shutdown rejects new work,
  signals cooperative tasks, aborts deadline stragglers and drains every join.
- The obsolete bootstrap bit-mask readiness implementation was removed so the
  process has one in-memory readiness authority.
- Startup telemetry binds service/build/source plus validated Tenant and Cell
  identity.

The non-routed bootstrap process intentionally remains not-ready until a later
durable-foundation slice installs real PostgreSQL/migration/provider probes.
No synthetic success publisher is used to make the development binary appear
ready.

Exact current and target source hashes are in `source-manifest.json`. Command
results and explicit `not_run` gates are in `verification.json`. Independent
review findings and their final disposition are in `independent-review.json`.
