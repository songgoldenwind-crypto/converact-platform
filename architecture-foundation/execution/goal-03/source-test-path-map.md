# G03 Source → Test → Evidence Map

## 1. Trace Closure

`traceability-v1.json` carries all **143** G00 requirements assigned to G03.
Every row maps exactly once, zero rows are omitted, and every row remains
`not_run` until its own G03 evidence is attached. Historical R4/Wave/server
evidence is not promoted.

## 2. Current and Target Paths

| Domain | Current/target implementation | Focused tests | Evidence ID |
| --- | --- | --- | --- |
| owned ID types | `src/agent-runtime/converact/voice/foundation-identifiers.ts` | `test/converact-call-leg-foundation.test.ts` | `G03-E03-ID-STATE` |
| Call business state | `voice/types.ts`; `voice/state-machine.ts`; `voice/call-service.ts` | Voice application/state tests | `G03-E03-ID-STATE` |
| Leg/race state | `voice/call-leg-state-machine.ts` | `test/converact-call-leg-foundation.test.ts` | `G03-E03-ID-STATE` |
| SipFoundation types/capabilities | `sip-foundation/types.ts`; `capabilities.ts`; `closed-schema.ts` | `test/converact-sip-foundation.test.ts` | `G03-E02-BASELINE` |
| Protocol Session and drain | `sip-foundation/session-registry.ts` | foundation + G03 tests | `G03-E09-DRAIN` |
| rsipstack Adapter | `sip-foundation/rsipstack-adapter.ts`; `route-binding.ts` | foundation tests; exact patch tests | `G03-E02-BASELINE`, `G03-E07-WIRE` |
| durable effects/receipts | `effect-oracle.ts`; `postgres-effect-store.ts`; migration 107 | effect oracle and physical PostgreSQL tests | `G03-E04-EFFECT`, `G03-E05-POSTGRES` |
| recovery/clock | `sip-foundation/recovery.ts`; dialog takeover/shadow sources | recovery and takeover tests | `G03-E08-RECOVERY` |
| one 100 Trying | rsipstack single-trying patch; RustPBX call module | exact patch/native test and SIPp latency campaign | `G03-E06-TRYING` |
| raw wire corpus | `architecture-foundation/execution/goal-03/wire-corpus/*` | G03 contract/corpus test; future differential harness | `G03-E07-WIRE` |
| exact source build | `infra/converact/rustpbx/build.sh`; `Cargo.lock`; patch queue | RustPBX build/patch contract tests | `G03-E02-BASELINE` |
| interop/long/performance | SIPp acceptance scripts and future controlled campaign | real external dependency | `G03-E11/E12/E13` |

## 3. Existing Source Disposition

| Slice | Decision | Removal Gate |
| --- | --- | --- |
| `VoiceCall` repository/state machine | preserve as only business Call authority | never replaced by Adapter state |
| TypeScript SipFoundation seam | preserve and harden | only superseding versioned contract |
| rsipstack Adapter/patch queue | current baseline; do not delete | G06 new-call move + active/unknown/repair zero + rollback closure |
| durable effect v1 | preserve; add semantic projection rather than destructive rename | rolling N/N+1 physical migration proof |
| dialog shadow/takeover | preserve as outer business recovery authority | superseding recovery ADR and evidence |
| rvoip high-level session/orchestrator | do not import | explicit superseding Authority review |
| media/codec/LiveKit | out of G03 | G04/G05/G07 goals |

## 4. Evidence Non-inheritance

The 103-test audit baseline is local source/unit evidence only. Physical
PostgreSQL, SIP peer, long-call, fault/OOM and host-capacity results require new
raw outputs bound to the final G03 commit. Existing server containers remain
untouched and no production evidence is borrowed.
