# G03 `.79` durable recovered admission — local functional evidence

- Campaign: `converact-g03-79-f56f954-local-functional`
- Canonical base HEAD: `f56f954`
- Candidate patchset: `ivekit.79`
- RustPBX source: `6c49ee76baa54fdbf8f98020cc9bee158c7c15de`
- rsipstack source: `8318e97b1170de4e5245b120afec1cdf53e3d716`
- rustrtc source: `166c6d22984429eb6b509920c14fcd69f974f0b3`
- Candidate patch SHA-256: `db62ef488199d9c10dfa54edf7a70037ad3c3a175530c65cbec36918e52b4d9c`
- Rust toolchain: `1.94.1-aarch64-apple-darwin`
- Evidence class: local functional only
- Production eligible: `false`
- Performance evidence: `false`

## Proven scope

The exact `.79` patch applies after `.78` and closes the in-process trusted
recovered-admission invocation seam without creating another Call or durable
effect Authority.

- The authenticated admission response is a closed tagged `fresh` or
  `recovered` value. Recovered admission requires the exact closed predecessor
  binding; durable mode rejects an absent owner snapshot as well as a
  legacy-unspecified proof.
- One `Arc<OwnerEntry>` snapshots Native Call identity, proof and guard. The
  same snapshot supplies active-call registration and Oracle selection.
- The session verifies that snapshot before and after the asynchronous Oracle.
  Conditional owner-pointer cleanup and the separately captured Native Call
  identity/cell cleanup fence cannot close a replacement owner or Active Call.
- Each owner refresh loop is bound to the original owner pointer and exits when
  that owner is replaced, preventing sequential replacements from accumulating
  duplicate refresh tasks against the successor.
- Recovered admission invokes the existing PostgreSQL recovery Oracle and
  cannot downgrade to ordinary installation when the runtime is absent.
- The TypeScript control plane emits `fresh` only after a newly prepared
  reservation and contains no `recovered` emitter.
- No unbounded channel, thread-per-call fallback, memory store or second owner
  registry was added.

Exact-source local functional results:

- SipEffect library filter: 135 passed, 0 failed, 11 physical tests ignored;
- Native SIP effect filter: 40 passed, 0 failed, 1 physical test ignored;
- Native owner filter: 11 passed, 0 failed;
- admission snapshot filter: 3 passed, 0 failed;
- recovered-admission filters: 15 passed, 0 failed;
- full RustPBX library: 2,109 passed, 0 failed, 12 external-prerequisite tests ignored;
- locked Rust library check and scoped rustfmt: passed;
- exact patch application and static patch contracts: passed;
- repository TypeScript typecheck and canonical focused admission tests: passed;
- all 56 modified test files: 232 passed, 0 failed;
- G03 generated machine contracts: 9 passed, 0 failed.

The first aggregate TypeScript command omitted the repository-required
`test/explicit-dev-auth.mjs` preload and failed one existing auth-context test.
The canonical command with that preload passed without an implementation
change. This failed harness invocation is not reported as a product failure or
hidden as a successful result.

During final review, two additional RED checks first failed: one proved that an
entirely absent owner snapshot could bypass the durable proof rule, and one
proved that session-level provider-ID cleanup lacked the existing Native Call
cell fence. The final source above closes both gaps; the RED failures are not
reported as passing product behavior.

The workspace-wide `cargo fmt --all -- --check` command is not applicable to
the pinned upstream tree because its `addons` module names an optional
`src/addons/wholesale.rs` source that is absent from this exact checkout. The
edition-2024 pinned `rustfmt --check` command over every `.79`-changed Rust
source passed. The missing optional source is not relabelled as a successful
workspace-format result.

## Evidence boundary

No server was contacted for `.79`; no running service, deployed source,
container, configuration, data, volume or port was read or changed. No Docker
command and no load, latency, CPS, concurrency, capacity, soak, allocation,
10K/100K or other performance command ran.

The `.78` isolated PostgreSQL adapter result remains historical component
evidence and is not relabelled as a `.79` server result. Trusted recovered-proof
production, real process restart and ambiguity recovery, live Endpoint
activation, Linux product-process verification, production eligibility,
`G03-E15-REVIEW` and `G03-E16-NATIVE-AUTHORITY` remain `not_run`.
