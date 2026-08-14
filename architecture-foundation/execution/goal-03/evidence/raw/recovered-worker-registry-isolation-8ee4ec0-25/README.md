# G03 `.85` recovered-worker registry isolation — local component evidence

- Campaign: `converact-g03-85-8ee4ec0-local-component`
- Captured UTC: `2026-08-14T06:56:22Z`
- Canonical base HEAD: `8ee4ec0f22d1a64f16f575a5192c531b49ef1729`
- Candidate patchset: `ivekit.85`
- RustPBX source: `6c49ee76baa54fdbf8f98020cc9bee158c7c15de`
- rsipstack source: `8318e97b1170de4e5245b120afec1cdf53e3d716`
- rustrtc source: `166c6d22984429eb6b509920c14fcd69f974f0b3`
- Candidate patch SHA-256: `5bbacdd3b2dc4c1dc377c82d56bfabc8e73efc306b150c6fb6f24825ca57976a`
- Rust test toolchain: `1.94.1-aarch64-apple-darwin`
- Evidence class: local functional, source and component integration only
- Production eligible: `false`
- Performance evidence: `false`

## Proven scope

The exact `.85` patch applies after `.84` and adds no production runtime
branch. Its regression connects the already bounded `.84` worker-panic report
to the real recovered Active Call registry and exact cleanup-fence types.

- Two distinct recovered Calls and four Dialog indexes are registered through
  `ActiveProxyCallRegistry::register_recovered`.
- One actual worker Future panics and is classified by
  `report_recovered_dialog_worker_exit` as `Panicked`.
- Releasing the affected `RecoveredActiveCallLease` removes only that Call and
  its exact Dialog pair.
- The unrelated recovered Call, handle and Dialog pair remain present and
  usable until their own fence is consumed.
- The patch adds no worker, queue, registry, retry, blocking operation,
  packet-path work or second Call authority.

Exact-source local results:

- focused recovered-worker registry-isolation regression: 1 passed, 0 failed;
- Rust dialog-shadow module: 14 passed, 0 failed;
- full RustPBX library: 2,116 passed, 0 failed, 12 external-prerequisite tests ignored;
- locked Rust library check and scoped rustfmt: passed;
- exact incremental patch replay and candidate/source byte comparison: passed;
- current-patch static suite: 240 passed, 0 failed across 61 exact files;
- combined G03 functional/static suite: 345 passed, 0 failed, 1 physical-only skip across 71 exact files;
- G03 generated machine contracts: 9 passed, 0 failed;
- repository TypeScript typecheck: passed.

## Regression provenance

This is an audit characterization/regression on the exact `.84` runtime, not a
claim that `.85` introduced a production fix. The `.85` test depends on the
`.84` worker-exit classification symbols; without that predecessor capability
the test cannot compile. On the exact `.85` candidate the panic is observed,
the affected exact cleanup fence is consumed and the unrelated registry state
survives.

## Evidence boundary

The regression uses the real registry and cleanup-lease types inside the Rust
component test, but it does not inject a fault through a live Endpoint
controller. No server was contacted; no running service, deployed source,
container, configuration, data, volume or port was read or changed. No Docker,
load, latency, CPS, concurrency, capacity, soak, allocation, 10K/100K or other
performance command ran.

Live Endpoint worker-fault injection, process abort/OOM, blocked external
dependency isolation, external media orphan reconciliation, real process
restart/two-node takeover, original-INVITE Oracle activation, Linux product
process execution, production eligibility, `G03-E15-REVIEW` and
`G03-E16-NATIVE-AUTHORITY` remain `not_run`.
