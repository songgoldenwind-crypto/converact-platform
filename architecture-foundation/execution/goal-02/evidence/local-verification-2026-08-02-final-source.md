# G02 local verification evidence — final runtime source

## Boundary

- Goal: `goals/goal-02-platform-foundation-security-observability.md`
- Goal SHA-256: `742e194e6b2d3e2b6fe9390bbabe96a6bbe0f40bdf99d8ed4ae4060a711a87f9`
- Tested source commit: `4f9ea6f94a8e0740975c801aff5a6a180124a62b`
- Branch: `codex/converact-platform-rename`
- Host: macOS 26.2 build 25C56, arm64
- Node.js: `v23.11.0`
- npm: `10.9.2`
- UTC evidence date: 2026-08-02

This exact runtime source closes the final independent-review findings: effect
takeover serialization, bounded and recoverable readiness waves, process-wide
metric-policy cardinality, streaming bounded JWKS reads, and deterministic
release of streamed, declared-oversized and non-success JWKS response bodies.
The final tests also wait for cache publication rather than request arrival.
Evidence-only commits after this record do not change the tested runtime.

## Observed outcomes

| Command scope | Outcome |
| --- | --- |
| JWKS auth command | 21 passed, 0 failed; repeated 10 times before the full run |
| `npm run typecheck` | exit 0 |
| `npm test` | 4,911 tests; 4,896 passed; 0 failed; 15 skipped; 52,659.384208 ms |
| Full log | 470,808 bytes; 5,432 lines; SHA-256 `ffc569ed594e55af67c5a5e4e7b14d01fceedc9bc3e51f753ba9c442ece3100c` |

The raw full-suite log passed the bounded secret scanner before deterministic
compression. Four repository-retained base64 fragments reconstruct its XZ
stream and reproduce the raw hash; see
`evidence/raw/local-verification-4f9ea6f/README.md`.

Two earlier, unaccepted diagnostic full-suite attempts each exposed one timing
test rather than being relabelled as passing evidence. The first (`daeedae`,
SHA-256 `59d1017370355f8a79ac9e2b3a59e31c5b2f7c7ecd5b9f1b6466cd0c8949a785`)
showed a 5 ms SIP permit test/watchdog race. The second (`8136415`, SHA-256
`69fa7bf7e7d2b2f86d685994b6802b4e550506d2b6ad6a8680a33e1591d6b140`)
showed that the JWKS lifecycle test waited for HTTP request arrival instead of
cache publication. Both tests were made deterministic before this accepted run.

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
[database-restart-db-4f9ea6f-01.md](database-restart-db-4f9ea6f-01.md)
campaign ran this same source commit with real PostgreSQL RLS, stop/start,
fresh-process reconciliation and synthetic transport continuity.

## Explicit non-claims

Neither local verification nor the isolated database campaign proves the
aggregate dependency matrix, real long Human Communication, all process/node
faults, capacity, restore, rolling active-zero drain, region recovery, DR,
native fuzz/sanitizer behavior or production eligibility. Those entries remain
`not_run`.
