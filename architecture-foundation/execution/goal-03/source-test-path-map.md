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
| native rsipstack runtime and bounded mailboxes | `.73` build: the `.72` supervisor tail plus a transaction-local matched-CANCEL pair and Native Call-owned default-disabled capability runtime; only Trying/Proceeding INVITEs receive the 487 capability, while late CANCEL after an existing final receives only 200. The bounded mailbox, protocol observation, derived ACK, private peer proof, UAS-2xx owner/retention, recovery identity, durable gate and directional model remain intact | local exact-source full rsipstack `314/314`, full RustPBX `2063 passed / 0 failed / 9 ignored`, focused server transactions `32/32`, durable gate `39/39`, Native capability composition `8/8`, Active Call registry `24/24`, builder `1/1`, both locked Rust checks and the `.73` static patch gate `4/4`; the isolated Linux rsipstack server target also passes `32/32`; RustPBX host targets remain `not_run` because the lib-test compile reached the fixed 2,560 MiB isolation ceiling; the one-line upstream test constructor change remains compiled/full-tested but is excluded from rustfmt due unrelated baseline drift | `.73` local result plus isolated Linux rsipstack component evidence in `isolated-server-matched-cancel-4431270-15/`; service/lower bytes are unchanged. Successor-safe cleanup fencing, restart reconstruction, RustPBX host targets, TCP/WS/TLS/WSS, physical PostgreSQL, live activation, exact-image verification, Linux full, performance requalification and `G03-E16` remain `not_run` |
| native durable rsipstack egress adapter | protocol-observation through `.73`: closed v2 facts, distinct terminal meanings, bounded observation ownership, fixed workers/queue, exact-target reconciliation grants, parent-bound ACK, private peer proof, and two separate one-use matched-CANCEL effects only while the INVITE is pending. `200 CANCEL` is transport-terminal; `487 INVITE` remains non-terminal until exact peer ACK. Native Call reserves both capabilities before installing the transaction-local gate; builder activation is `None` by default | local exact-source full rsipstack `314/314`, full RustPBX `2063 passed / 0 failed / 9 ignored`, focused durable gate `39/39`, Native capability composition `8/8`, server transactions `32/32`, registry `24/24`, builder `1/1`, locked Rust checks and `.73` static patch gate `4/4`; isolated Linux repeats the rsipstack server transactions `32/32`, while RustPBX host targets remain `not_run` under the safe memory ceiling; controlled `.72` focused Linux and prior `.60` physical PostgreSQL evidence are not inherited | compiled default-disabled Rust path plus isolated rsipstack component proof only; durable completion/recovery resumption, RustPBX host targets, physical PostgreSQL, remaining transports, product activation and `G03-E16` remain `not_run` |
| durable effects/receipts reference | `effect-oracle.ts`; `postgres-effect-store.ts`; migrations 107, 113, 114 and 115; `.66` native stale-effect recovery; `.69` database-clock fixture; `.70` recovery SQL alias; `.71` fixed observer supervision; `.72` exact-target reconciler supervision | existing evidence-backed effect tests plus isolated `.72` reconciler `28/28`, affected SipEffect `87 passed / 0 failed / 8 ignored`, privacy UI probes, locked check and Rust formatting. The `.72` path uses the existing composite primary key for bounded exact lookup/no scans; both in-memory and PostgreSQL claim paths share the 512-byte repair-fence validator; monotonic expiry includes queue dwell, dequeue freezes one whole-ms execution lease, usable timeout is capped at 29 s and remaining lease must be strictly greater than timeout + 500 ms. Parent-cancelled submit is rejected; a caught port panic cancels the entire reconciler child domain and rejects new grants without affecting the parent call process; process-local progress advances per confirmed durable reconcile/exhaustion even if later work fails | existing `G03-E04-EFFECT/verified_controlled` and `G03-E05-POSTGRES/verified_controlled` are not promoted by `.72`; live issuer/sink, physical PostgreSQL, 10K/100K plans and native activation remain `not_run` |
| physical restart/replay probe | `services/converact-service/acceptance/g03-sip-foundation/postgres-effect-restart-probe.ts` | `test/converact-g03-postgres-restart-acceptance.test.ts`; controlled host campaign | `G03-E05-POSTGRES` |
| recovery/clock | `sip-foundation/recovery.ts`; TypeScript v2 recovery capsule; Rust `.65` reciprocal dialog takeover/shadow and `NativeCallRecoveryBinding`; `.66` exact-session stale SipEffect recovery using the database clock; `.69` real stale-window fixture; `.70` unambiguous update candidate | recovery/takeover tests, v1 fail-closed and shared Rust/TypeScript SHA-256 golden, bounded batch/index/static Rust tests, and exact `.70` PostgreSQL pool-recreation recovery `2/2` | `G03-E08-RECOVERY/verified_controlled` for the focused pool-recreation slice; live successor wiring and real process-crash/two-node takeover remain `not_run` |
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

The `.72` `28/28` reconciler and affected SipEffect
`87 passed / 0 failed / 8 ignored` results, privacy UI probes, locked check and Rust formatting
have local component verification plus a controlled offline focused-Linux
rerun. They do not inherit the controlled `.71` Linux full suite or promote any
evidence status. Physical PostgreSQL claim/rollback, 10K/100K distractor query
plans, the authoritative issuer, durable completion sink, live Endpoint,
process-crash/two-node, Linux full, fault/performance and production evidence
all remain `not_run`.

The `.73` matched-CANCEL results include local functional checks and one
zero-impact isolated Linux rsipstack component run (`32/32`). They neither
replace `.72` Linux evidence nor start a load campaign. The RustPBX host
targets remain `not_run` after their test binary compile reached the fixed
2,560 MiB ceiling; no resource limit was raised. Remaining transports,
product activation and every performance Gate remain `not_run`.
