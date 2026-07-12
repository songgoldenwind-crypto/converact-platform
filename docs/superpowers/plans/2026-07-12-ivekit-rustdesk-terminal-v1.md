# iveKit RustDesk Real Terminal V1 Implementation Plan

> **Status:** Planned after M3 local completion. No server upload or deployment is included in this plan execution.

**Goal:** Turn the existing iveKit RustDesk control plane, SDK, edge command queue, audit model, and acceptance bundle into a reusable real-terminal V1 that LED and other products can integrate without depending on OPC call-center source.

**Architecture:** RustDesk OSS native clients remain responsible for screen rendering, keyboard/mouse control, multi-display, file transfer, clipboard, and client-side recording. iveKit remains authoritative for tenant identity, business binding, device registration, consent, permission scopes, session state, signed launch plans, control ownership, physical disconnect commands, operation audit, and evidence. The browser launches a pinned native client or presents explicit manual fields; it does not proxy RustDesk credentials or implement a second remote-desktop protocol.

**Tech Stack:** TypeScript, PostgreSQL with FORCE RLS, `@opc/ivekit-sdk`, React/Vite reference client, RustDesk OSS `hbbs`/`hbbr` and native clients, platform-specific allowlisted edge wrappers, Node test runner, Playwright controlled E2E, existing RustDesk preflight/readiness/client-acceptance/evidence-pack tooling.

**Approved scope:** Windows, macOS, and Linux client configuration; attended consent; policy-only unattended access without storing plaintext passwords; native launch/manual fallback; view/control/multi-display/file/clipboard/recording operation audit; single-controller lock and transfer; disconnect/revoke/recovery; SDK/UI/docs/evidence. Building or forking RustDesk's screen codec, relay protocol, or native UI is out of scope.

---

## Stable Rules

1. LED and other products depend only on `@opc/ivekit-sdk`, `/api/ivekit/rustdesk/*`, and tenant-scoped events.
2. The browser never receives the iveKit API key, edge signing secret, RustDesk private key, unattended password, or raw service credentials.
3. `JWT sub` is authoritative for browser users. System/API-key mode may represent another actor only through an explicit audited header.
4. Every device, gateway session, operation event, command, lock, and evidence row is tenant-scoped and protected by FORCE RLS.
5. Consent scopes are the upper bound for launch permissions and operation events. A client capability heartbeat cannot grant a scope that consent did not grant.
6. Native RustDesk is the data plane. iveKit operation events are an auditable mirror, not proof that the native operation succeeded without a terminal observation.
7. Ending a session, revoking consent, removing a device, or expiring a control lock invalidates launch first and then requests physical disconnect.
8. Session-specific disconnect is preferred. Service restart is an explicit fallback with collateral-session risk in the result and audit.
9. Controlled E2E proves iveKit state and UI logic only. Screen pixels, keyboard/mouse effect, multi-display, file bytes, clipboard content, recording playback, relay use, and physical disconnect remain `not_run` until real clients are used.
10. Real acceptance artifacts must be unique, secret-free, SHA-256-bound, and independently reviewed. No local wrapper exit code may be reported as operator-observed disconnect.

---

## Existing Foundation To Reuse

- Device registration, business-ref lookup, heartbeat, online TTL, deactivation, and tenant RLS.
- Gateway session creation, launch plan, signed launch URL, protocol URL, audit events, end, and disconnect status.
- Device-bound edge token, command claim lease, progress/result reporting, retry, session adapter, and service-restart fallback.
- Typed RustDesk HTTP client and LED workflow SDK.
- Operation event schemas for control, file transfer, clipboard, recording, gateway end, and disconnect lifecycle.
- Deployment preflight, server evidence, readiness, client config pack, LED example, event forwarder, dead-letter/replay, audit export/coverage, client acceptance, evidence pack, handoff pack, and acceptance bundle.

M4 must extend these contracts instead of creating parallel device/session/audit stores.

---

## Task 1: Freeze The Terminal Contract And Capability Matrix

