# G03 Fault and Threat Review

Status: design review complete; dynamic fault campaigns tracked as `not_run`
Production eligibility: `false`

## 1. Protected Assets

- one Call/Leg/Business Dialog writer and its owner fence;
- prepared SIP bytes, route/candidate identity and effect receipts;
- tenant isolation and idempotency namespace;
- Protocol Dialog/transaction correlation;
- authentication, TLS and media-key confidentiality;
- existing Call availability under new-call overload;
- CDR and external-effect uniqueness.

## 2. Threats and Controls

| Threat | Required control | Current evidence boundary |
| --- | --- | --- |
| forged Edge metadata | strip all external internal headers; rebuild six allowed fields after strong Edge identity | contract/source only; live mTLS campaign not inherited |
| request smuggling or parser differential | original bytes + hash, closed limits, conflicting singleton rejection, shared corpus | exact `.53` rsipstack differential replay verified; future rvoip Adapter replay `not_run` |
| Call-ID, provider reference or UUID confused with business Call | distinct types; a module-issued projection adapter may attest an exact legacy tenant/ID match, but only native RustPBX may adopt the candidate; provider/SIP IDs never become CallId | local role/identifier tests; native binding `not_run` |
| stale/split-brain owner | positive epoch, generation, expected revision and durable CAS | local logic/source tests; fleet partition `not_run` |
| duplicate visible effect | idempotency key + exact prepared bytes + receipt replay | native isolated PostgreSQL transition/repair tests and restart verified; live SIP dispatch `not_run` |
| unknown send blindly retried | unknown state, query, repair lease/token/revision fence | `.57` native gate and ledger tests; live endpoint activation `not_run` |
| restart treats an empty in-memory capability holder as proof that no predecessor wire effect existed | `.76` freezes the exact recovery binding; `.77` advances the exact tenant/session owner-generation fence and probes only deterministic 200-CANCEL and 487-INVITE effect IDs in one PostgreSQL transaction; `.79` requires an authenticated `recovered` proof and routes that exact owner snapshot through the Oracle; visible or ambiguous state fails closed | isolated PostgreSQL 16 migration/SQL harness and historical `.78` Rust startup-contract adapter pass; `.79` invocation tests pass locally. Trusted recovered-proof production and real process restart remain `not_run` |
| missing, forged or stale recovered admission silently downgrades to fresh, stale async cleanup closes a replacement owner/Active Call, or an old refresh task follows that replacement forever | closed authenticated `fresh`/`recovered` union; durable mode rejects absent and legacy proof; exact predecessor identity validation; one owner `Arc` feeds registry and Oracle; pre/post-async current-owner checks; owner pointer-fenced cleanup plus exact Native Call identity/cell cleanup fence; refresh loop bound to its original owner pointer | `.79` owner `11/11`, admission snapshot `3/3`, recovered-path `15/15` and full RustPBX `2109/2109`; trusted recovered-proof issuer, process restart and live Endpoint remain `not_run` |
| product starts a second, in-memory or partially configured SIP effect authority | `.78` creates one default-disabled Rust composition before SIP startup, shares one PostgreSQL store across Gate/observation/recovery, owns the supervisor lifetime, rejects unknown/missing/non-PostgreSQL config, duplicate builder injection and live reload, and has no memory/TypeScript fallback. `.79` reuses that exact runtime and owner registry rather than constructing a recovery store or owner. The one-time cold catalog scan has a separate bounded 2 s deadline while per-Call store work stays at 250 ms | exact-source SipEffect `135/135`, native SIP effect `40/40`, full RustPBX `2109/2109`, historical exact isolated PostgreSQL adapter `1/1`, locked check and static contracts pass; live Endpoint remains `not_run` |
| old binary bypasses a recovered session fence | migration 116 seeds and locks a durable owner/generation high-water mark, rejects stale inserts, and rejects the first `send_attempted` transition of an effect prepared before takeover while still accepting later real observations | isolated SQL harness observed SQLSTATE `55000` and atomic attempted-receipt rollback for both bypass shapes; rolling mixed-binary live activation remains `not_run` |
| recovery receipt is replayed with drift or leaks the raw SIP transaction key | receipt key/hash and result are immutable and replay-validated; only the transaction-key SHA-256 is durable | isolated replay, mutation rejection and schema review passed; live audit consumption remains `not_run` |
| one pending-INVITE CANCEL is treated as one effect, allows an unowned 487, or a late CANCEL authorizes a second final | split only the sealed transaction-layer peer proof while INVITE is Trying/Proceeding; bind separate one-use capabilities, identities and completion scopes to `200 CANCEL` and `487 INVITE`; 487 waits for exact ACK; after an existing final, authorize only 200 CANCEL | `.73` local rsipstack `32/32`, durable gate `39/39` and Native capability `8/8`; isolated Linux rsipstack server target `32/32`; RustPBX host and restart/reconcile remain `not_run` |
| a durable gate is installed globally, twice or after visible signaling | install only on the admitted server-INVITE transaction, after idempotent 100 Trying and before any other visible response/effect; conflict revokes both capabilities and closes only that Call | `.73` local default-disabled and conflict tests plus isolated Linux rsipstack `32/32`; product activation and RustPBX host execution `not_run` |
| repair worker enumerates or takes cross-session authority | only an opaque/sealed crate-private minting surface can create the one-shot grant for one exact tenant/session/generation, one successor repair epoch and 1..100 exact ordered target IDs/revisions/identity hashes; worker cannot scan, mint/reuse epochs or send SIP | `.72` isolated local reconciler `28/28`, affected SipEffect `87 passed / 0 failed / 8 ignored` and sibling UI probes with expected `E0603`/`E0451`; live durable Authority issuer, physical PostgreSQL and activation `not_run` |
| partial/stale repair claim mutates an ambiguous subset | existing composite primary key exact-target lookup; one transaction returns exact claimed/exhausted IDs; any missing/stale/locked target is `FenceLost` and rolls back; true monotonic expiry includes queue dwell and freezes one whole-ms execution lease at dequeue; usable timeout is at most 29 s and remaining lease must be strictly greater than timeout + 500 ms | `.72` local source/tests only; physical PostgreSQL rollback and 10K/100K distractor query-plan proof `not_run` |
| cancelled or panicked reconciler accepts/reuses authority | reject submit after parent cancellation without queue-counter churn; a caught port panic cancels the reconciler child token, stops every repair worker and rejects new grants so shared dependencies are never reused; parent Call/Human Communication remains outside the child domain | `.72` local TDD only; process-crash/two-node and live supervision `not_run` |
| later batch failure erases confirmed progress | increment process-local reconciled/exhausted counters immediately after each confirmed durable reconcile/exhaustion, including before later transient, `Terminal`, permanent, panic, timeout or cancel outcomes | `.72` local TDD only; durable completion sink and restart-persistent metrics `not_run` |
| auth/SDP secret leak | raw values excluded from logs, metrics, evidence and error details | source review plus exact-campaign generated-secret scans passed |
| queue/connection exhaustion | hard capacities, deterministic 503/Retry-After, no unbounded waiter/task | `.58` local bounded-gate and direction-key tests plus the `.53` exact 2-vCPU 1000-CPS controlled step passed separately; `.58` host allocation and saturation frontier remain `not_run` |
| inbound UAS emits a local ACK or enters outbound fork selection | direction is part of the transition key; inbound 2xx waits in `awaiting_ack`; fork registration/selection is outbound-only | `.58` TypeScript/native focused tests; live endpoint activation remains `not_run` |
| malicious object/accessor/proxy input | closed own-data snapshots and bounded copies | existing local SipFoundation tests |
| async callback continues after registry failure | Call registry invokes no callbacks; only fenced bounded dequeue, supervised execution and fenced re-entry | G03 unit/source evidence required |
| fork winner leaves early sibling ringing | register every branch before INVITE; winner receipt contains bounded per-Leg CANCEL effects and atomically marks siblings terminating | G03 race unit evidence required |
| retransmitted 2xx revives a terminating winner | preserve `terminating`; emit one idempotent ACK-then-BYE effect under the same Call fence | G03 race unit evidence required |
| Adapter callback reenters open/drain | reserve ID/capacity before callback; opening reservation counts as active; same-ID reentry fails closed | G03 local reentrancy tests; host fault campaign `not_run` |
| schema downgrade or shadow writer | schema/writer registries disabled until activation receipt; exact writer role | source/migration tests; physical activation `not_run` |

