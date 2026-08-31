# AI → Human → AI Handoff R1 implementation plan

> Status: `controlled_core_store_worker_passed / physical_integrations_not_run`

**Goal:** Complete D6 as a reusable Rust handoff authority without creating a second Call, SIP,
media or Agent state machine.

**Architecture:** `converact-agent-handoff-core` owns the pure durable transition contract;
`converact-agent-handoff-store` owns tenant-scoped command dedupe, CAS and receipts; the existing
Voice Agent Worker orchestrates typed RustPBX and Active Call ports. Current owner remains active
during prepare, and only an atomic committed generation changes authority.

## TDD slices

### Slice 1 — core ownership transaction

1. Add failing tests for request → answered → human commit → human active → AI resume.
2. Assert commit before answer, stale revision/generation, replay with another payload, and
   generation overflow fail closed.
3. Implement bounded IDs, Context Packet refs, owner/state model and pure transition function.
4. Run only Handoff Core tests, scoped Clippy and format check; commit separately.

### Slice 2 — durable Store

1. Add failing schema/Store tests for tenant isolation, one active Handoff per Interaction, command
   payload dedupe, CAS revision/generation and immutable receipts.
2. Add additive migration, SQLite development mirror and PostgreSQL tenant-transaction Adapter.
3. Prove exact replay returns the same receipt and ambiguous effects remain reconcile-required.
4. Physical PostgreSQL remains `not_run` unless an isolated test database is explicitly available.

### Slice 3 — Worker ports

1. Add a failing controlled vertical test with typed fake Telephony and Channel Agent ports.
2. Prepare Context Packet, dial/query the human Leg, commit only after answered, fence stale AI
   output/Tool commands, prepare/query AI resume and commit the next generation.
3. Project only coarse phases to the existing `CallAttempt`; do not duplicate its lifecycle.
4. Test abort and crash/unknown reconciliation paths precisely.

### Slice 4 — evidence

1. Record exact commit/tree/toolchain and scoped command results.
2. Keep real RustPBX, Active Call, human seat, SIP/PSTN/media, recording continuity, performance,
   capacity, long-run, independent review and production deployment `not_run` until observed.
3. Update canonical design navigation and manifest hashes in a separate docs commit.

The local controlled Slice 1-4 checkpoint is recorded in
[`r1-human-handoff`](../../architecture-foundation/ai-outbound/evidence/r1-human-handoff/README.md).
All real integration and production claims listed there remain `not_run`.
