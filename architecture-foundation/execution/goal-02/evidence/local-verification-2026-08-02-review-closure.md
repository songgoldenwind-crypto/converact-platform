# G02 local verification evidence — 2026-08-02 review closure

## Boundary

- Goal: `goals/goal-02-platform-foundation-security-observability.md`
- Goal SHA-256: `742e194e6b2d3e2b6fe9390bbabe96a6bbe0f40bdf99d8ed4ae4060a711a87f9`
- Tested source commit: `1674eacfd6c56c23d1fbb7dcf082fb2054aec40f`
- Branch: `codex/converact-platform-rename`
- Host: macOS 26.2 build 25C56, arm64
- Node.js: `v23.11.0`
- npm: `10.9.2`
- UTC evidence date: 2026-08-02

The complete local suite ran after closing the final independent-review findings
in inbox ordering, Effect writer fencing, JWKS lifecycle wiring, readiness
admission, metric label cardinality, and raw-evidence retention. The tested
source includes the minimal deterministic Python sidecar health-test bind fix.
Later commits may add only generated indexes, evidence and review records; they
must not be represented as runtime-tested source.

## Observed commands and outcomes

| Command scope | Observed outcome |
| --- | --- |
| `npm run typecheck` | exit 0 |
| G02 review-closure focused command | 127 passed, 0 failed; 1,254.62825 ms |
| `npm test` | 4,905 tests; 4,890 passed; 0 failed; 15 skipped; 52,980.349 ms; exit 0 |
| Full local log | SHA-256 `19b522a6ac2454e653e871cfa86acc85b1e203c32ec0973f3659c0852f326db4` |

The preceding full-suite run exposed one deterministic local-only failure:
the Python AI-worker health server bound to `0.0.0.0`, which can block on
macOS reverse-name lookup. Production behavior remains unchanged: the worker's
default host is still `0.0.0.0`. The test now explicitly sets
`HOST=127.0.0.1`; its focused six-test suite and the final full suite passed.

## Proven local scope

- Fail-closed tenant identity and consent decisions, including complete RS256
  identity claims, bounded JWKS startup/periodic/unknown-key refresh, and
  revocation/policy epochs.
- Deterministic N/N-1 event decode plus transaction-serialized ordering:
  idempotent exact replay, stale no-op receipt, gap reconcile and same-revision
  conflict.
- Effect Receipt stage ordering, immutable usage reconstruction and writer
  changes fenced by owner-epoch advance.
- Tenant-scoped bounded PostgreSQL access, additive migration order, FORCE RLS
  declarations and one reusable readiness probe wave under caller timeout.
- Explicit finite metric label allowlists, redaction, monotonic/wall clock
  boundaries and bounded exporter/admission behavior.
- Recording-consent failure denies new capture without terminating established
  Human Communication.

## Controlled evidence and exact-source boundary

The isolated database restart campaign is recorded separately in
[database-restart-db-9166ad9-01.md](database-restart-db-9166ad9-01.md). Its
runtime source is exactly `9166ad93f626d47b823383677868131fcfb2015f`.
The later `1674eac` source changes are evidence retention and a test-only
loopback bind selection; the campaign is not relabelled as having run those
later commits.

## Explicit non-claims

Local verification does not prove process/container, all real dependencies,
long-media, capacity, restore, rolling drain, region recovery, DR or production
behavior. The controlled database campaign adds only real PostgreSQL
RLS/restart/reconciliation plus synthetic transport evidence. Event/object-store
faults, real PKI/KMS rotation, DNS/config/AI/GPU/provider faults, backup/restore,
rolling active-zero drain, long real media, capacity, region recovery, native
fuzz/sanitizer evidence and production eligibility remain `not_run`.
