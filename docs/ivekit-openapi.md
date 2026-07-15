# iveKit HTTP API 与事件契约

> 契约版本：v1-draft / 2026-07-14。Base path 为 `/api/ivekit`。本文是 LED/OPC 对接用的 Markdown 契约；真实运行能力先读取 capabilities。更完整背景见《iveKit视频IM通用能力详细设计》。

本契约由独立进程 `npm run start:ivekit` 提供，正式 TypeScript 客户端为 `@opc/ivekit-sdk`。稳定域还包括 `/api/ivekit/voice/*`、`/api/ivekit/ivr/*` 和 `/api/ivekit/contact-center/*`；旧 OPC 进程在迁移期间继续提供兼容入口。

## 1. 通用约定

### 1.1 鉴权

服务端调用：

```http
X-API-Key: <OPC_API_KEY>
X-Tenant-Id: tenant_led
X-User-Id: agent_1001
```

浏览器调用：

```http
Authorization: Bearer <user-jwt>
X-Tenant-Id: tenant_led
```

API key 的 `X-User-Id` 表示可信后端代表的操作者。Bearer 身份只取 JWT `sub`，忽略调用方伪造的用户 header。tenant 必须与数据库 RLS 上下文一致。

部署信任边界：LED 服务只持有 iveKit API key/JWT，不持有 `opc_admin`、PostgreSQL runtime 密码、LiveKit API secret、Tinode 服务账号密码、MinIO root/service secret 或 RustDesk control-plane token。数据库迁移与角色初始化由一次性任务完成；长驻 iveKit 使用不可自行开启 RLS bypass 的 `opc_runtime`，Tinode 使用仅能连接 Tinode 数据库的独立角色。此部署变化不修改下述 HTTP payload，但属于生产接入硬门禁。

### 1.2 数据与错误

- JSON 请求使用 `Content-Type: application/json`。
- 附件上传直接发送二进制 body，并在 query 传 `kind/filename`。
- 成功 HTTP 响应直接返回 route `data`，没有额外 `{ data: ... }` 包装。
- 受控录制导出返回二进制和 `Content-Disposition`。
- 跨域浏览器 origin 必须列入 `OPC_IVEKIT_ALLOWED_ORIGINS`；预检支持 bearer/API-key 所需 headers。
- 普通 JSON 和 webhook body 受 `OPC_IVEKIT_HTTP_BODY_MAX_BYTES` 限制，超限返回 413；畸形 JSON 返回 400 `invalid_json`。
- 错误通常为 `{ "error": "detail" }`；平台 500 可能返回带 `error.message/status/id` 的结构。

| HTTP | 含义 |
| --- | --- |
| 200/201 | 成功；创建通常 201 |
| 202 | 本地消息/审计已提交，provider 等待 durable retry |
| 204 | 成功但没有 body |
| 400 | 参数、状态或确认字段不合法 |
| 401 | 缺认证/认证失败 |
| 403 | tenant/role/identity/consent/scope 不允许 |
| 404 | tenant-scoped 资源不存在 |
| 409 | 生命周期、幂等 payload、mutation window 或并发冲突 |
| 413/415 | 附件过大/MIME 不匹配 |
| 422 | Voice/IVR 请求结构、Revision、地址或路由规则无效 |
| 501 | 当前部署或 Provider 没有声明该 capability；不得当作成功重试 |
| 502 | provider 操作失败；Media moderation/终态保持原状态并可重试，消息投递等接口按各自章节保留本地记录 |
| 503 | PostgreSQL/provider/必要配置不可用 |

### 1.3 SDK 映射

`createIveKitClient()` 返回 `context`、`media`、`chat`、`intelligence`、`events`、`rustdesk`、`voice`、`ivr` 和 `contactCenter` 客户端。Node 后端使用 API key，浏览器使用短期 bearer token；恰好只能配置一种认证方式。除 RustDesk 外的 HTTP facade 使用 `IveKitHttpSdkError`，RustDesk 使用 `IveKitRustDeskHttpError`；两者都保留 `status/method/path/payload`。`timeoutMs` 触发或网络失败时 `status=0`，幂等写请求必须使用原 `Idempotency-Key` 重试。

### 1.4 Contact Center 与监控投影

```text
GET  /api/ivekit/contact-center/capabilities
GET  /api/ivekit/contact-center/monitor
GET|POST /api/ivekit/contact-center/skills
GET|POST /api/ivekit/contact-center/agents
GET|POST /api/ivekit/contact-center/queues
GET|POST /api/ivekit/contact-center/callbacks
POST /api/ivekit/contact-center/routing/assignments
POST /api/ivekit/contact-center/assignments/:id/{accept,reject,connect,complete}
POST /api/ivekit/contact-center/supervisor/actions
```

配置创建、callback、routing assignment 和 supervisor start 要求 `Idempotency-Key`。`monitor` 是 tenant-scoped 一致快照，包含坐席 Presence/容量、活动 Voice Call、各队列等待与可用技能容量、UTC 当日 SLA、callback/overflow/supervisor 运行计数和不含敏感正文的告警。无可用容量时 `estimated_wait_seconds=null`。完整方法与 DTO 由 `ivekit.contactCenter` 导出。

录制导出由 SDK 返回 `Uint8Array` 与 MIME/文件名元数据；附件上传接受标准 `BodyInit` 二进制 body，不做 base64 JSON 包装。RustDesk 高层方法 `ensureDevice/startSession` 负责设备、heartbeat 和 launch plan，操作审计与结束/物理断开状态仍是显式步骤。

### 1.5 Unified Business Context

```text
GET /api/ivekit/context/by-ref?business_ref_type=service_order&business_ref_id=SO-1001
```

`context.getByBusinessRef({type,id})` 返回当前 viewer 可见的 Chat session、Media call、Remote session 和 RustDesk device 脱敏摘要，供统一导航和深链接使用。响应不包含业务 metadata、消息正文、LiveKit token、RustDesk ID、launch URL、provider credential 或 evidence 内容，并设置 `Cache-Control: private, no-store`。

响应的 `authorization` 包含按可见资源分组的只读授权事实：Chat participant role/active-left、Media participant role/status、Remote viewer role、active consent scopes、活动 RustDesk gateway permissions 及 control owner/version。它不包含 participant user_ref、底层 metadata、二次确认或 operation authorization；任何写操作仍必须调用对应模块命令并重新执行 RBAC/状态机校验。

API-key system 调用可读取该 tenant 下业务引用的完整摘要。Bearer 调用至少必须是一个活跃 Chat participant 或非 `declined/left/missed/removed` 的 Media participant，否则返回 `404` 以避免枚举。普通用户只有在可见 Chat session 绑定该 Remote session 时才能看到远协摘要；仅参与 Media call 不会获得设备或远控可见性。关闭资源仍可按成员权限读取历史摘要，写操作继续由 Chat/Media/Remote 各自的终态规则拒绝。

统一时间线：

```text
GET /api/ivekit/context/timeline?business_ref_type=service_order&business_ref_id=SO-1001&limit=50&cursor=...
```

`context.listTimeline(ref, {limit,cursor})` 返回 Chat message/mutation、Media call action、Remote consent/audit、quality finding 和 evidence 的统一倒序页。cursor 与 business ref 绑定，不可跨业务复用。事件只有稳定 ID、source/type、资源 ID、actor、服务端时间和白名单 attributes；evidence 仅返回 evidence ID/kind/checksum/retention，不返回正文、reason、metadata、storage URL、录屏字节、屏幕像素、剪贴板或文件内容。Bearer evidence 必须绑定当前可见 Chat/Remote session，或通过 evidence metadata 的 `call_session_id` 绑定当前可见 Media call。

## 2. Media Core

### 2.1 Durable call lifecycle

The PostgreSQL call projection is authoritative. LiveKit room and participant
events reconcile into this projection; they do not replace it.

```text
POST /api/ivekit/media/calls
GET  /api/ivekit/media/calls/:call_id
POST /api/ivekit/media/calls/:call_id/actions
POST /api/ivekit/media/calls/:call_id/join
GET  /api/ivekit/media/calls/:call_id/participants
```

Call actions require `Idempotency-Key`. Supported actions are `ring`, `accept`,
`reject`, `cancel`, `timeout`, `activate`, `end`, and `fail`. Reusing a key with
the same request returns the original snapshot; reusing it for another request
returns `409`. Calls use `created -> ringing -> accepted -> active -> ended`,
with terminal `rejected`, `cancelled`, `timed_out`, and `failed` branches.
When another request is currently claiming the same key, the server returns a
retryable `409`; clients retry with the original key and payload.

