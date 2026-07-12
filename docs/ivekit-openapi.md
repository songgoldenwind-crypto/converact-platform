# iveKit HTTP API 与事件契约

> 契约版本：v1-draft / 2026-07-11。Base path 为 `/api/ivekit`。本文是 LED/OPC 对接用的 Markdown 契约；真实运行能力先读取 capabilities。更完整背景见《iveKit视频IM通用能力详细设计》。

本契约由独立进程 `npm run start:ivekit` 提供，正式 TypeScript 客户端为 `@opc/ivekit-sdk`。稳定域是 `/api/ivekit/media/*`、`/api/ivekit/chat/*` 和 `/api/ivekit/rustdesk/*`；旧 OPC 进程在迁移期间继续提供兼容入口。

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
| 502 | provider 操作失败；Media moderation/终态保持原状态并可重试，消息投递等接口按各自章节保留本地记录 |
| 503 | PostgreSQL/provider/必要配置不可用 |

### 1.3 SDK 映射

`createIveKitClient()` 返回 `media`、`chat`、`rustdesk` 三个客户端，与本文三个 API 域一一对应。Node 后端使用 API key，浏览器使用短期 bearer token；恰好只能配置一种认证方式。Media/Chat 错误类型为 `IveKitHttpSdkError`，RustDesk 错误类型为 `IveKitRustDeskHttpError`，两者都保留 `status/method/path/payload`。`timeoutMs` 触发或网络失败时 `status=0`，幂等写请求必须使用原 `Idempotency-Key` 重试。

录制导出由 SDK 返回 `Uint8Array` 与 MIME/文件名元数据；附件上传接受标准 `BodyInit` 二进制 body，不做 base64 JSON 包装。RustDesk 高层方法 `ensureDevice/startSession` 负责设备、heartbeat 和 launch plan，操作审计与结束/物理断开状态仍是显式步骤。

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
    "provider_inbound_sync": false,
    "durable_provider_delivery": true,
    "message_receipts": true,
    "typing": true,
    "presence": true,
    "message_edit": true,
    "message_soft_delete": true
  },
  "config": {
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
| POST | `/api/ivekit/rustdesk/gateway-sessions/:external_id/events` | 结构化操作审计 |
| GET | `/api/ivekit/rustdesk/gateway-sessions/:external_id/audit` | 审计列表 |
| DELETE | `/api/ivekit/rustdesk/gateway-sessions/:external_id` | 结束控制面会话并触发物理断开命令 |
| GET | `/api/ivekit/rustdesk/gateway-sessions/:external_id/disconnect` | pending/succeeded/failed/unavailable |

Legacy OPC compatibility route `/api/opc/rustdesk/sessions` is attended-only. An omitted
`access_mode` keeps the historical attended create contract; when `remote_session_id` is
provided, active consent and requested consent scopes are rechecked. Unattended creation must use `/api/ivekit/rustdesk/gateway-sessions`, which applies the registered-device, business-ref,
active-policy, expiry, and active-consent checks. The legacy control plane rejects explicit
`access_mode=unattended` and access-mode or unattended aliases hidden in metadata.

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

## 5. 租户 WebSocket 事件

事件 envelope 由 OPC WebSocket 通道提供，data 至少包含 `session_id` 或资源 ID。关键事件：

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
主动关闭连接；参考客户端提前 60 秒刷新短令牌并重新建立 HTTP/WS 客户端。WebSocket
可能断线或丢失瞬时事件。重连后必须 GET snapshot/message-state/realtime-state；事件
不是唯一数据源。

## 6. SDK 方法映射

`createIveKitHttpSdk({baseUrl, tenantId, apiKey|accessToken, userId?, timeoutMs?, fetch?})` 返回：

- `sdk.media.*`：capabilities、room、join、participant、recording、object、export、cleanup。
- `sdk.chat.*`：`listSessions()`、`closeSession()`、`listMessagesPage()`、session、binding、client-plan、participant、message、delivery、receipt、state、mutation、attachment、finding、quality。
- 二进制导出返回 `{bytes, contentType, filename}`。
- 错误为 `IveKitHttpSdkError(status, method, path, payload)`；网络/超时 `status=0`。

RustDesk 使用独立的 `createIveKitRustDeskLedSdk`，因为其设备注册、launch、操作审计和物理断开是一个更高层流程，不塞进通用 JSON client。

## 7. 兼容与未完成边界

1. 当前 API 是 v1 draft 的 additive contract；能力差异先看 capabilities。
2. Tinode inbound seq/cursor 未实现，因为 `direct_client_publish=false` 且 ACL 无 `W`。
3. Tinode 附件/native edit-delete 同步未实现；本地镜像是业务权威。
4. WebSocket 重连增量水位尚未完成，必须 snapshot 收敛。
5. 真实 LiveKit/Tinode/RustDesk/OCR/ASR/AI/PostgreSQL 多副本/网络环境仍待服务器验收。
6. 本地 MemoryPg、fake provider、preflight 不是生产通过证明。
7. `LIVEKIT_URL` 是 OPC、AI Agent、Egress 等服务端可达地址；`LIVEKIT_PUBLIC_URL` 是浏览器 `Room.connect()` 使用的受信任 `wss://` 地址。LED 只消费 Join Plan 返回值，不自行拼接内部地址。

## 8. 非 HTTP 验收面

LiveKit 的交付门禁由部署/QA 脚本承担，不新增浏览器可调用的管理 API：

1. `livekit:acceptance-bundle` 初始化同一 release 的清单、runbook、模板和 manifest。
2. `livekit:server-evidence`、`smoke:media:readiness` 和 `livekit:client-acceptance` 分别生成服务器、自动 readiness 和真实客户端结果。
3. `livekit:evidence-pack` 重新校验 schema、完整 preflight/readiness check、JSON artifact 内容与完整 SHA-256、QA Ed25519 签名、CLI 期望 run metadata、部署模式和当前 24 小时时间窗，再输出 `incomplete` 或 `ready_for_customer_review`。
4. LED 业务代码继续只调用本文件的 iveKit API/SDK；不得通过 API 上传一份自称 `ok=true` 的报告来绕过真实环境门禁。

证据文件不得包含 API key、LiveKit token、signed invite 或对象存储 secret。完整检查项、产物关系和执行顺序见 `docs/superpowers/specs/2026-07-11-livekit-acceptance-evidence-design.md`。
