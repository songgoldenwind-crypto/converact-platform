# iveKit Voice Foundation V1 详细设计

> 状态：M2 Voice Core、M3 IVR Runtime、Voice SDK/headless controller、React Voice 控制工作台代码完成，M4 Contact Center 已完成领域模型、PostgreSQL schema/store、配置服务/API、原子排队分配服务与 IVR queue adapter，受控 PostgreSQL/RustPBX 协议验收通过；Contact Center worker/callback/supervisor/SDK/UI、浏览器 SIP/WebRTC 媒体接入和真实通信环境验收未完成
> 日期：2026-07-13
> 目标仓库：`opc-platform`
> 实现分支：`codex/ivekit-v4-voice-foundation`
> 适用消费者：OPC、LED 及后续独立业务系统

## 0. 当前实现状态

本节是代码事实口径，优先级高于本文后续仍保留的目标设计。2026-07-13 的当前状态如下：

| 范围 | 状态 | 证据边界 |
| --- | --- | --- |
| Voice Core domain、PostgreSQL store、RLS、号码加密/HMAC | 已实现 | fresh migration、旧库 upgrade、跨租户不可见和真实 PostgreSQL 受控验收通过 |
| profile/capability、trunk、DID、extension、route desired state | 已实现 | apply/test durable command、revision 收敛、过期 lease 接管和 superseded command 测试通过；apply 结果不明时不重复下发，超过对账窗口终止为 `provider_result_unknown` |
| 外呼、provider event、CDR、录音、策略和 consent | 已实现 | dialing/ringing/active/held/transferring/completed、重复/乱序事件和 recording metadata 受控验收通过 |
| RustPBX Management/AMI、Router、RWI v1 adapter | 已实现协议边界 | 本仓库受控 provider 通过；真实 RustPBX 仍为 `not_run` |
| PSTN 到 LiveKit SIP bridge orchestration | 已实现 | 注入受控 `SipClient`、超时后 participant lookup 对账且不重复创建通过；真实 LiveKit SIP/PSTN 为 `not_run` |
| standalone Voice 镜像与部署材料 | 已实现静态交付 | 隔离 source graph/build、三个编译入口、Compose merge、Helm/交付清单测试通过；真实容器和 RustPBX 数据面启动仍为 `not_run` |
| IVR Runtime | 已实现 | 25 节点执行器、资源门禁、发布/回滚、模拟器、耐久 session/action、Step IVR、worker/reconciliation 和提交后事件通过单元及真实 PostgreSQL 受控验收 |
| Voice SDK/headless WebPhone controller | 已实现控制面 | `@opc/ivekit-sdk` 覆盖全部公开 Voice API；controller 覆盖呼叫动作、状态订阅、分机 session plan 和模糊失败幂等重试，不等于浏览器 SIP/WebRTC 媒体已联通 |
| React Voice 控制工作台 | 已实现控制面 | 参考客户端提供独立懒加载工作区、`voice_call_id` 深链、呼入/外呼、状态门禁控制、DTMF、转接、会议、Park/Pickup、录音、LiveKit bridge 和分机 session readiness；不渲染 session credential |
| Contact Center Kit | 部分实现 | 通用状态机、容量门禁、四种确定性 ACD 排序、`052_ivekit_contact_center.sql`、tenant-scoped PostgreSQL store、Agent/Skill/Presence/Queue/Membership 配置 API、原子 enqueue/offer/accept/reject/connect/complete/expire 服务和 IVR queue adapter 已实现；queue maintenance worker、callback/supervisor、SDK 与 Queue Monitor 尚未完成 |
| 浏览器 SIP/WebRTC 媒体接入 | 未实现 | 属于 M5；不得从已有 OPC call-center 页面、控制工作台或 headless controller 推断真实软电话媒体已交付 |

当前新增迁移为：

- `046_ivekit_voice_foundation.sql`：Voice Core 权威表、RLS、号码密文和基础约束。
- `047_ivekit_ivr_foundation.sql`：IVR foundation 表和边界占位，不等于完整 IVR Runtime。
- `048_ivekit_voice_operations.sql`：configuration command、worker claim/lease、route operation 等运行闭环。
- `049_ivekit_voice_route_deployment.sql`：已发布 route payload 不可变，单独允许 deployment state/provider revision 单向收敛。
- `050_ivekit_ivr_runtime.sql`：IVR durable session、step、pending action、lease 和恢复状态。
- `051_ivekit_ivr_resources.sql`：IVR 音频、时段、区域、振铃组和 runtime settings 权威表。
- `052_ivekit_contact_center.sql`：Contact Center Agent、Presence、Skill、Queue、Assignment、Callback 与 Supervisor 权威表。
- `053_ivekit_contact_center_configuration_idempotency.sql`：可升级的配置创建幂等账本；不回写已经发布的 052。

受控验收入口为 `scripts/ivekit-controlled-voice-provider.ts`、`test/ivekit-controlled-voice-provider.test.ts`、`test/ivekit-voice-controlled-postgres.test.ts` 和 `scripts/verify-ivekit-postgres.sh`。这些结果只能标记为 `controlled`；真实 RustPBX、真实 SIP trunk/DID/PSTN、真实 RTP/录音、真实 LiveKit SIP 和软电话浏览器均保持 `not_run`。

## 1. 目标

在现有 iveKit Media、IM、Remote、Intelligence 之上增加可独立部署和版本化的语音呼叫底座。V1 必须把现有 RustPBX、Voice、IVR 和通用联络中心能力从 OPC 产品代码中解耦，同时保留 OPC 现有行为。

最终交付形态不是把 RustPBX 嵌入 Node.js 进程，也不是复制整个 OPC call-center，而是：

1. RustPBX、LiveKit SIP 和可选 Active Call/LiveKit Agents 继续作为独立数据面进程。
2. iveKit 提供统一语音控制面、PostgreSQL 权威状态、业务绑定、权限、审计和 SDK。
3. Voice Core 与 IVR Runtime 为必选模块。
4. ACD、队列、坐席和班长控制作为可选 Contact Center Kit。
5. OPC 和 LED 只通过稳定 API、SDK、事件与 UI 接入面使用语音能力。

## 2. 非目标

以下能力不进入共享 Voice Foundation V1：

- OPC Lead、CRM、获客、销售线索评分和营销业务流。
- OPC 特有的 Campaign 运营页面与营销名单管理。
- Stripe SaaS 订阅计费、WFM 排班和 OPC 白标产品逻辑。
- LED 设备、门店、工单和售后业务表。
- 在 iveKit 数据库保存 SIP trunk、分机、对象存储或 Provider 明文密钥。
- 用受控测试冒充真实运营商、真实号码、真实桌面软电话或生产网络验收。
- 在第一阶段重写 RustPBX、LiveKit SIP 或现有 IVR 执行器。

通用预测拨号、运营商话费核算和 WFM 可以在后续作为独立扩展设计，不能阻塞 Voice Core 和 IVR 的可复用闭环。

## 3. 当前资产审计

### 3.1 已有能力

当前基线已经包含：

- 60 个 `src/agent-runtime/ivr/` 文件。
- 75 个 IVR 专项测试。
- 25 种后端 IVR 节点：`start`、`play`、`menu`、`collect`、`set_var`、`condition`、`time_condition`、`queue`、`http`、`transfer`、`voicemail`、`sip`、`disconnect`、`flush_audio`、`ai_dialogue`、`intent`、`knowledge_qa`、`avatar_switch`、`compliance`、`video_play`、`screen_share`、`visual_menu`、`subflow`、`recording`、`webhook`。
- Step IVR adapter、RWI bridge、Audio Queue、Barge-in、DTMF、语音菜单、流程模拟、发布校验和可视化设计器。
- RustPBX call router、CDR receiver、RWI client、呼入 ACD、队列、坐席、转接、会议、Park/Pickup、语音信箱和录音能力。
- 15 张 `voice_*`/`tenant_voice_*` 历史基础表，以及 IVR session、step、settings、history 等迁移。
- Voice、IVR、LiveKit 和 RustPBX 的大量单元与受控集成测试。

### 3.2 必须关闭的结构问题