**Files:**
- Modify: `sdk/ivekit/src/types.ts`
- Modify: `sdk/ivekit/src/rustdesk-http-client.ts`
- Modify: `docs/ivekit-openapi.md`
- Modify: `docs/iveKit视频IM通用能力详细设计.md`
- Create: `docs/rustdesk-client-version-matrix.md`
- Create: `test/rustdesk-terminal-contract.test.ts`

- [ ] Define named DTOs for terminal profile, platform, architecture, client version, configured fields, runtime capabilities, permission scopes, control ownership, disconnect state, and operation evidence.
- [ ] Separate `configured`, `available`, `granted`, and `observed` capability states so the API cannot imply real success from configuration alone.
- [ ] Pin the supported RustDesk OSS server/client version matrix and record platform-specific limitations.
- [ ] Preserve all existing RustDesk SDK methods and response fields; additions must be backward-compatible.
- [ ] Verify the SDK package remains browser-safe and contains no OPC server source.

## Task 2: Build Secret-Safe Client Profiles And Distribution Manifests

**Files:**
- Create: `src/agent-runtime/collaboration/rustdesk-client-profile.ts`
- Modify: `src/agent-runtime/collaboration/rustdesk-client-config.ts`
- Modify: `src/agent-runtime/ivekit/rustdesk-http-client.ts`
- Modify: `sdk/ivekit/src/rustdesk-http-client.ts`
- Create: `scripts/rustdesk-client-profile-pack.ts`
- Create: `test/rustdesk-client-profile.test.ts`
- Create: `test/rustdesk-client-profile-pack.test.ts`

- [ ] Return platform/architecture-specific manual fields, public key fingerprint, allowed version range, install source checksum metadata, protocol support, and unattended-policy state.
- [ ] Do not include private keys, edge tokens, API keys, passwords, signed launch tokens, or installer credentials.
- [ ] Generate a handoff manifest for Windows/macOS/Linux with checksums and operator instructions; do not download or execute installers automatically.
- [ ] Reject unsupported platforms, malformed versions, key drift, server drift, and expired profiles.
- [ ] Add cache headers that prevent shared caching of actor/session-specific responses.

## Task 3: Add Durable Attended And Unattended Access Policy

**Files:**
- Create: `src/migrations/039_rustdesk_access_policy.sql`
- Modify: `src/migrations/005_full_schema.sql`
- Create: `src/agent-runtime/collaboration/rustdesk-access-policy-store.ts`
- Modify: `src/agent-runtime/ivekit/rustdesk-http-client.ts`
- Modify: `sdk/ivekit/src/rustdesk-http-client.ts`
- Create: `test/rustdesk-access-policy.test.ts`

- [ ] Model `attended_only` and `unattended_allowed` policy, approver, expiry, allowed scopes, target device, business ref, reason, and immutable history.
- [ ] Never store or return a plaintext unattended password. A provider credential reference may be stored only if an external secret store is explicitly configured later.
- [ ] Require active policy plus active consent before unattended launch; deny by default when either is absent or expired.
- [ ] Require owner/admin authorization and a reason for policy changes, with idempotency and audit.
- [ ] Apply FORCE RLS and cross-tenant 404 behavior.

## Task 4: Add Single-Controller Lock, Transfer, And Secondary Confirmation

**Files:**
- Create: `src/migrations/040_rustdesk_control_ownership.sql`
- Modify: `src/migrations/005_full_schema.sql`
- Create: `src/agent-runtime/collaboration/rustdesk-control-lock-store.ts`
- Modify: `src/agent-runtime/ivekit/rustdesk-http-client.ts`
- Modify: `sdk/ivekit/src/rustdesk-http-client.ts`
- Create: `test/rustdesk-control-lock.test.ts`

- [ ] Allow one active controller per gateway session, with bounded lease, heartbeat, release, expiry, and transactional transfer.
- [ ] Observers may view only when consent allows; they cannot emit control/file/clipboard operations.
- [ ] Require a fresh secondary confirmation for `control_mouse_keyboard`, `transfer_file`, `clipboard`, unattended launch, and control transfer.
- [ ] Reject stale owners, replayed confirmation challenges, and lock changes after terminal session state.
- [ ] Broadcast lock and transfer changes only to active session participants.