The `.80` candidate supersedes the two `.79` issuer-status cells above: local
trusted proof issuance is implemented and verified from one reciprocal v2
capsule pair. The remaining risk is real restart-to-issuer-to-Oracle execution,
not the existence of a client-callable recovered proof emitter.

## 3. Failure-domain Truth Table

| Failure | Allowed result | Forbidden claim |
| --- | --- | --- |
| one Call actor/event handler panic while process remains alive | contain failure, fence that Call's mutation, preserve other registry entries | automatic successful Call recovery without receipt |
| one Protocol worker panic | supervisor observes terminal worker result; existing unrelated Calls remain indexed | process-wide safety without native test |
| blocking DNS/store call | bounded deadline, reject new work, preserve established media | infinite wait or growing waiter list |
| durable store loss | 503 new Call; bounded repair; ordinary established RTPengine media may continue | business fact committed without durable ACK |
| Unified RustPBX abort/OOM/kill | control and in-process registry are lost; external RTPengine ordinary forwarding may continue degraded | “existing Call registry survives process OOM” |
| embedded media worker failure | only affected decode-required Edge may interrupt; ordinary external RTPengine Edge is independent | whole Call called healthy when mandatory Edge is broken |
| RTPengine loss | affected ordinary media interrupts and is reconciled | SIP control health renamed media continuity |

