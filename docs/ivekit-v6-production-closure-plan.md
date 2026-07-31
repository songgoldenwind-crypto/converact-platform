# iveKit V6 Production Closure Implementation Plan

> 执行方式：Inline Execution。每项先写失败测试，再实现最小生产代码并运行聚焦回归。

**Goal:** 关闭 Tinode Kubernetes、Tinode 原生 mutation、RustDesk 精准断开与原生证据安全入库缺口，并把可用真实环境纳入可审计验收。

**Architecture:** iveKit 保持权威控制面，外部执行统一使用 PostgreSQL durable outbox/command、lease fencing、幂等完成与 dead letter。Windows companion 只执行 capability manifest 允许的本地动作，所有内容证据进入 secure-file 链路。

**Tech Stack:** TypeScript、Node.js、PostgreSQL、Tinode WebSocket protocol、Helm/Kubernetes、PowerShell、RustDesk OSS、ClamAV、S3/MinIO。

**后续性能目标：** 单套平台横向扩展到 100,000 并发通信属于独立容量工程 Goal。本轮只保留 PostgreSQL durable lease、无状态 API、外部对象存储和 external Provider/cluster 等横向扩展前提；没有完成分层容量模型、压测、瓶颈剖析和服务器数量优化前，不声明 100,000 并发。

---

## Task 1: Tinode standalone Helm

**Files:**

- Create: `services/ivekit-service/helm/ivekit/templates/tinode-config.yaml`
- Create: `services/ivekit-service/helm/ivekit/templates/tinode-deployment.yaml`
- Create: `services/ivekit-service/helm/ivekit/templates/tinode-service.yaml`
- Create: `services/ivekit-service/helm/ivekit/templates/tinode-pvc.yaml`
- Create: `services/ivekit-service/helm/ivekit/templates/tinode-pdb.yaml`
- Modify: `services/ivekit-service/helm/ivekit/templates/_helpers.tpl`
- Modify: `services/ivekit-service/helm/ivekit/templates/deployment.yaml`
- Modify: `services/ivekit-service/helm/ivekit/values.yaml`
- Modify: `services/ivekit-service/helm/ivekit/README.md`
- Create: `src/agent-runtime/collaboration/tinode-service-account-bootstrap.ts`
- Create: `src/ivekit-tinode-bootstrap.ts`
- Test: `test/ivekit-tinode-helm-deployment.test.ts`

- [x] Add failing static contracts for disabled, bundled, immutable image, Secret refs, probes, PVC, PDB and invalid multi-replica settings.
- [x] Add Tinode helpers and values with `enabled=false` by default.
- [x] Add ConfigMap/Deployment/Service/PVC/PDB templates and iveKit internal URL wiring.
- [x] Add fail-closed Tinode service-account bootstrap and production WSS/worker/Secret validation.
- [x] Add release bundle/source graph coverage and operator documentation.
- [x] Run Tinode Helm, deployment bundle, source graph and typecheck tests.

## Task 2: Durable Tinode mutation outbox

**Files:**

- Create: `src/migrations/074_tinode_message_mutation_outbox.sql`
- Create: `src/agent-runtime/collaboration/tinode-message-mutation.ts`
- Modify: `src/agent-runtime/collaboration/chat-gateway.ts`
- Modify: `src/agent-runtime/collaboration/message-state-store.ts`
- Modify: `src/agent-runtime/collaboration/collaboration-http.ts`
- Modify: `src/agent-runtime/collaboration/tinode-sync-worker.ts`
- Modify: `src/agent-runtime/collaboration/tinode-inbound-projector.ts`
- Modify: `src/agent-runtime/collaboration/tinode-metrics.ts`
- Modify: `src/agent-runtime/collaboration/index.ts`
- Test: `test/tinode-message-mutation.test.ts`
- Test: `test/tinode-inbound-projector.test.ts`
- Test: `test/collaboration-message-state.test.ts`

- [x] Add failing migration and store tests for outbox uniqueness, RLS, lease fencing and per-message version ordering.
- [x] Insert outbox atomically with local edit/delete when the provider is Tinode.
- [x] Extend `ChatGateway` with edit/delete operations; implement Tinode replacement and delete wire frames.
- [x] Add worker retry/dead-letter/metrics and immediate best-effort delivery after API commit.
- [x] Suppress inbound echoes while preserving external-client mutations and rejecting stale versions.
- [x] Add API/SDK sync status and operational dead-letter replay.
- [x] Treat edit publish ACK loss and recovered expired edit leases as terminal `provider_outcome_uncertain`; require explicit reconciliation/replay.
- [x] Reconcile a verified late Tinode echo to delivered and publish one post-commit correction event.
- [x] Run mutation, inbound, HTTP, SDK, PostgreSQL and typecheck tests.

## Task 3: RustDesk precise Windows disconnect

**Files:**

