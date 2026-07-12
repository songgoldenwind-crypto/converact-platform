# iveKit Standalone Service

This package owns the build and runtime dependencies of the reusable iveKit HTTP and WebSocket service.

Do not build this directory directly inside the OPC monorepo because its `src/` tree is generated from the audited dependency graph. Generate and verify an isolated context from the repository root:

```bash
npm run verify:ivekit:standalone-context
```

The generated context contains only the iveKit source graph, this package manifest and lockfile, the standalone Dockerfile, and explicitly selected communication migrations. The boundary verifier rejects call-center, IVR, frontend, unresolved imports, undeclared runtime packages, symlinks, extra files, and lockfile drift.

The generated `migrations/` directory includes the minimal fresh-database foundation, communication schema, forced tenant RLS, and standalone runtime security hardening. Apply migrations with the one-shot compiled entrypoint before starting the long-running service:

```bash
npm run migrate
```

Create the `opc_runtime` role before migration so restricted helper-function grants can be applied, then grant it schema/table/sequence access after migration and revoke all access to `schema_migrations`. The long-running service must use `opc_runtime` with `NOSUPERUSER NOBYPASSRLS`; only the one-shot migration job may use `opc_admin`.
