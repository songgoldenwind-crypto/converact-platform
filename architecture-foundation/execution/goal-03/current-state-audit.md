# G03 Current-state Audit

Date: 2026-08-02; exact-candidate update: 2026-08-09
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
| Product Call model | `src/agent-runtime/converact/voice/types.ts`; `state-machine.ts`; `call-service.ts` | `VoiceCall` is a durable Call intent/rebuildable control-plane projection with legacy string IDs | preserve product behavior, but never treat it or `provider_call_id` as native Call/Leg authority |
| SipFoundation seam | `src/agent-runtime/converact/voice/sip-foundation/*` | Exported Converact-owned types, bounded Protocol Session model, capability selection, route/wire binding and rsipstack-named conformance Adapter exist | retain as conformance/migration harness; native SIP authority stays inside RustPBX |
| Durable effect ledger | `effect-oracle.ts`; `postgres-effect-store.ts`; migration `107_ivekit_sip_effect_oracle.sql`; native `.57` PostgreSQL gate adapter patch | Reference and native implementations share prepared/durable/send/accepted/observed/unknown semantics, exact wire identity, repair fences and bounded queues; the native adapter is compiled but default-disabled | retain TypeScript as contract/reference evidence; live native RustPBX endpoint activation remains `not_run` |
| Recovery | `sip-foundation/recovery.ts`; reciprocal dialog shadow/takeover sources | Confirmed, transaction-quiescent, same-runtime eligibility exists; actual takeover remains a separate RustPBX flow | freeze exact recovery boundary; do not claim cross-Adapter or early-dialog recovery |
| RustPBX/rsipstack runtime | `infra/converact/rustpbx/build.sh` and patch queue | RustPBX `6c49ee76…`, rsipstack `8318e97b…`, rustrtc `166c6d22…`, patchset `.57` are pinned; exact locked local Rust library evidence is 1977 passed + 5 ignored | exact image/wire/latency/peer/2-vCPU evidence remains bound only to `.53` source `b63383b`; `.57` host requalification is `not_run` and production eligibility remains false |
| Initial 100 Trying | `rsipstack-ivekit-single-trying.patch`; SIPp campaign sources | Exact `.53` image emitted exactly 100 Trying responses for 100 INVITEs; p99/max were 1/1 ms, with zero response retransmissions | `G03-E06` controlled evidence; no inherited `.42` promotion |
| SIP wire tests | frozen 22-case corpus and exact dual-binary replay | `.53` matches all 18 accepted semantics and applies four versioned malformed-input tightenings with zero unexplained differences | `G03-E07` controlled evidence; future rvoip differential remains `not_run` |
| rvoip runtime | no G03 runtime source dependency found | Not a parser, transaction, Dialog or transport production path | `not_run`; reserved for G06 layer-by-layer gates |

The TypeScript SipFoundation code arrived through commit `385521c` and its
PostgreSQL boundary was retained/hardened in later commits including `6c5d998`.
A source search finds the namespace export in `voice/index.ts`, but no current
`VoiceCallService` construction path elects `SipEffectOracle` as a live native
writer. The `RsipstackFoundationAdapter` materializes and validates model wire
facts; it does not parse or send production SIP. Therefore these files are
conformance/reference source, not proof of an activated production path.

## 3. Baseline Check

Before G03 implementation, the focused source and unit suite ran 103 tests with
103 passes and zero failures. It covered the TypeScript SipFoundation, effect
ledger, recovery eligibility, exact-source RustPBX/rsipstack patch contracts,
dual-leg CDR and dialog recovery. This is a local source/unit baseline only.

The controlled PostgreSQL role/RLS/restart replay and exact `.53`
wire/latency/interop/two-hour-control-call/2-vCPU capacity campaigns have run,
but they do not prove `.57` native RustPBX live endpoint activation and cannot
be inherited by the changed candidate. The following remain `not_run` for the
current `.57` candidate at this update:

- native Call/Leg and effect-writer activation;
- node loss, blocking syscall, native panic, OOM and process-abort campaigns;
- allocation and 2/4/8-core scaling (the retained 2-vCPU capacity result is a
  controlled regression baseline, not the complete performance Gate);
- carrier-specific interoperability beyond the retained SIPp and Asterisk peer;
- production eligibility.

## 4. Gaps to Close in G03

1. Strongly distinguish `CallId`, `LegId`, `ProtocolDialogId`, `TransactionId`,
   `MediaSessionId` and `InteractionId` while accepting current Call ID strings
   through an explicit compatibility boundary.
2. Keep the bounded TypeScript Leg model as conformance evidence, then bind the
   same semantics to the sole native RustPBX Call/Leg authority without a
   second active registry.
3. Expose the receipt semantic difference between local acceptance, primary
   protocol completion and state observed after `unknown` reconciliation.
4. Make Protocol Session drain reject new sessions, preserve old sessions and
   expose active-zero without forced hangup.
5. Freeze the complete raw-byte corpus and its hashes.
6. Bind all 143 G00 rows assigned to G03 exactly once, without evidence
   promotion.
7. Activate and prove the compiled Native Call/Leg control port and default-
   disabled SipEffect gate across every SIP direction; until then
   `G03-E16-NATIVE-AUTHORITY` stays `not_run`.

## 5. Deletion and Migration Boundary

G03 does not delete rsipstack, replace the RustPBX dependency graph, activate
rvoip, or move live calls. Deletion is deferred until G06 proves new-call selection,
old-call drain, active-zero, unknown/repair zero and rollback-window closure.
