# Active Call Release artifact Store R1 implementation plan

> Date: 2026-09-01
>
> Scope: immutable tenant-scoped PostgreSQL read path for compiled Active Call Playbooks
>
> Status: `physical_schema_lifecycle_passed / rust_store_physical_query_not_run / production_not_run`

## Goal

Make the existing `ActiveCallPlaybookResolver` load a real immutable runtime artifact from the
shared Rust PostgreSQL foundation instead of a test-only source. The artifact remains bound to the
Campaign-selected Agent Release, its canonical content hash, all eight component digests and one
reviewed compiler revision.

## Frozen boundary

- Add one append-only, tenant-scoped runtime-artifact table. Existing Release, Campaign and Attempt
  writers are not switched by the migration.
- One row contains the compiled Active Call Playbook and its declared artifact digest. It references
  an existing Agent Release and is keyed by tenant, Release and compiler revision.
- Runtime lookup joins the authoritative Release row in the same tenant transaction. It reconstructs
  the complete `AgentReleaseBinding`; requested and stored Release identity/content/components must
  match exactly before content can leave the Store boundary.
- Runtime configuration pins one bounded compiler revision. There is no `latest`, fallback scan,
  cross-tenant lookup or process-global cache.
- The Store bounds the Playbook to 64 KiB and validates all identifiers, digests, component JSON and
  stored content before returning a redacted record.
- PostgreSQL RLS remains tenant authority. The runtime role gets read-only access; artifact
  publication/control-plane authorization is deliberately outside this slice.
- The Worker adapter implements the existing `ActiveCallArtifactSourcePort`; the existing resolver
  remains authority for compiler/release provenance and final Playbook artifact validation.

## Minimal TDD proof

1. Freeze the additive PostgreSQL/SQLite schema contract, RLS, append-only guard and runtime role.
2. Prove configuration and stored-row validation without a database.
3. Prove the concrete PostgreSQL Store implements the existing Worker source port.
4. Run the existing Playbook resolver tests plus scoped formatting and Clippy.

## Explicit exclusions

- artifact authoring/upload and deterministic component-to-Playbook compiler execution;
- a physical Rust Store-adapter query, deployed Worker composition or process restart;
- real Active Call, RustPBX, SIP/PSTN, media, model, performance or production tests.
