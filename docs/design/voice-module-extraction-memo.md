# Voice/LiveKit 模块抽取备忘录

> **日期**: 2026-06-24（首次）· 2026-06-29（按 `docs/design/README.md` 准绳重扫 schema）
> **状态**: 设计备忘（未实施）
> **动机**: 后续有别的项目需要复用 LiveKit 视频能力，希望把 voice/livekit 抽成自包含包，供其他项目 import
>
> **关联文档**（见 `docs/design/README.md`）：[实现级架构规格](./architecture-v3.md) · [修订版总规划](./revised-master-plan.md) · [上级: 产品方向](../product-direction-2026-06.md)（§3.1 资产校准，称 voice 表为 14 张）· [本目录导航与治理](./README.md)
>
> **重扫校准（2026-06-29，核查日期=2026-06-29）**：原文按 2026-06 实测写为 **12 张** voice 表与 `.js` 依赖文件名；后又在 `voice_webrtc_sessions` / `voice_webrtc_signals` 加入后增至 **14 张**（见 `product-direction-2026-06.md` §3.1）。`src/schema.sql` 实测亦为 14 张（13 个 `voice_*` 前缀 + `tenant_voice_policies`）。源文件实为 `.ts` 而非 `.js`（`.js` 为旧 build 输出/笔误），下文已逐处更正。

## 现状事实（2026-06 实测）

### 目录结构

```
src/agent-runtime/
├── voice/                      ← 2 文件（store + media-client）
│   ├── voice-store.ts
│   └── voice-media-client.ts
├── livekit/                    ← 5 文件（token + room + dispatch + webhook + config）
│   ├── config.ts
│   ├── token-service.ts
│   ├── room-store.ts
│   ├── agent-dispatch-service.ts
│   └── webhook-handler.ts
├── voice-tools.ts              ← 1 文件，注册 26 个 voice.* 工具
└── call-center/                ← voice-agent-* 编排逻辑在这（6 文件）
    ├── voice-agent-defaults.ts
    ├── voice-agent-ivr-importer.ts
    ├── voice-agent-navigator.ts
    ├── voice-agent-navigation-session.ts
    ├── voice-agent-spec-generator.ts
    └── voice-agent-spec-store.ts
```

### 依赖关系（关键）

**voice/livekit 对外的依赖（少）：**
- `db.ts`（数据库访问）
- `livekit-server-sdk`（npm 包）
- `call-center/types.ts`（类型）
- `call-center/dialer-wait-registry.ts`（拨号等待）

**call-center 对 voice/livekit 的依赖（多）：**
- `voice/voice-store.ts`
- `voice-agent-*.ts`（6 个文件，IVR 导航/spec 生成等编排逻辑）

**结论：双向耦合。** voice 用 call-center 的类型/注册表，call-center 用 voice 的 store 和编排逻辑。不能整块切走。

### DB 表（14 张，命名独立）

`voice_call_logs` · `voice_call_sessions` · `voice_agent_presence` ·
`voice_skill_queues` · `voice_queue_memberships` · `voice_routing_snapshots` ·
`tenant_voice_policies` · `voice_call_consents` · `voice_recordings` ·
`voice_media_storage_policies` · `voice_runtime_deployment_snapshots` ·
`voice_credential_rotations` · `voice_webrtc_sessions` · `voice_webrtc_signals`

> 原写 12 张；新增的 `voice_webrtc_sessions` / `voice_webrtc_signals`（音视频 + 屏幕共享 WebRTC 状态）后增至 14 张（见头部校准）。

表名全部 `voice_*` 前缀（仅 `tenant_voice_policies` 用 `tenant_voice_*`），与 platform/lead 表无交叉，迁移时易分离。

### 工具接口（26 个 voice.* 工具）

