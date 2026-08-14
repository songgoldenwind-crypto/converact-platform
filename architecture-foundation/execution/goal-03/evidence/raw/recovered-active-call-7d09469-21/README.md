# G03 `.81` recovered Active Call — local functional evidence

- Campaign: `converact-g03-81-7d09469-local-functional`
- Canonical base HEAD: `7d09469e97caa9030728cd34061413f14c453dad`
- Candidate patchset: `ivekit.81`
- RustPBX source: `6c49ee76baa54fdbf8f98020cc9bee158c7c15de`
- rsipstack source: `8318e97b1170de4e5245b120afec1cdf53e3d716`
- rustrtc source: `166c6d22984429eb6b509920c14fcd69f974f0b3`
- Candidate patch SHA-256: `2f45849d742e99a2a3716ff7831179bb3a68c5072fc498df42b894145bd263e9`
- Rust toolchain: `1.94.1-aarch64-apple-darwin`
- Evidence class: local functional only
- Production eligible: `false`
- Performance evidence: `false`

## Proven scope

The exact `.81` patch applies after `.80` and closes only the local confirmed-
dialog Active Call composition gap.

- The existing `ActiveProxyCallRegistry` remains the sole Native Call
  Authority. One recovered slot contains one confirmed inbound Native Leg and
  exactly two distinct reciprocal Dialog IDs; a partial Dialog conflict rolls
  the complete slot back.
- Native Leg restoration uses the ordinary inbound state machine:
  `InboundInviteObserved`, `Final2xx`, then `Invite2xxAckObserved`. Each
  transition is required to produce no new effect because the Dialog is already
  confirmed.
- The recovered session handle has one bounded command channel. It accepts only
  whole-Call Hangup with cascade-all and rejects unsupported control before
  enqueue.
- Controller ownership includes one exact Native Call identity/cell cleanup
  lease. Stale teardown cannot delete a replacement slot.
- Confirmed-dialog recovery has no original server-INVITE transaction key or
  Via lineage. The patch does not fabricate those facts and does not invoke the
  matched-CANCEL capability Oracle on a guessed key.
- No second registry/store, unbounded queue, global scan, blocking worker,
  ordinary new-Call hot-path work or media packet-path work is introduced.

Exact-source local functional results:

- recovered command-handle regression: 1 passed, 0 failed;
- recovered projection regression: 1 passed, 0 failed;
- recovered pair registration/rollback regression: 1 passed, 0 failed;
- Rust dialog-shadow module: 10 passed, 0 failed;
- Active Call registry module: 25 passed, 0 failed;
- full RustPBX library: 2,112 passed, 0 failed, 12 external-prerequisite tests ignored;
- locked Rust library check and scoped rustfmt: passed;
- exact patch replay and candidate/source byte comparison: passed;
- repository TypeScript typecheck: passed;
- affected current-patch static suite: 231 passed, 0 failed across 57 files;
- G03 generated machine contracts: 9 passed, 0 failed.

## TDD provenance

The first Rust RED build failed because `register_recovered_call`,
`SipSessionHandle::new_recovered` and the recovered projection did not exist.
The next RED proved that merely publishing the slot left the Native Leg in
`Planned`, not `Confirmed`. GREEN added the ordinary state-machine replay,
all-or-nothing pair publication, bounded command scope and exact cleanup lease.

The first G03 contract rerun after the patchset bump exposed one stale `.80`
build assertion. The first 57-file static rerun then exposed four stale generated
result expectations. Only those expectations were updated to the already
verified `.81` truth; canonical reruns passed 9/9 and 231/231. An initial
combined replay/check command also attempted `cargo check` in the minimal patch
baseline, which intentionally has no `Cargo.toml`; the canonical check was
rerun in the exact full candidate and passed. These harness failures are not
reported as passing product behavior.

## Evidence boundary

No server was contacted for `.81`; no running service, deployed source,
container, configuration, data, volume or port was read or changed. No Docker,
load, latency, CPS, concurrency, capacity, soak, allocation, 10K/100K or other
performance command ran.

The historical `.78` PostgreSQL result, `.79` recovered-admission result and
`.80` trusted-proof result are not relabelled as `.81` physical evidence. Real
process restart into the recovered registry, live peer control, controller-
panic async media cleanup, original-INVITE Oracle activation, two-node
ambiguity recovery, live Endpoint activation, Linux product-process execution,
production eligibility, `G03-E15-REVIEW` and `G03-E16-NATIVE-AUTHORITY` remain
`not_run`.