1. 至少 7 个 IVR 文件直接 import `call-center` 实现，包括 ACD、坐席、转接、知识库、Egress、RWI 和 outbound session lookup。
2. 至少 16 个 Voice、LiveKit、IVR 文件直接 import `db.ts` 或旧 migration bootstrap。
3. `ivr-runtime-schema.ts` 同时包含 SQLite DDL、PostgreSQL 探测和运行时 ALTER，不能进入独立生产运行图。
4. `/api/voice/*` 仍通过 query/body 接收 `tenant_id`，并依赖 OPC `harness.toolExecutor`，不满足 iveKit Bearer 身份权威和独立进程边界。
5. `voice_call_sessions` 等历史表仍含 `lead_id`、`customer_id`、`workspace_id` 和 TEXT JSON 等 OPC/SQLite 语义，不能直接成为 standalone 权威模型。
6. 当前 Voice 状态与 `ivekit_media_calls`、collaboration session、录制 evidence 之间没有统一资源绑定合同。
7. RustPBX 早期 community 镜像的 RWI 能力与当前官方能力存在版本漂移，不能把单一 RWI 路径写死为生产前提。
8. 旧抽取备忘录以 `@opc/voice` 进程内包为目标，已不符合 iveKit standalone 服务和双项目独立升级方向。

## 4. 核心架构决策

### 4.1 同一 iveKit 产品，不新建第二套 Voice 服务产品

Voice Core 进入 iveKit 控制面，原因如下：

- IM、视频、远控和电话必须共享 tenant、business reference、参与人、事件、审计和 evidence。
- OPC 与 LED 不应同时集成两套认证、两套 WebSocket、两套 SDK 和两套存储策略。
- RustPBX 和 LiveKit SIP 已经提供独立扩缩容边界，Node.js 控制面无需再按功能拆成更多网络服务。

代码内部仍保持深模块边界，Voice、IVR、Contact Center 之间只通过公开 port 通信。

### 4.2 PostgreSQL-only 生产权威状态

- iveKit standalone 的 Voice/IVR 生产运行只支持 PostgreSQL。
- 单元测试可以使用实现相同 port 的内存 fake，但不能把 SQLite DDL 打入 standalone source graph。
- RustPBX 自身数据库使用独立 PostgreSQL database/schema，不与 iveKit runtime role 混用。
- 可以共用 PostgreSQL 集群，但必须使用不同 database、role、migration ledger 和备份策略。
- Redis 只负责短时 presence、事件加速、分布式锁或 Provider 内部需要，不作为呼叫生命周期权威来源。

### 4.3 数据面能力协商，不猜版本

每个 RustPBX deployment profile 必须通过 preflight 产生能力快照：

- `management_http`
- `json_rpc_routing`
- `step_ivr`
- `rwi`
- `webrtc_extension`
- `recording`
- `sipflow`
- `queue`
- `postgres_backend`

路由和操作只能调用快照声明为 available 的能力。RWI 不可用时不得伪造成功；Step IVR 是 IVR 的确定性兼容路径，RWI 是可选实时增强路径。

### 4.4 OPC/LED 业务只通过 business reference 绑定

共享底座不知道 lead、order、device 或 ticket 的内部表。所有资源统一使用：

```text
tenant_id
business_ref_type
business_ref_id
```

消费者可以使用 `lead`、`order`、`ticket`、`device_service` 等值，但 iveKit 只做格式、权限和一致性校验，不查询消费者业务数据库。

## 5. 目标运行拓扑

```text
OPC / LED
  |
  | @opc/ivekit-sdk, React integration, Webhook
  v
iveKit Control Plane
  |- Shared Kernel
  |    tenant, auth, business_ref, durable events, audit, evidence
  |- Voice Core
  |    calls, trunks, DID, extensions, recording, provider control
  |- IVR Runtime
  |    flow, session, action, side-effect ports, Step IVR/RWI adapters
  |- Contact Center Kit (optional)
  |    queue, ACD, presence, skill, callback, supervisor control
  |- Existing Media / IM / Remote / Intelligence
  |
  +--> PostgreSQL: ivekit database
  +--> Redis
  +--> S3/MinIO
  |
  +--> RustPBX: SIP/PBX/RTP/CDR/SipFlow
  +--> LiveKit SIP: PSTN to LiveKit room bridge
  +--> Active Call or LiveKit Agents: optional realtime voice AI
```

RustPBX、LiveKit SIP、Active Call 和 iveKit 使用独立 service account、网络策略、健康检查和资源限制。

## 6. 模块边界

### 6.1 Shared Kernel

复用现有 iveKit 能力：

- Bearer 认证和 request-scoped tenant PostgreSQL transaction。
- `business_ref` 资源绑定。
- durable tenant event replay。
- evidence timeline。
- object storage resolver。
- secret ref 和 deployment profile 规则。
- idempotency key、cursor、结构化错误和审计字段规则。

Voice/IVR 不允许复制这些能力。

### 6.2 Voice Core

Voice Core 负责：

- RustPBX deployment profile 与 capability snapshot。
- trunk、DID、extension 和 route desired state。
- 呼入/外呼 call lifecycle。
- provider call id、SIP dialog id、LiveKit room/call 的稳定映射。
- DTMF、接听、挂断、Hold/Resume、转接、会议、Park/Pickup 等控制命令。
- CDR、录音、同意、保留、导出和 evidence。
- WebRTC softphone join/config，不代理长时媒体字节。
- PSTN 与 LiveKit SIP 的 bridge orchestration。

Voice Core 不负责：

- 业务名单来源。
- CRM writeback。
- 营销节奏。
- IVR 图执行。
- ACD 选座算法。

### 6.3 IVR Runtime

IVR Runtime 只依赖以下 ports：

```typescript
interface IvrFlowRepository {}
interface IvrSessionRepository {}
interface IvrAudioResolver {}
interface IvrCallControlPort {}
interface IvrQueuePort {}
interface IvrKnowledgePort {}
interface IvrRealtimeAiPort {}
interface IvrRecordingPort {}
interface IvrWebhookPort {}
interface IvrClock {}
```

执行器不得 import `call-center/*`、`db.ts`、OPC harness 或消费者业务模块。Contact Center、Knowledge、LiveKit、RustPBX 都通过 port adapter 注入。

### 6.4 Contact Center Kit

可选模块负责：

- agent presence、skill、capacity。
- queue、membership、优先级和 overflow。
- ACD 分配、排队位置、预估等待和回呼。
- 盲转、暖转、会议、Park/Pickup 的坐席策略。
- supervisor 监听、耳语、强插和强制断开授权。
- 通用 wallboard projection。

Contact Center Kit 可以依赖 Voice Core，Voice Core 不得反向依赖 Contact Center Kit。IVR 的 queue 节点只调用 `IvrQueuePort`。

### 6.5 Realtime Voice AI Port

V1 定义稳定 port 和受控 adapter，允许以下实现：

- Active Call。
- LiveKit Agents。
- 自建 streaming ASR + LLM + TTS pipeline。
- 第三方实时语音 Provider。

统一能力包括 VAD、streaming ASR、streaming TTS、打断、DTMF、tool call、延迟指标和 transcript event。具体模型和厂商继续由 deployment profile 决定。

最小运行合同：

```typescript
interface RealtimeVoiceAiPort {
  capabilities(profileId: string): Promise<RealtimeVoiceAiCapabilities>;
  startSession(input: {
    tenantId: string;
    callId: string;
    profileId: string;
    language: string;
    tools: ReadonlyArray<PublishedToolRef>;
    idempotencyKey: string;
  }): Promise<{ providerSessionId: string }>;
  sendDtmf(sessionId: string, digits: string): Promise<void>;
  interrupt(sessionId: string, reason: string): Promise<void>;
  endSession(sessionId: string, reason: string): Promise<void>;
}
```

ASR/TTS/LLM 流量不经过普通 HTTP request 生命周期持久化；控制面只保存授权后的 transcript projection、tool call、延迟指标和 evidence ref。需要字幕翻译时，transcript event 调用现有 Intelligence Translation port，不在 Voice 中复制翻译引擎。未经策略允许不得默认保存原始音频或完整提示词。

## 7. 建议代码布局

