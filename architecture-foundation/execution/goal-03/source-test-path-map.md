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
| native rsipstack runtime and bounded mailboxes | `.69` build plus the `.66` indexed stale-nonterminal runtime and the superseded `.67`/`.68` fixture guards, bounded mailbox, protocol-observation, derived non-2xx ACK, peer-ingress proof, peer-derived matched-CANCEL, bounded UAS-2xx owner/retention, Native Call recovery identity, durable gate and directional Native Call patches | `.69` local exact-patch gates pass `186/186`, affected TypeScript gates pass `121/121`, G03 contract passes `9/9`, and typecheck passes; exact `.68` Linux passed the bounded unit and then correctly rejected a timestamp earlier than `prepared_at`, while database-clock `.69` physical-PostgreSQL verification remains `not_run`; retained `.65` authorized-server `1d05333…` passed RustPBX `2,015/0/8`, dialog-shadow `20/20`, rsipstack `311/311` and doctests `67/67`; `.53` remains the exact controlled image/wire/latency/interop/capacity source | `.59` protocol evidence remains under `native-protocol-observation-fe4c38b-05`; `.60` exact-source evidence is under `derived-non-2xx-ack-9fc99ee-06`; `.61` component evidence is under `peer-ingress-proof-701475a-07`; `.62` component evidence is under `peer-derived-cancel-56e0d42-08`; `.63` host rsipstack passed but RustPBX compile failed; `.64` controlled component evidence is under `uas-2xx-retention-a85d249-09`; `.65` component evidence is under `native-call-recovery-1d05333-10`; `.69` server evidence, live Native Authority, image/traffic/performance requalification and `G03-E16` remain `not_run` |
| native durable rsipstack egress adapter | protocol-observation patches plus derived non-2xx ACK, peer-ingress, matched-CANCEL and UAS-2xx owner/retention patches: closed v2 facts, separate terminal meanings, bounded observation ownership, one stable parent-bound non-2xx ACK child, a private zero-sized Endpoint proof, one pre-authorized peer-derived CANCEL 200 and one exact frozen 2xx/permit owner retained by RustPBX | focused capability/mismatch/cancellation/replay/provenance/ACK/deadline/owner-retention/initial-send-failure/reliable-transport tests; local RustPBX `2,008/0/8`; local rsipstack `311/311`; prior `.60` physical PostgreSQL atomic child prepare `1/1`; static exact-patch gates | compiled default-disabled adapter only; real Call Core capability registration, live Endpoint wiring, reconcile resume, transport flow-generation receipt binding, parent-Unknown/stale-nonterminal/UAS-owner crash recovery and `G03-E16` remain `not_run` |
| durable effects/receipts reference | `effect-oracle.ts`; `postgres-effect-store.ts`; migrations 107, 113, 114 and 115; `.66` native stale-effect recovery; `.69` final database-clock physical fixture | effect-oracle tests, v1/v2 migration gates, bounded successor-fence static/unit tests, and six prior controlled physical PostgreSQL cases; corrected `.69` physical crash-window case remains `not_run` | `G03-E04-EFFECT`, `G03-E05-POSTGRES`; native writer activation is `G03-E16/not_run` |
| physical restart/replay probe | `services/converact-service/acceptance/g03-sip-foundation/postgres-effect-restart-probe.ts` | `test/converact-g03-postgres-restart-acceptance.test.ts`; controlled host campaign | `G03-E05-POSTGRES` |
| recovery/clock | `sip-foundation/recovery.ts`; TypeScript v2 recovery capsule; Rust `.65` reciprocal dialog takeover/shadow and `NativeCallRecoveryBinding`; `.66` exact-session stale SipEffect recovery using the database clock; `.69` real stale-window fixture | recovery/takeover tests, v1 fail-closed and shared Rust/TypeScript SHA-256 golden, plus bounded batch/index/static Rust tests | local component proof only; corrected `.69` physical PostgreSQL and live successor wiring plus real process-crash/two-node takeover remain `G03-E08-RECOVERY/not_run` |
| one 100 Trying | rsipstack single-trying patch; RustPBX call module; `g03-trying/final/overload` SIPp scenarios; `scripts/converact-g03-sip-latency.ts` | exact patch/native test, SIPp 3.7.7 raw RTT plus aggregate/message-count parser tests, nearest-rank tests and controlled latency campaign | `G03-E06-TRYING` |
| inbound REFER transfer singleton | `rustpbx-ivekit-inbound-refer-wire.patch`; rsipstack-generated typed `Max-Forwards`; optional `Replaces` only | upstream native `test_inbound_refer_success`; `test/converact-rustpbx-inbound-refer-wire-patch.test.ts`; complete native RustPBX library suite | controlled source verification recorded in `inbound-refer-wire-repair-report.md`; external peer evidence remains `G03-E11-INTEROP/not_run` |
| raw wire corpus | `architecture-foundation/execution/goal-03/wire-corpus/*`; `rsipstack-ivekit-wire-guard.patch`; `scripts/g03/rsipstack-wire-replay.rs`; `scripts/converact-g03-wire-differential.ts` | G03 contract/corpus test; exact queue parser tests; dual-binary sanitized differential tests | `G03-E07-WIRE` |
| exact source build | `infra/converact/rustpbx/build.sh`; `Cargo.lock`; patch queue | RustPBX build/patch contract tests | `G03-E02-BASELINE` |
| controlled PostgreSQL evidence | `controlled-postgres-restart-report.md`; `evidence/raw/native-protocol-observation-fe4c38b-05/`; `evidence/raw/derived-non-2xx-ack-9fc99ee-06/`; retained raw manifests | prior restart campaign, `.59` atomic prepare/observation cases and `.60` atomic parent/child derived-ACK case; `.61` and `.62` change no PostgreSQL behavior and do not inherit those runs | `G03-E05-POSTGRES`; current component proof does not promote live authority or production eligibility |
| interop/long/performance | SIPp acceptance scripts and controlled `.53` campaign | SIPp plus Asterisk interop, one 7,201,279-ms SIP-control call and 50/100/200/1000-CPS 2-vCPU steps passed; allocation and 2/4/8-core scaling remain unproved | `G03-E11/E12` controlled; `G03-E13` remains evidence-gated |

