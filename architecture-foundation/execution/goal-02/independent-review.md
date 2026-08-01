# G02 Independent Review

## Final status

- Review date: `2026-08-02`
- Reviewer task: `/root/g02_final_independent_review`
- Review status: `accepted_with_external_evidence_blockers`
- Reviewed base: `051ad988edcc204fbd716f6ea73ce92ec08ab4b2`
- Reviewed commit: `c920d7a59e02daba38118491217630fef94ce393`
- Binary diff SHA-256: `341e2bbb844e3bbf705c1f6e6faec670a258434a1d489de2dd2fc0d8a2781cae`
- Final runtime/test source: `4f9ea6f94a8e0740975c801aff5a6a180124a62b`
- Critical: `0`
- High: `0`
- Important: `0`
- Minor: `0`
- Production eligibility: `false`

The independent reviewer accepted the local foundation and the one controlled
PostgreSQL restart slice. This is not runtime, production, long-media, capacity,
restore, drain, region or native-safety acceptance.

## Reviewed boundary

The reviewer was read-only and reviewed:

1. `goals/PROGRAM-RULES.md`, the SHA-bound G02 Goal, all G02 designs,
   machine contracts, schemas, traceability and TDD plan;
2. the complete `051ad988..c920d7a` implementation, migration, test and
   evidence diff;
3. exact-source local evidence for `4f9ea6f`, including four retained log
   fragments and their manifests;
4. the exact-source `db-4f9ea6f-01` PostgreSQL campaign, its 21 raw artifacts,
   two supplemental artifacts and evidence identities;
5. all current evidence-index statuses and non-claims.

`4f9ea6f..c920d7a` contains only evidence, generator and contract changes; it
does not modify runtime, migrations or product tests.

## Fresh reviewer verification

| Check | Reviewer result |
| --- | --- |
| `npm run typecheck` | passed |
| JWKS rejected-response resource tests | 3/3 passed |
| SIP permit timing test | 1/1 passed |
| Platform focused tests | 43/43 passed |
| G02 machine contract | 10/10 passed |
| `git diff --check` and fixed HEAD/diff identity | passed |
| Full-suite fragment hashes and reconstruction | passed |
| Database raw and supplemental manifests | 21/21 + 2/2 passed |
| Evidence secret scan | all 23 database artifacts passed |

The independently reconstructed full-suite log is 470,808 bytes and 5,432
lines, with raw SHA-256
`ffc569ed594e55af67c5a5e4e7b14d01fceedc9bc3e51f753ba9c442ece3100c`
and XZ SHA-256
`3bf89d55eaec390fbbd21013b3680e89a42b5fd617989533076381982ca91a5d`.
It records 4,911 tests, 4,896 passed, 0 failed and 15 skipped.

The database evidence is bound to exact source `4f9ea6f`, preserves nine
pre-existing stopped-container snapshots byte-for-byte, leaves zero campaign
resources, passes all eight controlled checks, and remains explicitly
`production_eligible=false` and `real_human_media=false`. The reviewer did not
start containers or connect to the validation server; review used the retained,
hash-bound, secret-scanned artifacts.

## Finding history and closure

Earlier review rounds rejected the work until each reproducible finding was
closed by a failing test, minimal change and renewed exact-source evidence.
The final two resource-lifecycle findings were:

- declared-oversized JWKS bodies were not released; closed by `86bf925`;
- non-success JWKS responses were not released; closed by `daeedae`.

The final implementation cancels and aborts non-success, declared-oversized and
streamed-oversized JWKS responses. `3b3ca18`, `8136415` and `4f9ea6f` only make
the SIP permit and JWKS cache-publication tests wait for the semantic condition
they assert. Two failed diagnostic full-suite attempts remain explicitly
recorded in the local evidence document and were never promoted as passing.

All earlier identity, rolling-event, receipt-backed billing, append-only
history, evidence-secret, key overlap, readiness, effect takeover, metric
cardinality and JWKS streaming findings were also rechecked as closed. No open
Critical, High, Important or Minor code finding remains at the reviewed boundary.

## Remaining external evidence blockers

These entries remain `not_run`:

- `G02-E09-DEPENDENCY`
- `G02-E10-RESTORE`
- `G02-E11-DRAIN`
- `G02-E12-LONG-MEDIA`
- `G02-E13-CAPACITY`
- `G02-E14-REGION`
- `G02-E15-NATIVE`

They require the remaining real dependency matrix, backup/restore and measured
RPO/RTO, multi-node drain/active-zero, real long Human Communication, fixed-host
capacity and overload, region recovery/split-brain, and exact-source native/
unsafe/FFI fault/fuzz/core-dump evidence. Until those campaigns exist, G02 is
`blocked_external`, not `completed`, and every production claim remains false.
