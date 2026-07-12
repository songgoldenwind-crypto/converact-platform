# iveKit RustDesk Edge Agent

Device-local command agent for the reusable iveKit RustDesk control plane.

Install dependencies, configure the variables documented in the delivery bundle, then run:

```bash
npm ci --omit=dev
npm start
```

`OPC_RUSTDESK_EDGE_SPOOL_DIR` is mandatory when a disconnect or restart adapter is enabled. The agent writes only sanitized command state; API keys, command/claim tokens, stdout/stderr, passwords, clipboard data, files, and screen content are never persisted.

The adapter examples are starting points. Pin, sign, permission, and test the wrapper for each supported RustDesk client and operating-system version before enabling strict physical disconnect.

The delivered `dist/` files are precompiled ESM and have no third-party runtime dependencies. The matching TypeScript sources are included for audit and controlled rebuilds.