The single-process boundary has a hard physical limit: an unrecoverable OOM,
abort or kill cannot preserve in-process memory. G03 therefore proves only
worker/task containment inside a surviving process and durable reconstruction
after process loss. Any stronger claim would be false.

## 4. Native/Unsafe Gate

Before any rvoip/native/unsafe parser slice becomes eligible, it needs exact
source and features, ABI review, fuzz/sanitizer results, bounded allocation,
panic/segfault containment decision, core-dump policy, SBOM/provenance and an
independent review. G03 introduces no rvoip/native slice, so this remains
`not_run`, not “not applicable forever”.

## 5. Performance Abuse Review

- lookup tables are bounded and expected O(1);
- timer work is amortized O(1) or bounded O(log N);
- fork-winner and other per-Call scans are bounded by hard branch/Leg/Dialog
  limits (fork branches at most 32);
- no request or timer path scans all Calls;
- no SIP/RTP message creates an unbounded task;
- retransmission reuses frozen bytes;
- metrics labels exclude tenant, Call ID, URI, phone, IP and raw cause text;
- durable store, object storage, Provider and general event bus never enter RTP
  packet processing.

CPU/allocation regressions still require same-source host evidence. Under the
current feature-first program policy, that evidence is deliberately deferred;
no current functional slice may claim or trigger a performance Gate. Passing a
microbenchmark or citing rvoip upstream numbers cannot close that Gate.

## 6. Residual Risks

1. TypeScript SipFoundation/effect source is a conformance/reference harness;
   the `.71` native composition and fixed observation supervisor are compiled,
   host-requalified but default-disabled, and therefore are not yet an elected
   live writer path.
2. Exact `.53` wire, raw latency, SIPp/Asterisk interop, two-hour SIP-control
   and 2-vCPU capacity regression campaigns passed; rvoip differential,
   allocation and multi-core scaling remain separate future Gates. The soak is
   not RTP/media, recording or quality evidence.
3. Native Call/Leg and all-direction SipEffect endpoint activation remains
   `G03-E16/not_run`; local adapter tests and controlled PostgreSQL replay do
   not close it.
4. Native panic, process abort, OOM, disk/network loss and blocking-call
   campaigns have not run.
5. Fault/OOM and complete host-performance evidence have not run for the exact
   `.73` candidate. Retained `.53` evidence is scoped to its exact source, and
   `.42` results remain historical only.
6. `.72` exact-target reconciliation remains default-disabled. Normal
   `FenceLost`/`Terminal` races are classified as superseded and keep healthy
   workers available. A caught port panic cancels the whole reconciler child
   domain, stops every repair worker and rejects new grants; parent-
   cancelled submission fails stopped, and process-local progress retains every
   confirmed durable reconcile/exhaustion even when later batch work fails.
   The authoritative issuer, durable completion sink,
   physical PostgreSQL exact-target/10K/100K plan, live Endpoint,
   process-crash/two-node and Linux full campaigns remain `not_run`.
