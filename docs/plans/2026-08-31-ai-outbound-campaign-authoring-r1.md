# AI Outbound Campaign Authoring R1 Implementation Plan

> **For agentic workers:** Execute inline with repository TDD rules. Do not use subagents,
> servers, Docker, broad regression suites or performance tests.
>
> **Status:** `controlled_core_store_http_slices_passed / concrete_postgres_runtime_adapter_not_run /
> production_not_run`

**Goal:** Make the approved Rust AI-outbound model callable for immutable Agent publication,
Campaign creation/lifecycle and bounded Contact import that atomically creates the first physical
Attempt for every accepted Contact.

**Architecture:** Keep the existing `ai-outbound-core` as business authority, add a content-free
idempotency receipt and tenant-scoped commands to `ai-outbound-store`, and expose a separate
capability-gated Campaign Admin router in the existing Voice Agent process. The Admin boundary is
not the Worker claim path and has no SIP, media, Active Call or Provider authority.

**Tech stack:** Rust 1.94.1, Axum, Tokio, `tokio-postgres`, canonical JSON SHA-256, PostgreSQL RLS.

---

## 1. Approved decision and rejected alternatives

The canonical design is
[AI Outbound & Voice Agent Platform R1](../design/2026-08-31-ai-outbound-active-call-platform-r1.md).
It already fixes Converact as Agent/Campaign/Workflow/Tool/Outcome authority and Active Call as the
telephone Channel Agent. This plan does not reopen that decision.

Approaches considered:

1. **Chosen — dedicated Admin port in the existing Rust process.** Clear authorization and durable
   transaction boundary without creating another service or authority.
2. Add mutations to `VoiceAgentRepository`. Rejected because inspection, Worker settlement and
   authoring would share one wide interface and become harder to test and compose.
3. Create a separate Campaign microservice. Rejected because it adds deployment/state ownership
   before the functional platform is complete.

## 2. Frozen behavior

1. Every mutation requires authenticated tenant, an explicit Campaign-write capability and a valid
   `Idempotency-Key`; missing capability fails before the port is invoked.
2. Publishing consumes a bounded Agent draft and eight exact component SHA-256 digests. The Release
   is immutable and exact replay returns the same content hash.
3. Campaign creation binds one exact published Agent Release, `AudienceId`, dial-policy revision and
   bounded schedule document. It starts only as `draft`.
4. Contact import accepts 1–500 items. The entire batch succeeds or rolls back; no partial response
   may be reported as success.
5. Each Contact supplies stable Contact, external-contact, first-Attempt, Interaction and
   idempotency identities. Import atomically inserts the Contact and its first `planned` Attempt
   with `attempt_number=1`, `execution_generation=1` and the Campaign's exact Agent Release.
6. Destination, consent, recording mode and retention are validated and persisted, but destination
   never appears in response, receipt, `Debug`, logs or metrics.
7. Import is allowed only for `draft`, `scheduled`, `running` or `paused`; draining or terminal
   Campaigns reject new Contacts.
8. Campaign transitions use the existing closed Core state machine plus expected revision. Schedule
   and Start require at least one queued Contact/Attempt. Complete and Archive require durable
   active Attempts to be zero.
9. One tenant-scoped transaction performs mutation and writes a content-free receipt containing
   command kind, request hash, resource ID, resulting state/revision and count. Same key/hash/kind
   is replay; any mismatch fails closed.
10. No endpoint performs a physical dial. The existing bounded Worker is the only component that
    claims a planned Attempt and reaches call-control ports.

## 3. File map

- Create `server-rs/crates/ai-outbound-core/src/authoring.rs`: bounded schedule, recording mode,
  Agent/Campaign/Contact command validation and canonical request hashes.
- Create `server-rs/crates/ai-outbound-core/tests/authoring.rs`: limits, PII-safe Debug, duplicate
  identity and hash determinism.
- Modify `server-rs/crates/ai-outbound-core/src/agent_release.rs`: bounded read access required by
  persistence without exposing mutation.
- Modify `server-rs/crates/ai-outbound-core/src/lib.rs`: exports and stable errors.
- Create `src/migrations/130_converact_outbound_admin_receipts.sql` and mirror it in
  `src/schema.sql`: content-free receipt, RLS, immutable history and least privilege.
