# AI outbound R1 Active Call Release artifact Store evidence

> Date: 2026-09-01
>
> Status: `passed_local_contract_and_physical_schema / runtime_query_not_run / production_not_run`

## Proven scope

- migration 137 adds one tenant-scoped append-only table keyed by exact Agent Release and compiler
  revision without switching any existing writer;
- the migration freezes published Agent Release content while still allowing the one-way
  `published -> retired` lifecycle transition;
- the runtime role receives read-only artifact access and PostgreSQL RLS remains tenant authority;
- the Rust Store performs one exact tenant/Release/compiler lookup, joins the authoritative Release
  row and reconstructs all eight component digests before returning bounded content;
- requested and stored Release bindings must be byte-for-byte equal; malformed component JSON,
  identities, digests, compiler revisions and Playbooks fail closed;
- the concrete PostgreSQL Store implements the existing Active Call artifact source port, while the
  existing resolver still verifies Release/compiler provenance and the final Playbook digest;
- Debug output reports only bounded provenance/size fields and never includes Playbook content.

## Precise verification

Rust `1.94.1` with `--locked`:

```text
converact-postgres-store active_call_release_artifact_contract: 3 passed
converact-voice-agent-worker postgres_active_call_artifact_source: 1 passed
converact-voice-agent-worker active_call_playbook_resolver: 2 passed
converact-ai-outbound-core agent_release: 4 passed
scoped PostgreSQL Store and Worker Clippy with -D warnings: passed
scoped rustfmt and git diff checks: passed
```

A disposable local PostgreSQL `14.18` cluster applied migrations 124 and 137, inserted an exact
Release plus compiled Playbook, accepted the one-way Release retirement, rejected Release-content
mutation, rejected artifact mutation and returned the exact compiler revision/content length. The
cluster was isolated on a temporary Unix socket and removed after the check.

No Docker, remote server, deployed service, broad regression or performance test was used.

## Explicitly not proved

- control-plane artifact authoring/upload and authorization;
- deterministic compilation from all eight component payloads into the stored Playbook;
- the Rust Store adapter querying a physical database through the production pool/RLS role;
- runnable Worker process composition, restart recovery or multi-node behavior;
- real Active Call/RustPBX, SIP/PSTN, media, model inference, production or capacity.
