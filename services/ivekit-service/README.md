# iveKit Standalone Service

This package owns the build and runtime dependencies of the reusable iveKit HTTP and WebSocket service.

Do not build this directory directly inside the OPC monorepo because its `src/` tree is generated from the audited dependency graph. Generate and verify an isolated context from the repository root:

```bash
npm run verify:ivekit:standalone-context
```

The generated context contains only the iveKit source graph, this package manifest and lockfile, the standalone Dockerfile, and explicitly selected communication migrations. The boundary verifier rejects call-center, IVR, frontend, unresolved imports, undeclared runtime packages, symlinks, extra files, and lockfile drift.

The V2 PostgreSQL foundation migration is delivered separately from the OPC full schema. Until that migration is present, the context proves independent compilation but is not a complete fresh-database deployment artifact.
