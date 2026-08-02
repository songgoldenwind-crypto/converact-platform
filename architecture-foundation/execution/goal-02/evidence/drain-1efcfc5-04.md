# G02 controlled rolling-drain and node-loss evidence

## Classification

- Evidence ID: `G02-E11-DRAIN`
- Run ID: `drain-1efcfc5-04`
- Status: `verified_controlled`
- `production_eligible`: `false`
- Scope: one fixed-host, multi-process platform coordinator/admission drain,
  signed active-zero transition, process loss, owner-epoch fencing and local
  rolling-schema decision slice

This proves only the exact controlled slice described below. It does not prove
production rolling drain, independent production Authority reporters, deployed
N/N-1 fleet compatibility, embedded-edge survival, SIP or real Human
Communication media continuity, region recovery, DR, fleet capacity or media
capacity.

## Exact identity

| Field | Value |
| --- | --- |
| Binding Goal SHA-256 | `742e194e6b2d3e2b6fe9390bbabe96a6bbe0f40bdf99d8ed4ae4060a711a87f9` |
| Source commit | `1efcfc553602a29b17abc5565505645385ff3529` |
| Incremental source bundle SHA-256 | `681ca6ef9df5171ad56f9240c0bff9b1baddb6fbaa2528ce7c095eeb7f899c15` |
| Required parent source | `b7fbaeda4bbbc7618a88716daf128782d9509385` |
| Harness config SHA-256 | `ecbaa9b8d5a4dd6db97959b39e86a1a7187c3cfcb8411971aabd9338a739f9db` |
| Raw-output manifest SHA-256 | `a57f05fe9689ad7febc0e5a98ed4b4734f3ccc24f0957cd90beac75a607dee68` |
| Supplemental manifest SHA-256 | `79fcd946eb357ebf37892c6b2eedf6a3d6f244bd65bd9759ce8df5f9b79b5b50` |
| Post-transfer scan manifest SHA-256 | `7bb46eb8839dd4cd4aef7904d6ceb3102b7dd438173d333a1630b365f5ad209c` |
| Final evidence JSON SHA-256 | `76d7aaf34a61e2ca65a7849b38368f64e36c9effe6577490ed6490722da918b1` |
| Execution identity JSON SHA-256 | `448025a16f9ac8976b0d82805494868125995155a8f5ca0756bf36259e56843f` |
| Receipt-transition logical SHA-256 | `ffdcdb770d887863878aed33200b97e8fd7818f338f8007b33f04de0f32449b7` |
| Node runtime reference | `node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d` |
| Executed Node binary | `v24.18.0`; SHA-256 `41a74efb34cbde5c7632cdac0cf8bd1a14d0b8d73dc1e82755014d9a9ce70f5c` |
| Host | `VM-0-3-ubuntu`; Linux 6.8.0-71-generic x86_64; 2 vCPU; 7.5 GiB RAM |
| Clock | UTC wall clock for audit; Node monotonic performance clock for deadlines; `kvm-clock` |
| Campaign started / completed | `2026-08-02T02:25:58.531Z` / `2026-08-02T02:26:00.276Z` |

The runner required a clean detached checkout at the exact source commit,
Node 24, an immutable Node runtime reference and zero running pre-existing
containers. It did not start, stop, remove or otherwise mutate a container.

## Drain and process-loss observations

| Observation | Result |
| --- | --- |
| Monotonic drain duration | 972 ms |
| Orchestrator / drain / lost / recovery / verifier PIDs | `3428739 / 3428747 / 3428759 / 3428771 / 3428788` |
| Drain / lost / recovery / verifier exits | `0 / SIGKILL / 0 / 0` |
| Drain identity | `drain-drain-1efcfc5-04`, `node-drain`, owner epoch `4294967297` |
| New admission after drain began | rejected with `component_node_draining` |
| Established reservation during drain | mutation remained allowed, then closed |
| Phase sequence | `accepting -> route_draining -> worker_draining -> authority_draining -> active_zero_verified -> quiesced -> stopped` |
| Lost / replacement owner epoch | `4294967299 -> 4294967300` |
| Stale writer result | rejected with `stale_owner_epoch` |
| Replacement-node new work | active, then closed |
| Validation processes remaining | 0 |

