# G02 local verification evidence — final runtime source

## Boundary

- Goal: `goals/goal-02-platform-foundation-security-observability.md`
- Goal SHA-256: `742e194e6b2d3e2b6fe9390bbabe96a6bbe0f40bdf99d8ed4ae4060a711a87f9`
- Tested source commit: `86bf9255f7be597677bc3fb086e824b50db782eb`
- Branch: `codex/converact-platform-rename`
- Host: macOS 26.2 build 25C56, arm64
- Node.js: `v23.11.0`
- npm: `10.9.2`
- UTC evidence date: 2026-08-02

This exact runtime source closes the final independent-review findings: effect
takeover serialization, bounded and recoverable readiness waves, process-wide
metric-policy cardinality, streaming bounded JWKS reads, and deterministic
release of both streamed and declared-oversized JWKS bodies. Evidence-only
commits after this record do not change the tested runtime.

## Observed outcomes

| Command scope | Outcome |
| --- | --- |
| JWKS auth command | 20 passed, 0 failed |
| `npm run typecheck` | exit 0 |
| `npm test` | 4,910 tests; 4,895 passed; 0 failed; 15 skipped; 52,885.083375 ms |
| Full log | 470,915 bytes; 5,431 lines; SHA-256 `fae845ed49536f7e2102d2307d8214376b3a1523e57a324ae6bdef5418efc8ec` |

The raw full-suite log passed the bounded secret scanner before deterministic
compression. Four repository-retained base64 fragments reconstruct its XZ
stream and reproduce the raw hash; see
`evidence/raw/local-verification-86bf925/README.md`.

## Proven local scope

- Complete fail-closed HS256/RS256 platform identity, tenant, policy and
  revocation claims; JWKS startup, periodic and unknown-key refresh; response
  deadline and stream byte budget.
- Event replay/stale/gap/conflict ordering plus transaction-serialized inbox and
  Effect authority heads.
- Effect stages, append-only receipt-backed usage and owner-epoch/writer fences.
- One bounded readiness replacement after a wedged driver, with a constant
  maximum of one abandoned plus one active wave per probe instance.
- Metric policy cache and global per-label/total/policy cardinality caps;
  O(1) emission-time membership.
- Consent, key lifecycle, correlation/redaction, clock and fault-policy local
  contracts.

## Controlled exact-source evidence

The separate
[database-restart-db-86bf925-01.md](database-restart-db-86bf925-01.md)
campaign ran this same source commit with real PostgreSQL RLS, stop/start,
fresh-process reconciliation and synthetic transport continuity.

## Explicit non-claims

Neither local verification nor the isolated database campaign proves the
aggregate dependency matrix, real long Human Communication, all process/node
faults, capacity, restore, rolling active-zero drain, region recovery, DR,
native fuzz/sanitizer behavior or production eligibility. Those entries remain
`not_run`.
