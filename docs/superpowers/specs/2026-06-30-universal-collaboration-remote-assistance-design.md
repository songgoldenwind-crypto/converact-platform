# 通用协作与远程支持能力设计计划

> 日期：2026-06-30
> 状态：设计计划，待确认后再拆实现计划
> 范围：把 OPC 和 LED 项目都能复用的语音、视频、屏幕共享、聊天、翻译、防绕单、远程协助、授权、录屏、审计能力设计成通用能力。本文不要求一次性全部实现。

## 1. 结论

建议把这块能力做成 OPC 的通用平台底座，而不是 call-center 的附属功能。

推荐三层架构：

```text
1. Media Core
   语音、视频、房间、token、参与人、屏幕共享、录制、webhook

2. Collaboration Session
   聊天、文件、翻译、防绕单、系统消息、业务对象绑定

3. Remote Assistance
   远程协助会话、第三方远控工具、平台内远控适配器、授权、录屏、操作日志、审计
```

第一阶段不要直接把 RustDesk、MeshCentral 或 Guacamole 深度嵌进核心代码。核心平台先掌控“会话、授权、审计、证据链、业务绑定”，开源项目作为可替换 Adapter。

## 2. 背景

OPC 当前已经有：

- `src/agent-runtime/livekit/`：LiveKit room、token、dispatch、webhook、recording。
- `src/agent-runtime/media-gateway/`：WebRTC join plan 和未来 SIP/VoLTE gateway 接缝。
- `src/agent-runtime/call-center/compliance/`：consent、retention、audit、compliance gate。
- `call_recordings`、`screen_recordings`、`tenant_compliance_settings` 等表结构基础。

LED 项目需求说明里明确要求：

- 第一版必须有语音通话、视频聊天。
- 第一版必须有平台内聊天和中英文实时翻译。
- 第一版远程控制可以调用 TeamViewer、AnyDesk、向日葵等第三方工具。
- 最终版本需要自研远程控制、屏幕共享、录屏、客户授权记录、远程会话日志、权限撤销和安全审计。

这说明音视频和远程支持能力不能只服务 OPC call-center。它应该能绑定不同业务对象：

```text
OPC: call_session / support_ticket / agent_conversation
LED: service_order / remote_support_order / dispute_case
未来: 任意 tenant-scoped business object
```

## 3. 设计目标

### 3.1 产品目标

1. 支持 OPC 当前通话、视频、录制、合规留痕。
2. 支持 LED 订单内聊天、翻译、语音、视频、屏幕共享、第三方远控工具调用。
3. 支持后续平台内远控能力接入。
4. 支持客户授权、撤销、录屏、证据归档、审计回放。
5. 支持多项目复用，不把业务字段写死成 `call_session_id`。

### 3.2 工程目标

1. 每层都是深 Module：小接口，大实现。
2. 通用层不 import `call-center/*` 或 LED 业务模块。
3. 业务项目通过 `BusinessRef` 绑定通用会话。
4. 开源远控引擎只通过 Adapter 接入。
5. 所有高风险动作先过授权和审计。
6. 当前 OPC 行为不破坏，先兼容再迁移。

## 4. 非目标

第一轮不做：

- 不直接 fork RustDesk 并深改进 OPC。
- 不自研完整远程桌面协议。
- 不一次性替换现有 call-center 聊天、录音、合规模块。
- 不把聊天、翻译、防绕单塞进 LiveKit Media Core。
- 不把远控实现和业务订单逻辑写死在一起。
- 不做 macOS/iMac 被控端。
- 不承诺第一版拥有 TeamViewer 级别远控体验。

## 5. 开源选型裁决

### 5.1 LiveKit

用途：

- 语音通话
- 视频聊天
- 屏幕共享
- 房间、参与人、token
- egress 录音/录像
- webhook 事件

裁决：

- 屏幕共享优先走 LiveKit 原生能力。
- LiveKit 仍然只属于 Media Core，不负责聊天、翻译、远控授权和业务审计。

依据：

- LiveKit 官方文档把 screen sharing 作为客户端 track 发布能力处理：<https://docs.livekit.io/home/client/tracks/screenshare/>

### 5.2 MeshCentral

用途：

- 平台内远控第一候选 Adapter。
- 更适合企业 IT 运维、设备管理、远程桌面、terminal、文件管理。