`voice.policy_upsert` · `voice.consent_record` · `voice.recording_ingest` ·
`voice.recording_retention_enforce` · `voice.agent_presence_upsert/list` ·
`voice.skill_queue_upsert/list/assign_agent` · `voice.call_center_routing_snapshot*` ·
`voice.call_center_ops_overview` · `voice.media_storage_policy_*` ·
`voice.recording_retention_plan` · `voice.media_ops_overview` ·
`voice.runtime_deployment_snapshot_*` · `voice.runtime_credential_rotate` ·
`voice.ingest_call_result` · `voice.rustpbx_create_call_session` ·
`voice.rustpbx_ingest_event` · `voice.webrtc_create_session` ·
`voice.webrtc_signal` · `voice.test_sip_route` · `voice.queue_call_for_approval`

这些是 voice 模块对外的稳定接口面，抽取时应作为包的 public API。

## 抽取策略

**目标形态**：自包含 npm 包（`@converact/voice`），不是独立微服务。
别的项目 `import { createVoiceModule } from '@converact/voice'` 即可用，需要时再独立部署成服务。

**理由**：呼叫中心是实时系统，跨进程调用是延迟杀手。库化优先于服务化，只有当独立扩缩容/部署需求真出现时才升级成独立服务。

## 抽取步骤（将来执行时照做）

### 阶段 0：解双向耦合（前置，必做）

1. 把 `call-center/types.ts` 里 voice 用到的类型抽到 `voice/types.ts`（或共享 types 包）
2. 把 `call-center/dialer-wait-registry.ts` 抽到 `voice/dialer-wait-registry.ts`
3. 把 `call-center/voice-agent-*.ts`（6 文件）移到 `voice/agent/` 下——它们是 voice 的编排逻辑，放 call-center 是历史遗留
4. 验证：`voice/` 不再 import `call-center/` 任何东西，依赖变单向（call-center → voice）

### 阶段 1：包化

1. 建 `packages/voice/`，把 `voice/` + `livekit/` + `voice-tools.ts` 移入
2. `package.json` 声明依赖：`livekit-server-sdk`、共享 db 接口（注入而非直接 import）
3. db 访问改依赖注入：voice 模块接收 `db` 参数，不直接 `import '../db.ts'`
4. 导出 public API：`createVoiceModule(db, config) => { tools, store, livekit, dispatch }`

### 阶段 2：Converact Platform 接入包

1. Converact Platform 的 `createHarness` 改为 `import { createVoiceModule } from '@converact/voice'`
2. `registerVoiceTools` 改为调包的注册函数
3. schema 里 14 张 voice 表的 migration 跟着包走

### 阶段 3：别的项目复用

1. 新项目 `npm i @converact/voice`（或 git submodule）
2. 提供自己的 db + config
3. 按需用 voice.tools / livekit.token / dispatch

## 现在不用做，但开发时注意

> **原则：别让 voice/livekit 往 Converact Platform 核心里长新依赖。**

新功能碰 voice 时：
- ✅ 让 call-center 依赖 voice 的接口（单向）
- ❌ 别让 voice 反向依赖 call-center 的新东西
- ✅ 新的 voice 相关类型放 `voice/types.ts`，别塞 `call-center/types.ts`
- ✅ voice 的 DB 表继续用 `voice_*` 前缀，别和 platform 表混

守住这条线，将来抽取时阶段 0 的工作量会随时间自动变小。

---

## 变更记录

| 日期 | 作者 | 变更内容 |
|------|------|---------|
| 2026-06-24 | - | 初始备忘（12 张 voice 表、`.js` 依赖名） |
| 2026-06-29 | Converact Platform Team | 按 `docs/design/README.md` §4 准绳：(1) voice DB 表 12→14（新增 `voice_webrtc_sessions` / `voice_webrtc_signals`，对齐 `src/schema.sql` 实测与 `product-direction-2026-06.md` §3.1）；(2) 依赖文件名 `.js`→`.ts`（5 处）；(3) 头部加 `<关联文档>` block 与重扫校准段。未实施状态不变。 |