7. `.73` compiles the matched-CANCEL pair and Rust session composition but
   leaves the builder runtime `None`. Local UDP behavior and the exact isolated
   Linux rsipstack server target (`32/32`) are proved; RustPBX host targets
   remain `not_run` because their test binary compile reached the unchanged
   2,560 MiB isolation ceiling. Pre/post service snapshots and lower-source
   hashes are identical. Reconstruction of unconsumed capabilities after
   restart is not implemented and blocks activation. RustPBX server
   functionality, TCP/WS/TLS/WSS, physical
   store, restart/reconcile and product activation remain `not_run`; no running
   server program or deployed source was modified.
8. `.74` supplies ordinary 101..699 response capabilities in that same
   default-disabled transaction-local Rust gate. It freezes one dialog identity
   and stable local To tag before responses are created. Cancellation or panic
   after durable preparation starts retains the exact effect identity; a
   concurrent Call revision after durable prepare emits `TransportUnknown` and
   cannot authorize another response. Local focused functional tests cover
   these paths, but physical PostgreSQL, process restart/rebuild, live Endpoint
   and isolated-server `.74` verification remain `not_run`. The exact isolated
   `9775a79` attempt reached a cgroup-scoped `rustc` OOM before any test
   executed; its 3,584 MiB ceiling was not raised, and byte-identical service
   and lower-source snapshots prove zero impact. The slice executes no
   performance, load, capacity, concurrency or soak test.
9. `.75` closes the concurrent successor-cleanup threat without activating the
   runtime. The cleanup capability is sealed by the original reservation,
   cannot be cloned, is consumed exactly once by value, and compares both full
   Native Call identity and exact cell pointer. The provider
   slot stays exclusively held until provider, native and dialog indexes are
   cleaned. Focused tests prove stale cleanup is a no-op for a reused Call-ID
   successor and exact cleanup removes every owned index. Process-restart
   reconstruction, physical dependencies, live Endpoint and server functional
   verification remain `not_run`; no performance command ran.
10. `.76` prevents empty-memory restart state from being mistaken for proof that
    no SIP effect was visible. A recovery request binds the closed predecessor
    capsule, exact server-INVITE transaction and expected successor fences. Only
    an atomic predecessor fence plus `NoVisibleEffect` permits reconstruction;
    `VisibleOrAmbiguous`, invalid receipts and successor replacement fail closed
    without intent mutation. An installed recovered gate is bound to the exact
    successor identity and rechecks it before every prepare path and after
    asynchronous durable preparation, so later reuse of the same provider
    Call-ID cannot receive a stale effect. `.77` implements the
    default-disabled Oracle in Rust/PostgreSQL. Its isolated PostgreSQL 16
    harness proves session fencing, exact two-key visibility, immutable replay,
    old-binary rejection and tenant RLS. The pre-existing server container
    remained healthy and only the exact `network=none` temporary test resources
    were removed. `.78` connects this Oracle to the real Rust app and
    `SipServerBuilder` lifecycle behind a default-disabled closed configuration.
    Its exact physical startup adapter now passes against a fresh migration
    001–116 PostgreSQL 16 instance with no host-published port and tmpfs data;
    the temporary instance was destroyed and the original container remained
    healthy/restart-zero. `.79` now invokes recovery only from a closed
    authenticated recovered proof and one current-owner snapshot; missing proof
    under the durable runtime and stale owner replacement both fail closed.
    `.80` adds the local issuer component: the compatibility coordinator rejects
    v1, missing or split bindings before claim, and Rust opens the reciprocal
    A256GCM pair, retains the exact predecessor and registers recovered owner
    proof on resume and finalization. It does not activate the Endpoint or prove
    real process crash/restart. No performance command ran; `.79` and `.80` did
    not contact the server.
11. The issuer is now Rust-owned, but end-to-end recovered-call production is
    still absent. A real process restart has not proved that takeover reaches
    the capsule issuer, installs the recovered Active Call and invokes the
    PostgreSQL capability Oracle with the exact predecessor. Crash timing,
    visible/ambiguous predecessor effects and two-node races therefore remain
    fail-closed activation gates rather than inferred successes.

All residual risks remain visible in the G03 status artifacts and prevent
production eligibility.
