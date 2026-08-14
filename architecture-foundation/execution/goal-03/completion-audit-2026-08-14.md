# G03 Requirement-by-requirement Completion Audit

Date: 2026-08-14

Binding Goal SHA-256: `05ce7f940782ab0efcd013d413220d068a7d3be1bab981f2c2c4f6a6f2a217af`

Exact candidate: RustPBX patchset `ivekit.85` after canonical commit `8ee4ec0`

Production eligible: `false`

## 1. Decision

G03 completion is **not yet proved**. All required documents and machine
contracts exist, and the available local/controlled component evidence is
green. The exact `.85` candidate also closes the remaining offline
recovered-worker registry-isolation check. The Goal still requires evidence
whose scope is broader than the current proof:

- `G03-E10-FAULT`: live Endpoint worker fault, process abort/OOM, blocked
  external dependency and orphan-media behavior;
- `G03-E13-PERFORMANCE`: allocation and 2/4/8-core same-source evidence,
  deliberately deferred by the current feature-first user policy;
- `G03-E15-REVIEW`: a reviewer independent from the implementer must examine
  the final exact commit/diff;
- `G03-E16-NATIVE-AUTHORITY`: live Native Call/Leg/SipEffect activation,
  original-INVITE recovery and restart/two-node proof.

These remain `not_run`; no narrower test is promoted to those claims.

## 2. Required outcomes

| # | Required outcome | Current authoritative evidence | Audit result |
| ---: | --- | --- | --- |
| 1 | Freeze Call/Leg/Dialog/Transaction/Media/Interaction identities and fences | `call-leg-state-machine-v1.json`; identifier/state tests; native recovery binding golden | `verified_local` for contract/component; live Native Authority remains `G03-E16/not_run` |
| 2 | Freeze SipFoundation ingress/egress/control/protocol/SDP/timer/DNS/transport/error interfaces | `sip-foundation-contract-v1.json`; closed-schema and SipFoundation tests | contract `verified_local`; current rsipstack Adapter stays behind the frozen seam; live control-port activation is `not_run` |
| 3 | Freeze the mandatory SIP wire corpus | 22-case manifest, byte hashes, `.53` rsipstack differential bundle | `verified_controlled` for the recorded exact source; future rvoip replay is outside G03 |
| 4 | Establish durable Effect/Receipt/idempotency/query/reconcile ledger | effect contract; migrations 107/113–116; Rust/PostgreSQL Gate, observer, reconciler and recovery Oracle evidence | component/physical PostgreSQL slices `verified_controlled`; live writer activation remains `not_run` |
| 5 | Bound 100 Trying, store SLO and overload behavior | frozen budgets; `.53` raw distribution; bounded pool/admission and deterministic 503 tests | recorded campaign `verified_controlled`; no `.85` performance inheritance or production claim |
| 6 | Bound Call registry/mailboxes, fencing, recovery and orphan handling | Native Call registry, capsule takeover, stale recovery, `.82`–`.85` fault/cleanup slices | local/controlled components verified; real restart/two-node, live Endpoint and external orphan reconciliation remain `not_run` |
| 7 | Freeze rolling schema, clock, drain, placement and active-zero | recovery/clock/drain contract; migration/session fences; monotonic and drain tests | local/controlled component scope verified; mixed-binary live activation remains `not_run` |
| 8 | Isolate parser/worker panic, OOM pressure and blocking failures from unrelated Calls | `.84` bounded worker supervisor; `.85` real registry/fence component test preserves the unrelated Call/pair | local recovered-worker slice verified; broader `G03-E10-FAULT` remains `not_run`, so this outcome is not fully proved |

## 3. Required artifacts

All eleven binding artifacts are present under this directory:

1. `sip-call-foundation-design.md`;
2. `sip-foundation-contract-v1.json` plus schema;
3. `call-leg-state-machine-v1.json` plus schema;
4. `sip-effect-receipt-contract-v1.json` plus schema;
5. `wire-freeze-corpus-manifest-v1.json` plus schema;
6. `recovery-clock-drain-contract.md`;
7. `fault-and-threat-review.md`;
8. `source-test-path-map.md`;
9. `2026-07-31-goal-03-sip-call-tdd-plan.md`;
10. `evidence-index-v1.json` plus schema;
11. `independent-review.md`.

The deterministic generator and G03 contract suite validate their closed
schemas, binding hashes, required fields, wire hashes and 143-row source map.
The independent-review artifact explicitly remains interim; its existence is
not evidence that `G03-E15` passed.

## 4. Acceptance-gate audit

| Gate | Evidence assessment |
| --- | --- |
| Multi-Leg/Dialog, fork, transfer, CANCEL/BYE and re-INVITE are unambiguous | local state-machine/native component tests pass; live Native Authority remains `not_run` |
| Wire corpus is semantically frozen | `.53` controlled differential passes with four explicit compatibility decisions; no unexplained difference |
| 100 Trying/final/overload meet the budget | `.53` raw controlled distribution passes; current `.85` same-source performance requalification is not claimed |
| Duplicate/reorder/timeout/unknown/restart do not duplicate effects/CDR | local and physical PostgreSQL component evidence passes; full live crash/two-node activation remains `not_run` |
| Slow/unavailable store behavior is bounded and established media is independent | bounded store/503 contracts and architecture boundary are verified locally; live product dependency-loss campaign remains `not_run` |
| Restart, rolling upgrade, clock and drain are repeatable | selected controlled PostgreSQL restart/clock slices pass; mixed-binary, full active-zero and live two-node takeover remain `not_run` |
| No global scan/unbounded mailbox/per-message DB or unexplained allocation regression | structural/static checks pass; allocation and multi-core evidence is `G03-E13/not_run` |
| Current/target/production states are separate and benchmarks are not borrowed | verified by machine contracts and evidence index; production eligibility remains `false` |

## 5. Current verification snapshot

- focused `.85` registry isolation: `1 passed / 0 failed`;
- Rust dialog-shadow module: `14 passed / 0 failed`;
- complete RustPBX library: `2116 passed / 0 failed / 12 ignored`;
- current patch static contracts: `240 passed / 0 failed` across 61 files;
- combined G03 functional/static suite: `345 passed / 0 failed / 1 physical-only skip` across 71 exact files;
- G03 machine contracts: `9 passed / 0 failed`;
- repository typecheck, locked Rust check, rustfmt and exact patch replay: passed.

No server, Docker, running service, deployed code, database, port or volume was
contacted or changed for `.79`–`.85`. No load, latency, CPS, concurrency,
capacity, soak, allocation or other performance command was run in `.85`.

## 6. Terminal boundary

The repository and active Goal must remain `implementation_in_progress` until
the final independent review is authorized and the remaining required scope is
either directly evidenced or formally accepted as a terminal
`blocked_external` boundary. G04 and the future TypeScript-to-Rust migration
Goal must not start from this audit.
