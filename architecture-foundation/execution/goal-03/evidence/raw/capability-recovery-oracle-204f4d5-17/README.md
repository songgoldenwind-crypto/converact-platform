# G03 `.77` isolated capability-recovery PostgreSQL functional evidence

Campaign ID: `converact-g03-77-204f4d5-physical`

Captured: `2026-08-13T22:21:18Z`
Production eligible: `false`
Performance evidence: `false`

## Scope

This bundle binds the uncommitted `ivekit.77` candidate above Converact
Platform base commit `204f4d562299` to:

- RustPBX capability-recovery oracle patch SHA-256
  `a56d3bbe49da1cc6f3acfc6d2e3958e21c71a502134d5da6f5f3ec1c2592a3b3`;
- migration `116_converact_sip_capability_recovery_fence.sql` SHA-256
  `69eb22f100587136a9ce512dae578ab3b51d1ef515e863524079035829eb374a`;
- exact physical SQL harness SHA-256
  `aee4e258a00e37c6bfc7b4e3ab6e82f8960136e603a84f0aa80a71dc07b7da4e`.

The server test used a disposable PostgreSQL 16 container named
`converact-g03-77-pg-204f4d5-physical2`, with `--network none`, no host
ports, a tmpfs database and read-only migration/harness mounts. It did not
mount, alter or connect to the pre-existing service.

## Exact functional result

| Target | Exact result | Classification |
| --- | --- | --- |
| Full ordered migration chain through migration 116 | completed successfully in isolated PostgreSQL 16 | passed |
| No-visible predecessor effect | a pre-existing `durable_decision` remained non-wire-visible; successor session fence and immutable replay receipt verified | passed |
| Pre-existing old-owner effect after takeover | first transition to `send_attempted` was rejected with SQLSTATE `55000`; the attempted receipt and transition rolled back together | passed |
| Visible/ambiguous predecessor effect | exact two-key detection and fail-closed result verified | passed |
| Old-binary direct effect insert after successor takeover | database trigger rejected stale owner/generation with SQLSTATE `55000` | passed |
| Receipt replay/immutability | deterministic replay accepted and mutation rejected | passed |
| Tenant isolation | executor RLS exposed only the configured tenant | passed |
| Rust adapter physical PostgreSQL ignored tests | not executed on the server | `not_run` |
| Live Endpoint/Call Core activation | not executed | `not_run` |

The final physical harness ended with
`g03_77_capability_recovery_physical_passed`. Earlier disposable setup
attempts, including an initialization-readiness race during this rerun,
stopped before the retained harness. They were automatically cleaned, their
logs are not retained, and they are not claimed as evidence. The retained
attempt pre-created the production fixture roles, ran the complete migration
chain and then ran the exact retained harness.

No Rust compilation was attempted on this server. Root storage was already at
95%, and protecting the existing workload took precedence. Local exact-source
Rust tests are separate component evidence; this bundle proves only the
physical SQL/migration behavior listed above.

## Existing-service isolation

Before the test, the pre-existing container was:

`17d46406fdf3 converact-g03-current-pg-7f4cd00c Up 4 days (healthy)`.

The temporary container was independently identified, used `network=none`
and exposed no ports. Cleanup asserted its exact name and network mode before
stopping and deleting only that temporary container and its exact
`/dev/shm/converact-g03-77-204f4d5-physical2` directory.

After cleanup, the server's running-container list contained only:

`17d46406fdf3 converact-g03-current-pg-7f4cd00c Up 4 days (healthy)`.

No existing container, service, deployed code, configuration, data, volume,
image, listener or occupied port was stopped, restarted, overwritten or
deleted.

## Evidence integrity

`migrations.log.xz` contains the exact secret-scanned 75,098-byte migration
log. Its uncompressed SHA-256 is
`498c5b89b75bc8bac0ac248d454967c55437c2f6fc28156f9c04a6493f18c9c2`;
the compressed file SHA-256 is
`b2f925c6ae1fea82f28e70186438e4241f2c42a9f6b613e259bc41d0a0d55bcf`.
`physical.log`, `physical.sql`, and the pre/post-cleanup snapshots retain
the exact functional output, harness and server boundaries. `SHA256SUMS`
binds every retained file.

The secret scan matched only schema identifiers containing
`authorization` and PostgreSQL `SET SESSION AUTHORIZATION` statements; it
found no credential value, bearer token, API key or private key.

## Honest boundary

This is component-level, isolated PostgreSQL functional evidence. It is not a
live-service test, Native Call/Endpoint activation proof, Rust adapter
physical-test proof, crash/two-node takeover proof, performance result or
production-eligibility claim. Load, CPS, latency, concurrency, capacity,
soak and 100K tests were intentionally not run. Every such item remains
`not_run`.
