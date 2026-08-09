# G03 Source → Test → Evidence Map

## 1. Trace Closure

`traceability-v1.json` carries all **143** G00 requirements assigned to G03.
Every row maps exactly once, zero rows are omitted, and every row remains
`not_run` until its own G03 evidence is attached. Historical R4/Wave/server
evidence is not promoted.

## 2. Current and Target Paths

| Domain | Current/target implementation | Focused tests | Evidence ID |
| --- | --- | --- | --- |
| owned ID types and projection-attested legacy import | `voice/foundation-identifiers.ts`; module-issued `VoiceCallProjectionIdAdapter` bound to exact `PostgresVoiceCallStore` with native-private composition and captured query method | `test/converact-call-leg-foundation.test.ts` including prototype/own-override rejection and role lock | `G03-E03-ID-STATE` |
| Call product intent/projection | `voice/types.ts`; `voice/state-machine.ts`; `voice/call-service.ts` | Voice application/state tests | `G03-E03-ID-STATE`; native authority is `G03-E16/not_run` |
| Leg/race conformance model | `voice/call-leg-state-machine.ts` covering pre-INVITE fork registration/CANCEL effects, terminating-winner 2xx retransmission, atomic transfer and fenced callback-free mailbox/timers | `test/converact-call-leg-foundation.test.ts` | `G03-E03-ID-STATE`; native binding is `G03-E16/not_run` |
| SipFoundation types/capabilities | `sip-foundation/types.ts`; `capabilities.ts`; `closed-schema.ts` | `test/converact-sip-foundation.test.ts` | `G03-E02-BASELINE` |
| originate/answer/terminate control port | closed `sip-foundation-control-message-v1` schema embedded in the target machine contract; current RustPBX binding remains outside the target port | compiled closed-schema contract test; future Adapter activation tests | `not_run` |
| Protocol Session, pre-callback reservation and drain | `sip-foundation/session-registry.ts` | foundation + G03 reentrancy tests | `G03-E09-DRAIN` |
| TypeScript rsipstack conformance Adapter | `sip-foundation/rsipstack-adapter.ts`; `route-binding.ts` | foundation tests and explicit non-authority role test | `G03-E02-BASELINE`; live native binding is `G03-E16/not_run` |
| native rsipstack runtime and bounded mailboxes | `.53` build plus `rsipstack-ivekit-bounded-protocol-mailboxes.patch` and `rustpbx-ivekit-bounded-call-mailboxes.patch` | exact patch gate; locked Rust library suite 1964 passed + 5 ignored; exact image/wire/latency/interop/capacity campaigns | controlled host evidence at source `b63383b`; live Native Authority remains `G03-E16/not_run` |
| durable effects/receipts reference | `effect-oracle.ts`; `postgres-effect-store.ts`; migration 107 | effect oracle and physical PostgreSQL tests; `test/converact-g03-postgres-restart-acceptance.test.ts` | `G03-E04-EFFECT`, `G03-E05-POSTGRES`; native writer is `G03-E16/not_run` |
| physical restart/replay probe | `services/converact-service/acceptance/g03-sip-foundation/postgres-effect-restart-probe.ts` | `test/converact-g03-postgres-restart-acceptance.test.ts`; controlled host campaign | `G03-E05-POSTGRES` |
| recovery/clock | `sip-foundation/recovery.ts`; dialog takeover/shadow sources | recovery and takeover tests | `G03-E08-RECOVERY` |
| one 100 Trying | rsipstack single-trying patch; RustPBX call module; `g03-trying/final/overload` SIPp scenarios; `scripts/converact-g03-sip-latency.ts` | exact patch/native test, SIPp 3.7.7 raw RTT plus aggregate/message-count parser tests, nearest-rank tests and controlled latency campaign | `G03-E06-TRYING` |
| inbound REFER transfer singleton | `rustpbx-ivekit-inbound-refer-wire.patch`; rsipstack-generated typed `Max-Forwards`; optional `Replaces` only | upstream native `test_inbound_refer_success`; `test/converact-rustpbx-inbound-refer-wire-patch.test.ts`; complete native RustPBX library suite | controlled source verification recorded in `inbound-refer-wire-repair-report.md`; external peer evidence remains `G03-E11-INTEROP/not_run` |
| raw wire corpus | `architecture-foundation/execution/goal-03/wire-corpus/*`; `rsipstack-ivekit-wire-guard.patch`; `scripts/g03/rsipstack-wire-replay.rs`; `scripts/converact-g03-wire-differential.ts` | G03 contract/corpus test; exact queue parser tests; dual-binary sanitized differential tests | `G03-E07-WIRE` |
| exact source build | `infra/converact/rustpbx/build.sh`; `Cargo.lock`; patch queue | RustPBX build/patch contract tests | `G03-E02-BASELINE` |
| controlled PostgreSQL evidence | `architecture-foundation/execution/goal-03/controlled-postgres-restart-report.md`; retained raw evidence manifest | exact-source physical PostgreSQL campaign and independent evidence review | `G03-E05-POSTGRES` |
| interop/long/performance | SIPp acceptance scripts and controlled `.53` campaign | SIPp plus Asterisk interop, one 7,201,279-ms SIP-control call and 50/100/200/1000-CPS 2-vCPU steps passed; allocation and 2/4/8-core scaling remain unproved | `G03-E11/E12` controlled; `G03-E13` remains evidence-gated |

## 3. Existing Source Disposition

| Slice | Decision | Removal Gate |
| --- | --- | --- |
| `VoiceCall` repository/state machine | preserve as Call intent and rebuildable control-plane projection | never promoted to active native authority |
| TypeScript SipFoundation seam | preserve as closed conformance/migration harness | never promoted to native transaction/Dialog authority |
| native rsipstack patch queue | current production baseline; do not delete | G06 new-call move + active/unknown/repair zero + rollback closure |
| durable effect v1 | preserve as reference contract; native writer must implement the same receipts | rolling N/N+1 plus `G03-E16` native activation proof |
| dialog shadow/takeover | preserve as recovery projection/reconciliation harness; native owner CAS is required | superseding recovery ADR and evidence |
| rvoip high-level session/orchestrator | do not import | explicit superseding Authority review |
| media/codec/LiveKit | out of G03 | G04/G05/G07 goals |

## 4. Evidence Non-inheritance

The local source/unit suite and the controlled physical PostgreSQL restart are
separate evidence classes. The latter qualifies only `G03-E05-POSTGRES` and is
not production evidence. Exact `.53` SIPp/Asterisk, two-hour SIP-control and
2-vCPU capacity outputs are retained separately. Fault/OOM, allocation,
multi-core scaling and carrier-specific results still require their own raw
outputs bound to the exact source commit.
Frozen production remains untouched and no historical production evidence is
borrowed.
