# Overlap And Authority Ledger

This ledger resolves design ownership only. It does not delete or migrate code.
`delete-after-drain` always means new sessions move first, old sessions remain
pinned, active state reconciles to zero, and only a later explicit Goal may delete.

| Domain | Authority / target | Overlap | Disposition | Goal | Invariant |
| --- | --- | --- | --- | --- | --- |
| Product/Call Authority | Unified RustPBX | Legacy Call models and high-level rvoip orchestrators | keep / quarantine | G03 | One Call/Leg/Dialog/CDR writer; rvoip high-level state never becomes authoritative. |
| SIP Edge | Kamailio | Rust registrar/proxy edge modes | keep / quarantine | G03 | Standalone modes may remain test adapters; production edge ownership stays Kamailio. |
| SIP interface | SipFoundation traits and exact wire receipts | rsipstack and rvoip public types | absorb | G03,G06 | Business code depends on stable traits; selected low-level slices remain behind adapters. |
| SIP state machine | RustPBX Business Dialog plus one active Protocol Adapter | rsipstack/rvoip dual transaction writers | delete-after-drain | G03,G06 | Shadow is read-only; migrate new calls, pin old calls, reconcile active-zero. |
| Durable model | Call/Effect/Generation/Receipt contracts | Process-local framework histories | keep / migrate | G02,G03,G07,G14 | Durable CAS/fences own decisions; projections are rebuildable. |
| Logical media graph | Unified RustPBX Call Core | Backend-local topology authorities | keep | G05 | Backends execute directed edges but do not decide graph or route. |
| Ordinary RTP/SRTP | RTPengine | Rust-native ordinary fast path candidate | keep / quarantine | G05,G08 | RTPengine remains performance floor; candidate needs same-cell full-function evidence. |
| Decode media | voice-media-rs facade | rustpbx-media and rvoip media duplicates | absorb / delete-after-drain | G05,G06 | Select algorithms by exact-source tests; one codec/session registry remains. |
| Codec registry | Unified Codec Registry | audio-codec/rvoip/rustpbx duplicate registries | migrate | G04,G05,G06 | One G729/8000 wire identity; legal gate only affects distribution/enablement. |
| Recording intent/timeline | RustPBX plus root RecordingManifest | Backend-local recording ownership | keep / migrate | G05,G07,G08 | Capture executors are fenced; upload is isolated and cannot stop main media. |
| LiveKit Room/WebRTC | LiveKit | RustPBX browser WebRTC or second SFU | keep / quarantine | G07 | RustPBX coordinates telephony; LiveKit owns Room/Participant/Track/SFU. |
| Voice-LiveKit switching | Fabric Coordination | Ad-hoc SIP bridge lifecycle | migrate | G07 | Durable prepare/commit/abort/query/reconcile with immutable generations. |
| ViLTE/IMS | Operator IMS plus Converact AV Gateway boundaries | LiveKit SIP video assumption | quarantine / conditional | G17 | LiveKit SIP audio only; runtime waits for independent external start gates. |
| Speech | Converact SpeechRuntime | Provider-shaped STT/LLM/TTS chains | migrate | G12 | HF replaces only overlapping execution; non-overlapping framework features remain. |
| Agent | Converact Agent Runtime | Active/LiveKit/pi-agent/nanobot durable authorities | absorb / quarantine | G13 | Frameworks are channel executors; one cross-channel lease and ContextRevision. |
| AI action | Converact Engage Action Authority | Framework direct HTTP/tool writes | migrate / quarantine | G11,G14 | ActionProposal crosses policy, approval, idempotency, receipt and reconcile. |
| Connector | Typed overlay Adapter | Customer-specific direct writes | absorb / quarantine | G11,G14 | External systems retain their formal records and closure authority. |
| Engagement | Converact Engage | Profile validators or external platforms as second writer | keep | G09 | Engagement/Profile/Outcome authority follows Program Rules. |
| Resolve Profile | Strict Engagement specialization | Resolution as platform-wide root | keep / quarantine | G01,G09 | Profile semantics never narrow the horizontal platform. |
| Collaboration | Human/AI collaboration projection | Chat/workspace as business authority | absorb | G10 | Workspace reflects leases and handoffs; it does not own Engagement or AgentRun. |
| Tests | Canonical Goal-owned tests | Borrowed legacy pass/fail claims | migrate / quarantine | G02-G17 | Tests may be absorbed after source review; old results remain historical. |
| Documents | Platform R2 + R5 + binding Goals | Obsolete OPC/AI-native plans | keep / quarantine | G00,G01 | Old documents remain traceable but cannot authorize implementation. |

## Review result

No unresolved Authority writer remains in the target model. Quarantined candidates
are not production paths. The detailed source paths and migration dispositions are
in [workspace-inventory-v1.json](./workspace-inventory-v1.json) and
[file-level-migration-sequence.md](./file-level-migration-sequence.md).