User-mode identity comes from the Bearer token. The creator is the call `host`;
invited identities are `participant` rows. Cross-tenant and unknown call ids
return `404`. JWT reads require persisted call membership. Join plans are issued
only while the call is `accepted` or `active`, and only to an `accepted/joined`
participant (the already-joined host is also allowed). Call join responses do not
reuse the legacy room `joinPath`.

Events are published only after the PostgreSQL transaction commits, are targeted
to the call participant identities, and contain ids and statuses only:

```text
ivekit.media.call.created
ivekit.media.call.updated
ivekit.media.participant.updated
ivekit.media.call.ended
```

### 2.2 Capabilities

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/ivekit/media/capabilities` | 返回 tenant、LiveKit/Egress/SIP/object/recording 能力和配置布尔状态 |

Media Core 不返回 URL、API key 或 secret。与 LiveKit 浏览器接入有关的配置状态为：

```json
{
  "provider": "livekit",
  "tenant_id": "tenant_led",
  "capabilities": {
    "calls": true,
    "host_moderation": true
  },
  "config": {
    "livekit_url_configured": true,
    "livekit_public_url_configured": true,
    "livekit_server_configured": true,
    "livekit_browser_join_ready": true,
    "livekit_api_key_configured": true,
    "livekit_api_secret_configured": true,
    "invite_secret_configured": true,
    "egress_configured": true
  }
}
```

`livekit_server_configured` 表示服务端地址、API key 和 API secret 齐全；`livekit_browser_join_ready` 表示服务端配置完整且浏览器入口有效。生产环境缺任一服务端配置都会拒绝签 token，只有显式配置 `LIVEKIT_PUBLIC_URL=wss://...` 时，浏览器 join 才可能就绪；production 不会签发 `dev-token`。

### 2.3 房间和 Join

| Method | Path | 说明 |
| --- | --- | --- |
| POST | `/api/ivekit/media/rooms` | 创建 tenant room；可带 business_ref |
| GET | `/api/ivekit/media/rooms/:room_name` | 查询房间 |
| POST | `/api/ivekit/media/rooms/:room_name/close` | 关闭房间，之后拒绝 join/recording/dispatch |
| POST | `/api/ivekit/media/rooms/:room_name/join` | 仅 system/API-key 兼容调用；返回 WebRTC 或 SIP/VoLTE join plan |
| GET | `/api/ivekit/media/rooms/:room_name/participants` | `include_left=1`、`limit` |

创建房间：

```json
{
  "purpose": "video_service",
  "room_name": "tenant-led-order-1001",
  "business_ref": { "type": "service_order", "id": "SO-1001" },
  "metadata": { "collaboration_session_id": "collab_xxx" }
}
```

Join Plan：

```json
{
  "identity": "agent_1001",
  "role": "agent",
  "media": "video",
  "channel": "webrtc",
  "metadata": {}
}
```

普通 Bearer/JWT 浏览器用户不得调用 legacy room join，必须使用
`POST /api/ivekit/media/calls/:call_id/join`；该入口把 JWT `sub` 固定为 LiveKit
identity，并校验 durable call 成员与角色。WebRTC 返回 LiveKit token/URL/join path；
SIP bridge 返回 dial target/trunk 等 metadata。WebRTC 响应中的 `livekit_url` 是浏览器
可连接的 `LIVEKIT_PUBLIC_URL`，不是服务端使用的 `LIVEKIT_URL`。生产环境缺少公网 URL
或使用 `ws://` 时，Join 会失败关闭，不会把容器内地址返回给浏览器。Token 不应写日志
或持久化到 LED 业务表。

### 2.4 主持人管控与终态撤权

| Method | Path | 说明 |
| --- | --- | --- |
| POST | `/api/ivekit/media/rooms/:room_name/participants/:identity/mute` | 主持人或 system 静音一条已发布轨道 |
| POST | `/api/ivekit/media/rooms/:room_name/participants/:identity/remove` | 主持人或 system 幂等移除参与人 |
| POST | `/api/ivekit/media/moderation/recover` | 仅 system；按当前 tenant 恢复/最终化 pending command，可带 `limit=1..100` |

两个管控命令都必须携带 `Idempotency-Key`。同 key 同 payload 重放原结果，
同 key 不同 payload 返回 `409`；并发占用返回可重试 `409`。若 provider 已成功但
数据库提交、响应或连接失败，客户端必须用原 key 和原 payload 重试。静音
`muted=true`、带 token 吊销的 remove 和 room close 都是幂等 provider 操作，
因此重试可收敛；成功结果与 payload hash 一起保存，已提交的重放不会再次调用
provider 或重复写审计。

为覆盖 provider 成功后进程崩溃或 PostgreSQL 业务提交失败的窗口，iveKit 在
provider 调用前用独立 tenant transaction 持久化
`ivekit_media_moderation_commands(status=pending)`。正常请求在业务事务 COMMIT
后的 callback 标记 `completed`；明确 provider 失败标记 `failed`；未确认结果保留
`pending`。system recovery 会先检查同 key 审计，已有审计只做最终化；没有审计
则重新执行幂等 provider 操作并补齐状态/审计。command 与 action 两张表均启用
FORCE RLS。每条恢复使用独立 tenant transaction，只有审计 COMMIT 成功后才把
对应 command 标为 completed；单条失败不会回滚或误最终化同批其他 command。
恢复返回 `examined/finalized/recovered/failed/results`，不包含 provider secret
或 token。

静音 body 必须包含 `track_sid`、`source` 和 `muted=true`。`source` 只允许
`camera`、`microphone`、`screen_share`、`screen_share_audio`。服务端不提供
remote unmute；恢复采集必须由参与人自己的浏览器和本地轨道完成。

Bearer 用户的操作者身份固定取 JWT `sub`，且必须是 durable call 的活动
`host`；普通 participant 和 observer 返回 `403`。API key 服务模式可代表系统
执行，但必须用 `X-User-Id` 记录实际操作者。所有房间、参与人和审计查询均按
tenant 限制，外租户资源返回 `404`。

LiveKit 管理调用成功后，服务端才更新参与人状态并写入
`ivekit_media_moderation_actions`。审计表使用 PostgreSQL FORCE RLS，记录 call、
room、目标参与人、操作者、轨道、来源、原因和时间。重复 remove 返回
`status=already_applied`，不重复调用 provider 或写审计。成功后仅向该 call 的
参与人发送 `ivekit.media.participant.moderated`。

`reject/cancel/timeout/end/fail` 进入终态前，服务端对 call 中全部已登记身份尝试
使用 `revokeTokenTs` 吊销旧 token、断开参与人并关闭 provider room。LiveKit OSS
对已离线身份可能返回 `404`，因此终态房间后续若再出现 `participant_joined`
webhook，iveKit 会根据 durable terminal call 再次吊销全部身份并立即关房，阻止
旧 token 持续复活同名房间。provider 失败返回可重试 `502`，durable call 和
participant 保持原非终态。LiveKit 管理端未配置时，显式 moderation 返回 `503`；
生产环境的终态撤权也 fail-closed 为 `503`，不会伪造成功。管理调用超时可用
`OPC_LIVEKIT_ADMIN_TIMEOUT_SECONDS=1..30` 配置，默认 10 秒。

### 2.5 Recording/Egress

| Method | Path | 说明 |
| --- | --- | --- |
| POST | `/api/ivekit/media/rooms/:room_name/recordings/start` | 启动录制，要求 media_call_id、call_session_id 或 business_ref；Media Call 模式仅 host 可写 |
| POST | `/api/ivekit/media/recordings/:recording_or_egress_id/stop` | 按录制 ID 或 Egress ID 停止；Media Call 模式仅 host 可写 |
| GET | `/api/ivekit/media/recordings?limit=50` | 兼容数组列表；system 可按 tenant 查询，JWT 必须指定有成员关系的 call_id |
| GET | `/api/ivekit/media/recordings?page=1&call_id=...` | 分页列表，支持 cursor、room_name、business_ref_type/id、status 和 limit |
| GET | `/api/ivekit/media/recordings/:recording_id` | 录制状态、对象和失败信息 |
| GET | `/api/ivekit/media/recordings/:recording_id/object` | 对象存在性/可读性/checksum 检查并写审计 |
| GET | `/api/ivekit/media/recordings/:recording_id/export` | 鉴权受控二进制导出并写审计 |
| POST | `/api/ivekit/media/recordings/retention/cleanup` | 默认 dry-run；真实删除要求 `dry_run=false, confirm=true` 和高权限角色 |

Recording start：

```json
{
  "media_call_id": "call_ivekit_1001",
  "business_ref": { "type": "service_order", "id": "SO-1001" },
  "format": "webm",
  "has_video": true,
  "retention_days": 90
}
```