## Task 5: Harden Launch Broker And Native-Client Fallback

**Files:**
- Modify: `src/agent-runtime/collaboration/rustdesk-launch-plan.ts`
- Modify: `src/agent-runtime/ivekit/rustdesk-http-client.ts`
- Modify: `sdk/ivekit/src/rustdesk-http-client.ts`
- Create: `clients/ivekit-reference/src/remote/rustdesk-launch-panel.tsx`
- Create: `clients/ivekit-reference/src/remote/rustdesk-launch-panel.test.tsx`
- Modify: `clients/ivekit-reference/src/app.tsx`
- Modify: `clients/ivekit-reference/src/styles.css`

- [ ] Add a Remote workspace to the reference client that resolves a business ref/device, shows consent and scopes, starts a gateway session, and displays exact target/key fingerprints.
- [ ] Use a user-initiated protocol launch button. Do not auto-launch on page load.
- [ ] Provide explicit manual fields when protocol handling is unavailable, while keeping signed launch tokens out of visible text and persistent storage.
- [ ] Re-fetch launch state immediately before launch and reject ended, expired, drifted, or wrong-target plans.
- [ ] Show control owner, disconnect progress, audit status, and terminal state without embedding a RustDesk data plane in the browser.

## Task 6: Ship Platform-Specific Physical Disconnect Adapters

**Files:**
- Create: `scripts/rustdesk-edge-adapters/linux-disconnect.sh`
- Create: `scripts/rustdesk-edge-adapters/windows-disconnect.ps1`
- Create: `scripts/rustdesk-edge-adapters/macos-disconnect.sh`
- Create: `scripts/rustdesk-edge-adapters/linux-restart.sh`
- Create: `scripts/rustdesk-edge-adapters/windows-restart.ps1`
- Create: `scripts/rustdesk-edge-adapters/macos-restart.sh`
- Modify: `scripts/rustdesk-edge-command.ts`
- Modify: `scripts/rustdesk-edge-agent.ts`
- Create: `test/rustdesk-edge-adapter-contract.test.ts`

- [ ] Keep wrappers allowlisted and argument-based; no shell interpolation or arbitrary command body is accepted from the server.
- [ ] Target only the requested `external_id`, target ID, and RustDesk ID when the installed client/runtime exposes a session-specific disconnect mechanism.
- [ ] Make restart fallback explicit per platform and record collateral-session risk.
- [ ] Verify timeout, process-group termination, bounded output hashing, nonzero exit, missing service, and idempotent already-disconnected behavior.
- [ ] Provide dry-run/validate mode that reports command availability without changing the machine.

## Task 7: Normalize Native Operation Telemetry

**Files:**
- Modify: `scripts/rustdesk-event-forwarder.ts`
- Modify: `src/agent-runtime/collaboration/rustdesk-gateway-event.ts`
- Modify: `sdk/ivekit/src/rustdesk-led-sdk.ts`
- Create: `scripts/rustdesk-operation-observer.ts`
- Create: `test/rustdesk-operation-observer.test.ts`

- [ ] Normalize view/control/multi-display/file/clipboard/recording events with operation IDs, direction, status, timestamps, byte counts/checksums, display IDs, and evidence refs.
- [ ] Never forward clipboard contents, file contents, keystrokes, screen pixels, or recording bytes through audit events.
- [ ] Deduplicate retries by stable operation key and preserve dead-letter/replay behavior.
- [ ] Attribute events to the active controller and reject events outside consent, control ownership, device, session, or tenant boundaries.
- [ ] Treat native observation adapters as optional platform integrations; missing telemetry must remain visible as `not_observed`.

## Task 8: Build Controlled Reference-Client E2E