裁决：

- 第二阶段优先评估 MeshCentral Adapter。
- OPC 核心只保存远程协助会话、授权、审计和外部会话 ID。
- MeshCentral agent 管理、连接细节和远控执行留在 Adapter 内。

依据：

- MeshCentral 仓库 license 为 Apache 2.0：<https://github.com/Ylianst/MeshCentral>

### 5.3 Apache Guacamole

用途：

- 浏览器远程桌面网关。
- 适合 RDP、VNC、SSH 等已有远程协议资源。

裁决：

- 作为第二候选 Adapter。
- 更适合“客户已有 RDP/VNC/SSH 环境”的企业场景，不一定适合普通客户一键被控。

依据：

- Apache Guacamole 是 Apache 项目，适合 HTML5 远程桌面网关：<https://guacamole.apache.org/>

### 5.4 RustDesk

用途：

- 高体验远控候选。
- 体验上更接近 TeamViewer/AnyDesk。

裁决：

- 不作为第一阶段深度集成对象。
- 可以支持“第三方 RustDesk ID/链接调用”。
- 深度改造前必须做 AGPL/商业授权评估。

依据：

- RustDesk 仓库 license 为 AGPL-3.0：<https://github.com/rustdesk/rustdesk>

## 6. 核心领域模型

### 6.1 BusinessRef

通用能力必须绑定业务对象，但不能知道业务对象内部结构。

```ts
export type BusinessRefType =
  | 'call_session'
  | 'service_order'
  | 'support_ticket'
  | 'conversation'
  | string;

export interface BusinessRef {
  tenant_id: string;
  type: BusinessRefType;
  id: string;
  display_name?: string;
  metadata?: Record<string, unknown>;
}
```

规则：

- 所有协作会话、媒体房间、远程协助会话、证据记录都必须绑定 `BusinessRef`。
- OPC 适配层把 `call_session_id` 映射成 `BusinessRef`。
- LED 适配层把 `order_id` 映射成 `BusinessRef`。
- 通用层不直接更新 `voice_call_sessions` 或 LED `orders` 表。

### 6.2 Participant

```ts
export type CollaborationParticipantRole =
  | 'customer'
  | 'agent'
  | 'engineer'
  | 'supervisor'
  | 'ai'
  | 'admin';

export interface CollaborationParticipant {
  id: string;
  tenant_id: string;
  session_id: string;
  identity: string;
  role: CollaborationParticipantRole;
  display_name?: string;
  user_ref?: BusinessRef;
}
```

### 6.3 EvidenceRecord

所有录音、录像、录屏、授权、操作日志都归为证据记录。

```ts
export type EvidenceKind =
  | 'audio_recording'
  | 'video_recording'
  | 'screen_recording'
  | 'remote_control_log'
  | 'consent_grant'
  | 'consent_revocation'
  | 'chat_export'
  | 'file_snapshot';

export interface EvidenceRecord {
  id: string;
  tenant_id: string;
  business_ref: BusinessRef;
  session_id: string;
  kind: EvidenceKind;
  storage_url?: string;
  checksum?: string;
  retention_until?: string;
  created_by?: string;
  created_at: string;
  metadata: Record<string, unknown>;
}
```

## 7. 三层 Module 设计

## 7.1 Media Core

职责：

- 创建媒体房间。
- 签发参与人 token。
- 处理语音、视频、屏幕共享加入计划。
- 管理 LiveKit webhook。
- 管理 egress 录音/录像。
- 把媒体事件发给 Collaboration Session 或业务 Adapter。

不负责：

- 聊天内容。
- 翻译。
- 防绕单。
- 远控授权。
- 工单/订单状态。

推荐接口：

```ts
export interface MediaCoreModule {
  createRoom(input: CreateMediaRoomInput): Promise<MediaRoom>;
  issueJoinPlan(input: IssueMediaJoinPlanInput): Promise<MediaJoinPlan>;
  startRecording(input: StartMediaRecordingInput): Promise<EvidenceRecord>;
  stopRecording(recordingId: string): Promise<EvidenceRecord | null>;
  handleWebhook(input: MediaWebhookInput): Promise<MediaWebhookResult>;
}
```

当前 `LiveKitMediaModule` 应继续演进成 Media Core 的 LiveKit Adapter，而不是承载所有协作业务。