- Create: `scripts/rustdesk-windows/Invoke-IveKitRustDeskSessionDisconnect.ps1`
- Create: `scripts/rustdesk-windows/Resolve-IveKitRustDeskSession.ps1`
- Modify: `scripts/rustdesk-edge-command.ts`
- Modify: `scripts/rustdesk-edge-adapters/windows-disconnect.ps1`
- Modify: `scripts/rustdesk-windows-capability-policy.ts`
- Modify: `scripts/rustdesk-windows-package.ts`
- Modify: `scripts/rustdesk-windows/Deploy-IveKitRustDesk.ps1`
- Modify: `src/agent-runtime/collaboration/rustdesk-device-command-store.ts`
- Modify: `src/agent-runtime/collaboration/rustdesk-physical-disconnect.ts`
- Test: `test/rustdesk-precise-disconnect.test.ts`
- Test: `test/rustdesk-edge-command.test.ts`
- Test: `test/rustdesk-windows-package.test.ts`

- [x] Add failing contracts proving a target native session is required and restart is not an automatic success path.
- [x] Add allowlisted session resolver/bridge and structured result schema.
- [x] Require explicit administrator emergency fallback with reason and collateral acknowledgement.
- [x] Package/install the bridge and expose capability/readiness state.
- [x] Add audit, operation observation, retry and physical disconnect completion tests.

## Task 4: RustDesk native evidence auto-ingestion

**Files:**

- Create: `scripts/rustdesk-native-evidence-watcher.ts`
- Create: `scripts/rustdesk-native-evidence-correlator.ts`
- Create: `scripts/rustdesk-native-evidence-policy.ts`
- Modify: `scripts/rustdesk-edge-observation-contract.ts`
- Modify: `scripts/rustdesk-evidence-uploader.ts`
- Modify: `scripts/rustdesk-observation-bridge.ts`
- Modify: `scripts/rustdesk-windows/Deploy-IveKitRustDesk.ps1`
- Create: `scripts/rustdesk-windows/Publish-IveKitRustDeskEvidence.ps1`
- Modify: `scripts/rustdesk-windows-package.ts`
- Modify: `src/agent-runtime/collaboration/rustdesk-edge-evidence-http.ts`
- Modify: `src/agent-runtime/collaboration/secure-file-service.ts`
- Create: `src/agent-runtime/collaboration/rustdesk-evidence-intelligence.ts`
- Create: `src/migrations/076_rustdesk_evidence_intelligence_reconciliation.sql`
- Modify: `src/agent-runtime/collaboration/secure-file-derivative-worker.ts`
- Test: `test/rustdesk-native-evidence-watcher.test.ts`
- Test: `test/rustdesk-evidence-uploader.test.ts`
- Test: `test/rustdesk-edge-evidence-http.test.ts`

- [x] Add failing tests for authorization, allowlisted roots, file stability, mutation detection, dedupe and forbidden evidence types.
- [x] Convert eligible native observations into durable local upload records.
- [x] Add custom RustDesk allowlist scanner candidates and device-context authorization correlation; keep manual publisher recovery-only.
- [x] Reuse single/multipart secure-file upload and bind authorization/session/business metadata.
- [x] Propagate scan/quarantine/derivative/OCR-ASR-AI states to operation evidence and audit.
- [x] Preserve `native_unscanned`/`local_only` for content not processed by uploader.
- [x] Add crash recovery and bounded spool retention tests.
- [x] Add idempotent ready-file reconciliation for a process exit after secure-file convergence.
- [x] Allow bounded post-session recording finalization, pair dead-letter payload cleanup with state, and terminally mark unsupported candidates.

## Task 5: Real environment acceptance and delivery

**Files:**

- Create: `docs/ivekit-v6-real-environment-acceptance.md`
- Create: `scripts/ivekit-v6-real-acceptance.ts`
- Modify: `scripts/ivekit-delivery-bundle.ts`
- Modify: `docs/ivekit-led-integration-guide.md`
- Modify: `docs/ivekit-v3-completion-audit.md`
- Modify: `docs/openapi.yaml`
- Modify: `sdk/ivekit/README.md`
- Test: `test/ivekit-v6-real-acceptance.test.ts`
- Test: `test/ivekit-delivery-bundle.test.ts`

- [x] Add a machine-readable eight-group real-environment manifest and strict evidence validator.
- [x] Execute static preflight/contracts that require no unavailable secret or physical device.
- [x] Evaluate available real environments; none of the eight groups has the required external resources, so no passed evidence was manufactured.
- [x] Record all unavailable external resources as `not_run` with reason codes and exact commands.
- [x] Update OpenAPI, SDK, LED guide, operations and completion audit without overstating evidence.
- [x] Compile-gate the pinned RustDesk overlay in Windows CI and include both native Rust modules in the delivery allowlist.
- [x] Run full verification, secret scan, independent review and close all findings.