**Files:**
- Create: `clients/ivekit-reference/e2e/controlled-rustdesk-server.ts`
- Create: `clients/ivekit-reference/e2e/rustdesk.spec.ts`
- Modify: `clients/ivekit-reference/playwright.config.ts`
- Modify: `package.json`

- [x] Cover device resolution, consent, scope display, gateway creation, protocol/manual launch, lock acquisition, transfer, operation event projection, end, disconnect progression, revoke, and old-link invalidation.
- [x] Verify participant/user isolation, cross-tenant denial, stale launch suppression, retry idempotency, and zero token persistence.
- [x] Capture desktop/mobile layouts without overlap or hidden revoke/end controls.
- [x] Label all controlled results as local regression evidence; do not emulate native screen/control success.

Local regression command: `npm run test:e2e:ivekit-rustdesk` (`3/3` on 2026-07-12). These controlled results validate only iveKit HTTP/UI state, authorization, idempotency, link handling, persistence, and responsive layout. They do not run a native RustDesk client and do not claim screen pixels, keyboard/mouse effects, file/clipboard operations, recording, relay traffic, or physical disconnect success.

## Task 9: Bind Real Terminal Acceptance Without Fabrication

**Files:**
- Modify: `scripts/rustdesk-client-acceptance.ts`
- Modify: `scripts/rustdesk-acceptance-bundle.ts`
- Modify: `scripts/rustdesk-evidence-pack.ts`
- Modify: `scripts/rustdesk-handoff-pack.ts`
- Modify: `test/rustdesk-client-acceptance.test.ts`
- Modify: `test/rustdesk-evidence-pack.test.ts`
- Modify: `infra/ivekit/README.md`

- [ ] Require real client/server versions, platform/architecture, target ID, key fingerprint, ID/relay path, and distinct operator/QA identities.
- [ ] Require separate structured observations for screen pixels, keyboard/mouse effect, multi-display, file checksum, clipboard direction, recording playback, reconnect, and physical disconnect.
- [ ] Bind every observation to run/environment/commit/external ID with a unique artifact and SHA-256.
- [ ] Require audit coverage and physical disconnect command lifecycle, but keep operator observation independent from command success.
- [ ] Return `not_run` when no real report is supplied; controlled E2E cannot satisfy real-terminal checks.

## Task 10: M4 Local Verification And Handoff

- [ ] Run RustDesk unit/contract suites, SDK build/pack, reference-client tests/E2E, full `npm run verify`, frontend build, Compose config, and sidecar checks.
- [ ] Scan browser bundles and generated packs for secrets, signed URLs, private keys, API keys, tokens, clipboard text, and file contents.
- [ ] Request independent review of RLS, identity, consent, policy, lock races, launch expiry, edge command safety, physical disconnect honesty, audit granularity, and evidence binding.
- [ ] Resolve every Critical/Important finding with TDD.
- [ ] Update OpenAPI, LED guide, detailed design, roadmap, deployment runbook, rollback steps, and M5 plan.
- [ ] Mark real hbbs/hbbr and native terminal checks `not_run` because local execution does not upload or deploy to a server.

---

## M4 Local Completion Criteria

1. SDK exposes typed RustDesk device/profile/policy/lock/session/audit/disconnect contracts without server-source dependencies.
2. Reference client launches the native client or presents manual fallback through a bounded, user-initiated workflow.
3. Consent, access policy, capability heartbeat, launch permissions, and control ownership converge without widening scopes.
4. Control ownership is single-writer, leased, transferable, and tenant isolated.
5. Platform disconnect wrappers are allowlisted, timeout-bounded, dry-run capable, and explicit about restart collateral risk.
6. Operation telemetry contains metadata and hashes only, never sensitive operation contents.
7. Ending/revoking a session invalidates launch and produces a queryable disconnect state and audit lifecycle.
8. Controlled E2E proves local workflow, layout, idempotency, revoke, and token non-persistence.
9. Real screen/control/file/clipboard/recording/reconnect/disconnect evidence remains `not_run` until two real clients are operated on the server.
10. Full local gates pass with no unresolved Critical or Important finding.