录制响应包含独立的 `media_call_id` 和 `room_name`；旧的
`call_session_id` 保留给语音/呼叫中心兼容路径。`listRecordings()` 继续返回数组，
`listRecordingsPage()` 返回 `{items,next_cursor,has_more}`。JWT 成员只可读取所属
Media Call 的录制，启动和停止要求该 call 的 `host` 角色；system/API-key 管理模式
保留 tenant 范围能力。公开 recording DTO 不包含 `storage_url`；对象播放与下载必须
调用受鉴权的 `export`。导出默认最多读取 64 MiB，可用
`OPC_RECORDING_EXPORT_MAX_BYTES` 调整至 1 GiB；服务端通过 AsyncIterable 逐块写 HTTP
响应，不聚合完整视频。文件在读取前检查大小，HTTP/S3 在 Content-Length 和逐块累计
两处执行上限，超限会取消上游读取。

同一 tenant 的同一房间只允许一个 `starting/pending/recording/stopping` 录制；
重复启动返回 `409`。JWT 启动时 `media_call_id` 对应的持久化 `room_name`
必须与路径房间一致，否则按不可见资源返回 `404`。

## 3. Collaboration Session / Chat

### 3.1 Capabilities 和 session

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/ivekit/chat/capabilities` | provider、功能开关、配置布尔状态和 delivery policy |
| POST | `/api/ivekit/chat/sessions` | 按 business_ref 建会话 |
| GET | `/api/ivekit/chat/sessions` | 游标分页；query: `status/business_ref_type/business_ref_id/query/cursor/limit`；每项含 viewer summary |
| GET | `/api/ivekit/chat/sessions/by-ref` | query: `business_ref_type/business_ref_id/limit` |
| POST | `/api/ivekit/chat/sessions/:session_id/close` | 撤销全部活动参与人的 provider 权限后关闭会话 |
| POST | `/api/ivekit/chat/sessions/:session_id/bind` | 创建/复用 local/Tinode binding |
| GET | `/api/ivekit/chat/sessions/:session_id/snapshot` | session/binding/participants/messages/policy 快照 |

当前关键能力协商：

```json
{
  "capabilities": {
    "provider_inbound_sync": true,
    "durable_provider_delivery": true,
    "message_receipts": true,
    "typing": true,
    "presence": true,
    "message_edit": true,
    "message_soft_delete": true
  },
  "config": {
    "inbound_sync_configured": true,
    "message_mutation_window_ms": 900000,
    "tinode_client_access_mode": "JRP"
  },
  "delivery_policy": {
    "direct_client_publish": false
  }
}
```

强制裁决：`direct_client_publish=false`。Tinode client-plan 的 topic ACL 为 `JRP`，不含 `W`。业务消息只能走 `/messages`，否则本地镜像、防绕单、OCR/ASR 和 AI 质检会失去证据。

会话分页项的 `summary` 包含 `unread_count`、`online_participant_count` 和 `last_message`。只有当前认证身份仍是该会话活动参与人时才返回消息摘要，否则返回全零/空摘要；未读数按当前认证身份计算；软删除消息返回空正文和 `deleted=true`；在线人数只统计未离开且 presence TTL 未过期的参与人。关闭操作要求当前身份仍是活动参与人，先把绑定 topic 上所有活动参与人的 mode 降为 `N`，任一 provider 撤权失败都不会把数据库提前标为 closed；成功后广播 `collaboration.session.closed`。

### 3.2 参与人和 Tinode plan

| Method | Path | 说明 |
| --- | --- | --- |
| POST | `/api/ivekit/chat/sessions/:session_id/participants` | 添加本地参与人并同步 Tinode `JRP` |
| POST | `/api/ivekit/chat/sessions/:session_id/participants/leave` | 设置 left_at，Tinode mode 降为 `N` |
| POST | `/api/ivekit/chat/sessions/:session_id/client-plan` | 返回 topic/user/user token/public WS/API key |

Client plan 请求：

```json
{ "identity": "agent_1001", "role": "agent", "display_name": "Agent A" }
```

响应只含当前用户 token，不含 root token、basic password 或 `TINODE_USER_PASSWORD_SECRET`。官方前端 adapter 使用 `tinode-sdk@0.25.1` subscribe 和 data/info/presence/read/typing note；没有 publish/sendMessage。

### 3.3 消息和 provider delivery

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/ivekit/chat/sessions/:session_id/messages?limit=100` | 本地审计镜像 |
| GET | `/api/ivekit/chat/sessions/:session_id/messages?direction=before&cursor=&query=&limit=50` | 游标历史页；`before/after` 游标不可混用 |
| POST | `/api/ivekit/chat/sessions/:session_id/messages` | 本地事务 + policy + durable provider delivery |
| GET | `/api/ivekit/chat/sessions/:session_id/messages/:message_id/delivery` | delivery 状态和 attempt history |
| POST | `/api/ivekit/chat/sessions/:session_id/messages/:message_id/delivery/retry` | 对到期 work 做 lease 保护的重试 |
| GET | `/api/ivekit/chat/sessions/:session_id/messages/:message_id/reactions` | reaction 列表和 emoji 聚合计数 |
| PUT | `/api/ivekit/chat/sessions/:session_id/messages/:message_id/reactions/:emoji` | 当前认证参与人幂等添加 reaction |
| DELETE | `/api/ivekit/chat/sessions/:session_id/messages/:message_id/reactions/:emoji` | 当前认证参与人幂等移除 reaction |
| GET | `/api/ivekit/chat/sessions/:session_id/pins` | 按置顶时间倒序返回 |
| PUT | `/api/ivekit/chat/sessions/:session_id/pins/:message_id` | 幂等置顶可见消息 |
| DELETE | `/api/ivekit/chat/sessions/:session_id/pins/:message_id` | 幂等取消置顶 |

分页响应统一为 `{items,next_cursor,has_more}`。会话按 `(created_at,id)` 倒序；消息页内始终按时间正序返回，`before` 从最新消息向历史加载，`after` 从最早消息向前收敛。游标是不可解释的版本化 token，并绑定资源和方向；客户端不得解析、修改或跨会话复用。`after` 页在暂时追平时仍返回高水位 `next_cursor`，此时用 `has_more=false` 表示当前没有更多消息，后续可持该游标继续增量请求。仅带 `limit` 的旧消息请求仍返回数组，供现有集成平滑迁移；新客户端应调用 SDK 的 `listMessagesPage()`。

消息 DTO 直接返回 `provider_origin`、`provider_sequence`、`provider_version`、`provider_sender_id`。本地未绑定 provider seq 时分别为 `""/0/0/""`；Tinode 入站消息用 `(provider_topic_id,provider_sequence)` 去重，replace/delete 后 `provider_version` 单调不减。LED 不应从 `metadata` 猜测这些坐标。

消息创建可带 `reply_to_message_id`、`forwarded_from_message_id` 和去重后的 `mentions`。关系目标必须是同租户、同会话且未删除的消息，mention 必须是当前活跃参与人。服务端只保存目标 ID，不复制被回复消息正文。Reaction 和 pin 写操作始终使用认证身份，忽略客户端伪造身份；变更分别广播 `collaboration.message.reaction_updated` 和 `collaboration.message.pin_updated`。

```http
POST /api/ivekit/chat/sessions/collab_xxx/messages
Idempotency-Key: led:SO-1001:message:0001
```

```json
{
  "sender_identity": "agent_1001",
  "message_type": "text",
  "body": "hello",
  "attachments": [],
  "metadata": {}
}
```

`Idempotency-Key` 最长 128 个单行字符。同 key + 同 payload 返回原消息；同 key + 不同 payload 返回 409。Tinode publish ack 只说明 provider 接收，不代表参与人 delivered/read。