```text
src/agent-runtime/ivekit/
  voice/
    application.ts
    types.ts
    ports.ts
    call-service.ts
    recording-service.ts
    deployment-profile.ts
    capability-service.ts
    workers/
      command-worker.ts
      provider-event-worker.ts
      reconciliation-worker.ts
    http.ts
    events.ts
    postgres/
      call-store.ts
      configuration-store.ts
      recording-store.ts
    adapters/
      rustpbx-management.ts
      rustpbx-routing.ts
      rustpbx-rwi.ts
      livekit-sip.ts
      controlled-voice-provider.ts
  ivr/
    types.ts
    ports.ts
    executor.ts
    validation.ts
    workers/
      pending-action-worker.ts
    http.ts
    postgres/
      flow-store.ts
      session-store.ts
    adapters/
      step-ivr.ts
      rwi.ts
      voice-call-control.ts
  contact-center/
    ports.ts
    presence-store.ts
    queue-store.ts
    acd-service.ts
    supervisor-service.ts
    http.ts
  compatibility/
    opc-voice-http.ts
    opc-ivr-http.ts
    opc-importer.ts
```

现有文件先通过兼容 re-export 和 adapter 迁移，不能一次性移动 60 个 IVR 文件造成不可审查 diff。

## 8. 数据模型

### 8.1 表归属原则

V3 standalone 验收明确排除 `voice_call_sessions`、`ivr_flows` 等 OPC 历史表。V4 继续保持这个边界：

- `voice_*`、`tenant_voice_*`、`ivr_*` 和 `audio_library` 历史表只作为 OPC migration importer 的读取来源。
- 新的生产权威表统一使用 `ivekit_voice_*`、`ivekit_ivr_*`；可选联络中心表使用 `ivekit_cc_*`。
- 新 application service 不双写旧表；OPC compatibility adapter 读取新 DTO，并在迁移窗口内保留旧字段映射。
- standalone migration 不能复制 `005_full_schema.sql`、`007_ivr_runtime_tables.sql` 或运行时 SQLite DDL。
- `ivekit_voice_calls` 只描述 SIP/PSTN 呼叫；需要视频、屏幕共享或 LiveKit 房间时，通过 `media_call_id` 关联现有 `ivekit_media_calls`。

### 8.2 Voice Core 权威表

| 表 | 作用 |
| --- | --- |
| `ivekit_voice_deployment_profiles` | 非秘密 Provider 配置、adapter 类型、desired version、启用状态 |
| `ivekit_voice_capability_snapshots` | preflight 能力、上游版本、探测时间、粗粒度错误和配置 hash |
| `ivekit_voice_sip_trunks` | trunk desired state、方向、codec、并发限制和 credential secret ref |
| `ivekit_voice_dids` | 号码归属、入口 route、trunk 和状态；号码使用密文、HMAC lookup 和脱敏 projection |
| `ivekit_voice_extensions` | 分机 desired state、identity、权限、WebRTC 能力和 credential ref |
| `ivekit_voice_routes` | route identity、draft revision、启用状态 |
| `ivekit_voice_route_versions` | 不可变已发布条件、动作、hash 和 deployment result |
| `ivekit_voice_calls` | 通用 business reference、方向、状态、号码 projection、provider/媒体映射和时间线 |
| `ivekit_voice_call_participants` | SIP、PSTN、WebRTC、LiveKit、AI 和坐席参与人及其状态 |
| `ivekit_voice_call_commands` | durable control command、幂等、lease、attempt、uncertain 和最终结果 |
| `ivekit_voice_provider_events` | 去重后的标准化 provider event、canonical hash、处理状态和安全原始摘要 |
| `ivekit_voice_livekit_bridges` | call、SIP participant、LiveKit media call/room 和 bridge 终态映射 |
| `ivekit_voice_recordings` | 录音生命周期、对象存储 ref、时长、同意、保留和 evidence ref |
| `ivekit_voice_consents` | 通用 subject/business reference 的外呼、录音和 AI 披露同意证据 |
| `ivekit_voice_policies` | 租户外呼、录音、披露、保留和号码脱敏策略 |
| `ivekit_voice_webrtc_sessions` | 短期 softphone 会话、extension、token hash、能力和过期时间 |

`ivekit_voice_calls` 至少包含：`tenant_id`、`business_ref_type`、`business_ref_id`、`provider_profile_id`、`provider_call_id`、`provider_dialog_id`、`media_call_id`、`direction`、`state`、加密的 from/to address、address HMAC、脱敏 projection、`idempotency_key`、`ringing_at`、`answered_at`、`ended_at`、`termination_reason`、`revision` 和审计时间。密钥由外部 KMS/secret ref 提供，数据库不保存解密密钥。

### 8.3 IVR Runtime 权威表

| 表 | 作用 |
| --- | --- |
| `ivekit_ivr_flows` | flow identity、名称、draft revision、当前 published version、状态 |
| `ivekit_ivr_flow_versions` | 不可变 graph JSONB、schema version、SHA-256、依赖快照和发布者 |
| `ivekit_ivr_sessions` | call、flow version、上下文、当前节点、revision、等待原因和终态 |
| `ivekit_ivr_session_steps` | 不可变节点输入、输出、branch、耗时和错误摘要 |
| `ivekit_ivr_pending_actions` | 外部副作用、幂等、lease、attempt、Provider ref 和恢复状态 |
| `ivekit_ivr_audio_assets` | 对象存储 ref、TTS source、语言、duration、checksum 和可见范围 |
| `ivekit_ivr_time_groups` | 时区、日历、营业时间和节假日规则 |
| `ivekit_ivr_region_groups` | 规范化区域匹配集合 |
| `ivekit_ivr_ring_groups` | 通用成员 identity、策略和超时；不引用 OPC seat 表 |
| `ivekit_ivr_settings` | 租户级执行上限、默认语言、超时和安全策略 |

### 8.4 可选 Contact Center 表

Contact Center migration pack 与 runtime profile 可单独启用：

- `ivekit_cc_agents`
- `ivekit_cc_agent_presence`
- `ivekit_cc_skills`
- `ivekit_cc_agent_skills`
- `ivekit_cc_queues`
- `ivekit_cc_queue_memberships`
- `ivekit_cc_queue_entries`
- `ivekit_cc_assignments`
- `ivekit_cc_callbacks`
- `ivekit_cc_supervisor_actions`

这些表只使用 iveKit identity、call id 和 business reference，不保存 OPC 用户、lead、campaign 或 workspace 外键。

### 8.5 旧表导入映射

| 旧来源 | 新目标 | 迁移规则 |
| --- | --- | --- |
| `voice_call_sessions`、`voice_call_logs` | `ivekit_voice_calls`、commands/events | `lead_id/customer_id` 映射为 business reference；TEXT JSON 解析失败进入 rejection report |
| `voice_call_consents`、`tenant_voice_policies` | `ivekit_voice_consents`、`ivekit_voice_policies` | `subject_type=lead/customer` 只保留为字符串 reference，不建消费者外键 |
| `voice_recordings` | `ivekit_voice_recordings` | URL 转 object storage ref；无法确认对象时标为 `external_unverified` |
| presence、queue、membership、routing 历史表 | `ivekit_cc_*` | 仅在启用 Contact Center Kit 时导入，workspace 转 metadata 或 consumer scope ref |
| `voice_agent_specs` 中带 `entryNodeId` 的 graph 与 `ivr_flow_history` | `ivekit_ivr_flows`、`ivekit_ivr_flow_versions` | 校验 graph、计算 hash、保留原 version；非法 graph 拒绝导入 |
| `ivr_sessions`、`ivr_session_steps` | 不迁移活动执行 | 历史只导出审计；切换前排空或终止旧 session，避免跨执行器续跑 |
| `audio_library`、时间/区域/组呼设置 | 对应 `ivekit_ivr_*` | 校验 tenant、对象存储、identity 和 JSON 后导入 |

importer 是离线工具，使用独立只读 source DSN 和 target migration role，不进入 standalone runtime source graph。它必须支持 dry-run、计数核对、逐行 rejection report、重复执行和 source checksum；禁止通过数据库 trigger 双写新旧模型。

### 8.6 PostgreSQL 约束

