# G03 `.84` recovered Dialog worker supervision — local functional evidence

- Campaign: `converact-g03-84-ae4665f-local-functional`
- Captured UTC: `2026-08-14T06:17:13Z`
- Canonical base HEAD: `ae4665fdb96934a7e821a304752e3ac27d8cfaf5`
- Candidate patchset: `ivekit.84`
- RustPBX source: `6c49ee76baa54fdbf8f98020cc9bee158c7c15de`
- rsipstack source: `8318e97b1170de4e5245b120afec1cdf53e3d716`
- rustrtc source: `166c6d22984429eb6b509920c14fcd69f974f0b3`
- Candidate patch SHA-256: `4ee5e5b33e777aba508097c1b1018651036fd33fade8db624458107734066185`
- Rust test toolchain: `1.94.1-aarch64-apple-darwin`
- Evidence class: local functional and source only
- Production eligible: `false`
- Performance evidence: `false`

## Proven scope

The exact `.84` patch applies after `.83` and closes the silent-loss path for
either of the two recovered Dialog event forwarders.

- The implementation retains exactly two workers and one recovered Call
  controller.
- One capacity-2 worker-exit channel can contain at most one result from each
  worker. Unexpected receiver close, forwarding stop or caught unwind reports
  once to the sole controller and terminates only its exact recovered Call.
- Intentional controller cancellation exits silently. Every controller exit
  cancels both workers.
- A successfully forwarded terminal Dialog event exits as cancellation rather
  than reporting worker loss, so the normal terminal-event reason cannot race
  a second fault reason. After both workers finish normally, the controller
  disables the now-closed exit-channel branch and consumes the already queued
  terminal event instead of spinning or inventing a worker-loss failure.
- No global registry, unbounded queue, blocking task, per-packet media work,
  retry loop or second Call authority is introduced.

Exact-source local results:

- focused worker-supervision regression: 1 passed, 0 failed;
- Rust dialog-shadow module: 13 passed, 0 failed;
- full RustPBX library: 2,115 passed, 0 failed, 12 external-prerequisite tests ignored;
- locked Rust library check and scoped rustfmt: passed;
- exact patch replay and candidate/source byte comparison: passed;
- affected current-patch static suite: 236 passed, 0 failed across 60 files;
- G03 generated machine contracts: 9 passed, 0 failed;
- repository TypeScript typecheck: passed.

## TDD provenance

Canonical RED failed because `RecoveredDialogWorkerExitKind` and
`report_recovered_dialog_worker_exit` did not exist. GREEN adds the bounded
supervision result and controller select branch, then proves panic and ordinary
unexpected exit report once while cancellation remains silent. The terminal-
event correction was applied before final patch generation and verification.

The first current-patch static run exposed four historical `.83`/2,114
expectations; after those exact generated-result expectations were advanced,
one remaining server-status expectation was still `.83`. Only that expected
value was corrected. Canonical rerun passed 236/236.

## Evidence boundary

The focused test exercises the local supervision helper; it does not inject a
fault through a live Endpoint event receiver. No server was contacted for
`.84`; no running service, deployed source, container, configuration, data,
volume or port was read or changed. No Docker, load, latency, CPS, concurrency,
capacity, soak, allocation, 10K/100K or other performance command ran.

Live Endpoint worker-fault injection, process abort/OOM, external media orphan
reconciliation, real process restart/two-node takeover, original-INVITE Oracle
activation, Linux product-process execution, production eligibility,
`G03-E15-REVIEW` and `G03-E16-NATIVE-AUTHORITY` remain `not_run`.