The actual `SIGKILL` proves process loss plus placement and owner-epoch
fencing. It does not prove that a process-owned embedded edge, SIP dialog or
media stream survives that loss.

## Signed receipt transition

The retained `drain-receipts.json` is SHA-256
`6a3f86113165e0c10d54d1d6d44efa9934c7808440234033c995b0500c19d97a`.
The retained public-key bundle is SHA-256
`52a780d4d378c6659eee0766be9dd9f27f1a95fdd6e4c4bc5aad430b80a6557f`.

- Revision 1 retains seven signed receipts. The
  `communication_attached_generations` receipt has active count `1`; the other
  six controlled inputs have count `0`.
- Revision 2 retains seven signed receipts and all seven counts are `0`.
- The coordinator and finalizer reject reused key IDs and distinct aliases of
  identical SPKI material.
- The finalizer verifies the exact raw manifest, seven unique Ed25519 SPKI
  fingerprints, the exact 40-field result schema and 14/14 Ed25519 signatures.
- Summary-only, forged-signature, recomputed-hash and unknown-field rebinding
  attacks all remain `failed`.

All seven keypairs and all fourteen reports were generated inside one bounded
controlled drain child. This proves cryptographic self-consistency, not an
independent production trust bootstrap or seven independently operated
Authority reporters. Only `communication_attached_generations` is backed by a
real admission reservation in this run. The other six Authority inputs are
probe-constructed empty collections.

## Rolling-schema decision observations

The campaign called the production event decoder and Inbox decision functions:

- an N+1 reader accepted the N event;
- an additive minor extension was accepted;
- an unknown major was quarantined as `unsupported_schema_version`;
- duplicate, stale, revision-gap and distinct-ordering-key decisions were
  respectively `replay`, `stale`, `gap_requires_reconcile` and `insert`.

These are deterministic local production-function observations. No N/N-1
fleet was deployed, so this is not production rolling-schema evidence.

## Isolation and retained evidence

- All nine pre-existing containers were stopped before and after the run.
- The before/after snapshots are byte-identical with SHA-256
  `813f75653746be1a506520dea825fc8462595a207be99b072f1b72e9152ca4d0`.
- `container_actions=0`; no drain validation process remained.
- The raw manifest has 6 entries, the supplemental manifest has 10 entries,
  and the independent post-transfer scan manifest has 11 entries. Every entry
  passes SHA-256 verification and secret-shaped artifact scanning.
- Rebuilding the current finalizer from retained raw artifacts is byte-equivalent
  to the retained final evidence JSON.

Raw evidence is retained under
`architecture-foundation/execution/goal-02/evidence/raw/drain-1efcfc5-04/`.

## Independent-review closure

The read-only reviewer first found that predecessor `drain-fcc2c51-02` allowed
different key IDs to alias identical key material, accepted fabricated receipt
summaries without raw cryptographic verification, and did not retain the
revision-1 nonzero receipts. Commit `b7fbaed` closed those findings and Run
`drain-b7fbaed-03` re-executed the campaign. The reviewer then found one Minor:
an unknown safe result field could be rebound and propagated. Commit `1efcfc5`
added the exact 40-field schema and a failing regression test, and this run is
a complete new execution on that exact source.

Final disposition is `Critical 0 / High 0 / Important 0 / Minor 0`, accepted
only as `verified_controlled` with `production_eligible=false`. The two
predecessor raw directories are retained for review history but are not
referenced by the accepted evidence index.

The aggregate dependency matrix, real long Human Communication, production
rolling fleet, region recovery, native safety, DR and every production claim
remain `not_run`.
