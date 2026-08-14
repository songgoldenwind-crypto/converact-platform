# G03 `.82` recovered-controller fault boundary — local functional evidence

- Campaign: `converact-g03-82-a989c37-local-functional`
- Captured UTC: `2026-08-14T05:20:23Z`
- Canonical base HEAD: `a989c375e2c7472f8f19ba910eb8918b37e72737`
- Candidate patchset: `ivekit.82`
- RustPBX source: `6c49ee76baa54fdbf8f98020cc9bee158c7c15de`
- rsipstack source: `8318e97b1170de4e5245b120afec1cdf53e3d716`
- rustrtc source: `166c6d22984429eb6b509920c14fcd69f974f0b3`
- Candidate patch SHA-256: `145094cec96b2e441acb4fe2873d2bc29c7901c43562996450f81ed4f732649f`
- Rust toolchain: `1.94.1-aarch64-apple-darwin`
- Evidence class: local functional and source only
- Production eligible: `false`
- Performance evidence: `false`

## Proven scope

The exact `.82` patch applies after `.81` and changes only the existing
recovered-dialog controller fault boundary.

- The controller Future is unwind-contained inside its existing child task;
  no process panic hook or abort behavior is installed.
- A caught controller unwind triggers one best-effort
  `terminate_all("controller_panic")` for the exact recovered Call.
- Cleanup is itself unwind-contained and has an 8-second total hard deadline.
  Each media close has a separate 2-second hard deadline.
- Returning the child releases the existing exact Native Call identity/cell
  cleanup lease. A stale controller still cannot remove a replacement.
- No second task, Call registry, store, unbounded queue, blocking worker,
  thread, global scan, ordinary new-Call hot-path work or media packet-path work
  is introduced.

Exact-source local results:

- focused unwind regression: 1 passed, 0 failed;
- Rust dialog-shadow module: 11 passed, 0 failed;
- full RustPBX library: 2,113 passed, 0 failed, 12 external-prerequisite tests ignored;
- locked Rust library check and scoped rustfmt: passed;
- exact patch replay and candidate/source byte comparison: passed;
- affected current-patch static suite: 229 passed, 0 failed across 58 files;
- G03 generated machine contracts: 9 passed, 0 failed;
- repository TypeScript typecheck: passed.

## TDD provenance

RED added `recovered_controller_panics_are_caught_at_the_child_fault_boundary`
and failed with Rust `E0425` because `recovered_controller_panicked` did not
exist. GREEN added the child unwind helper, bounded exact-Call cleanup, nested
cleanup unwind containment and the two cleanup deadlines. The first affected
static rerun then exposed one stale `.81` generated-result assertion; only that
assertion was advanced to the generated `.82` truth before the canonical rerun
passed 229/229.

The unit fault is injected into the unwind helper. It is not evidence that a
panic was injected through a live Endpoint controller, nor that an external
media resource was reconciled after the cleanup deadline.

## Evidence boundary

No server was contacted for `.82`; no running service, deployed source,
container, configuration, data, volume or port was read or changed. No Docker,
load, latency, CPS, concurrency, capacity, soak, allocation, 10K/100K or other
performance command ran.

Real task/process panic, process abort/OOM, external media orphan
reconciliation, real process restart/two-node takeover, original-INVITE Oracle
activation, live peer/Endpoint behavior, Linux product-process execution,
production eligibility, `G03-E15-REVIEW` and `G03-E16-NATIVE-AUTHORITY` remain
`not_run`.