## 3. Existing Source Disposition

| Slice | Decision | Removal Gate |
| --- | --- | --- |
| `VoiceCall` repository/state machine | preserve as Call intent and rebuildable control-plane projection | never promoted to active native authority |
| TypeScript SipFoundation seam | preserve as closed conformance/migration harness | never promoted to native transaction/Dialog authority |
| native rsipstack patch queue | current production baseline; do not delete | G06 new-call move + active/unknown/repair zero + rollback closure |
| durable effect v1/v2 | preserve v1 readers and rows while new effects use the closed v2 contract only after a gated reader-before-writer rollout | mixed-binary N/N+1 evidence, v1 active-zero and `G03-E16` native activation proof |
| dialog shadow/takeover | preserve as recovery projection/reconciliation harness; native owner CAS is required | superseding recovery ADR and evidence |
| rvoip high-level session/orchestrator | do not import | explicit superseding Authority review |
| media/codec/LiveKit | out of G03 | G04/G05/G07 goals |

## 4. Evidence Non-inheritance

The local source/unit suite and controlled `.59`, `.60`, `.61` and `.62` Linux component bundles,
and controlled physical PostgreSQL campaigns are separate evidence classes.
They qualify only the exact component behavior stated in their manifests and
are not production evidence. Exact `.53` SIPp/Asterisk, two-hour SIP-control
and 2-vCPU capacity outputs are retained separately and are not inherited by
`.62` or `.64`. The failed `.63` host RustPBX build and controlled `.64`
component result do not inherit those image or traffic bundles. Fault/OOM, allocation,
multi-core scaling, real-peer, long-call and
carrier-specific results still require their own raw outputs bound to the
exact release source/image.
Frozen production remains untouched and no historical production evidence is
borrowed.