- Create `server-rs/crates/ai-outbound-store/src/authoring.rs`: publish, create, replay preflight,
  import and transition commands inside caller-owned tenant transactions. Modify `postgres.rs`
  only for stable Store errors.
- Create `server-rs/crates/ai-outbound-store/tests/authoring_contract.rs`: exact SQL authority and
  no-PII receipt contract.
- Extend the ignored `server-rs/crates/ai-outbound-store/tests/postgres.rs` harness only for physical
  execution; compile it but keep execution `not_run` without an isolated database.
- Create `server-rs/apps/converact-voice-agent-worker/src/campaign_admin.rs`: access, port, requests,
  bounded responses and sanitized errors.
- Create `server-rs/apps/converact-voice-agent-worker/src/campaign_admin_http.rs`: tenant/capability/
  idempotency-gated routes.
- Create `server-rs/apps/converact-voice-agent-worker/tests/campaign_admin_http.rs`: controlled HTTP
  vertical slice and no-authority/no-PII assertions.
- Create `architecture-foundation/ai-outbound/evidence/r1-campaign-authoring/`: exact local evidence
  and `not_run` matrix.

## 4. Task 1 — Core authoring commands

- [x] Write failing `authoring.rs` tests for a valid 500-item boundary, a rejected 501-item batch,
  duplicate Contact/Attempt/Interaction identity, malformed destination/consent/retention, and a
  `Debug` representation without destination.
- [x] Run `cargo test -p converact-ai-outbound-core --test authoring`; observe the missing API.
- [x] Implement `CampaignSchedule`, `RecordingMode`, `CreateCampaign`, `ImportContact`,
  `ImportContacts`, `CampaignTransition` and their canonical request hashes.
- [x] Keep validation linear and bounded with no global state or external calls.
- [x] Run only Core authoring plus existing Campaign/Agent tests; format, Clippy and commit exact
  Core files.

## 5. Task 2 — Receipt migration and Store commands

- [x] Write failing schema/Store contract tests requiring RLS, immutable content-free receipts,
  exact Release binding, atomic Contact+Attempt insert, Campaign-state gate and revision CAS.
- [x] Add migration 130 and the matching development schema section without switching any writer.
- [x] Implement Store commands/results for publish/create/import/transition. The caller owns the
  transaction and deadline; Store never logs request bodies.
- [x] Make replay classification compare idempotency key, command kind and canonical request hash.
- [x] Compile but do not execute physical PostgreSQL tests; run only schema and authoring contract
  tests, scoped formatting and Clippy, then commit exact Store/migration files.

## 6. Task 3 — Rust Admin port and HTTP vertical slice

- [x] Write failing HTTP tests for authentication, explicit write capability, idempotency header,
  Agent publish, Campaign create, 2-contact import, lifecycle transition and exact replay.
- [x] Require JSON body limits and 1–500 contacts before invoking the port. Map invalid/conflict/
  missing/stale/unavailable to stable 400/409/404/412/503 responses.
- [x] Return only Release/Campaign IDs, content hash, Campaign state/revision, accepted count and
  replay flag. Never return destination or consent details.
- [x] Prove source has no SIP, media, Active Call or real-time Agent authority imports.
- [x] Run only the new HTTP test plus existing five internal HTTP tests; format, Clippy and commit
  exact Worker files.

## 7. Evidence and completion boundary

- [x] Record exact commit/toolchain/test counts and update canonical navigation/status/manifest
  hashes.
- [x] Keep physical PostgreSQL, production auth composition, real Campaign UI/import file, legacy
  TypeScript writer shadow/switch, real RustPBX/Active Call call, performance and production
  deployment `not_run`.
- [x] Commit only clean evidence/status files.

The three focused layers now prove the ten frozen behaviors at local contract and controlled-test
double level. The Store SQL is real, but no concrete `CampaignAdminPort` to `PostgresRuntime`
composition has been activated, so physical transaction behavior remains `not_run`. R1 is not
production eligible until that adapter, the physical PostgreSQL transaction, production capability
middleware, real UI/import workflow and real call path have direct evidence.
