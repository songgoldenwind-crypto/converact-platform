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

The included Compose file runs the compiled `init:runtime-role` entrypoint before `migrate`. It creates or rotates `opc_runtime`, applies default and existing-object grants, and revokes schema creation and migration-ledger access. The long-running service uses `opc_runtime` with `NOSUPERUSER NOBYPASSRLS`; only the one-shot role and migration jobs receive `opc_admin` credentials.

For an isolated foundation deployment, generate the context, replace both passwords in `env.example`, and run Compose from the generated directory:

```bash
docker compose --env-file env.example up --build
```

The default provider workers are disabled. Enable each worker only after its corresponding LiveKit, Tinode, storage, Redis, or quality provider configuration has been supplied.

Run the compiled V3 configuration gate before enabling OCR, ASR, quality, or translation workers:

```bash
npm run preflight:intelligence
```

For the optional Voice profile, render the RustPBX configuration and run the Voice gate with compiled entrypoints that are included in the production image:

```bash
npm run render:rustpbx
npm run preflight:voice
```

Provider profile metadata is supplied through `OPC_IVEKIT_PROVIDER_PROFILES_JSON`; secrets stay in dedicated environment variables or an external secret manager. The complete self-hosted/third-party profile format, RBAC, durable retry behavior, health checks, alerts, controlled-provider acceptance, upgrade, and rollback procedure is in `docs/ivekit-v3-intelligence-operations.md` in the source repository.