- 所有 tenant 表启用并 FORCE RLS。
- `opc_runtime` 保持 `NOSUPERUSER`、`NOBYPASSRLS`、无 schema CREATE 权限。
- migration runner 使用独立 admin role。
- 时间统一使用 `TIMESTAMPTZ`。
- JSON 使用 `JSONB`，不继续新增 TEXT JSON。
- Provider idempotency 使用 tenant + profile + external id 唯一约束。
- command claim 使用 `FOR UPDATE SKIP LOCKED` 和 lease。
- 已发布 IVR graph 不可原地修改。
- Voice/IVR migration 只允许追加新 migration；已发布 SQL 由 checksum ledger 防篡改。

## 9. 呼叫状态机

统一状态：

```text
planned
  -> queued
  -> dialing
  -> ringing
  -> active
  -> held
  -> transferring
  -> completed

planned/queued/dialing/ringing
  -> cancelled | missed | rejected | failed | timed_out

active/held/transferring
  -> completed | failed
```

规则：

- provider webhook、CDR、控制命令和客户端刷新都必须收敛到同一状态机。
- 终态不能回到非终态。
- 重复 provider event 通过 provider event id 或 canonical payload hash 去重。
- API 请求超时不等于命令失败；未知结果进入 `uncertain` command 状态并由 reconciliation worker 查询。
- CDR 可以补全 duration、termination reason 和 recording，但不能复活已结束 call。
- call、IVR session、recording 和 bridge 结束必须按稳定顺序收敛。

## 10. RustPBX adapter 合同

### 10.1 Management Port

- health/version。
- trunk list/apply/test。
- DID/extension desired state apply。
- route evaluate/reload。
- active dialog lookup。
- recording/CDR reconciliation。

### 10.2 Routing Port

RustPBX 发起呼叫路由请求时，iveKit 返回严格动作：

```text
reject
forward_sip
start_ivr
enqueue
bridge_livekit
voicemail
```

路由请求必须通过签名或专用 service token，tenant 由已验证 DID/trunk/profile 映射得出，不能相信来电方自带 `X-Tenant-Id`。

### 10.3 Step IVR Port

- RustPBX session id 与 iveKit call/IVR session 一一绑定。
- event 序号和 action revision 防止重放或乱序。
- adapter 把 iveKit action 映射为 RustPBX 支持的 prompt、DTMF、queue、transfer 和 hangup。
- 不支持的 action 返回明确能力错误，不静默降级成成功。

### 10.4 RWI Port

- preflight 确认 endpoint、认证、协议版本和命令集合。
- 支持时用于低延迟控制、Audio Queue、打断和事件。
- 不支持时 `rwi=not_available`，调用方选择 Step IVR 或失败，不伪造执行。
- 每个 command 使用稳定 idempotency key 并写 `ivekit_voice_call_commands`。

M2 实现严格使用官方 RWI v1 envelope：请求为 `{action, action_id, params}`，完成事件兼容官方 `{type, action_id, data}`，呼叫状态事件使用 `event=call_state_change`、`event_id`、`call_id` 和 `state`。当前映射如下：

| iveKit command | RWI action | M2 状态 |
| --- | --- | --- |
| `originate` | `call.originate` | 已实现，timeout 进入 `uncertain` 并用 AMI dialog lookup 对账 |
| `answer` / `hangup` | `call.answer` / `call.hangup` | 已实现 |
| `hold` / `resume` | `call.hold` / `call.unhold` | 已实现 |
| `blind_transfer` | `call.transfer` | 已实现 |
| `warm_transfer` | `call.transfer.attended` | 已实现协议映射；真实 RustPBX 行为未验证 |
| `conference` | `conference.add` | 已实现协议映射；会议生命周期和真实多方媒体未验证 |
| `recording_start/pause/resume/stop` | `record.start/pause/resume/stop` | 已实现协议映射；真实录音文件链路未验证 |
| `dtmf` / `park` / `pickup` | 无已确认的官方可执行 RWI action | 明确返回 `capability_unavailable`，不伪造成功 |
| `livekit_bridge_create` | 不走 RustPBX RWI | 使用独立 LiveKit SIP adapter |

因此，DTMF、Park、Pickup 虽已进入通用 command type 和 API 校验面，但当前 RustPBX adapter 不具备可执行实现。Audio Queue、Barge-in、supervisor whisper/barge 和完整会议控制也不属于 M2 已完成能力，需在 M3/M4 基于实际 Provider capability 落地。

## 11. IVR 设计

### 11.1 Graph 版本

- draft 可编辑。
- publish 产生不可变 version 和 SHA-256。
- session 启动后绑定 version，不跟随 draft 变化。
- rollback 创建新 version 指向历史 graph，不覆盖历史记录。
- 后端和前端使用同一 `shared/ivr` graph schema 与 validation policy。

### 11.2 执行模型

- 纯节点计算保持无副作用。
- 外部动作全部通过 port。
- 每次 advance 使用 session revision 乐观锁。
- 每一步写不可变 `ivr_session_steps`。
- pending external action 写 durable state，进程重启后可恢复或 reconciliation。
- 超时、错误、取消和 branch miss 必须有明确结果。

### 11.3 发布门禁

发布必须拒绝：

- 无唯一 start。
- 无可达终态。
- 必需 edge 缺失。
- 目标 node 不存在。
- 非法循环或超过执行上限。
- 引用不存在或未授权的 queue、audio、subflow、knowledge profile、AI profile。
- 需要 Provider capability 但 deployment profile 未声明。
- secret、完整电话号码或 Authorization 出现在 graph。

### 11.4 视频升级

`avatar_switch`、`video_play`、`screen_share` 和 `visual_menu` 通过现有 Media Core port 实现。IVR 不直接 import LiveKit SDK。

### 11.5 25 种节点的执行归属

| 节点 | 执行归属 | 外部依赖/要求 |
| --- | --- | --- |
| `start`、`set_var`、`condition`、`time_condition`、`disconnect` | IVR 纯执行器 | graph/context/clock；`disconnect` 最终通过 call control 挂断 |
| `play`、`menu`、`collect`、`flush_audio` | IVR + audio/call control port | audio asset、DTMF/ASR、Step IVR 或 RWI capability |
| `http`、`webhook` | Webhook port | allowlist、secret ref、timeout、响应 schema 和 durable pending action |
| `subflow` | IVR flow repository | 发布版本固定、递归深度和循环限制 |
| `queue` | `IvrQueuePort` | Contact Center Kit 可用；不可用时发布失败或走图中显式 fallback |
| `transfer`、`sip` | Voice call control port | transfer/SIP route capability、目标权限和号码策略 |
| `voicemail` | Voice recording + notification port | 对象存储、录音策略、通知 webhook |
| `recording`、`compliance` | Voice policy/recording port | consent、AI disclosure、PCI pause/resume 和 evidence |
| `intent`、`knowledge_qa`、`ai_dialogue` | Knowledge/Realtime AI port | profile capability、超时、内容策略和显式错误分支 |
| `avatar_switch`、`video_play`、`screen_share`、`visual_menu` | Media Core port | 已绑定 `media_call_id`、参与人授权和相应 Media capability |

节点 adapter 缺失时不得返回伪成功。发布器根据 deployment profile 和启用模块生成依赖清单；执行期能力发生变化时，进入图中明确的 error/fallback edge，否则终止为 `capability_unavailable`。

## 12. HTTP API

所有新稳定端点使用 `/api/ivekit/*`，旧 `/api/voice/*`、`/api/ivr/*` 和 call-center 路由仅作为 OPC compatibility adapter。

### 12.1 Voice

以下是 `src/agent-runtime/ivekit/voice/http.ts` 当前已经注册的路径，不是目标草案：