## 7.2 Collaboration Session

职责：

- 创建订单/工单/call_session 绑定的协作会话。
- 管理参与人。
- 管理聊天消息、文件、图片、视频消息。
- 管理系统消息：议价、付款提醒、完成确认、转人工、远控授权提示。
- 管理翻译任务和翻译结果。
- 执行基础防绕单检测。
- 产生审计事件。

不负责：

- 实时音视频传输。
- 远控协议执行。
- 支付、结算、订单状态核心流转。

推荐接口：

```ts
export interface CollaborationSessionModule {
  openSession(input: OpenCollaborationSessionInput): Promise<CollaborationSession>;
  addParticipant(input: AddParticipantInput): Promise<CollaborationParticipant>;
  postMessage(input: PostMessageInput): Promise<CollaborationMessage>;
  attachFile(input: AttachFileInput): Promise<CollaborationAttachment>;
  requestTranslation(input: TranslationRequest): Promise<TranslationResult>;
  scanPolicy(input: PolicyScanInput): Promise<PolicyScanResult>;
  listTimeline(sessionId: string): Promise<CollaborationTimelineItem[]>;
}
```

防绕单第一阶段只做文本规则：

- 电话
- email
- WhatsApp
- Telegram
- WeChat
- `call me`
- `text me`
- `pay me directly`
- `outside app`

后续再做：

- 图片 OCR
- 语音转写检测
- AI 风控

## 7.3 Remote Assistance

职责：

- 创建远程协助会话。
- 申请客户授权。
- 记录授权、拒绝、撤销。
- 启动屏幕共享。
- 调用第三方远控工具或平台远控 Adapter。
- 记录操作日志。
- 生成录屏/录制证据。
- 产生审计事件。

不负责：

- 自己实现所有远控协议。
- 直接管理订单付款或结算。
- 直接决定业务纠纷结果。

推荐接口：

```ts
export interface RemoteAssistanceModule {
  createSession(input: CreateRemoteAssistanceSessionInput): Promise<RemoteAssistanceSession>;
  requestConsent(input: RequestRemoteConsentInput): Promise<ConsentRequest>;
  grantConsent(input: GrantRemoteConsentInput): Promise<ConsentGrant>;
  revokeConsent(input: RevokeRemoteConsentInput): Promise<ConsentRevocation>;
  startToolSession(input: StartRemoteToolSessionInput): Promise<RemoteToolSession>;
  endToolSession(toolSessionId: string): Promise<RemoteToolSession>;
  recordAudit(input: RemoteAuditEventInput): Promise<RemoteAuditEvent>;
  listEvidence(input: ListEvidenceInput): Promise<EvidenceRecord[]>;
}
```

远控 Adapter：

```ts
export interface RemoteControlAdapter {
  provider: 'external_link' | 'meshcentral' | 'guacamole' | 'rustdesk' | string;
  start(input: StartRemoteControlInput): Promise<RemoteControlStartResult>;
  stop(input: StopRemoteControlInput): Promise<RemoteControlStopResult>;
  getStatus(sessionId: string): Promise<RemoteControlStatus>;
}
```

第一阶段 Adapter：

- `external_link`
- 保存 TeamViewer ID、AnyDesk ID、向日葵识别码、Zoom/Google Meet 链接、RustDesk ID。
- 不控制第三方工具，只做绑定、授权、打开入口、审计。

第二阶段 Adapter：

- `meshcentral`
- 平台内远控第一候选。

第三阶段 Adapter：

- `guacamole`
- 用于 RDP/VNC/SSH 网关场景。

第四阶段研究：

- `rustdesk`
- 体验候选，但必须通过许可证和商业授权评估。

## 8. 数据模型规划

第一阶段可以新增通用表，不急着替换现有表。

### 8.1 collaboration_sessions

字段建议：

- `id`
- `tenant_id`
- `business_ref_type`
- `business_ref_id`
- `status`
- `title`
- `metadata`
- `created_at`
- `updated_at`
- `closed_at`

### 8.2 collaboration_participants

- `id`
- `tenant_id`
- `session_id`
- `identity`
- `role`
- `display_name`
- `user_ref_type`
- `user_ref_id`
- `joined_at`
- `left_at`

### 8.3 collaboration_messages

