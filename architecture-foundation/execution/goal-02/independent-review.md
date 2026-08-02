# G02 Independent Review

## Final status

- Review date: `2026-08-02`
- Reviewer task: `/root/g02_final_independent_review`
- Review status: `accepted_with_external_evidence_blockers`
- Reviewed base: `051ad988edcc204fbd716f6ea73ce92ec08ab4b2`
- Reviewed commit: `c920d7a59e02daba38118491217630fef94ce393`
- Binary diff SHA-256: `341e2bbb844e3bbf705c1f6e6faec670a258434a1d489de2dd2fc0d8a2781cae`
- Final runtime/test source: `4f9ea6f94a8e0740975c801aff5a6a180124a62b`
- Latest incremental reviewed commit: `1efcfc553602a29b17abc5565505645385ff3529`
- Latest accepted capacity run: `capacity-b263a55-01`
- Latest accepted restore run: `restore-a517cf3-01`
- Latest accepted drain run: `drain-1efcfc5-04`
- Critical: `0`
- High: `0`
- Important: `0`
- Minor: `0`
- Production eligibility: `false`

The independent reviewer accepted the local foundation, one controlled
PostgreSQL restart slice, one frozen-checkpoint restore slice and one fixed-host
bounded control-plane capacity slice, plus one fixed-host multi-process drain
and node-loss slice. This is not production, continuous-write PITR, long-media,
SIP/media/mixed-cell/fleet capacity, deployed multi-node/fleet drain, region or
native-safety acceptance.

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

## Incremental capacity review

The same read-only reviewer first rejected predecessor Run
`capacity-b5c500d-01` with `Critical 0 / High 0 / Important 2 / Minor 2`:
the workload had not attempted retry/fanout overflow, the builder accepted an
input marked `failed`, and the queue assertion was not derived. The predecessor
is retained as `superseded_rejected` and is not referenced by the evidence
index.

Follow-up review of runtime commit
`b263a55a975704f852b53a3da6eaba711307b07b` and complete new Run
`capacity-b263a55-01` closed every finding with disposition
`accepted_with_external_evidence_blockers` and
`Critical 0 / High 0 / Important 0 / Minor 0`.

Fresh review verified:

- 2,000,000 immediate decisions: 1,400,000 accepted, 400,000 admission
  saturation rejects, 100,000 `retry=4` rejects and 100,000 `fanout=9`
  rejects;
- accepted maxima `retry=3` and `fanout=8`, attempted maxima `4` and `9`,
  unchanged admission counters across policy rejects, 320/320 retained-lease
  bound, zero queued requests at completion and final active/pending `0/0`;
- `status=failed`, missing rejection classes, counter drift, queued work and a
  false bounded-queue assertion all fail evidence promotion;
- source/config/raw identities, 4 raw plus 8 supplemental manifest entries,
  secret scans and byte-identical snapshots of nine stopped pre-existing
  containers;
- `npm run typecheck`, focused tests `22/22`, G02 contract `11/11`,
  `git diff --check`, and isolated generator idempotence.

The capacity result remains `production_eligible=false` and proves only the
production bounded control primitive on one exact fixed host.

## Incremental restore review

The same read-only reviewer rejected predecessor Run `restore-7a46401-01` with
`Critical 0 / High 0 / Important 1 / Minor 2`. Although the production
backup/restore path, source/target isolation, empty target, exact database and
object digests, RLS, append-only history and cleanup were valid, its required
6,158 ms RTO subtracted cross-process `Date.now()` wall-clock values. That
violated the frozen monotonic elapsed-time contract. The predecessor remains
retained as `superseded_rejected_wall_clock_rto`, is not indexed as accepted,
and the current evidence builder rejects it.

Commit `a517cf368bc25417c0f51870091e3306592b6fc4` introduced one parent-process
`performance.now()` boundary around production restore, runtime-role
initialization and a distinct fresh verification child. It also binds one
backup ID, three distinct process identities and exact RTO scope. New Run
`restore-a517cf3-01` closed the finding with disposition
`accepted_with_external_evidence_blockers` and
`Critical 0 / High 0 / Important 0 / Minor 0`.

Fresh review verified:

- exact source `a517cf3`, immutable PostgreSQL and Node image references, Node
  binary identity, config identity and a clean execution checkout;
- source and target database identities differ; the source project was removed
  before target creation; the target had zero public tables before restore;
