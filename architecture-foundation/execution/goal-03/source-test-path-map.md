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
| native rsipstack runtime and bounded mailboxes | `.76` build: `.73` matched-CANCEL, `.74` ordinary responses, `.75` exact failure cleanup, and `.76` conservative unconsumed-capability recovery. Recovery binds the closed Native Call capsule, predecessor/successor fences and exact server-INVITE transaction; only an atomic `NoVisibleEffect` Oracle result may precede successor revalidation and capability installation. The installed gate carries the exact successor identity and rejects every prepare path if that identity is no longer current. Existing bounded mailboxes, protocol observation, derived ACK, private peer proof, UAS-2xx owner/retention and directional model remain intact | local exact-source focused Native SIP capability `25/25`, Active Call registry `24/24`, full RustPBX `2082/2082` with 9 external-prerequisite cases ignored, locked Rust library check and scoped rustfmt; isolated-server `.76` verification remains `not_run` | compiled default-disabled `.76` component path only. Earlier isolated server evidence is retained but not inherited. Real PostgreSQL recovery Oracle, live wiring, physical PostgreSQL, product activation, remaining transports, all performance work and `G03-E16` remain `not_run` |
| native durable rsipstack egress adapter | protocol-observation through `.76`: `.73` retains two matched-CANCEL effects; `.74` orders ordinary response authority through durable prepare; `.75` prevents stale failure cleanup from deleting a successor; `.76` refuses blind post-restart reconstruction unless one durable Oracle atomically fences the predecessor and proves no visible effect, then rechecks and binds the exact successor before reserving the pair. A later same-provider-ID successor makes the stale gate fail closed without Call mutation or a new effect | focused Native SIP capability `25/25`, registry `24/24`, full RustPBX `2082/2082` with 9 ignored external prerequisites, locked check and rustfmt; physical PostgreSQL and server functional verification remain `not_run` | compiled default-disabled Rust component only; prior evidence is not inherited. Durable Oracle implementation, live recovery holder, physical PostgreSQL, product activation and `G03-E16` remain `not_run` |
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

The `.75` cleanup-fencing results are local focused functional checks only.
They prove exact authority ordering and failure behavior in Rust, but do not
inherit `.73` server evidence. The isolated `9775a79` attempt applied the exact
patch chain but executed no RustPBX test because the lib-test compile reached
its 3,584 MiB cgroup; byte-identical service/lower-source snapshots are retained
under `isolated-server-native-response-9775a79-16/`. Physical PostgreSQL, live
Endpoint and isolated server functional verification remain `not_run`; no
performance, load, capacity, concurrency or soak command is part of this slice.