- `id`
- `tenant_id`
- `session_id`
- `sender_identity`
- `message_type`
- `body`
- `original_language`
- `metadata`
- `created_at`

### 8.4 collaboration_message_translations

- `id`
- `tenant_id`
- `message_id`
- `target_language`
- `translated_body`
- `provider`
- `confidence`
- `created_at`

### 8.5 collaboration_policy_events

- `id`
- `tenant_id`
- `session_id`
- `message_id`
- `policy_type`
- `severity`
- `matched_text_hash`
- `action`
- `created_at`

### 8.6 remote_assistance_sessions

- `id`
- `tenant_id`
- `collaboration_session_id`
- `business_ref_type`
- `business_ref_id`
- `status`
- `mode`
- `adapter_provider`
- `started_by`
- `started_at`
- `ended_at`
- `metadata`

`mode`：

- `screen_share`
- `third_party_remote_tool`
- `platform_remote_control`
- `remote_desktop_gateway`

### 8.7 remote_consent_events

- `id`
- `tenant_id`
- `remote_session_id`
- `actor_identity`
- `event_type`
- `scope`
- `expires_at`
- `created_at`
- `metadata`

`event_type`：

- `requested`
- `granted`
- `denied`
- `revoked`
- `expired`

`scope`：

- `view_screen`
- `control_mouse_keyboard`
- `record_screen`
- `transfer_file`
- `clipboard`

### 8.8 remote_audit_events

- `id`
- `tenant_id`
- `remote_session_id`
- `actor_identity`
- `event_type`
- `target`
- `created_at`
- `metadata`

事件例子：

- `session.created`
- `consent.requested`
- `consent.granted`
- `screen_share.started`
- `remote_control.started`
- `remote_control.stopped`
- `recording.started`
- `recording.stopped`
- `file_transfer.started`
- `clipboard.used`
- `session.ended`

### 8.9 evidence_records

用于统一录音、录像、录屏、授权凭证、聊天导出和操作日志。

- `id`
- `tenant_id`
- `business_ref_type`
- `business_ref_id`
- `session_id`
- `kind`
- `storage_url`
- `checksum`
- `retention_until`
- `created_by`
- `created_at`
- `metadata`

## 9. 和现有 OPC 的关系

### 9.1 现有 LiveKitMediaModule

保留，并继续作为 Media Core 的 LiveKit 实现。

下一步需要把这些字段通用化：

- `call_session_id` 不应该是 Media Core 的核心字段。
- `EgressRecord.call_session_id` 后续应被 `BusinessRef` 替代或并行支持。
- `getRoomByCallSession()` 后续保留为 OPC compatibility facade。

### 9.2 call-center 适配层

新增 OPC Adapter：

```text
CallCenterCollaborationAdapter
  call_session_id -> BusinessRef
  voice_call_sessions -> collaboration session
  existing call_recordings -> evidence records
  compliance consent -> remote consent
```

现有功能先不删：

- `call_recordings`
- `screen_recordings`
- `ConsentTracker`
- `AuditStore`
- `EgressManager` compatibility facade

先写兼容映射，等新通用表稳定后再迁移。

### 9.3 LED 项目适配层

未来 LED Adapter：

```text
LedServiceCollaborationAdapter
  order_id -> BusinessRef
  engineer/customer -> participants
  negotiation/system messages -> collaboration messages
  remote support order -> remote assistance session
```

LED 不需要知道 OPC 的 call-center 内部结构。

## 10. 安全和授权原则

远程协助必须比普通通话更严格。

规则：

1. 没有客户授权，不允许远控。
2. 授权必须有范围：只看屏幕、可控制鼠标键盘、可录屏、可传文件、可用剪贴板。
3. 授权必须可撤销。
4. 高风险权限要有过期时间。
5. 每次授权、撤销、远控开始、远控结束都要写审计事件。
6. 录音、录像、录屏必须进入证据记录，并受 retention policy 控制。
7. 第三方远控工具也要记录工具名、ID、发起人、授权状态和开始/结束时间。
8. 不在通用层保存明文敏感凭据，远控 provider secret 走 tenant-scoped integration config。

## 11. 分阶段路线

### Phase 0：文档和接口冻结

目标：

- 确认三层架构。
- 确认 `BusinessRef`。
- 确认 Remote Assistance 只通过 Adapter 接入开源远控。
- 确认第一阶段不深改 RustDesk。

