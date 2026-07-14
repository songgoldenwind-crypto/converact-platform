# iveKit Standalone Service

This package owns the build and runtime dependencies of the reusable iveKit HTTP and WebSocket service.

Do not build this directory directly inside the OPC monorepo because its `src/` tree is generated from the audited dependency graph. Generate and verify an isolated context from the repository root:

```bash
npm run verify:ivekit:standalone-context
```

The generated context contains only the iveKit source graph, this package manifest and lockfile, the standalone Dockerfile, and explicitly selected communication migrations. The boundary verifier rejects OPC call-center, legacy OPC IVR, frontend, unresolved imports, undeclared runtime packages, symlinks, extra files, and lockfile drift while retaining standalone `agent-runtime/ivekit/ivr`.

The generated `migrations/` directory includes the minimal fresh-database foundation, communication schema, forced tenant RLS, and standalone runtime security hardening. Apply migrations with the one-shot compiled entrypoint before starting the long-running service:

```bash
npm run migrate
```

The standalone Helm Chart source is under `helm/ivekit/`. It requires an immutable application image digest and an externally managed Secret, runs runtime-role initialization plus advisory-locked forward migrations as a `pre-install,pre-upgrade` hook, and deploys the API only after that hook succeeds. PostgreSQL and communication providers remain external dependencies; optional RustPBX is enabled separately with its own digest and database.

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

Real Voice acceptance is an operator-run release gate, not a long-running service or a controlled Compose profile. Generate the source-bound 45-check template and runbook from the repository with `npm run ivekit:voice-acceptance`, or use `acceptance/voice-real-template.json`, `acceptance/voice-real-runbook.md`, and `acceptance/tools/ivekit-voice-acceptance.ts` from the delivery bundle. Validation requires distinct SHA-256-bound observations from real RustPBX, SIP/PSTN, browser RTP, IVR, recording, bridge, Contact Center, recovery, isolation, and performance runs. A successful result is `ready_for_review`; real RustPBX remains `not_run` until independent QA approves those artifacts.

Provider profile metadata is supplied through `OPC_IVEKIT_PROVIDER_PROFILES_JSON`; secrets stay in dedicated environment variables or an external secret manager. The generated delivery bundle carries `operations/release-contract.json` and `operations/upgrade-runbook.md`. Migrations are forward-only; application rollback selects a compatible prior immutable image, while schema recovery restores a verified pre-upgrade backup.