| Method | Path | 用途 |
| --- | --- | --- |
| `GET` | `/api/ivekit/voice/capabilities` | 返回租户可用模块和 deployment capability 摘要 |
| `GET` / `POST` | `/api/ivekit/voice/profiles` | 管理 Provider profile；创建只保存 `env://` secret ref |
| `GET` / `PATCH` | `/api/ivekit/voice/profiles/:id` | 查看或按 revision 更新 profile |
| `POST` | `/api/ivekit/voice/profiles/:id/preflight` | 执行探测并持久化 capability snapshot |
| `GET` / `POST` | `/api/ivekit/voice/trunks` | 查询或创建 trunk desired state |
| `GET` / `PATCH` | `/api/ivekit/voice/trunks/:id` | 查看或按 revision 更新 trunk |
| `POST` | `/api/ivekit/voice/trunks/:id/apply` | 入队幂等 apply command |
| `POST` | `/api/ivekit/voice/trunks/:id/test` | 执行不产生真实收费呼叫的配置测试 |
| `GET` / `POST` | `/api/ivekit/voice/dids` | 查询或登记 DID |
| `GET` / `PATCH` | `/api/ivekit/voice/dids/:id` | 查看或更新 DID 与入口 route |
| `POST` | `/api/ivekit/voice/dids/:id/apply` | 解密号码仅到 Provider 边界并入队 apply command |
| `GET` / `POST` | `/api/ivekit/voice/extensions` | 查询或创建分机 |
| `GET` / `PATCH` | `/api/ivekit/voice/extensions/:id` | 查看或更新分机 |
| `POST` | `/api/ivekit/voice/extensions/:id/apply` | 入队分机 apply command |
| `POST` | `/api/ivekit/voice/extensions/:id/session` | 可选注入 extension-session provider；未注入返回 capability error |
| `GET` / `POST` | `/api/ivekit/voice/routes` | 查询或创建 route draft |
| `GET` / `PATCH` | `/api/ivekit/voice/routes/:id` | 查看或按 revision 更新 draft |
| `POST` | `/api/ivekit/voice/routes/:id/validate` | 静态校验并返回 canonical payload hash |
| `GET` | `/api/ivekit/voice/routes/:id/versions` | 查询不可变 route version |
| `POST` | `/api/ivekit/voice/routes/:id/publish` | 创建不可变 version 并入队 apply command |
| `GET` / `POST` | `/api/ivekit/voice/calls` | 查询 call 或发起呼叫意图 |
| `GET` | `/api/ivekit/voice/calls/:id` | 返回 call 权威状态 |
| `POST` | `/api/ivekit/voice/calls/:id/actions` | 入队通用 call command；Provider 不支持的动作明确失败 |
| `GET` | `/api/ivekit/voice/calls/:id/events` | 按 cursor 查询标准化事件 |
| `GET` | `/api/ivekit/voice/calls/:id/recordings` | 查询录音和 evidence 状态 |
| `GET` | `/api/ivekit/voice/calls/:id/bridges` | 查询 call 的 LiveKit SIP bridge |
| `GET` | `/api/ivekit/voice/calls/:id/participants` | 查询参与人 |
| `POST` | `/api/ivekit/voice/calls/:id/livekit-bridge` | 入队幂等 PSTN 到 LiveKit SIP bridge command |
| `GET` / `PATCH` | `/api/ivekit/voice/policy` | 查询或按 revision 更新租户语音策略 |
| `GET` / `POST` | `/api/ivekit/voice/consents` | 查询或登记外呼、录音和 AI 披露同意 |
| `GET` | `/api/ivekit/voice/recordings` | 按 call、状态和 cursor 查询 |
| `POST` | `/api/ivekit/voice/providers/:profileId/router` | RustPBX 路由决策入口 |
| `POST` | `/api/ivekit/voice/providers/:profileId/events` | RustPBX HTTP 事件入口 |
| `POST` | `/api/ivekit/voice/providers/:profileId/cdrs` | CDR/recording reconciliation 入口 |

写操作按角色分为 admin/operator，tenant 只来自认证上下文；trunk apply/test、DID/extension apply、route publish、call create/action/bridge 都要求 `Idempotency-Key`。`@opc/ivekit-sdk` 已覆盖本节全部公开控制面，Provider webhook 仍仅供服务端使用。当前仍没有注册 recording export、retention-run 或机器可读 OpenAPI 产物，不能按未注册的规划路径调用。

### 12.2 IVR

以下 IVR 控制面现已在 `src/agent-runtime/ivekit/ivr/` 注册，并通过签名租户认证、RBAC、revision、幂等和 PostgreSQL RLS 验收。RustPBX Step 路由使用 deployment profile 绑定的 webhook 鉴权，不接受浏览器 tenant 覆盖。

| Method | Path | 用途 |
| --- | --- | --- |
| `GET` / `POST` | `/api/ivekit/ivr/flows` | 查询或创建 flow draft |
| `GET` / `PATCH` | `/api/ivekit/ivr/flows/:id` | 查看或按 draft revision 更新 graph |
| `GET` | `/api/ivekit/ivr/flows/:id/versions` | 查询不可变版本 |
| `POST` | `/api/ivekit/ivr/flows/:id/validate` | 返回结构、依赖、安全和 capability 报告 |
| `POST` | `/api/ivekit/ivr/flows/:id/publish` | 发布指定 draft revision |
| `POST` | `/api/ivekit/ivr/flows/:id/rollback` | 从历史版本创建并发布新版本 |
| `POST` | `/api/ivekit/ivr/simulations` | 使用虚拟 clock/provider 执行流程模拟 |
| `GET` / `POST` | `/api/ivekit/ivr/sessions` | 查询 session 或以已发布 version 启动 session |
| `GET` | `/api/ivekit/ivr/sessions/:id` | 返回执行位置、等待原因和步骤摘要 |
| `POST` | `/api/ivekit/ivr/sessions/:id/advance` | 受控测试/adapter 推进；要求 event sequence |
| `POST` | `/api/ivekit/ivr/provider-webhooks/rustpbx/:profileId/step` | RustPBX Step IVR 事件与 action 交换 |
| `GET` / `POST` | `/api/ivekit/ivr/audio-assets` | 查询或登记音频/TTS 资产 |
| `GET` / `PATCH` | `/api/ivekit/ivr/audio-assets/:id` | 更新 metadata；已发布引用的 checksum 不可替换 |
| `GET` / `POST` | `/api/ivekit/ivr/time-groups` | 管理时段和节假日规则 |
| `GET` / `PATCH` | `/api/ivekit/ivr/time-groups/:id` | 查看或按 revision 更新时间组 |
| `GET` / `POST` | `/api/ivekit/ivr/region-groups` | 管理区域规则 |
| `GET` / `PATCH` | `/api/ivekit/ivr/region-groups/:id` | 查看或按 revision 更新地区组 |
| `GET` / `POST` | `/api/ivekit/ivr/ring-groups` | 管理通用 identity 组呼 |
| `GET` / `PATCH` | `/api/ivekit/ivr/ring-groups/:id` | 查看或按 revision 更新组呼成员和策略 |
| `GET` / `PATCH` | `/api/ivekit/ivr/settings` | 查询或按 revision 更新执行策略 |

资源发布规则：草稿可暂时引用未就绪资源，但 validate/publish 会检查音频、时间组、地区组、振铃组、子流程、Voice profile/Step capability、Webhook allowlist 以及显式绑定的 queue/knowledge/AI/media capability。任何不可变发布版本引用资源后，checksum、对象引用、TTS 文本、时段、区域和组呼运行字段均禁止原地变更；替换时创建新资源 ID，再发布新的 flow version。显示名称和非敏感 metadata 仍可按 revision 更新。资源和 settings 不保存 Authorization、password、private key、access token 或 secret。

### 12.3 Contact Center

以下路径已在 standalone iveKit 注册；tenant 仅取自认证上下文，配置写操作要求 admin，Presence 要求坐席本人或 admin，分配动作按认证 identity 反查 agent：

