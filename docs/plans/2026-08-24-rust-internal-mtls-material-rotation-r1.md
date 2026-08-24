# Rust Internal mTLS Material Loading and Rotation R1 Implementation Plan

**Goal:** Add a bounded offline filesystem adapter and atomic config slot that
can later rotate the existing Rust mTLS listener without mixed generations or
online route changes.

**Architecture:** `converact-internal-mtls` remains the TLS/identity adapter.
New `converact-internal-mtls-runtime` owns Unix file descriptors, Kubernetes
AtomicWriter generation resolution, PEM buffers, polling and readiness. One
Tokio watch value atomically publishes a completely validated config; each
accepted socket clones one generation before its handshake.

**Constraints:** TDD, exact pins, no running server/Docker/database/load work,
no TypeScript route change, no directory scan, no overlapping reload, no
unbounded task/queue/retry, no raw material in public errors or Debug.

### Task 1: Freeze the source and operational contract

- [x] Record the exact Kubernetes AtomicWriter and Secret update semantics,
  rustls resumption warning and Tokio watch borrow rule in the architecture.
- [x] Freeze four exact PEM names, Unix access policy, byte/count limits,
  required-CRL mode, readiness margin and `not_run` rollout gates.
- [x] Commit only the design and plan as
  `docs(rust): design atomic mTLS material rotation`.

### Task 2: Parse bounded PEM into strict material

**Modify:**

- `server-rs/crates/internal-mtls/src/material.rs`
- `server-rs/crates/internal-mtls/src/lib.rs`
- `server-rs/crates/internal-mtls/tests/pem_material.rs`

- [x] Write failing tests for exact section kinds/counts, one key, byte bounds,
  wrong DNS/server purpose, wall-time validity and required current CRLs.
- [x] Add one consuming bounded PEM constructor using the existing
  `rustls-pki-types` PEM API; do not add `rustls-pemfile`.
- [x] Keep raw PEM/DER/parser/rustls types private and private-key source bytes
  overwritten on drop.
- [x] Run focused tests, crate Clippy, docs and format checks.
- [x] Commit as `feat(rust): validate bounded mTLS PEM bundles`.

### Task 3: Load exactly one immutable bundle generation

**Create:**

- `server-rs/crates/internal-mtls-runtime/Cargo.toml`
- `server-rs/crates/internal-mtls-runtime/src/lib.rs`
- `server-rs/crates/internal-mtls-runtime/src/bundle.rs`
- `server-rs/crates/internal-mtls-runtime/tests/bundle.rs`

- [x] Write failing tests for absolute path and target-component bounds,
  synthetic `..data` generation selection, concurrent swap/removal, escape,
  entry symlink, non-file, mode/owner/GID and every byte budget.
- [x] Use descriptor-relative `readlinkat`/`openat`; never resolve four visible
  Secret symlinks independently and never scan the directory.
- [x] Read only the four fixed names, one file at a time, with total accounting
  and stable value-free errors.
- [x] Make non-Unix builds fail closed without pretending production support.
- [x] Run focused tests, crate Clippy, docs and format checks.
- [x] Commit as `feat(rust): load one atomic mTLS bundle`.

### Task 4: Publish one complete config generation

**Modify:**

- `server-rs/crates/internal-mtls/src/listener.rs`
- `server-rs/crates/internal-mtls/src/lib.rs`
- `server-rs/crates/internal-mtls/tests/listener_rotation.rs`

- [ ] Write failing tests for same-bundle idempotency, checked revision,
  valid replacement, failed replacement retention and revision exhaustion.
- [ ] Add one watch-backed config slot. Preserve the existing fixed listener
  constructor as a compatibility wrapper.
- [ ] Clone one published config immediately after accept and drop the watch
  borrow before handshake await.
- [ ] Prove old in-flight handshake/new handshake generation isolation and
  unchanged bounded shutdown behavior.
- [ ] Run listener tests repeatedly, Clippy, docs and format checks.
- [ ] Commit as `feat(rust): rotate mTLS config atomically`.

### Task 5: Add bounded reload scheduling and readiness

**Create/modify:**

- `server-rs/crates/internal-mtls-runtime/src/reload.rs`
- `server-rs/crates/internal-mtls-runtime/src/readiness.rs`
- `server-rs/crates/internal-mtls-runtime/tests/reload.rs`
- `server-rs/crates/internal-mtls-runtime/tests/readiness.rs`

- [ ] Write failing injected-clock tests for `not_loaded`, ready, degraded,
  margin expiry, stale scheduler, failed-load retention and clock regression.
- [ ] Implement one non-overlapping scheduler with interval `1 s..=5 min`, at
  most one blocking-pool read per tick and no catch-up queue or inner retry.
  Only the awaiting scheduler owns publication; a late completion after
  cancellation must have no state-changing handle.
- [ ] Run it only as one owned `HealthTaskGroup` child with cooperative
  cancellation and bounded shutdown.
- [ ] Expose stable readiness projection without wiring an online endpoint.
- [ ] Run all affected Rust and active TypeScript mTLS/dialog-shadow suites.
- [ ] Commit as `feat(rust): supervise mTLS material reload`.

### Task 6: Verify and record the offline checkpoint

- [ ] Run pinned Workspace test, Clippy, rustdoc and format gates.
- [ ] Run Node 24 typecheck and active mTLS/dialog-shadow differential suites.
- [ ] Review dependency/feature/license/native/unsafe deltas and exact archives.
- [ ] Record README, RED/GREEN log, dependency review, source manifest,
  verification and independent-review status under
  `architecture-foundation/rust-migration/evidence/r1-internal-mtls-material-rotation/`.
- [ ] Parse every JSON, replay every SHA-256, run `git diff --check` and prove
  the historical G03 dirty README remains unstaged.
- [ ] Keep every online, physical, fleet, rollout, performance and production
  item `not_run`.
- [ ] Commit as `docs(rust): record mTLS material rotation evidence`.