### 3.4 receipt、未读、typing、presence

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/ivekit/chat/sessions/:session_id/messages/:message_id/receipts` | 指定消息 receipt |
| POST | `/api/ivekit/chat/sessions/:session_id/messages/:message_id/receipts` | 当前身份推进 delivered/read high-watermark |
| GET | `/api/ivekit/chat/sessions/:session_id/message-state` | 当前身份 unread count + receipts |
| POST | `/api/ivekit/chat/sessions/:session_id/typing` | `{identity, typing, ttl_ms?}` |
| POST | `/api/ivekit/chat/sessions/:session_id/presence` | `{identity, status, ttl_ms?}`，status online/away/offline |
| GET | `/api/ivekit/chat/sessions/:session_id/realtime-state` | 会话 presence/typing 快照 |

Receipt：

```json
{
  "identity": "agent_1001",
  "status": "read",
  "source": "ivekit",
  "provider_sequence": 42,
  "metadata": {}
}
```

receipt metadata 会递归遮蔽手机号/邮箱。read-through 按 `created_at,id` 推进；自己发送和软删除消息不计入 unread。typing 默认 8 秒，presence 默认 90 秒。

### 3.5 编辑、软删除和 mutation audit

| Method | Path | 说明 |
| --- | --- | --- |
| PATCH | `/api/ivekit/chat/sessions/:session_id/messages/:message_id` | `{body, reason?}` |
| DELETE | `/api/ivekit/chat/sessions/:session_id/messages/:message_id` | `{reason?}` |
| GET | `/api/ivekit/chat/sessions/:session_id/messages/:message_id/mutations` | 版本、动作、hash、操作者、脱敏 reason |

仅原发送者可在 `OPC_CHAT_MESSAGE_MUTATION_WINDOW_MS` 内修改文本。编辑后重扫 policy；删除为软删除，原 `body` 留作审计，对外 `body=''`。mutation 只存前后 SHA-256，不复制历史正文。当前不写回 Tinode 原生消息 mutation，LED UI 以 iveKit snapshot/事件为权威。

### 3.6 附件、OCR/ASR

| Method | Path | 说明 |
| --- | --- | --- |
| POST | `/api/ivekit/chat/sessions/:session_id/attachments/upload?kind=image&filename=x.png` | 二进制 body；MIME/大小门禁 |
| GET | `/api/ivekit/chat/sessions/:session_id/attachments/:attachment_id` | attachment + processing job |
| GET | `/api/ivekit/chat/sessions/:session_id/attachments/:attachment_id/download` | 鉴权二进制下载；返回 MIME 和 Content-Disposition |
| POST | `/api/ivekit/chat/sessions/:session_id/attachments/:attachment_id/retry` | 重新排 OCR/ASR |
| POST | `/api/ivekit/chat/attachment-processing/run` | 运维/测试 due batch；生产通常 worker 驱动 |

上传返回 descriptor，再放进消息 `attachments`。浏览器 SDK 的 `uploadAttachmentWithProgress()` 使用 XHR 报告字节进度并返回 `{result,abort}`；Node 使用可注入 fetch fallback。每次上传尝试生成新的 `x-upload-id`，但随后创建消息时重试必须复用原 `Idempotency-Key`。文件不做 base64 转换。图片走 OCR，audio/video/screen_recording 走 ASR；提取文本回填后重新执行 policy 和 AI 质检。客户端状态可区分 `uploading/uploaded/attached/processing_pending/processing/retry_wait/completed/failed/provider_unconfigured/cancelled`。真实 provider 仍需服务器选型/验收。

descriptor 的 `storage_url` 只指向 `/api/ivekit/chat/objects/*` 受控路径；持久化为消息附件后优先使用按 session/attachment 鉴权的 `download` 路径。两种路径都不返回 MinIO/S3 凭据，也不暴露 `/api/call-center/media/*`。

### 3.7 finding、AI 质检和人审

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/ivekit/chat/sessions/:session_id/findings` | query: `message_id/source/review_status/limit` |
| GET | `/api/ivekit/chat/sessions/:session_id/findings/:finding_id` | finding + review history |
| POST | `/api/ivekit/chat/sessions/:session_id/findings/:finding_id/review` | confirmed/false_positive/escalated/resolved |
| GET | `/api/ivekit/chat/sessions/:session_id/messages/:message_id/quality-review` | AI job |
| POST | `/api/ivekit/chat/sessions/:session_id/messages/:message_id/quality-review` | 按当前内容哈希入队 |
| POST | `/api/ivekit/chat/quality-review/run` | 运维/测试 due batch |

AI finding 的执行 action 固定为 `review`；provider 的建议只进入脱敏 metadata。模型不能直接封单、处罚或执行不可逆动作。

人工复核只允许会话内仍活跃的 `agent/engineer/supervisor/admin` 参与人；`customer/ai`、已离开参与人和跨租户身份返回 `403`。参考客户端按 `high/medium/low` 排序并按 fingerprint 去重，消息只显示克制的风险标记；详情仅呈现二次脱敏 rationale、证据类型和不可变 review history，不展示 `matched_text_hash`、fingerprint、checksum 或 provider 私有 metadata。复核提交必须填写原因，切换 finding/会话会清空未提交原因，实时 finding 更新按 `updated_at` 重新加载详情；窄屏通过可关闭抽屉完成同一复核流程。重复提交当前状态返回 `200` 和 `review=null`，不广播重复事件，客户端也按 review audit ID 去重。

### 3.8 Intelligence policy、Provider 与租户审核队列

| Method | Path | RBAC | 说明 |
| --- | --- | --- | --- |
| GET | `/api/ivekit/intelligence/capabilities` | authenticated | 返回租户 OCR/ASR/质检/翻译的 enabled/automatic/available/reason |
| GET | `/api/ivekit/intelligence/policy` | owner/admin/system | 返回租户策略和乐观锁 `version` |
| PUT | `/api/ivekit/intelligence/policy` | owner/admin/system | 全量策略写入；版本冲突 409 |
| GET | `/api/ivekit/intelligence/providers` | owner/admin/system | 只返回脱敏 profile 和 `token_configured` |
| POST | `/api/ivekit/intelligence/providers/health` | owner/admin/system | 可选 `profile_ids[]`，返回健康等级和延迟，不返回 URL/token |
| GET | `/api/ivekit/intelligence/findings` | operator/admin/system | 租户审核队列；支持 session/source/severity/status/time/cursor/limit |
| GET | `/api/ivekit/intelligence/findings/:finding_id` | operator/admin/system | finding 与不可变 review history |
| POST | `/api/ivekit/intelligence/findings/:finding_id/review` | operator/admin/system | confirmed/false_positive/resolved/escalated |

policy 字段包括四类 enabled/profile id/automatic、`allow_third_party`、目标语言和 OCR/ASR confidence threshold。第三方 profile 只有在 `allow_third_party=true` 时可选。租户队列供 Quality 工作区使用，不要求审核员仍是每个会话的 participant，但仍受 tenant、RBAC、软删除和 RLS 约束；普通 viewer 返回 403。

### 3.9 录制源导入与翻译

| Method | Path | 说明 |
| --- | --- | --- |
| POST | `/api/ivekit/intelligence/sessions/:session_id/sources` | 导入 `media_recording|remote_recording`；必须带 `Idempotency-Key` |
| GET | `/api/ivekit/intelligence/sessions/:session_id/sources/:source_id` | source、合成 message/attachment、processing job 和 findings |
| POST | `/api/ivekit/intelligence/sessions/:session_id/sources/:source_id/retry` | 重新排失败/取消的录制源处理 |
| GET/POST | `/api/ivekit/chat/sessions/:session_id/messages/:message_id/translations` | 查询或请求消息翻译 |
| GET/POST | `/api/ivekit/chat/sessions/:session_id/attachments/:attachment_id/translations` | 查询或请求附件抽取文本翻译 |
| POST | `/api/ivekit/chat/sessions/:session_id/translations/:job_id/retry` | 仅重试允许重试的 failed job |
| POST | `/api/ivekit/chat/translation/run` | system 运行当前 tenant due batch；生产通常 worker 驱动 |

翻译 POST body 为 `{source_language?: "auto", target_language}`，且必须带稳定 `Idempotency-Key`。GET 可带 `target_language`；`history=1` 仅 admin/system 可读。返回同时包含 current result `items` 和 durable `jobs`，状态为 `pending|processing|retry_wait|succeeded|failed|cancelled`。结果绑定 `source_hash`，原消息编辑、删除或附件提取结果变化后旧 job 不会覆盖当前原文。

相关 SDK 方法位于 `sdk.intelligence.*`、`sdk.chat.list/request*Translations()` 和 `sdk.chat.retryTranslation()`。LED 不应自行拼接 Provider 请求。

## 4. Remote Assistance / RustDesk

RustDesk 稳定路径前缀为 `/api/ivekit/rustdesk`，推荐使用 `createIveKitRustDeskLedSdk`。

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/ivekit/rustdesk/client-config` | ID/relay/API server、public key/fingerprint |
| GET | `/api/ivekit/rustdesk/client-profile?platform=windows&architecture=x86_64&client_version=1.4.7&expected_server_version=1.1.15&expected_server_key_fingerprint=sha256%3A...` | 鉴权后的固定版本客户端分发 profile；两个 expected pin 必填 |
| POST | `/api/ivekit/rustdesk/devices` | 注册 business_ref 设备 |
| GET | `/api/ivekit/rustdesk/devices/by-ref` | business_ref 查设备 |
| GET | `/api/ivekit/rustdesk/devices/:device_id` | 设备状态 |
| POST | `/api/ivekit/rustdesk/devices/:device_id/heartbeat` | edge/runtime heartbeat |
| POST | `/api/ivekit/rustdesk/devices/:device_id/deactivate` | 停用设备 |
| POST | `/api/ivekit/rustdesk/gateway-sessions` | 授权范围内创建会话 |
| GET | `/api/ivekit/rustdesk/gateway-sessions/:external_id/launch` | launch plan |
| GET | `/api/ivekit/rustdesk/gateway-sessions/:external_id/control` | 当前控制者、租约和版本 |
| POST | `/api/ivekit/rustdesk/gateway-sessions/:external_id/control/confirmations` | 为指定敏感操作签发 30-300 秒一次性确认 |
| POST | `/api/ivekit/rustdesk/gateway-sessions/:external_id/control/acquire` | 使用键鼠确认获取单控制者租约 |
| POST | `/api/ivekit/rustdesk/gateway-sessions/:external_id/control/heartbeat` | 当前控制者按版本续租 |
| POST | `/api/ivekit/rustdesk/gateway-sessions/:external_id/control/release` | 当前控制者按版本释放 |
| POST | `/api/ivekit/rustdesk/gateway-sessions/:external_id/control/transfer` | 使用转移确认原子转移控制权 |
| POST | `/api/ivekit/rustdesk/gateway-sessions/:external_id/control/operations` | 消费文件、剪贴板或键鼠确认并返回一次性 operation grant |
| POST | `/api/ivekit/rustdesk/gateway-sessions/:external_id/events` | 结构化操作审计 |
| GET | `/api/ivekit/rustdesk/gateway-sessions/:external_id/audit` | 审计列表 |
| DELETE | `/api/ivekit/rustdesk/gateway-sessions/:external_id` | 结束控制面会话并触发物理断开命令 |
| GET | `/api/ivekit/rustdesk/gateway-sessions/:external_id/disconnect` | pending/succeeded/failed/unavailable |

`events` 保留既有 control/file/clipboard/recording 事件，并新增 canonical
`remote.rustdesk.operation.observed`。metadata 必须包含 `operation_id`、`operation`、
`status` 和 `observer`。`not_observed` 固定使用 `observer=none`、`observed_at=null`、空
`evidence_refs`；成功/失败观察必须提供 ISO `observed_at` 和至少一个
`{type,ref,sha256}` evidence ref。可选字段包括 provider operation/session ID、direction、
display ID、byte count、checksum、duration、reason、status detail 和 control version。
禁止提交 clipboard/file/keystroke/screen/recording 原始内容以及 token、password、API/private
key。control/file/clipboard 观察在 control-enforced session 中必须由当前 controller 提交，
并携带匹配的 `control_version`；检查和 audit insert 在同一个数据库锁/事务中完成。

Legacy OPC compatibility route `/api/opc/rustdesk/sessions` is attended-only. An omitted
`access_mode` keeps the historical attended create contract; when `remote_session_id` is
provided, active consent and requested consent scopes are rechecked. Unattended creation must use `/api/ivekit/rustdesk/gateway-sessions`, which applies the registered-device, business-ref,
active-policy, expiry, and active-consent checks. The legacy control plane rejects explicit
`access_mode=unattended` and access-mode or unattended aliases hidden in metadata.

新建 iveKit gateway session 固定写入 `control_enforcement_version=1`。只有 active
collaboration participant 可以读取控制状态；`agent/engineer/supervisor/admin` 可以申请
控制，`customer/ai` observer 只能查看。每个 session 同时最多一个控制者，租约为
5-120 秒；heartbeat、release、transfer 都携带当前 `version`，旧 owner、旧版本、终态
session 和重放 challenge 返回 4xx。状态变化只推送给当前 active participants。

`control_mouse_keyboard`、`transfer_file`、`clipboard`、`control_transfer` 和
`unattended_launch` 必须使用新签发且未消费的 confirmation。新会话上报控制动作、文件
started 或剪贴板事件时，metadata 必须额外携带 `operation_grant_id` 和
`control_version`；操作授权关联和审计写入处于同一数据库事务。旧 OPC 会话不增加该字段
要求，以保持已发布 control-plane 合同。

无人值守创建响应不会返回可直接使用的 `launch_url`。调用方应先创建 session，再申请
`unattended_launch` confirmation，最后调用
`GET .../launch?confirmation_id=...`；确认只能使用一次。

### 4.1 真实终端 DTO 与能力事实

SDK 在 `sdk/ivekit/src/types.ts` 导出 `RustDeskTerminalProfile`、
`RustDeskTerminalPlatform`、`RustDeskTerminalArchitecture`、
`RustDeskClientVersion`、`RustDeskConfiguredFields`、
`RustDeskRuntimeCapabilities`、`RustDeskPermissionScopes`、
`RustDeskControlOwnership`、`RustDeskDisconnectState` 和
`RustDeskOperationEvidence`。现有 `RustDeskClientConfig`、`RustDeskDevice`、
`RemoteToolSession`、`RustDeskGatewayLaunchPlan`、原 response 字段和 HTTP client
方法保持不变；新增 profile/scope/ownership/disconnect/evidence 字段均为 additive
optional contract，旧服务响应和旧调用方继续兼容。

终端能力不能用一个 `ready` 布尔值表达，必须保留四个互不替代的状态：

| 字段 | 含义 |
| --- | --- |
| `configured` | ID/relay/API/public-key 字段是否完成配置，以及 server key fingerprint；只表示配置存在 |
| `available` | heartbeat/native observer/operator report 报告的 runtime capability；缺失为 `unknown` |
| `granted` | requested scope 经 active consent 和 iveKit policy 收窄后的授权集合 |
| `observed` | native/edge/operator/QA 对单项操作的独立观察；没有真实观察必须是 `not_observed` |

`configured=true`、`available`、`granted`、HTTP 2xx、launch plan 或断开命令
`succeeded` 都不能自动生成 `observed_succeeded`。屏幕、键鼠、多显示器、文件、
剪贴板、录屏和物理断开分别需要自己的 observation/evidence；一个操作的证据不能
替代另一个操作。operation evidence 只保存 metadata、checksum 和 evidence ref，
不保存屏幕像素、键盘输入、文件内容、剪贴板内容或录屏字节。

`RustDeskOperationEvidence` 是 discriminated union：`not_observed` 固定要求
`observer=none`、`observed_at=null`、`evidence_refs=[]`；
`observed_succeeded/observed_failed` 必须使用非 `none` observer、真实时间戳和至少
一个 evidence ref。The top-level `operation_id` is authoritative; evidence metadata does not repeat it.
`RustDeskOperationEvidenceMetadata` 没有任意键，只允许 external/provider ID、direction、display ID、byte count、SHA-256 checksum、duration、
reason 和 status detail 等非内容审计字段。

`IveKitRustDeskGatewayDisconnectState` remains an exported compatibility interface for declaration merging and
extends consumers, with the original `required` / `status` / `command` fields. `getGatewayDisconnectState()`
and the runtime projector return the strict `RustDeskDisconnectState` union, which is structurally assignable
to that interface; compatibility does not weaken the strict state invariants.

The SDK and static-pack base URL must be an HTTP(S) origin root; any non-root path is rejected
because absolute API paths would otherwise discard it.

支持的 RustDesk OSS server/client/platform/architecture 组合冻结在
[RustDesk 客户端版本矩阵](rustdesk-client-version-matrix.md)。矩阵中的
`not_run` 不能由本地配置、mock、controlled E2E 或 wrapper exit code 改写。

浏览器只使用短期 Bearer token，不接收 iveKit API key、private key、edge signing
secret、无人值守密码或 raw service credential。`launch_url` 必须作为 opaque、短期
capability 使用；其中的 signed token 不得拆出展示、写日志或持久化。可信后端可以
使用 API key，但不得转发给浏览器。SDK 只依赖 Web Platform API，不导入 OPC server
source 或 Node-only module。

`rustdesk:client-config-pack` 是静态交接产物，不持久化 signed `launch_url` 或 executable
protocol URL；兼容字段保持空字符串，仅输出 `launch_available` /
`protocol_available` 的生成时可用性快照。`actions.can_launch` 只有严格等于 boolean
`true` 才能标记为可用；配置包 base URL 禁止 credentials、query 和 fragment，配置的
RustDesk target ID 与 launch plan 不一致时生成失败。真正拉起客户端时仍调用
`getGatewayLaunchPlan()` 即时获取短期
opaque URL，不能从静态 pack 复用。

### 4.2 客户端分发 Profile

`getClientProfile()` 与 `RustDeskClientDistributionProfile` 是独立于
`RustDeskTerminalProfile` 的分发契约。V1 只允许 Windows `x86_64`、macOS
`x86_64/aarch64` 和 Linux `x86_64/aarch64`，并严格固定 client `1.4.7` 与 server
`1.1.15`。调用方同时传入可信部署记录中的 expected server version 和 key
fingerprint；服务端与 SDK 都拒绝漂移、过期 profile、错误 tuple、浮动版本、非 HTTPS
artifact、URL userinfo/query/fragment、文件名不匹配和非 64-hex SHA-256。
RustDesk public key 必须是单行 canonical standard base64，解码后恰好 32 bytes；SDK 使用
browser Web Crypto 从返回 key 独立计算既有 SHA-256 fingerprint，并同时匹配 response 与
调用方的 trusted expected fingerprint。时间戳必须是 canonical ISO 字符串，`issued_at`
最多允许 60 秒 clock skew，profile lifetime 必须在 60 秒到 1 小时之间。Artifact URL
只允许 GitHub `/download/1.4.7/<filename>` 或 mirror `/releases/1.4.7/<filename>` 精确后缀，
path/filename 中不得出现冲突的版本、platform 或 architecture token。Installer filename
必须是 1–255 字符的 canonical ASCII，只允许 letters/digits/dot/underscore/plus/hyphen；
URL raw basename 必须与 filename 完全一致，不接受 whitespace、control、Unicode 或 percent escape。
官方 V1 basename 固定为 `rustdesk-1.4.7-x86_64.exe`、
`rustdesk-1.4.7-x86_64.dmg`、`rustdesk-1.4.7-aarch64.dmg`、
`rustdesk-1.4.7-x86_64.deb` 或 `rustdesk-1.4.7-aarch64.deb`；platform 由请求 tuple
和 extension 绑定，filename 不添加 `windows/macos/linux` token。

Artifact 只从 `OPC_RUSTDESK_CLIENT_ARTIFACTS_JSON` 的显式 manifest 读取；缺少某个
tuple 时 profile 返回 `install_source.state=not_configured`，不会猜 URL 或 checksum。
`rustdesk:client-profile-pack` 聚合五个 desktop tuple，任一 artifact 缺失时
`ready=false`；每个 response 到达后立即使用新的 clock 验证，聚合完成时再使用新的
completion clock 重新验证全部 profile 和最早
`expires_at`，聚合期间过期会 fail closed。它只生成 JSON handoff，不下载或执行安装器。Task 3 前 unattended 固定为
`mode=attended_only,state=not_configured`。profile 响应使用
`Cache-Control: private, no-store`，并按认证、tenant 与 Origin 设置 `Vary`。
部署必须显式设置 `RUSTDESK_SERVER_IMAGE_TAG=1.1.15`；Helm/Compose 同时向 OPC 注入
`OPC_RUSTDESK_CLIENT_VERSION=1.4.7`、`OPC_RUSTDESK_CLIENT_PROFILE_TTL_SECONDS=900`
和显式 artifact manifest，RustDesk server pods 与 OPC 使用同一个 image tag。

设备 claim/progress/result 路径只允许设备绑定 edge token，不属于 LED 普通前端/API key 的调用面。完整 scope、事件和验收规则见 RustDesk 专项设计。

Web Assist 的 consent/event/media/recording 兼容路径仍位于 `/api/collaboration/*`；在独立服务抽离前由 iveKit session bundle/详细设计统一说明，不应与 RustDesk 系统级远控混为一类。

## 5. Voice Foundation、IVR 与 Contact Center

### 5.1 Voice 通用规则

Voice API 的租户只能来自认证上下文。`owner/admin/system` 管理 profile、trunk、DID、extension、route、policy 和 consent；非 viewer 的 operator 可以创建/控制通话、创建 LiveKit bridge 和获取本人或管理员授权的 WebPhone session。查询默认 `limit=50`，允许 `1..200`，cursor 是 opaque；响应页统一使用 `{items,next_cursor}`。

创建真实外呼、配置 apply/test、route publish、WebPhone session、call action 和 LiveKit bridge 都必须携带 `Idempotency-Key`。同 key 同 payload 返回原结果；同 key 不同 payload 返回 `409`。配置 apply/test、route publish 和 call action 返回 `202` durable command，调用方根据 command state 和租户事件收敛，不能因 HTTP 超时换 key 重放。更新配置使用当前 `revision`；过期 revision 返回冲突，不能最后写入覆盖。

号码只在创建/Provider 边界以明文输入；持久化和普通响应使用加密值、HMAC lookup 与 projection。profile `config` 禁止 credential、token、password、private key、Authorization、带 userinfo/query/fragment 的 URL；秘密只能通过 `secret_refs` 指向服务端 allowlist 环境变量。

### 5.2 Voice HTTP 路径

| Method | Path | 角色与结果 |
| --- | --- | --- |
| GET | `/api/ivekit/voice/capabilities` | 任意已认证调用；模块级能力事实 |
| GET/POST | `/api/ivekit/voice/profiles` | 查询；admin 创建 Provider profile |
| GET/PATCH | `/api/ivekit/voice/profiles/:profile_id` | 查询；admin + revision 更新 |
| POST | `/api/ivekit/voice/profiles/:profile_id/preflight` | admin；获取 protocol/effective capability snapshot |
| GET | `/api/ivekit/voice/profiles/:profile_id/capabilities` | 任意已认证调用；返回与当前 profile config hash 匹配的最近动作快照，无有效快照时为 `null` |
| GET/POST | `/api/ivekit/voice/trunks` | 查询；admin 创建 SIP trunk |
| GET/PATCH | `/api/ivekit/voice/trunks/:trunk_id` | 查询；admin + revision 更新 |
| POST | `/api/ivekit/voice/trunks/:trunk_id/apply` | admin + idempotency；返回配置 command |
| POST | `/api/ivekit/voice/trunks/:trunk_id/test` | admin + idempotency；返回线路测试 command |
| GET/POST | `/api/ivekit/voice/dids` | 查询；admin 创建加密 DID |
| GET/PATCH | `/api/ivekit/voice/dids/:did_id` | 查询；admin + revision 更新 |
| POST | `/api/ivekit/voice/dids/:did_id/apply` | admin + idempotency；返回配置 command |
| GET/POST | `/api/ivekit/voice/extensions` | 查询；admin 创建分机 |
| GET/PATCH | `/api/ivekit/voice/extensions/:extension_id` | 查询；admin + revision 更新 |
| POST | `/api/ivekit/voice/extensions/:extension_id/apply` | admin + idempotency；返回配置 command |
| POST | `/api/ivekit/voice/extensions/:extension_id/session` | operator/self-or-admin；返回短期 WSS SIP session plan |
| GET/POST | `/api/ivekit/voice/routes` | 查询；admin 创建 draft route |
| GET/PATCH | `/api/ivekit/voice/routes/:route_id` | 查询；admin + revision 更新 draft |
| POST | `/api/ivekit/voice/routes/:route_id/validate` | 校验当前或传入 rules，不发布 |
| POST | `/api/ivekit/voice/routes/:route_id/publish` | admin + revision + idempotency；创建 immutable version 和 apply command |
| GET | `/api/ivekit/voice/routes/:route_id/versions` | 查询不可变发布版本 |
| GET/POST | `/api/ivekit/voice/calls` | 查询；operator + idempotency 创建外呼 |
| GET | `/api/ivekit/voice/parking-slots` | 按 `profile_id` / `state` / cursor 查询 tenant-scoped 停车位 |
| GET | `/api/ivekit/voice/calls/:call_id` | tenant-scoped call snapshot |
| POST | `/api/ivekit/voice/calls/:call_id/actions` | operator + idempotency；返回 call command |
| POST | `/api/ivekit/voice/calls/:call_id/livekit-bridge` | operator + idempotency；创建 PSTN/LiveKit SIP bridge command |
| GET | `/api/ivekit/voice/calls/:call_id/events` | Provider event inbox 投影 |
| GET | `/api/ivekit/voice/calls/:call_id/recordings` | 该通话录音 metadata |
| GET | `/api/ivekit/voice/calls/:call_id/bridges` | 该通话 LiveKit SIP bridge 投影 |
| GET | `/api/ivekit/voice/calls/:call_id/participants` | 该通话参与人投影 |
| GET/PATCH | `/api/ivekit/voice/policy` | 查询；admin 更新 consent/recording/disclosure/calling-window 策略 |
| GET/POST | `/api/ivekit/voice/consents` | 查询；admin 写入带 evidence ref 的 consent |
| GET | `/api/ivekit/voice/recordings` | 按 call/status 分页查询录音 metadata |
| POST | `/api/ivekit/voice/providers/:profile_id/router` | RustPBX 签名/服务密钥 webhook；DID/profile 服务端映射租户 |
| POST | `/api/ivekit/voice/providers/:profile_id/events` | RustPBX 鉴权事件 webhook；返回 `202` inbox 状态 |
| POST | `/api/ivekit/voice/providers/:profile_id/cdrs` | RustPBX 鉴权 CDR webhook；按 provider event id/canonical hash 幂等 |

外呼请求至少包含 `profile_id`、`from`、`to`、`business_ref`；地址 kind 为 `e164|extension|sip_uri`。示例：

```json
{
  "profile_id": "profile_rustpbx",
  "from": { "kind": "extension", "value": "1001" },
  "to": { "kind": "e164", "value": "+8613800000000" },
  "business_ref": { "type": "service_order", "id": "SO-1001" },
  "metadata": {}
}
```

`actions` 支持 `answer`、`hangup`、`hold`、`resume`、`dtmf`、`blind_transfer`、`warm_transfer`、`conference`、`park`、`pickup`、`recording_start`、`recording_pause`、`recording_resume` 和 `recording_stop`。`conference` payload 使用 `operation=create|add|remove|destroy` 和 `conference_id`；`dtmf` payload 只接受经校验的数字、`*`、`#` 及受限时长；`park/pickup` payload 只接受 `{ "slot": "701" }`，slot 必须匹配 `^[A-Za-z0-9][A-Za-z0-9_*#-]{0,31}$`。profile snapshot 使用 `capability_schema_version=1`，`action_capabilities.commands` 完整列出 16 种 command，`action_capabilities.conference_operations` 完整列出 4 种会议操作。缺少字段、旧快照、未知版本、config hash 已变化或值不为 `true` 时均 fail closed。RustPBX `0.4.11` 原生 Park/Pickup capability 仍为 false；iveKit 仅在 RWI 分别具备 `call.hold` 以及 `call.unhold + call.bridge` 时开放组合式 Park/Pickup，并以 PostgreSQL/RLS 槽位状态机负责并发、重启恢复和对账。缺少原语时返回 `501 capability_unavailable`，不得伪造 command succeeded。`livekit_bridge_create` 由 `sipflow` 和独立 LiveKit SIP adapter 裁决，不冒充 RustPBX RWI action。浏览器内 DTMF 也可由 `@opc/ivekit-sdk/sip-webphone` 通过已建立的 SIP media handler 发送，两条路径都必须以当前 session/profile capability 裁决。

WebPhone session plan 只返回 `wss://`、短期 SIP credential、AoR、ICE server 和布尔 capability。服务端拒绝过期计划、非 WSS、带 URL credential、越权分机、空 ICE URL 和未知 capability；客户端不得持久化 credential 或把它写入 DOM/日志。

### 5.3 IVR HTTP 路径

| Method | Path | 角色与结果 |
| --- | --- | --- |
| GET/POST | `/api/ivekit/ivr/flows` | 查询；admin 创建 draft flow |
| GET/PATCH | `/api/ivekit/ivr/flows/:flow_id` | 查询；admin + expected revision 更新 |
| GET | `/api/ivekit/ivr/flows/:flow_id/versions` | immutable 发布版本 |
| POST | `/api/ivekit/ivr/flows/:flow_id/validate` | graph、资源和能力编译报告 |
| POST | `/api/ivekit/ivr/flows/:flow_id/publish` | admin + revision + idempotency；发布门禁 |
| POST | `/api/ivekit/ivr/flows/:flow_id/rollback` | admin + revision + idempotency；从历史版本生成新发布版本 |
| POST | `/api/ivekit/ivr/simulations` | 确定性模拟，不执行真实 Provider side effect |
| GET/POST | `/api/ivekit/ivr/sessions` | operator 查询或启动 durable session |
| GET | `/api/ivekit/ivr/sessions/:session_id` | session 与 step history |
| POST | `/api/ivekit/ivr/sessions/:session_id/advance` | operator；必须提交当前 event sequence/action revision |
| GET/PATCH | `/api/ivekit/ivr/settings` | 查询；admin 更新 tenant IVR settings |
| GET/POST | `/api/ivekit/ivr/audio-assets` | 查询；admin 创建音频资源 |
| GET/PATCH | `/api/ivekit/ivr/audio-assets/:asset_id` | 查询；admin 更新音频资源 |
| GET/POST | `/api/ivekit/ivr/time-groups` | 查询；admin 创建时段组 |
| GET/PATCH | `/api/ivekit/ivr/time-groups/:group_id` | 查询；admin 更新时段组 |
| GET/POST | `/api/ivekit/ivr/region-groups` | 查询；admin 创建区域组 |
| GET/PATCH | `/api/ivekit/ivr/region-groups/:group_id` | 查询；admin 更新区域组 |
| GET/POST | `/api/ivekit/ivr/ring-groups` | 查询；admin 创建振铃组 |
| GET/PATCH | `/api/ivekit/ivr/ring-groups/:group_id` | 查询；admin 更新振铃组 |
| POST | `/api/ivekit/ivr/provider-webhooks/rustpbx/:profile_id/step` | RustPBX 鉴权 Step IVR；响应 action node 与 session revision headers |

Flow graph 支持播放、菜单、收号、语音匹配、条件、变量、子流程、HTTP/Webhook、知识库、AI 对话、队列、转接、Audio Queue、Barge-in、语音信箱、调查和终态等 26 类节点。publish 必须先通过图结构、可达性、资源和 capability 校验；simulation 结果不能作为真实语音 side effect 的通过证据。session advance 使用 `(event_sequence,action_revision)` 防重复和乱序；外部动作持久化后由 worker claim/reconcile，Provider 超时进入 `uncertain`，不能直接重放。

### 5.4 Contact Center 完整路径

| Method | Path | 角色与结果 |
| --- | --- | --- |
| GET | `/api/ivekit/contact-center/capabilities` | 模块和 supervisor 真实能力 |
| GET | `/api/ivekit/contact-center/monitor` | tenant-scoped 一致 Queue Monitor snapshot |
| GET/POST | `/api/ivekit/contact-center/skills` | 查询；admin + idempotency 创建 |
| GET/PATCH | `/api/ivekit/contact-center/skills/:skill_id` | 查询；admin + revision 更新 |
| GET/POST | `/api/ivekit/contact-center/agents` | 查询；admin + idempotency 创建 |
| GET/PATCH | `/api/ivekit/contact-center/agents/:agent_id` | 查询；admin + revision 更新 |
| POST | `/api/ivekit/contact-center/agents/:agent_id/presence` | 坐席本人或 admin 更新 Presence |
| GET/PUT | `/api/ivekit/contact-center/agents/:agent_id/skills` | 查询；admin 原子替换技能集合 |
| GET/POST | `/api/ivekit/contact-center/queues` | 查询；admin + idempotency 创建 |
| GET/PATCH | `/api/ivekit/contact-center/queues/:queue_id` | 查询；admin + revision 更新 |
| GET/POST | `/api/ivekit/contact-center/queues/:queue_id/memberships` | 查询；admin upsert membership |
| DELETE | `/api/ivekit/contact-center/queues/:queue_id/memberships/:agent_id` | admin 移除 membership |
| GET/PUT | `/api/ivekit/contact-center/queues/:queue_id/skill-requirements` | 查询；admin 原子替换技能门槛 |
| GET | `/api/ivekit/contact-center/queues/:queue_id/entries` | state/cursor/limit 查询条目和 assignment history |
| GET/POST | `/api/ivekit/contact-center/callbacks` | 查询；operator + idempotency 请求 callback |
| GET | `/api/ivekit/contact-center/callbacks/:callback_id` | callback 状态/attempt 投影 |
| POST | `/api/ivekit/contact-center/callbacks/:callback_id/cancel` | operator 取消未终态 callback |
| POST | `/api/ivekit/contact-center/routing/assignments` | operator + idempotency 执行一次确定性 ACD offer |
| POST | `/api/ivekit/contact-center/assignments/:assignment_id/:action` | `accept|reject|connect|complete`，坐席本人或 admin |
| POST | `/api/ivekit/contact-center/supervisor/actions` | admin；`start` 需要 idempotency/authorization ref，或 `end` |

队列支持 `longest_idle|round_robin|fewest_active|highest_skill`，容量、Presence、membership 和 skill requirement 在同一 tenant transaction 内裁决。callback 保存加密目标并通过 Voice durable command 外呼；queue timeout、offer 回收、callback retry 和 overflow 由 PostgreSQL lease worker 处理。supervisor 只有部署注入经过验收的 control port 时 capability 才为 true；RustPBX typed adapter 还要求 preflight 同时报告目标 action、`supervisor.stop` 和对应 effective mode，当前锁定基线全部 fail closed，默认端口返回 `501`。provider 启动超时保留 `requested` 供同一幂等 key 重试，不会把未知结果伪记为失败。

### 5.5 SDK 与事件映射

- `IveKitVoiceHttpClient` 覆盖本节全部 Voice 配置、call、recording、bridge 和 policy 路径；`createIveKitVoiceController` 提供 durable call 高层控制；`@opc/ivekit-sdk/sip-webphone` 管理浏览器 SIP.js 生命周期。
- `IveKitIvrHttpClient` 覆盖 flow/version/validate/publish/rollback/simulation/session/resource/settings。
- `IveKitContactCenterHttpClient` 覆盖配置、Presence、ACD、assignment、callback、monitor 和 supervisor。
- Voice/IVR/Contact Center 变更通过租户 durable event 加速刷新；HTTP/PostgreSQL projection 仍是恢复后的权威 snapshot，消费者按 event ID 去重并使用 opaque cursor replay。

## 6. 租户 WebSocket 事件

事件 envelope 由 iveKit WebSocket 通道提供。M6.4 起事件先写入 PostgreSQL durable log，再进行本机和 Redis fan-out：

```json
{
  "event_id": "42",
  "cursor": "<opaque-signed-cursor>",
  "type": "collaboration.message.created",
  "data": { "session_id": "collab_...", "message_id": "cmsg_..." },
  "timestamp": "2026-07-12T12:00:00.000Z"
}
```

`event_id` 是服务端单调水位，客户端只能按字符串保存和去重；`cursor` 是签名、版本化、tenant 绑定且有 retention 的 opaque token，禁止解析或修改。关键事件：

| Event | 说明 |
| --- | --- |
| `collaboration.message.created` | 新本地权威消息和 policy 摘要 |
| `collaboration.message.receipt_updated` | receipt high-watermark/unread 更新 |
| `collaboration.typing.updated` | typing TTL 更新 |
| `collaboration.presence.updated` | presence TTL 更新 |
| `collaboration.message.edited` | 当前正文/version 更新 |
| `collaboration.message.deleted` | 软删除更新 |
| `collaboration.message.reaction_updated` | reaction 列表和聚合计数变化 |
| `collaboration.message.pin_updated` | pin 列表变化 |
| `collaboration.attachment.processed` | OCR/ASR 回填完成 |
| `collaboration.quality_review.completed` | AI job 完成 |
| `collaboration.policy.finding_reviewed` | 人审状态迁移 |

浏览器 WebSocket 使用 `Sec-WebSocket-Protocol: ivekit.v1, ivekit.jwt.<access-token>`
完成握手认证，不把 access token 放入 URL。服务端在 JWT `exp` 到期时以 `4001`
主动关闭连接；参考客户端提前 60 秒刷新短令牌并重新建立 HTTP/WS 客户端。

首次连接不带 cursor，`connected.data` 返回当前 `head_cursor`。重连时在 WebSocket URL 增加 `cursor=<opaque-cursor>`；cursor 不是凭据，但仍不得写入日志或长期浏览器存储。服务端先冻结 live delivery，完成 replay 后再释放连接期间积压事件。`connected.data` 同时返回 `head_cursor/replay_from/replayed_events/snapshot_required/reason?`。

也可通过 `GET /api/ivekit/events?cursor=<opaque>&limit=50` 拉取 `{items,next_cursor,has_more,snapshot_required}`。不带 cursor 时返回空 items 和当前 head。签名错误、跨 tenant、超过 retention 或单次 WS replay 超限时明确返回 `snapshot_required`；HTTP 状态为 409，WebSocket 在 connected data 中给出 reason。此时客户端必须重新获取 snapshot/message-state/realtime-state，再以新的 head cursor 继续。

Replay 每次按当前权限重新判断：定向事件只对 audience 用户可见；chat/media/remote 事件检查当前 participant，离开或被移除后不能读取历史私有事件；owner/admin/system 仅可旁路非定向资源事件，不能读取发给其他用户的定向事件。

## 7. SDK 方法映射

`createIveKitHttpSdk({baseUrl, tenantId, apiKey|accessToken, userId?, timeoutMs?, fetch?})` 返回：

- `sdk.media.*`：capabilities、room、join、participant、recording、object、export、cleanup。
- `sdk.chat.*`：`listSessions()`、`closeSession()`、`listMessagesPage()`、session、binding、client-plan、participant、message、delivery、receipt、state、mutation、attachment、finding、quality。
- `sdk.voice.*`：profile、trunk、DID、extension、route、call、command、bridge、recording、policy 和 consent。
- `sdk.ivr.*`：flow、version、publish/rollback、simulation、session、audio/time/region/ring resource 和 settings。
- `sdk.contactCenter.*`：skill、agent、Presence、queue、membership、ACD assignment、callback、monitor 和 supervisor。
- `sdk.events.getHeadCursor()`、`listPage()` 和有界 `replay()` 已交付；409 snapshot fallback 返回类型化 `snapshot_required` 结果，调用方按第 6 节刷新三工作区 snapshot 后取得新 head cursor。
- 二进制导出返回 `{bytes, contentType, filename}`。
- 错误为 `IveKitHttpSdkError(status, method, path, payload)`；网络/超时 `status=0`。

RustDesk 使用独立的 `createIveKitRustDeskLedSdk`，因为其设备注册、launch、操作审计和物理断开是一个更高层流程，不塞进通用 JSON client。

## 8. 兼容与未完成边界

1. 当前 API 是 v1 draft 的 additive contract；能力差异先看 capabilities。
2. Tinode inbound seq/cursor、Drafty 引用附件、native edit/delete 已实现 durable 同步；`inbound_sync_configured` 表示当前部署是否具备 URL、服务认证并启用 worker。
3. `direct_client_publish=false` 和客户端 ACL `JRP` 仍保留；业务消息优先走 iveKit facade。入站同步用于 provider 历史补偿、批准的其他客户端/管理操作和防止本地镜像漏记，不改变本地镜像与审计权威边界。
4. WebSocket 重连增量水位已完成服务器复验；HTTP/WS 从重启前 cursor 各恢复 2 个事件，撤权、跨租户、定向 audience、retention 和重复重启均通过。
5. 真实 RustPBX、SIP/PSTN、WSS/SDP/ICE/RTP、物理音频、真实录音和 LiveKit SIP bridge，以及 LiveKit/RustDesk/OCR/ASR/AI/PostgreSQL 多副本/网络环境仍待对应服务器验收；Tinode 单节点真实消息、编辑、Drafty 引用、删除和离线恢复已通过。
6. 本地 MemoryPg、fake provider、preflight 不是生产通过证明。
7. `LIVEKIT_URL` 是 OPC、AI Agent、Egress 等服务端可达地址；`LIVEKIT_PUBLIC_URL` 是浏览器 `Room.connect()` 使用的受信任 `wss://` 地址。LED 只消费 Join Plan 返回值，不自行拼接内部地址。

## 9. 非 HTTP 验收面

LiveKit 的交付门禁由部署/QA 脚本承担，不新增浏览器可调用的管理 API：

1. `livekit:acceptance-bundle` 初始化同一 release 的清单、runbook、模板和 manifest。
2. `livekit:server-evidence`、`smoke:media:readiness` 和 `livekit:client-acceptance` 分别生成服务器、自动 readiness 和真实客户端结果。
3. `livekit:evidence-pack` 重新校验 schema、完整 preflight/readiness check、JSON artifact 内容与完整 SHA-256、QA Ed25519 签名、CLI 期望 run metadata、部署模式和当前 24 小时时间窗，再输出 `incomplete` 或 `ready_for_customer_review`。
4. LED 业务代码继续只调用本文件的 iveKit API/SDK；不得通过 API 上传一份自称 `ok=true` 的报告来绕过真实环境门禁。

RustDesk 的真实终端验收同样不新增浏览器管理 API。`rustdesk:client-acceptance` 使用 schema-v2 `real_terminal` 报告，并要求每个检查引用唯一 observation JSON；validator 重算 SHA-256，绑定 run/environment/full commit/external_id/rustdesk_id/time/tool，校验 hbbs/hbbr 和两端客户端版本、平台/架构、target ID、key fingerprint、ID/relay 路径及不同 operator/QA 身份。controlled E2E、Playwright、mock、synthetic、符号链接、越目录、重复、过期、上下文不匹配和含敏感内容的 artifact 均拒绝。缺少真实报告时返回 `not_run`；物理断开 command 成功和人工观察到画面/控制停止是两个独立条件。

Voice 的真实通信验收也不提供可由业务端伪造的 passed API。交付包携带 `acceptance/voice-real-template.json`、`voice-real-runbook.md` 和 `tools/ivekit-voice-acceptance.ts`；45 项检查分别绑定真实 RustPBX、SIP/PSTN、WebPhone/RTP、IVR、Realtime AI、LiveKit SIP bridge、Contact Center、恢复/RLS 和性能 observation。validator 拒绝 controlled/Playwright/mock/fake/synthetic/simulated、符号链接或父目录逃逸、重复、过期、hash/context 不匹配及含 secret 的 artifact。全部通过只返回 `ready_for_review`，不会自动修改 delivery 的 `real_environment.rustpbx=not_run`。

证据文件不得包含 API key、LiveKit token、signed invite 或对象存储 secret。完整检查项、产物关系和执行顺序见 `docs/superpowers/specs/2026-07-11-livekit-acceptance-evidence-design.md`。