| Method | Path | 用途 |
| --- | --- | --- |
| `GET` | `/api/ivekit/contact-center/capabilities` | 返回已实现与待实现能力真值 |
| `GET` / `POST` | `/api/ivekit/contact-center/skills` | 分页查询或创建技能 |
| `GET` / `PATCH` | `/api/ivekit/contact-center/skills/:id` | 查询或按 revision 更新技能 |
| `GET` / `POST` | `/api/ivekit/contact-center/agents` | 分页查询或创建坐席与初始离线 Presence |
| `GET` / `PATCH` | `/api/ivekit/contact-center/agents/:id` | 查询坐席快照或按 revision 更新坐席 |
| `POST` | `/api/ivekit/contact-center/agents/:id/presence` | 上线、离开或下线；活动工作期间禁止降容/下线 |
| `GET` / `PUT` | `/api/ivekit/contact-center/agents/:id/skills` | 查询或整体替换坐席技能熟练度 |
| `GET` / `POST` | `/api/ivekit/contact-center/queues` | 分页查询或创建队列 |
| `GET` / `PATCH` | `/api/ivekit/contact-center/queues/:id` | 查询队列完整配置或按 revision 更新 |
| `GET` / `POST` | `/api/ivekit/contact-center/queues/:id/memberships` | 查询或 upsert 队列成员 |
| `DELETE` | `/api/ivekit/contact-center/queues/:id/memberships/:agentId` | 移除队列成员 |
| `GET` / `PUT` | `/api/ivekit/contact-center/queues/:id/skill-requirements` | 查询或整体替换技能门槛 |
| `POST` | `/api/ivekit/contact-center/routing/assignments` | 使用 Idempotency-Key 原子创建下一次 Offer |
| `POST` | `/api/ivekit/contact-center/assignments/:id/{accept,reject,connect,complete}` | 推进受 agent 绑定的分配状态 |

Skill、Agent、Queue 创建和 routing assignment 创建均要求 `Idempotency-Key`。前三类创建通过 `053_ivekit_contact_center_configuration_idempotency.sql` 的不可变 tenant 账本与 advisory transaction lock 保证同 key 同 payload 重放、同 key 不同 payload 返回 `409 idempotency_conflict`。

以下路径仍是 M4 待实现目标，capabilities 对 callback/supervisor 明确返回 `false`：

- `GET /api/ivekit/contact-center/queues/:id/entries`
- `GET` / `POST` `/api/ivekit/contact-center/callbacks`
- `POST /api/ivekit/contact-center/supervisor/actions`

### 12.4 API 安全规则

- tenant 只来自认证上下文；body/query 中 tenant 仅允许 system-to-system compatibility adapter 使用并必须交叉校验。
- 管理、线路、录音、班长控制使用明确 RBAC。
- RustPBX webhook 使用 deployment profile 绑定的 secret ref 或签名，不复用浏览器 token。
- 所有 list API 使用稳定 cursor 和硬 limit。
- 电话号码默认只返回脱敏值。
- 呼叫恢复需要的完整号码只以 envelope-encrypted address 保存；检索使用 keyed HMAC，解密权限与普通查询权限分离。
- SDP、ICE credential、SIP Authorization、trunk password 不写日志、事件或 DTO。

### 12.5 通用合同

- 创建和有外部副作用的 `POST` 必须携带 `Idempotency-Key`；同 key 不同 payload 返回 `409 idempotency_conflict`。
- draft `PATCH` 必须携带 `If-Match` 或 body revision；过期 revision 返回 `409 revision_conflict`。
- Provider 已接受但结果异步的操作返回 `202` 和 command resource；不能用 HTTP timeout 推断呼叫失败。
- list response 固定为 `{ items, next_cursor }`，cursor 绑定 tenant、filter 和排序。
- 错误固定为 `{ error: { code, message, retryable, request_id, details } }`，`details` 不含 secret 或完整号码。
- 时间使用 RFC 3339 UTC，duration 使用整数毫秒，电话号码写入时使用 E.164 或明确的 extension 类型。
- SDK DTO 只暴露通用 business reference；OPC compatibility DTO 的 `lead_id/customer_id/workspace_id` 不进入稳定 OpenAPI。

## 13. SDK 与前端

`@opc/ivekit-sdk` 当前已交付：

- `voice`：capability、profile、trunk、DID、extension/session plan、route/version、call/action、participant/event/recording、policy/consent 和 LiveKit bridge。
- `ivr`：flow/version、validate/publish/rollback、simulation、durable session、audio/time/region/ring resource 和 settings。
- `createIveKitVoiceController`：框架无关的拨号、接听、挂断、DTMF、Hold/Resume、转接、会议、Park/Pickup、录音和 LiveKit bridge 控制器。
- `contactCenter`：尚未进入共享 SDK，等待 M4 的共享 domain/API 完成后再发布。

浏览器接入分两层：

1. headless Voice controller：已交付 call state、控制命令、分机能力门禁和稳定幂等重试；真实 SIP/WebRTC 媒体 adapter 尚未联调。
2. 可嵌入 React Voice 控制工作台：已交付 durable call 深链、脱敏 Call Detail、呼入/外呼和完整控制动作，Voice/IVR durable event 会触发快照刷新；它不保存或显示分机 credential，也不声称已经完成软电话注册和 RTP 媒体。
3. 浏览器 SIP/WebRTC media adapter、IVR Designer、Queue Monitor：尚未交付。

参考客户端继续作为完整示例，OPC 和 LED 不复制其源码。

## 14. 事件合同

新增 durable event 类型：

- `voice.call.created`
- `voice.call.state_changed`
- `voice.call.command_updated`
- `voice.call.dtmf_received`
- `voice.call.recording_updated`
- `voice.call.bridge_updated`
- `voice.provider.capability_updated`
- `ivr.session.started`
- `ivr.session.step_completed`
- `ivr.session.waiting`
- `ivr.session.completed`
- `contact_center.queue.updated`
- `contact_center.assignment.updated`
- `contact_center.supervisor_action`

事件 payload 只包含公开 DTO、稳定 resource id、business reference 和 coarse provider state。

IVR 事件由会话提交后的统一投影器生成。普通 session HTTP、RustPBX Step webhook、pending-action worker 和 reconciliation worker 使用同一事件结构；幂等重放返回原响应但不重复发布。载荷固定为 `ivr_session_id`、`voice_call_id`、`flow_id/version`、state、node、step/revision、action kind、waiting/termination reason，不发布 session context、变量值、号码、Provider 原文或外部动作 payload。HTTP 通过 `afterCommit` 写 `ivekit_tenant_events` 后广播；worker 在自己的 PostgreSQL transaction 返回后执行同一流程，事件发布失败只告警，不反向篡改已经提交的 action/session 状态。

## 15. 错误、重试与恢复

- RustPBX 5xx、timeout、connection reset 归类 retryable。
- 认证、能力缺失、非法号码、非法状态转换归类 terminal。
- originate、transfer、recording 等非幂等 Provider 操作必须先持久化 command，再调用 Provider。
- 请求超时后由 reconciliation 查询 provider，不自动重复 originate。
- webhook 先去重再更新权威状态，处理失败进入 durable inbox/retry。
- IVR pending side effect 和 call command 均支持 lease 回收。
- 进程关闭时停止 claim，新实例接管过期 lease。
- Provider 数据不可确认时写 `uncertain`，不得写 `succeeded`。
- configuration apply 暂无经过真实 RustPBX 确认的安全查询 API；`uncertain` 期间只做 lease/age reconciliation，不重放 PUT，超过最大窗口以 `provider_result_unknown` 终止，避免永久悬挂或重复变更。

## 16. 安全与合规

### 16.1 安全控制

- 线路和 Provider secret 只通过环境变量、Kubernetes Secret 或 secret ref 解析。
- trunk/DID/route 变更写不可变 admin audit。
- 外呼前通过可注入 compliance port；OPC 可以提供 DNC/时窗/频次策略，LED 可以使用较简单策略。
- 录音策略支持 disabled、consent_required、always，并绑定 consent/evidence。
- 录音导出使用短期签名 URL 或服务端流式代理。
- PCI pause/resume 保存原始格式和 provider command 证据。
- 班长监听、耳语、强插和强制断开要求二次权限检查和 reason。
- webhook、日志和 acceptance evidence 执行 secret scan。

### 16.2 可观测性