产物：

- 本设计计划。
- 后续实现计划。

### Phase 1：Media Core 补齐

目标：

- 让当前 LiveKitMediaModule 更通用。
- 增加 screen share join plan 概念。
- 支持 `BusinessRef` 并保留 `call_session_id` 兼容。
- 录制记录开始向 EvidenceRecord 靠拢。
- 当前实现已让 Media Core 录制支持 `business_ref`：非 OPC 通话对象可以启动录制并写入 `call_recordings.business_ref_*`，旧 `call_session_id` 自动映射成 `call_session` ref。
- 当前实现已新增媒体录制证据桥：总 HTTP 入口有 Postgres 时，LiveKit Egress 录制会同步写入 `evidence_records`，可与远控录屏、授权、操作日志按同一 `BusinessRef` 汇总。
- 当前实现已让 LiveKit `egress_ended` webhook 同步支持录制更新和证据桥，避免真实 LiveKit 完成回调绕过 EvidenceRecord。

验收：

- OPC 现有测试不破坏。
- LiveKit module 不 import call-center。
- 可以为 `call_session` 和模拟 `service_order` 创建媒体房间。

### Phase 2：Collaboration Session 基础

目标：

- 新增通用协作会话。
- 支持参与人、消息、附件、系统消息。
- 支持基础中英文翻译接口。
- 支持基础防绕单规则扫描。

验收：

- 可以创建绑定 `call_session` 的协作会话。
- 可以创建绑定 `service_order` 的协作会话。
- 消息和翻译结果能按 session 查询。
- 防绕单命中能产生 policy event。

### Phase 3：Remote Assistance v1

目标：

- 新增远程协助会话。
- 新增授权事件。
- 新增第三方远控工具 Adapter：TeamViewer、AnyDesk、向日葵、RustDesk ID/链接、Zoom/Google Meet 链接。
- 新增审计事件和 EvidenceRecord。

验收：

- 客户授权后才能启动远程工具会话。
- 授权撤销后不能继续启动新远控，且已启动的 active 工具会话必须结束。
- 所有关键动作都有 audit event。
- 能绑定 OPC call_session 和 LED service_order。
- 当前实现已新增 `/api/collaboration/*` HTTP 入口：session、remote assistance、consent request/grant/deny/revoke、tool sessions、audit、evidence、screen recording upload 与 timeline。
- 授权拒绝 `denied` 会写入 consent timeline 和 `remote.consent.denied` audit event，且仍阻止远控工具启动。
- `evidence/upload` 返回的本地证据读取地址需要同租户认证，未认证和跨租户不能读取录屏/截图文件。
- 当前实现已新增 `npm run smoke:collaboration`，用于在真实后端/Postgres 环境中串起 session、remote assistance、授权前工具阻断、consent request/grant/revoke、第三方工具会话、审计事件、录屏证据上传与 timeline 校验；revoke 后会要求工具会话已结束并出现 `remote.tool_session.ended` 审计。该 smoke 已纳入 `npm run smoke:media:readiness` 默认目标，也可以单独运行。它验证的是通用编排和证据链，不替代 RustDesk/MeshCentral 网关真实联调。
- 当前实现已新增 `/api/collaboration/remote-assistance/:id/tools/gateway`，用于 OPC 后端通过配置好的 MeshCentral / Guacamole client 创建远程桌面工具会话；该入口与内部 `startGatewayClientSession` 都会先检查 active consent，再调用外部网关，避免未授权时先创建上游会话。`/api/collaboration/remote-assistance/:id/audit/gateway-sync` 会按 `tool_session_id` 从同一网关拉取上游操作日志并写回 OPC `remote_audit_events` / timeline。授权 revoke 时，如果当前 remote session 还有 active 的 MeshCentral / Guacamole gateway tool，OPC 会先调用上游网关结束会话并同步网关审计，再结束本地 tool session。`smoke:collaboration` 设置 `OPC_COLLAB_SMOKE_USE_GATEWAY_TOOL=1` 后会同时覆盖 `/tools/gateway` 与 `/audit/gateway-sync`。
- 当前实现已新增 `npm run smoke:remote-gateway`，用于对 MeshCentral / Guacamole 这类 HTTP 网关执行真实接通验收：创建网关会话、校验返回的 `launch_url`、读取网关审计、结束网关会话。它是 `smoke:media:readiness` 的可选目标 `remote-gateway`，默认不启用；当部署确实接入远程桌面网关时，通过 `OPC_VIDEO_READINESS_TARGETS=...,remote-gateway` 纳入硬门禁。

