# iveKit RustDesk Edge Agent

Device-local command agent for the reusable iveKit RustDesk control plane.

Install dependencies, configure the variables documented in the delivery bundle, then run:

```bash
npm ci --omit=dev
npm start
```

`OPC_RUSTDESK_EDGE_SPOOL_DIR` is mandatory when a disconnect or restart adapter is enabled. Observation inbox/spool and evidence inbox/spool are optional paired capabilities. The packaged custom RustDesk producer scans only configured file/recording roots, baselines existing files, emits metadata candidates after two stable scans, and lets the companion correlate each candidate with a short-lived device/controller/operation authorization before staging content. API keys, command/claim tokens, stdout/stderr, passwords, clipboard content, screen pixels, and keystrokes are never persisted in edge state. Local source paths exist only in ACL-protected device state and are never sent to the server.

The observation bridge uses `received -> forwarding -> forwarded|dead_letter`. The evidence uploader supports single and resumable multipart uploads and emits an `ivekit_secure_file` observation only after the server confirms size and SHA-256. `native_unscanned` and `local_only` remain truthful fallback labels for content outside the packaged allowlisted flow; they never imply scanning or OCR/ASR eligibility.

The adapter examples are starting points. Pin, sign, permission, and test the wrapper for each supported RustDesk client and operating-system version before enabling strict physical disconnect.

The delivered `dist/` files are precompiled ESM and have no third-party runtime dependencies. The matching TypeScript sources are included for audit and controlled rebuilds.