- liveness 只判断进程事件循环；readiness 判断 PostgreSQL、migration version 和启用模块的本地依赖，不因未启用的 RustPBX/LiveKit profile 失败。
- deployment profile 单独暴露 `ready/degraded/not_configured`，避免一个租户的线路故障拖垮整个 iveKit readiness。
- 指标覆盖 call setup latency、active calls、command duration/retry/uncertain、provider event lag、IVR step duration/error、pending action lease、queue wait、bridge success 和 recording reconciliation。
- 当前 IVR runtime 已暴露 `opc_ivekit_ivr_pending_actions_total`、`opc_ivekit_ivr_pending_action_duration_seconds`、`opc_ivekit_ivr_reconciliations_total` 和 `opc_ivekit_ivr_session_events_total`；action kind、result、error、event type、session state 均先折叠到固定枚举，未知输入统一为 `other`。
- Prometheus label 禁止完整号码、call id、business ref、tenant id、flow id 等高基数或敏感值；按 adapter、direction、state、error code 和 capability 聚合。
- trace 在 HTTP、durable command、Provider webhook、IVR pending action、LiveKit bridge 之间传播 `trace_id`；日志使用稳定 resource id，但号码始终脱敏。
- 每个 capability snapshot、route publish、IVR publish 和 migration import 生成可导出的诊断报告，报告先经过 secret scan。

## 17. 部署

### 17.1 Compose

仓库保留两套用途不同、不可混为一谈的 Compose：

1. `infra/ivekit/docker-compose.yml` + `infra/ivekit/docker-compose.voice.yml` 是 OPC 仓库完整集成拓扑，使用仓库主镜像，继续承载内置 Tinode、RustDesk 和验收 profile。
2. 生成后的 `service/build-context/docker-compose.yml` + `docker-compose.voice.yml` 是 iveKit standalone 拓扑，只使用独立镜像内的 `dist/ivekit-server.js`、`dist/ivekit-render-rustpbx-config.js`、`dist/ivekit-voice-preflight.js` 等编译入口。Voice overlay 通过 `init-rustpbx-database.sh` 建立 `rustpbx_app/rustpbx`，不会把 RustPBX 数据库凭据交给长期运行的 iveKit 服务。

两套拓扑都让 RustPBX Management/RWI 保持内部可达，只显式暴露 SIP/RTP。LiveKit 继续使用现有独立部署。`voice-ai` 和完整 `voice-acceptance` Compose profile 是后续目标；M2 的 controlled provider 只作为交付包 `acceptance/tools` 源码，不进入生产 runtime image，也不声明真实 PSTN。

### 17.2 Kubernetes

- RustPBX 使用独立 Deployment/Service、UDP/TCP/TLS/RTP 端口和 PodDisruptionBudget。
- iveKit Voice worker 可独立扩缩，但与 HTTP 使用同一镜像。
- LiveKit SIP 与 LiveKit 采用独立 chart values。
- PostgreSQL、Redis、对象存储使用外部生产服务或明确持久卷。
- 网络策略只允许所需 service-to-service 路径。

### 17.3 镜像与版本

- RustPBX、LiveKit SIP、iveKit 均按不可变 tag/digest 记录。
- release manifest 记录 RustPBX capability matrix。
- 上游版本升级先通过 adapter contract、受控呼叫和回滚演练。
- standalone source policy 显式收录 Voice preflight 和 RustPBX config renderer；隔离构建门禁要求三个 operational entrypoint 都实际生成。

### 17.4 M2 环境变量

| 变量 | 用途 |
| --- | --- |
| `OPC_IVEKIT_VOICE_WORKERS_ENABLED` | 总开关；只有 `1` 启动 command/event/reconciliation workers |
| `OPC_IVEKIT_IVR_WORKERS_ENABLED` | IVR durable action 总开关；默认 `0`，启用时宿主必须同时注入 executor 与 reconciler，否则应用拒绝启动 |
| `OPC_IVEKIT_IVR_ACTION_INTERVAL_MS` / `BATCH_SIZE` / `LEASE_MS` | IVR worker 动作的轮询周期、单租户批量和租约 |
| `OPC_IVEKIT_IVR_ACTION_RETRY_BASE_MS` / `RETRY_MAX_MS` | 已知可重试失败的指数退避下限和上限；Provider 超时进入 `uncertain`，不得直接重放 |
| `OPC_IVEKIT_IVR_RECONCILIATION_INTERVAL_MS` / `LEASE_MS` / `RETRY_MS` / `MAX_ATTEMPTS` | `uncertain` action 对账轮询、租约、再次对账周期和终止上限；达到上限后以 `provider_result_unknown` 失败并恢复会话 |
| `OPC_IVEKIT_IVR_TENANT_LIMIT` | 单轮 IVR worker tenant 扫描上限；tenant 由 PostgreSQL `opc_worker_tenant_ids('ivr_pending_action', ...)` 发现 |
| `OPC_IVEKIT_VOICE_COMMAND_INTERVAL_MS` / `BATCH_SIZE` / `LEASE_MS` / `MAX_ATTEMPTS` / `RETRY_DELAYS_MS` | 配置命令和通话命令的轮询、批量、租约和重试 |
| `OPC_IVEKIT_VOICE_EVENT_INTERVAL_MS` / `BATCH_SIZE` / `LEASE_MS` | provider event inbox worker 参数 |
| `OPC_IVEKIT_VOICE_RECONCILIATION_INTERVAL_MS` / `MAX_AGE_MS` | `uncertain` command 对账周期和最终未知上限 |
| `OPC_IVEKIT_VOICE_PROVIDER_TIMEOUT_MS` | Provider 操作超时预算；command/event lease 必须覆盖安全余量 |
| `OPC_IVEKIT_VOICE_TENANT_LIMIT` | 单轮 worker tenant 扫描上限 |
| `OPC_IVEKIT_VOICE_ADDRESS_KEY` / `ADDRESS_HMAC_KEY` | 两把不同的 32-byte base64 key，分别用于号码加密和稳定 HMAC lookup |
| `OPC_IVEKIT_VOICE_SECRET_ENV_NAMES` | Management/RWI secret resolver 允许读取的环境变量名 |
| `OPC_IVEKIT_VOICE_WEBHOOK_SECRET_ENV_NAMES` | Provider webhook 认证允许读取的环境变量名 |
| `RUSTPBX_MANAGEMENT_TOKEN` / `RUSTPBX_RWI_TOKEN` / `RUSTPBX_WEBHOOK_TOKEN` | 由 profile 中的 `env://...` secret ref 引用，不写入 profile config |
| `RUSTPBX_IMAGE` / `PROFILE_ID` / `DB_PASSWORD` / `DATABASE_URL` | RustPBX 镜像、profile 映射和独立 PostgreSQL 数据库配置 |
| `RUSTPBX_ROUTER_URL` / `CDR_WEBHOOK_URL` | 指向 `/api/ivekit/voice/providers/:profileId/router` 和 `/cdrs` |
| `RUSTPBX_SIP_PORT` / `RTP_START_PORT` / `RTP_END_PORT` / `EXTERNAL_IP` | SIP/RTP 暴露和 NAT 输入 |

完整默认值见 `services/ivekit-service/env.example` 和 `infra/ivekit/env.example`。生产配置禁止把 token、数据库密码、号码明文或带 credentials/query/fragment 的 Provider URL 写入 profile `config`。

### 17.5 M2 交付包边界

- `service/build-context/`：standalone runtime source、Dockerfile、migrations、compiled-entrypoint source、standalone Compose/Voice overlay 和数据库 bootstrap；不含 controlled provider。
- `deploy/application/`：OPC 仓库完整集成 Compose 及 Voice overlay。
- `deploy/kubernetes/ivekit/`：完整 Helm chart，包括 Voice values、Secret、RustPBX Deployment/Service/PDB 和 iveKit worker 配置。
- `acceptance/tools/ivekit-controlled-voice-provider.ts`：仅用于受控协议验收，不进入 runtime image。
- `manifest.json`：直接声明 `voice_preflight`、`voice_compose`、`voice_helm` 和 RustPBX provider ownership；`real_environment_acceptance.rustpbx` 固定为 `not_run`，直到 source-bound 真实证据完成。

## 18. 兼容迁移

迁移采用小步双读/单写：

1. 建立新 port 与 standalone PostgreSQL stores，不改旧路由行为。
2. 旧 `/api/voice/*` 和 `/api/ivr/*` 调用新 application service。
3. 新 `/api/ivekit/*` 直接调用同一 service。
4. OPC lead/customer 字段映射为 business reference。
5. 对比新旧 projection 与事件结果。
6. standalone source graph 纳入 Voice/IVR，明确排除 OPC 产品模块。
7. OPC 改用 SDK 或 compatibility adapter。
8. 完成一个 release deprecation 周期后删除旧反向 import 和 runtime SQLite DDL。

