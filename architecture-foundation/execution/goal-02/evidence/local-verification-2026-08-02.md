# G02 local verification evidence — 2026-08-02

## Boundary

- Goal: `goals/goal-02-platform-foundation-security-observability.md`
- Goal SHA-256: `742e194e6b2d3e2b6fe9390bbabe96a6bbe0f40bdf99d8ed4ae4060a711a87f9`
- Tested source commit: `fd20d37b2ae6c973e38a91569694ced66f0e75f7`
- Branch: `codex/converact-platform-rename`
- Host: macOS 26.2 build 25C56, arm64
- Node.js: `v23.11.0`
- npm: `10.9.2`
- UTC evidence window: 2026-08-01

The working-tree-only changes during the accepted runs were G02 generated documentation and did not alter the
tested runtime or test sources. No production container or production host was used.

## Observed commands and outcomes

| Command scope | Observed outcome |
| --- | --- |
| Run `generate-goal-02.mjs` twice and hash the seven generated contracts/maps | exit 0; both runs produced identical SHA-256 values |
| `node --test architecture-foundation/execution/goal-02/goal-02-contract.test.mjs` | 9 passed, 0 failed |
| All 14 `test/converact-platform-*.test.ts` files with `--test-concurrency=1` | 80 passed, 0 failed |
| Impacted auth, tenant, consent, retention, event, audit, receipt, billing, key, telemetry, readiness, placement and worker suites | 255 passed, 0 failed |
| Migration/checksum/standalone/readiness/SIP effect/delivery focused suites | 103 passed, 0 failed |
| Recording consent regression, recording-storage isolation and source-ledger closure | 8 passed, 0 failed |
| `npm run typecheck` | exit 0 |
| `npm test` after resolving the two discovered regressions | 4,879 tests; 4,864 passed; 0 failed; 15 skipped; 52,601.637 ms; exit 0 |

The first full-suite diagnostic run found three failures: one stale README closure hash and two transfer-recording
tests whose setup lacked the newly required durable consent and whose caller omitted the authoritative tenant when
evaluating consent. The closure was refreshed, the caller now binds its authenticated tenant, and the integration
fixtures write explicit granted consent. Focused reproduction and the final full suite then passed.

## Proven local scope

- Pure fail-closed identity and consent decisions, including tenant/capability/purpose/revocation boundaries.
- Deterministic N/N-1 event decode, inbox decisions, effect Receipt stages and immutable usage reconstruction.
- Tenant-scoped SQL/query shape, bounded claims, additive migration order, FORCE RLS declarations and readiness floor.
- Local key/certificate/native safety policy, redaction/cardinality, wall/monotonic clocks and bounded admission.
- Recording consent failure denies new capture without terminating established media control state.

## Explicit non-claims

At this local-verification checkpoint, actual PostgreSQL RLS enforcement, process crash boundaries,
event/object-store faults, real PKI/KMS rotation, DNS/config/AI/GPU/provider faults, backup/restore, rolling drain,
long real media, capacity, region recovery, native fuzz/sanitizer evidence and production eligibility were
`not_run`. The later isolated database restart campaign is recorded separately in
[database-restart-db-4fc7b59-01.md](database-restart-db-4fc7b59-01.md); it verifies only that controlled PostgreSQL
scenario. Every other listed campaign remains `not_run`, and neither record proves production behavior.
