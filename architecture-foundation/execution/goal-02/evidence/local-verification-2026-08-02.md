# G02 local verification evidence — 2026-08-02

## Boundary

- Goal: `goals/goal-02-platform-foundation-security-observability.md`
- Goal SHA-256: `742e194e6b2d3e2b6fe9390bbabe96a6bbe0f40bdf99d8ed4ae4060a711a87f9`
- Tested source commit: `d8cd86458e35b85ea543888ac17c06afee4e0507`
- Branch: `codex/converact-platform-rename`
- Host: macOS 26.2 build 25C56, arm64
- Node.js: `v23.11.0`
- npm: `10.9.2`
- UTC evidence window: 2026-08-01 through 2026-08-02

The full local suite ran from a clean `d8cd86458e35b85ea543888ac17c06afee4e0507`
checkout after all runtime, migration, test, acceptance-harness and generated-schema
review fixes. Later commits add only source-bound evidence and review records. No
production container or production host was used.

## Observed commands and outcomes

| Command scope | Observed outcome |
| --- | --- |
| Run `generate-goal-02.mjs` twice, then require zero generated diff | exit 0; stable output |
| `node --test architecture-foundation/execution/goal-02/goal-02-contract.test.mjs` | 10 passed, 0 failed |
| Billing/receipt/migration/fault/readiness/standalone/delivery closure command | 63 passed, 0 failed |
| Key rotation/readiness/evidence/fault-policy closure command | 30 passed, 0 failed |
| `npm run typecheck` | exit 0 |
| `npm test` | 4,901 tests; 4,886 passed; 0 failed; 15 skipped; 54,904.161 ms; exit 0 |

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

Local verification does not prove process/container, real dependency, long-media,
capacity, recovery or production behavior. The later isolated database restart
campaign is recorded separately in
[database-restart-db-d8cd864-01.md](database-restart-db-d8cd864-01.md); it adds
only real PostgreSQL RLS/restart/reconciliation plus synthetic transport evidence.
Event/object-store faults, real PKI/KMS rotation, DNS/config/AI/GPU/provider
faults, backup/restore, rolling drain, long real media, capacity, region recovery,
native fuzz/sanitizer evidence and production eligibility remain `not_run`.
