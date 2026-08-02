# G03 Current-state Audit

Date: 2026-08-02
Binding Goal: `G03` / `05ce7f940782ab0efcd013d413220d068a7d3be1bab981f2c2c4f6a6f2a217af`
Production eligibility: `false`

## 1. Entry Gate

G03 uses the later user-authorized gate-only amendment
`GATE-AMENDMENT-G02-G03-2026-08-02-V1`. G02's platform-foundation development
Gate is complete at `16ab4af98c5f3b453ad3d9bdd1ae5fe959a37720`; G02 remains
`blocked_external` for `G02-E09/E12/E14/E15`. G03 does not inherit those
claims and this audit does not mark G02 complete or production eligible.

## 2. Observed Current Implementation

| Slice | Exact current source | Observed status | G03 disposition |
| --- | --- | --- | --- |
| Product Call model | `src/agent-runtime/converact/voice/types.ts`; `state-machine.ts`; `call-service.ts` | One `VoiceCall` authority exists, but IDs are plain strings and there is no first-class bounded Leg model | preserve authority; add typed compatibility seam and Leg transition model without creating another Call store |
| SipFoundation seam | `src/agent-runtime/converact/voice/sip-foundation/*` | Exported Converact-owned types, bounded Protocol Session registry, capability selection, route/wire binding and rsipstack Adapter exist | retain and harden; do not expose upstream types |
| Durable effect ledger | `effect-oracle.ts`; `postgres-effect-store.ts`; migration `107_ivekit_sip_effect_oracle.sql` | Prepared/durable/send/accepted/observed/unknown states, exact wire identity, repair fence, bounded queue and deterministic 503 mapping exist | retain; freeze semantic mapping for accepted/completed/state-observed |
| Recovery | `sip-foundation/recovery.ts`; reciprocal dialog shadow/takeover sources | Confirmed, transaction-quiescent, same-runtime eligibility exists; actual takeover remains a separate RustPBX flow | freeze exact recovery boundary; do not claim cross-Adapter or early-dialog recovery |
| RustPBX/rsipstack runtime | `infra/converact/rustpbx/build.sh` and patch queue | RustPBX `6c49ee76…`, rsipstack `8318e97b…`, rustrtc `166c6d22…`, patchset `ivekit.40` are pinned | current Adapter baseline; no full-stack replacement in G03 |
| Initial 100 Trying | `rsipstack-ivekit-single-trying.patch`; RustPBX README and patch tests | One application-level transaction owner is source-tested; raw end-to-end latency distribution is absent | retain source behavior; latency/capacity evidence remains `not_run` |
| SIP wire tests | SIPp XML under `services/converact-service/acceptance/sipp`; rsipstack patch tests | Basic INVITE/ACK/BYE/CANCEL/REGISTER/OPTIONS and selected failure paths exist | add a frozen raw-byte corpus for all G03 cases; differential Adapter replay remains `not_run` |
| rvoip runtime | no G03 runtime source dependency found | Not a parser, transaction, Dialog or transport production path | `not_run`; reserved for G06 layer-by-layer gates |

The SipFoundation code arrived through commit `385521c` and its PostgreSQL
boundary was retained/hardened in later commits including `6c5d998`. A source
search finds the namespace export in `voice/index.ts`, but no current
`VoiceCallService` construction path that elects `SipEffectOracle` as a live
production writer. Therefore the code is current source, not proof of an
activated production path.

## 3. Baseline Check

Before G03 implementation, the focused source and unit suite ran 103 tests with
103 passes and zero failures. It covered the TypeScript SipFoundation, effect
ledger, recovery eligibility, exact-source RustPBX/rsipstack patch contracts,
dual-leg CDR and dialog recovery. This is a local source/unit baseline only.

The following remain `not_run` at audit time:

- physical PostgreSQL activation, RLS/role and crash/restart replay;
- raw `100 Trying`/final/503 latency distribution;
- real SIP peer and carrier interoperability;
- long call, node loss, blocking syscall, native panic, OOM and process-abort campaigns;
- same-host allocation/CPU/capacity baseline;
- production eligibility.

## 4. Gaps to Close in G03

1. Strongly distinguish `CallId`, `LegId`, `ProtocolDialogId`, `TransactionId`,
   `MediaSessionId` and `InteractionId` while accepting current Call ID strings
   through an explicit compatibility boundary.
2. Add one bounded Leg state model for fork, transfer, CANCEL/2xx and BYE races;
   keep `VoiceCall` as the only business Call authority.
3. Expose the receipt semantic difference between local acceptance, primary
   protocol completion and state observed after `unknown` reconciliation.
4. Make Protocol Session drain reject new sessions, preserve old sessions and
   expose active-zero without forced hangup.
5. Freeze the complete raw-byte corpus and its hashes.
6. Bind all 143 G00 rows assigned to G03 exactly once, without evidence
   promotion.

## 5. Deletion and Migration Boundary

G03 does not delete rsipstack, change the RustPBX build graph, activate rvoip,
or move live calls. Deletion is deferred until G06 proves new-call selection,
old-call drain, active-zero, unknown/repair zero and rollback-window closure.