### Phase 4：平台内远控 Adapter

目标：

- 优先接 MeshCentral Adapter。
- OPC 只调用 RemoteAssistanceModule。
- Adapter 内部负责 MeshCentral session 创建、agent 映射、状态同步。

验收：

- 远控 session 能被统一创建、结束和审计。
- 业务侧不直接依赖 MeshCentral SDK 或 API 细节。

### Phase 5：高级证据和风控

目标：

- 录屏归档。
- 聊天导出。
- 图片 OCR 防绕单。
- 语音转写防绕单。
- AI 风控。
- Retention job 和证据销毁审计。

验收：

- 可按业务对象查看完整证据链。
- 可按租户策略执行留存和删除。
- 删除也有审计记录。

## 12. 实现顺序建议

建议后续实现计划按这个顺序拆：

1. `BusinessRef` 和 EvidenceRecord 类型。
2. Media Core 兼容改造。
3. Collaboration Session schema 和 store。
4. Collaboration Session module 接口。
5. 基础消息、附件、系统消息。
6. 翻译接口和 mock/in-memory provider。
7. 防绕单规则扫描。
8. Remote Assistance schema 和 store。
9. 授权事件和审计事件。
10. External Link Remote Adapter。
11. OPC call-center adapter。
12. LED service-order adapter 的测试替身。
13. MeshCentral Adapter 研究和 PoC。
14. 真实远控网关联调 smoke：RustDesk/MeshCentral 会话创建、回调鉴权、远控操作日志同步和录像对象存储。

## 13. 风险

### 13.1 范围过大

风险：

- 三层都很大，一次性做会失控。

控制：

- 每个 Phase 都要有独立验收。
- 先做通用模型和 External Link Adapter，不先做完整远控协议。

### 13.2 许可证风险

风险：

- RustDesk AGPL 可能影响商业闭源平台。

控制：

- RustDesk 第一阶段只作为第三方工具 ID/链接，不深度嵌入。
- 深度集成前必须做法律和商业授权评估。

### 13.3 数据迁移风险

风险：

- 现有 `call_recordings`、`screen_recordings`、compliance 表已经存在。

控制：

- 第一阶段并行建通用表。
- 通过 compatibility facade 读取旧数据。
- 稳定后再迁移。

### 13.4 安全风险

风险：

- 远控权限过大，可能导致客户数据泄露或误操作。

控制：

- 授权范围最小化。
- 默认不允许文件传输、剪贴板和后台静默控制。
- 每个高风险动作都审计。

### 13.5 体验风险

风险：

- MeshCentral/Guacamole 的普通用户体验可能不如 RustDesk。

控制：

- 第一版用第三方工具链接满足真实业务。
- 平台内远控先满足企业支持场景。
- 如果客户强依赖高频远控，再评估 RustDesk 商业方案或独立远控引擎。

## 14. 成功标准

设计成功的标准：

1. OPC 和 LED 都能用同一套协作/远程支持模型。
2. Media Core 不知道 call-center 或 LED。
3. Remote Assistance 不绑定任何单一远控开源项目。
4. 授权、审计和证据链是平台自有能力。
5. 第一版能满足真实业务：语音、视频、屏幕共享、聊天、翻译、第三方远控工具调用。
6. 后续能逐步接 MeshCentral、Guacamole 或 RustDesk，而不重写业务层。

## 15. 待确认决策

建议默认采用以下决策：

1. 屏幕共享：LiveKit。
2. 第一版远控：External Link Adapter。
3. 第二版平台内远控：MeshCentral Adapter。
4. Guacamole：企业 RDP/VNC/SSH 场景备用。
5. RustDesk：体验候选，但深度集成前必须过 AGPL/商业授权评估。
6. 通用业务绑定：`BusinessRef`。
7. 证据链：统一 `EvidenceRecord`。
8. 远控权限：默认最小授权，客户可撤销。

如果这些决策确认，下一步应写实现计划，不直接开始编码。
