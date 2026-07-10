# 新增功能准入清单（Call-Center / Voice-Agent 域）

> 本清单替代旧的 lead-acquisition 准入清单（旧清单已归档，移出本仓库）。
> 适用于 `src/agent-runtime/call-center/` 及 `src/agent-runtime/voice-*` 相关的所有新增功能。

## 1. HTTP 路由注册

新增 HTTP 端点必须注册到 `src/call-center-http.ts`（call-center 域）或 `src/http.ts`（platform 域）。

- **call-center 域路由**：`src/call-center-http.ts`（`routeCallCenterApi`），路径前缀 `/api/call-center/*`
- **platform 域路由**：`src/http.ts`，路径前缀 `/api/*`（tenant/channel/landing/task/lead 等通用 CRUD）
- **禁止**在 `src/http.ts` 里新增 lead-acquisition 路由（模块已归档）

## 2. Tool 注册

新增 voice/call-center tool 必须在对应模块注册：

- **voice tool**：`src/agent-runtime/voice-tools.ts`（`registerVoiceTools`），tool_id 前缀 `voice.*`
- **call-center agent tool**：`src/agent-runtime/call-center/agent-tools/agent-tools-http.ts`
- **禁止**在 `src/agent-runtime/business-tools.ts` 注册新 tool（该文件已退化为 no-op 桩）

## 3. Schema 字段

新增表或字段写到 `src/schema.sql`。call-center 域已有表组（schema.sql 末尾 `===== Call Center (RustPBX + LiveKit) =====`）：

- `livekit_rooms` / `call_recordings` / `ai_conversation_turns` / `agent_seats` / `outbound_tasks`
- `voice_call_sessions` / `voice_call_logs` / `voice_recordings` / `voice_webrtc_sessions`

合规相关字段必填：`consent_id`、`recording_mode`、`retention_until`。

## 4. 合规拦截

涉及外呼或录音的功能必须经过合规层：

- **外呼合规**：`src/agent-runtime/call-center/compliance/outbound-compliance.ts` + `compliance-gate.ts`（时间窗口 9:00-21:00、DNC 检查）
- **录音合规**：`src/agent-runtime/call-center/compliance/consent-tracker.ts` + `recording-pci.ts`
- **AI 披露**：`src/agent-runtime/call-center/compliance/disclosure-enforcer.ts`（中英文开场白）

## 5. 集成配置

外部服务（RustPBX / LiveKit / NATS / Redis / MinIO / Stripe）配置通过 `IntegrationConfigStore`：

- 配置存 `tenant_integration_configs.config`（JSON）
- 密钥存 `integration_secret_refs`（绑 env 变量）
- `resolveRuntimeConfig` 合并 config + env 到 runtime_config
- 环境变量声明在 `.env.example`（`LIVEKIT_*` / `RUSTPBX_*` / `NATS_URL` / `REDIS_URL` / `MINIO_*` / `STRIPE_*`）

## 6. 测试样板

新增功能必须附带测试，放在 `test/` 目录：

- call-center 域测试：`test/sprint*.test.ts` 或 `test/phase*.test.ts`
- voice 域测试：`test/voice-*.test.ts` 或 `test/call-center-*.test.ts`
- 测试用 `:memory:` SQLite + `createDatabase`，不依赖外部服务
- 涉及 RustPBX/LiveKit 的测试用 `http.Server` mock，不连真实服务

## 7. CI 验收

新增功能提交前必须通过：

```bash
npm run typecheck           # 0 错误
npm run test:call-center-s12 # 11/11
npm run test:phase3-platform # 3/3
```

涉及 Phase 0/1 改动时追加：
```bash
npm run test:phase0
npm run test:phase1
```

## 8. 禁止事项

- **禁止**从已归档的旧 lead-acquisition 代码引入依赖（已移出本仓库）
- **禁止**在 `src/platform/` 里反向依赖 `src/agent-runtime/call-center/`（platform 是底层，call-center 是上层）
- **禁止**在 `src/agent-runtime/business-tools.ts` 注册新 tool
- **禁止**在 `src/http.ts` 新增 `/api/lead-acquisition-runs/*` 路由
- **禁止**提交 `.browser-data/` 或任何含登录态 cookie 的浏览器数据