迁移期间禁止双写两个互不校验的生命周期状态机。

## 19. 实施里程碑

### M0：设计与审计

状态：已完成。

- 本文、依赖图、表归属、API/事件清单和验收边界。
- 固定 `opc-platform` 为共享底座权威来源。

### M1：边界与 PostgreSQL

状态：Voice/IVR foundation 边界已完成；旧 OPC compatibility 清理仍按后续迁移推进。

- 定义 Voice/IVR ports。
- 建 standalone source graph。
- 新 migration、RLS、runtime role 和 upgrade tests。
- 逐步消除 `db.ts`、harness 和 call-center 反向 import。

### M2：Voice Core 与 RustPBX

状态：代码完成，受控 PostgreSQL/RustPBX/LiveKit SIP adapter 验收通过；真实通信环境保持 `not_run`。

- deployment profile、capability/preflight。
- call lifecycle、durable command、event inbox、CDR/recording。
- trunk/DID/extension/route desired state。
- RWI、Router、Management/AMI 和 LiveKit SIP adapters；Step IVR 执行闭环进入 M3。

### M3：IVR Runtime

状态：代码完成；单元、受控 RustPBX Step 和真实 PostgreSQL durable runtime 验收通过，真实语音数据面保持 `not_run`。

- 25 种节点、版本、发布、回滚、simulation 和 session recovery。
- 前后端共享 graph schema。
- RustPBX Step IVR 与可选 RWI 实际协议闭环。

### M4：Contact Center Kit

状态：共享领域状态机、容量门禁、ACD ranking、PostgreSQL authority schema/store、Agent/Skill/Presence/Queue/Membership 配置服务与公开 API、原子 enqueue/offer/accept/reject/connect/complete/expire 服务和 IVR queue adapter 已实现；queue maintenance/offer worker、callback/supervisor runtime、SDK 和 Queue Monitor 尚未完成。OPC 历史 call-center 代码不算 iveKit M4。

- presence、skill、queue、ACD、callback 和 supervisor。
- IVR queue port 接入，不引入 OPC 业务依赖。

### M5：SDK、UI 与交付

状态：完整 Voice/IVR TypeScript SDK、headless WebPhone controller 和 React Voice 控制工作台已完成；浏览器 SIP/WebRTC media adapter、IVR Designer、Queue Monitor 尚未完成。standalone source context、Compose/Helm 和交付包已有可运行基础。

- SDK、headless hooks、WebPhone、IVR Designer、Queue Monitor。
- Compose、Helm、SBOM、image metadata、upgrade/rollback 和 LED/OPC 示例。

### M6：验证

状态：单元、客户端生产构建/分块预算、静态交付和受控 PostgreSQL 部分已执行；真实 RustPBX/PSTN/LiveKit SIP、浏览器软电话媒体和隔离服务器仍未执行。

- 全仓回归。
- standalone 独立安装/build。
- 真实 PostgreSQL fresh/upgrade/RLS/restart recovery。
- 受控 RustPBX/Step IVR/RWI capability matrix。
- 真实 RustPBX 双向 SIP、真实号码/软电话、录音、LiveKit SIP bridge。
- 浏览器 SIP/WebRTC WebPhone media、IVR designer、queue monitor E2E。
- 交付 evidence 与 source commit/hash 绑定。

## 20. 验收定义

### 20.1 分层验证矩阵

| 层级 | 必须验证 | 不可替代项 |
| --- | --- | --- |
| 单元 | 状态机、graph validation、号码规范化、幂等、adapter mapping、错误分类 | 新 Voice/IVR 核心不访问网络和 SQLite SQL；使用 port fake。旧 compatibility regression 可在迁移期继续使用 legacy SQLite harness |
| PostgreSQL 集成 | fresh/upgrade/checksum、RLS、tenant 事务、lease claim/recovery、唯一约束、importer dry-run/rejection | 使用真实 PostgreSQL，不能用内存 fake 冒充 |
| 受控协议 | RustPBX management/router/Step IVR/RWI、事件乱序/重复/超时、CDR、LiveKit SIP adapter | 受控 Provider 结果必须标记 `controlled` |
| 浏览器 | WebPhone 注册、RTP 媒体、呼入/外呼状态、设备切换、Hold/Transfer、IVR designer、queue monitor | 使用真实浏览器和构建产物；React 控制工作台单元测试不能替代本层 |
| 隔离服务器 | standalone 安装、Compose/Helm render、重启恢复、网络端口、对象存储、evidence bundle | source commit、镜像 digest、配置 hash 必须一致 |
| 真实通信环境 | 双向 SIP/PSTN、真实号码/软电话、RTP/录音、LiveKit SIP bridge、RWI 实际能力 | 未配置运营商或真实客户端时保持 `not_run`，不得写 `passed` |

### 20.2 完成条件

代码交付完成必须同时满足：

1. standalone source graph 不包含 OPC Lead、CRM、Stripe、WFM、Campaign 产品模块。
2. Voice/IVR production runtime 不加载 SQLite。
3. Voice/IVR 不 import OPC harness、call-center concrete class 或 `db.ts`。
4. OPC 旧行为通过 compatibility tests。
5. LED 示例仅用 SDK、HTTP、事件和公开 UI 包完成呼入/外呼/IVR 接入。
6. PostgreSQL fresh/upgrade、RLS、lease、restart recovery 通过。
7. RustPBX capability 缺失时准确失败或选择兼容路径。
8. 受控 provider、真实 SIP/PSTN、真实浏览器和生产网络状态分层记录。
9. 没有未解决的 Critical 或 Important 审查问题。
10. 交付包绑定 source commit、SDK、client、migration、镜像 digest、SBOM 和 evidence SHA-256。

## 21. 风险控制

| 风险 | 控制措施 |
| --- | --- |
| 一次性移动 IVR 导致大面积回归 | compatibility re-export、小步 port 注入、每步跑现有 75 项 IVR 测试 |
| RustPBX 版本能力漂移 | digest pin、capability preflight、协议矩阵、Step IVR 与 RWI 双 adapter |
| 重复 originate 导致真实重复呼叫 | durable command 先写、稳定幂等、timeout 后 reconciliation |
| tenant 来自 SIP header 导致越权 | DID/trunk/profile 服务端映射，忽略未经验证 tenant header |
| SQLite/PG 双实现继续漂移 | production PostgreSQL-only，单元测试使用 port fake，不复制 SQL |
| OPC 业务重新渗入底座 | source graph denylist、依赖方向测试、consumer adapter |
| IVR 外部动作在重启后重复 | session revision、durable pending action、lease 和 provider reconciliation |
| 录音和电话数据泄露 | secret ref、号码脱敏、短期下载、retention、RLS、evidence scan |

## 22. 已确定决策

- Voice Core、IVR 和可选 Contact Center Kit 进入 iveKit。
- RustPBX、LiveKit SIP、Active Call/LiveKit Agents 保持独立运行组件。
- `opc-platform` 是共享底座权威仓库。
- iveKit 生产控制面只使用 PostgreSQL，不使用 SQLite。
- Step IVR 是基础兼容路径，RWI 由 capability 决定。
- OPC 与 LED 都是消费者，不拥有共享模块的分叉源码。
- 真实环境未执行项必须保持 `not_run`。

## 23. 设计依据

- 本仓库 [架构总纲](design/architecture-v3.md)、[视频语音呼叫中心架构](architecture-video-voice-callcenter.md) 和 [新功能准入清单](new-feature-application-checklist.md)。
- [RustPBX 官方仓库](https://github.com/restsend/rustpbx)：上游代码、模块和发布信息。
- [RustPBX Overview](https://miuda.ai/docs/rustpbx/overview)：当前组件与运行边界。
- [RustPBX Specifications](https://miuda.ai/docs/rustpbx/specs/)：SIP、WebRTC、数据库和协议能力。
- [RustPBX Routing, Trunk and Billing](https://miuda.ai/docs/rustpbx/routing-trunk-billing/)：路由和 trunk 配置依据。

上游链接只用于能力基线，最终交付以锁定 digest 的 capability preflight 和协议验收结果为准。
