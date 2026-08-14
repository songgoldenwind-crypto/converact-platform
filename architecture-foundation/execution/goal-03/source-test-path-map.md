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
| native rsipstack runtime and bounded mailboxes | `.79` build: `.73` matched-CANCEL, `.74` ordinary responses, `.75` exact failure cleanup, `.76` conservative recovery seam, `.77` Rust/PostgreSQL recovery Oracle, `.78` product composition and `.79` authenticated recovered admission. The Rust app keeps one default-disabled store/owner Authority; one owner snapshot feeds registry and Oracle, stale owner and Active Call cleanup use separate exact pointer fences, and an old refresh loop exits when its original owner is replaced | exact-source SipEffect `135/135` with 11 ignored; native SIP effect `40/40` with one ignored; owner `11/11`; admission snapshot `3/3`; recovered paths `15/15`; full RustPBX `2109/2109` with 12 ignored; locked check, rustfmt, typecheck and static contracts pass. Evidence: `durable-recovered-admission-f56f954-19/` | compiled default-disabled `.79` component path only. Trusted recovered-proof production, live Endpoint, remaining transports, Linux process execution, process restart, all performance work and `G03-E16` remain `not_run` |
| native durable rsipstack egress adapter | protocol-observation through `.79`: `.77` enforces exact-key recovery and session high-water marks; `.78` binds that durable store to the real Rust app/SIP builder lifecycle; `.79` selects ordinary versus recovered installation only from the authenticated owner proof and exact current-owner snapshot. Disabled mode performs no database work; malformed, missing, duplicate or live-reloaded configuration fails closed. Cold startup is bounded at 2 s without widening the 250 ms Call-store deadline | local SipEffect `135/135`; native SIP effect `40/40`; focused owner/admission/recovery `11/11`, `3/3`, `15/15`; full RustPBX `2109/2109`. Historical migration 001–116 and exact `.78` Rust physical adapter `1/1` passed on isolated PostgreSQL 16; `.79` used no server | default-disabled Rust trusted invocation only. Recovered-proof issuer, real process restart, live Endpoint activation and `G03-E16` remain `not_run` |
| durable effects/receipts reference | `effect-oracle.ts`; `postgres-effect-store.ts`; migrations 107, 113, 114, 115 and 116; `.66` stale-effect recovery; `.71` fixed observer; `.72` exact-target reconciler; `.77` capability-recovery Oracle; `.78` Rust composition root; `.79` authenticated invocation | existing controlled evidence plus `.79` local SipEffect `135/135`, native SIP effect `40/40`, focused owner/admission/recovery filters and full RustPBX `2109/2109`. TypeScript remains a contract/conformance and authenticated control-plane compatibility layer; server runtime, workers, owner registry and durable store composition are Rust | existing `G03-E04-EFFECT` and `G03-E05-POSTGRES` are not promoted to live authority by this component evidence; recovered issuer/sink, live Endpoint, process-crash/two-node and native activation remain `not_run`; 10K/100K and every performance item are deferred |
| physical restart/replay probe | `services/converact-service/acceptance/g03-sip-foundation/postgres-effect-restart-probe.ts` | `test/converact-g03-postgres-restart-acceptance.test.ts`; controlled host campaign | `G03-E05-POSTGRES` |
| recovery/clock | `sip-foundation/recovery.ts`; TypeScript v2 recovery capsule; Rust `.65` reciprocal dialog takeover/shadow and `NativeCallRecoveryBinding`; `.66` exact-session stale SipEffect recovery using the database clock; `.69` real stale-window fixture; `.70` unambiguous update candidate | recovery/takeover tests, v1 fail-closed and shared Rust/TypeScript SHA-256 golden, bounded batch/index/static Rust tests, and exact `.70` PostgreSQL pool-recreation recovery `2/2` | `G03-E08-RECOVERY/verified_controlled` for the focused pool-recreation slice; live successor wiring and real process-crash/two-node takeover remain `not_run` |
| one 100 Trying | rsipstack single-trying patch; RustPBX call module; `g03-trying/final/overload` SIPp scenarios; `scripts/converact-g03-sip-latency.ts` | exact patch/native test, SIPp 3.7.7 raw RTT plus aggregate/message-count parser tests, nearest-rank tests and controlled latency campaign | `G03-E06-TRYING` |
| inbound REFER transfer singleton | `rustpbx-ivekit-inbound-refer-wire.patch`; rsipstack-generated typed `Max-Forwards`; optional `Replaces` only | upstream native `test_inbound_refer_success`; `test/converact-rustpbx-inbound-refer-wire-patch.test.ts`; complete native RustPBX library suite | controlled source verification recorded in `inbound-refer-wire-repair-report.md`; external peer evidence remains `G03-E11-INTEROP/not_run` |
| raw wire corpus | `architecture-foundation/execution/goal-03/wire-corpus/*`; `rsipstack-ivekit-wire-guard.patch`; `scripts/g03/rsipstack-wire-replay.rs`; `scripts/converact-g03-wire-differential.ts` | G03 contract/corpus test; exact queue parser tests; dual-binary sanitized differential tests | `G03-E07-WIRE` |
| exact source build | `infra/converact/rustpbx/build.sh`; `Cargo.lock`; patch queue | RustPBX build/patch contract tests | `G03-E02-BASELINE` |
| controlled PostgreSQL evidence | prior PostgreSQL bundles plus `evidence/raw/capability-recovery-oracle-204f4d5-17/`; `.78` bundle under `evidence/raw/durable-sip-runtime-composition-2ecfb72-18/`; `.79` local-only bundle under `evidence/raw/durable-recovered-admission-f56f954-19/` | prior restart/observation/derived-ACK cases plus full migration 001–116 and exact `.78` Rust startup-contract adapter `1/1`; `.79` reuses this physical contract but makes no new physical claim and did not contact the server | `G03-E05-POSTGRES` remains scoped component evidence; no live Endpoint, Linux product process, native authority or production promotion |
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

The `.77` bundle proves only the isolated PostgreSQL 16 migration and SQL
contract. It records exact candidate hashes, full migration output, the
physical harness and pre/post-cleanup server state. The existing container
remained healthy; the exact temporary `network=none` container and tmpfs
directory are absent after cleanup. Rust adapter physical tests, live recovery,
real process crash/two-node, Endpoint activation and production remain
`not_run`. No performance command ran.

The `.79` bundle is local functional evidence only. It proves the authenticated
admission shape, exact owner snapshot, recovery-Oracle invocation selection and
replacement-safe cleanup on the pinned Rust sources. It does not inherit the
`.78` physical adapter result as a `.79` server result, nor any `.53` traffic or
capacity result. The server was not contacted. Trusted recovered-proof
production, real process restart/two-node, live Endpoint, Linux product process,
fault/OOM, production and all deferred performance work remain `not_run`.