- one backup ID across backup/restore, backup/restore/fresh-verification PIDs
  `3403212 / 3403853 / 3404097`, six exact authority records and one exact
  object;
- monotonic RTO 5,777 ms with scope restore + runtime-role initialization +
  fresh-process verification, and quiescent-checkpoint RPO 0 ms;
- runtime RLS and append-only mutation rejection, byte-identical snapshots of
  nine stopped pre-existing containers, zero campaign resources, 23 raw plus
  27 supplemental manifest entries, and secret scans before and after transfer;
- current builder accepts the new result and rejects the predecessor; focused
  tests `21/21`, G02 contract `11/11`, typecheck, diff check and generator
  idempotence passed.

The accepted restore remains `production_eligible=false`; the binary archive is
not retained in Git, and the run proves neither continuous-write PITR nor
regional or production disaster recovery.

## Incremental drain review

The same read-only reviewer rejected predecessor Run `drain-fcc2c51-02` with
`Critical 0 / High 0 / Important 2 / Minor 1`. Different key IDs could alias
the same Ed25519 public-key material, the finalizer trusted hash-shaped receipt
summaries instead of verifying the raw signed receipts, and revision-1 nonzero
receipts were not retained. Commit
`b7fbaeda4bbbc7618a88716daf128782d9509385` added SPKI fingerprint uniqueness,
exact raw-artifact binding, 14-signature verification and both receipt
revisions. Run `drain-b7fbaed-03` closed those findings, but review found one
Minor because an unknown safe result field could still be rebound and
propagated.

Commit `1efcfc553602a29b17abc5565505645385ff3529` added an exact 40-field result
schema and a failing regression test before the implementation fix. Complete
new Run `drain-1efcfc5-04` then closed the final finding with disposition
`accepted_with_external_evidence_blockers` and
`Critical 0 / High 0 / Important 0 / Minor 0`.

Fresh review verified:

- exact source `1efcfc5`, clean execution checkout, immutable Node runtime
  reference, Node v24.18.0 binary identity and exact config identity;
- five distinct process identities, an actual `SIGKILL`, stale-owner rejection,
  replacement owner epoch, new-admission rejection and the exact seven-phase
  monotonic drain sequence;
- seven revision-1 signed receipts with communication count 1 and six zeros,
  followed by seven revision-2 signed zero receipts, seven distinct Ed25519
  SPKI fingerprints and 14/14 valid signatures;
- accepted additive/N and N+1 local decoder decisions plus fail-closed unknown
  major, replay, stale and revision-gap decisions;
- exact six-entry raw, ten-entry supplemental and eleven-entry post-transfer
  manifests, byte-identical snapshots of nine stopped pre-existing containers,
  zero container actions and zero remaining validation processes;
- focused and G02 contract tests `21/21`, typecheck, shell syntax, diff checks,
  builder byte equivalence, generator idempotence and explicit rejection of a
  rebound unknown result field.

The controlled campaign ran for 972 ms on the fixed 2-vCPU validation host.
Its raw manifest SHA-256 is
`a57f05fe9689ad7febc0e5a98ed4b4734f3ccc24f0957cd90beac75a607dee68`,
final evidence SHA-256 is
`76d7aaf34a61e2ca65a7849b38368f64e36c9effe6577490ed6490722da918b1`,
and logical receipt-transition SHA-256 is
`ffdcdb770d887863878aed33200b97e8fd7818f338f8007b33f04de0f32449b7`.

All seven keypairs and all reports were self-generated by one controlled child;
they are not independently operated production Authority reporters. Only the
communication count came from a real admission reservation; the other six
Authority inputs were probe-constructed empty collections. The `SIGKILL`
proves process loss plus placement/owner-epoch fencing only. The campaign has
no embedded edge, SIP or real Human Communication media continuity, deployed
N/N-1 fleet, region recovery, DR, production or fleet/media capacity proof.

## Remaining external evidence blockers

These entries remain `not_run`:

- `G02-E09-DEPENDENCY`
- `G02-E12-LONG-MEDIA`
- `G02-E14-REGION`
- `G02-E15-NATIVE`

They require the remaining real dependency matrix, continuous-write PITR,
deployed multi-node/fleet drain and active-zero, real long Human Communication,
fixed-host SIP/media/mixed-cell/fleet capacity, region recovery/split-brain, and
exact-source native/unsafe/FFI fault/fuzz/core-dump evidence. Until those
campaigns exist, G02 is
`blocked_external`, not `completed`, and every production claim remains false.
