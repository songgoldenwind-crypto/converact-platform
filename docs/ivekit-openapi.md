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

`createIveKitClient()` 返回 `context`、`media`、`chat`、`intelligence`、`events`、`rustdesk`、`voice`、`ivr`、`contactCenter`、`notifications`、`audit` 和 `retention` 客户端。Node 后端使用 API key，浏览器使用短期 bearer token；恰好只能配置一种认证方式。除 RustDesk 外的 HTTP facade 使用 `IveKitHttpSdkError`，RustDesk 使用 `IveKitRustDeskHttpError`；两者都保留 `status/method/path/payload`。`timeoutMs` 触发或网络失败时 `status=0`，幂等写请求必须使用原 `Idempotency-Key` 重试。

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
  "data": {
    "provider": "livekit",
    "tenant_id": "tenant_led",
    "capabilities": {
      "calls": true,
      "rooms": true,
      "tokens": true,
      "join": true,
      "participants": true,
      "host_moderation": true,
      "recording": true,
      "recording_object_check": true,
      "recording_export": true,
      "recording_retention_cleanup": true,
      "quality_observability": true,
      "connection_rejoin_events": true,
      "webhooks": true,
      "web_assist": true,
      "sip_volte": "planned"
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
}
```

`livekit_server_configured` 表示服务端地址、API key 和 API secret 齐全；`livekit_browser_join_ready` 表示服务端配置完整且浏览器入口有效。生产环境缺任一服务端配置都会拒绝签 token，只有显式配置 `LIVEKIT_PUBLIC_URL=wss://...` 时，浏览器 join 才可能就绪；production 不会签发 `dev-token`。

`data.capabilities.sip_volte` 读取当前 Media Core 实际使用的 gateway registry。registry 启动时按 fail-closed 规则构建：只有 `OPC_SIP_VOLTE_ENABLED=1`，且 `LIVEKIT_URL/API_KEY/API_SECRET`、`LIVEKIT_SIP_BRIDGE_TARGET`、`RUSTPBX_LIVEKIT_TRUNK`、`RUSTPBX_RWI_URL/TOKEN` 全部有效时才返回 `ready`；否则返回 `planned`。修改环境变量后必须重启应用，接口不会绕过当前 registry 动态提升状态。该字段不泄露地址或凭据，也不等价于真实运营商 VoLTE/PSTN 已完成端到端验收。

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
SIP bridge 返回 dial target/trunk 等 metadata。启用 Cell placement 后，WebRTC 响应中的
`livekit_url` 来自该调用的持久化 active owner，而不是全局地址；`token.placement` 同时返回
`region_id`、`zone_id`、`cell_id`、`owner_node_id`、`owner_epoch`、`profile_id` 和
`snapshot_version`。这些字段也写入 LiveKit participant token metadata，用于 Cell 路由和
fencing，但不替代用户授权。未启用 placement 时，`livekit_url` 才使用浏览器可连接的
`LIVEKIT_PUBLIC_URL`，不是服务端 `LIVEKIT_URL`。生产环境缺少公网 URL、owner 尚未 active
或地址不可作为 WebSocket 端点时，Join 会失败关闭。Token 不应写日志或持久化到 LED 业务表。

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
| GET | `/api/ivekit/media/recordings/:recording_id/jobs` | 查询 provider Egress 子任务；返回 selector、状态和对象生命周期，但不暴露 `storage_url` |
| GET | `/api/ivekit/media/recordings/:recording_id/object` | 对象存在性/可读性/checksum 检查并写审计 |
| GET | `/api/ivekit/media/recordings/:recording_id/export` | 鉴权受控二进制导出并写审计 |
| GET | `/api/ivekit/media/recordings/:recording_id/jobs/:job_id/object` | 检查指定轨道/合成产物并写审计 |
| GET | `/api/ivekit/media/recordings/:recording_id/jobs/:job_id/export` | 鉴权导出指定轨道/合成产物并写审计 |
| POST | `/api/ivekit/media/recordings/retention/cleanup` | 默认 dry-run；真实删除要求 `dry_run=false, confirm=true` 和高权限角色 |

Recording start：

```json
{
  "media_call_id": "call_ivekit_1001",
  "business_ref": { "type": "service_order", "id": "SO-1001" },
  "format": "ogg",
  "recording_mode": "track",
  "tracks": [
    { "track_id": "TR_audio", "kind": "audio", "source": "microphone" },
    { "track_id": "TR_video", "kind": "video", "source": "camera" }
  ],
  "retention_days": 90
}
```

`recording_mode` 可为 `track`、`track_composite`、`room_composite`；未传时保持旧行为
`room_composite`。`track` 要求 1..64 条不重复的 `tracks`，每条轨道产生一个独立 job 和
对象；`track_composite` 至少提供 `audio_track_id` 或 `video_track_id`；
`room_composite` 不接受 selector。一个父录制只有在全部 job 完成后才进入 completed，
任一 job 的成功不能覆盖其他 job 的失败。

录制响应包含独立的 `media_call_id` 和 `room_name`；旧的
`call_session_id` 保留给语音/呼叫中心兼容路径。`listRecordings()` 继续返回数组，
`listRecordingsPage()` 返回 `{items,next_cursor,has_more}`。JWT 成员只可读取所属
Media Call 的录制，启动和停止要求该 call 的 `host` 角色；system/API-key 管理模式
保留 tenant 范围能力。公开 recording DTO 不包含 `storage_url`；对象播放与下载必须
调用受鉴权的 `export`。导出默认最多读取 64 MiB，可用
`OPC_RECORDING_EXPORT_MAX_BYTES` 调整至 1 GiB；服务端通过 AsyncIterable 逐块写 HTTP
响应，不聚合完整视频。文件在读取前检查大小，HTTP/S3 在 Content-Length 和逐块累计
两处执行上限，超限会取消上游读取。

父级 `export` 始终导出第一条主 job，保证旧客户端兼容；多轨客户端先调用
`listRecordingJobs()`，再用 `inspectRecordingJobObject()` / `exportRecordingJobObject()`
访问指定产物。保留清理逐个处理全部 job 对象，成功子对象记录 `deleted` 并在重试时跳过；
只有所有对象均已删除或不存在且证据生命周期同步成功，父录制才进入 `deleted`。

公开 Egress job DTO 只返回调用方需要的 selector、模式、状态、错误和对象生命周期；
`storage_url`、Cell `reservation_id`、`owner_epoch`、provider missing 观察次数以及 reconciliation
lease/worker/attempt 字段均为服务端内部状态，不通过 API/SDK 暴露。每个 child job 在请求
provider 前取得独立 Cell reservation，provider 接受后激活；终态 Webhook 以及后台对账
都使用原 reservation/epoch 精确释放，旧 owner 的迟到事件不能释放新任务容量。

后台 reconciliation 使用 PostgreSQL lease 处理长时间停留在
`starting|recording|stopping` 的 job。provider 明确返回终态时直接收敛；provider 返回
missing 时必须经过两次独立观察才标记失败。终态释放失败返回/保留可重试状态，不伪造容量
已归还；failed Egress webhook 不调用 recording-completed hook。部署侧可分别通过
`OPC_IVEKIT_PLACEMENT_EGRESS_TRACK_POLICY_JSON` 与
`OPC_IVEKIT_PLACEMENT_EGRESS_COMPOSITE_POLICY_JSON` 约束两个 pool，使用
`OPC_LIVEKIT_EGRESS_CAPACITY_METRICS_ENABLED` 和
`OPC_LIVEKIT_EGRESS_CAPACITY_METRICS_INTERVAL_MS` 开启控制面聚合指标。Helm 模板提供各 pool
独立 KEDA/HPA、ServiceMonitor 和告警，但这些模板与受控测试不构成真实容量通过证明。

同一 tenant 的同一房间只允许一个 `starting/pending/recording/stopping` 录制；
重复启动返回 `409`。JWT 启动时 `media_call_id` 对应的持久化 `room_name`
必须与路径房间一致，否则按不可见资源返回 `404`。

### 2.6 QoS、断线状态与重入审计

| Method | Path | 说明 |
| --- | --- | --- |
| POST | `/api/ivekit/media/calls/:call_id/qos` | 上报 1..100 条有界 track QoS snapshot；普通用户只能上报自己的 identity |
| GET | `/api/ivekit/media/calls/:call_id/qos` | 返回参与人的连接/质量状态及最近 1..500 条安全 snapshot |
| POST | `/api/ivekit/media/calls/:call_id/connection-events` | 上报幂等、单调的连接与重入事件 |

QoS snapshot 只接受 `participant_identity`、`connection_revision`、`sample_id`、
`track_source`、`quality_level`、RTT、jitter、packet loss、bitrate、quality score 和
服务端允许时间窗口内的 `sampled_at`。未知字段一律返回 `400`，因此 SDP、ICE
candidate、IP、设备 label、token 和任意 metadata 不能进入数据库、事件或日志。
同一 revision/sample/track 重放且 payload hash 一致时计为 replay；不同 payload
返回 `409`，不会悄悄覆盖历史。

默认连续 3 个劣化 sample 才从 `unknown|good` 进入 `degraded`，连续 3 个恢复
sample 才进入 `good` 并产生 recovered。阈值由以下变量配置：

```text
OPC_MEDIA_QOS_DEGRADED_SAMPLES=3
OPC_MEDIA_QOS_RECOVERY_SAMPLES=3
OPC_MEDIA_QOS_DEGRADED_RTT_MS=300
OPC_MEDIA_QOS_DEGRADED_JITTER_MS=60
OPC_MEDIA_QOS_DEGRADED_PACKET_LOSS_RATIO=0.05
OPC_MEDIA_QOS_DEGRADED_QUALITY_SCORE=2.5
OPC_MEDIA_QOS_RETENTION_MS=604800000
OPC_MEDIA_QOS_MAX_SAMPLE_AGE_MS=300000
OPC_MEDIA_CONNECTION_MAX_EVENT_AGE_MS=86400000
OPC_MEDIA_QOS_MAX_FUTURE_SKEW_MS=30000
```

Connection event 使用 caller 生成的 `event_id` 幂等，revision 必须单调；同 revision
的 `occurred_at` 也不能早于当前状态。旧 adapter 的新事件返回 `409`，但之前成功的
旧 event id 仍可安全重放。受支持事件为 `connected/reconnecting/reconnected/`
`disconnected/rejoining/rejoined/failed`。公开事件只有 call、participant、event、
revision/state、受限 reason code 和时间：

```text
ivekit.media.qos.degraded
ivekit.media.qos.recovered
ivekit.media.connection.connected
ivekit.media.connection.reconnecting
ivekit.media.connection.reconnected
ivekit.media.connection.disconnected
ivekit.media.connection.rejoining
ivekit.media.connection.rejoined
ivekit.media.connection.failed
```

SDK 方法为 `media.reportCallQuality()`、`media.getCallQuality()` 和
`media.reportCallConnectionEvent()`。Prometheus 暴露
`opc_ivekit_media_qos_samples_total`、`opc_ivekit_media_qos_rtt_seconds`、
`opc_ivekit_media_qos_packet_loss_ratio`、`opc_ivekit_media_qos_transitions_total` 和
`opc_ivekit_media_connection_events_total`；label 仅使用固定 result、track source 和
event type，不使用 tenant、call 或 participant ID。

参考客户端把 LiveKit 原生 `reconnecting/reconnected` 视为同一
`connection_revision` 内的短暂恢复，不重建 Room。收到 terminal disconnect 后，
客户端按 `1s/2s/5s/10s/30s` 有界退避；离线或页面不可见时暂停，恢复 online/visible
后只启动一个 in-flight 重入。每次重入必须先重新读取 call，再取得新的 join plan/token
并创建新的 adapter；旧 adapter 与旧请求的事件由 call request id、adapter identity 和
单调 adapter epoch 三层隔离。

重入只自动恢复用户先前启用的麦克风和摄像头。屏幕共享及系统音频不会静默恢复；连接
恢复后客户端显示显式操作，用户再次确认浏览器共享选择器后才发布 screen-share track。
call 结束、成员撤权、切换 call 或组件卸载会取消 timer、停止后续重入并销毁当前 adapter。
连接事件按客户端串行 best-effort 队列上报；上报失败不阻断本地媒体恢复，服务端仍以
幂等 event id 和单调 revision 拒绝迟到或冲突写入。

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

`provider_delivery.status` 还包含两个文件门禁状态：`blocked_by_file_security` 表示至少一个安全文件仍在 scanning/processing，worker 不创建 attempt、不调用 Tinode；`blocked` 表示文件已 quarantined/failed/expired，是终态。所有文件达到 `ready + clean` 后，前者持久化迁回 `pending`。即时文件回调和 Tinode worker tenant-discovery 都能触发收敛，进程崩溃不会永久丢失唤醒。

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

仅原发送者可在 `OPC_CHAT_MESSAGE_MUTATION_WINDOW_MS` 内修改文本。编辑后重扫 policy；删除为软删除，原 `body` 留作审计，对外 `body=''`。mutation 只存前后 SHA-256，不复制历史正文。已绑定 Tinode 且已有 provider sequence 的消息会在同一 PostgreSQL 事务写入 mutation outbox：edit 使用 replacement publish，delete 使用目标 sequence delete；LED UI 始终以 iveKit snapshot/事件为权威，并通过响应中的 `provider_mutation.status` 展示 `pending|processing|retry_wait|delivered|dead_letter`。

连接、登录或订阅阶段失败会进行有界退避重试。edit `pub` 已发送但 ACK 超时/连接关闭时，系统无法证明 Provider 是否已提交 replacement，因此立即以 `provider_outcome_uncertain` 进入 dead letter，禁止自动重发。同样，进程在 edit 发送后、完成状态落库前退出时，新 worker 接管过期 `processing` lease 也会按结果未知死信，而不是再发一次 edit；delete 保持可重试。管理员必须先核对 Tinode 原生状态，再通过 3.8 的 mutation dead-letter API 显式重放；稳定 `x-opc-mutation-id` 用于入站回环抑制与对账，但不被误当成 Tinode 原生幂等保证。

若丢失的 ACK 之后到达一个可验证的 Tinode mutation echo，inbound 会在同一事务将 outbox 从 `dead_letter|processing|retry_wait|pending` 纠正为 `delivered`，并用稳定幂等键把 `collaboration.message.provider_mutation_updated` 写入 durable tenant event journal。事务提交后只负责广播同一个已持久化事件；即使实时广播失败，HTTP replay/Webhook 仍能恢复纠正。事件包含 `status=delivered` 和 `reconciled_from_status`，消费者应单调更新之前的 dead-letter 投影；同一 inbound inbox 事件或广播重放不会产生第二条逻辑纠正。

### 3.6 附件、OCR/ASR

| Method | Path | 说明 |
| --- | --- | --- |
| POST | `/api/ivekit/chat/sessions/:session_id/attachments/upload?kind=image&filename=x.png` | 二进制 body；MIME/大小门禁 |
| GET | `/api/ivekit/chat/sessions/:session_id/attachments/:attachment_id` | attachment + 兼容 `job` + 完整 `jobs[]` + hash-only `observations[]` |
| GET | `/api/ivekit/chat/sessions/:session_id/attachments/:attachment_id/download` | 鉴权二进制下载；返回 MIME 和 Content-Disposition |
| POST | `/api/ivekit/chat/sessions/:session_id/attachments/:attachment_id/retry` | 重新排 OCR/ASR |
| POST | `/api/ivekit/chat/attachment-processing/run` | 运维/测试 due batch；生产通常 worker 驱动 |

旧上传接口是小文件兼容 facade，iveKit 路径内部仍创建 single 安全文件并返回 `secure_file_id`；上传完成后先处于 `scanning`，只有安全文件达到 `ready + clean` 才可绑定消息、下载或进入 OCR/ASR。新接入应优先使用 3.7 节 `/files` 协议。创建消息时附件只需提交 `{ "secure_file_id": "..." }`，服务端从安全文件权威记录派生 kind、文件名、MIME、大小和摘要，忽略客户端伪造值。直接 `/api/collaboration` 路径保留旧存储兼容行为，不属于 iveKit 对 LED 的安全合同。

浏览器 SDK 的 `uploadAttachmentWithProgress()` 使用 XHR 报告字节进度并返回 `{result,abort}`；Node 使用可注入 fetch fallback。每次上传尝试生成新的 `x-upload-id`，但随后创建消息时重试必须复用原 `Idempotency-Key`。文件不做 base64 转换。图片走 OCR，音频走 ASR，video/screen_recording 同时建立 `asr` 和 `video_frame_ocr` 两个 durable job；后者复用 OCR profile、配额、熔断和故障切换。一个任务失败不会覆盖另一个任务的成功文本，部分成功返回 `processing_status=ready` 和 `processing_error_code=partial_processing_failure`。提取文本回填后重新执行 policy 和 AI 质检。客户端状态可区分 `uploading/uploaded/scanning/attached/processing_pending/processing/retry_wait/completed/failed/provider_unconfigured/cancelled`。真实 provider 仍需服务器选型/验收。

OCR Provider 可返回 `qr_code|barcode|text_region` observation。iveKit 只在处理事务内读取 `value` 做规则扫描，持久层、API、SDK、事件和日志只保存/返回 `value_hash`、码制、置信度、帧时间、页码、job id 和 detector version。`IveKitVisualObservation` 明确没有 `value` 字段。视频抽帧由 Provider 执行；代码入口和受控 fixture 通过不等于真实视频识别质量通过。

兼容 descriptor 不返回对象 key 或 MinIO/S3 地址；其下载 URL 仅指向按 tenant、session 和 attachment 鉴权的 iveKit facade，也不暴露 `/api/call-center/media/*`。安全文件 DTO 永不返回 `storage_url`，客户端只使用 `/files/:file_id/download`。

### 3.7 安全文件与断点续传

安全文件协议是新附件、录屏、OCR/ASR 输入及跨项目文件传输的统一入口。单文件和 multipart 最终都进入同一状态机：`initiated -> uploading -> scanning -> processing -> ready`；感染、MIME 冲突或扫描异常进入 `quarantined|failed`，中止和保留期清理进入 `expired`。只有 `status=ready` 且 `threat_status=clean` 可下载或绑定消息，`scanning/processing` 不代表可用。

| Method | Path | 说明 |
| --- | --- | --- |
| POST | `/api/ivekit/chat/sessions/:session_id/files` | 创建 single/multipart 上传；必须带 `Idempotency-Key` |
| PUT | `/api/ivekit/chat/sessions/:session_id/files/:file_id/content` | single 二进制上传；必须带 `X-Content-SHA256` |
| PUT | `/api/ivekit/chat/sessions/:session_id/files/:file_id/parts/:part_number` | 预留并上传一个固定大小 part；同编号不同摘要返回 409 |
| GET | `/api/ivekit/chat/sessions/:session_id/files/:file_id/parts` | 查询已上传 part，断线后据此续传 |
| POST | `/api/ivekit/chat/sessions/:session_id/files/:file_id/complete` | `{size_bytes,sha256}` 完成 multipart 并进入 scanning |
| GET | `/api/ivekit/chat/sessions/:session_id/files/:file_id` | 查询安全状态、MIME 和派生文件进度 |
| DELETE | `/api/ivekit/chat/sessions/:session_id/files/:file_id` | 幂等中止尚未完成的上传 |
| GET | `/api/ivekit/chat/sessions/:session_id/files/:file_id/download` | 仅下载 ready + clean 的完整性校验后字节 |

创建 body 示例：

```json
{
  "kind": "video",
  "filename": "inspection.webm",
  "declared_mime": "video/webm",
  "upload_mode": "multipart",
  "expected_size_bytes": 104857600,
  "part_size_bytes": 8388608,
  "retention_until": "2026-08-15T00:00:00.000Z"
}
```

part 必须从 1 连续编号；除最后一块外大小等于创建时的 `part_size_bytes`。服务端先按编号、大小和摘要预留数据库记录，再写对象存储，避免两个不同 payload 并发覆盖同一 S3 part。相同 part 可安全重放；complete、中止和同 payload 创建也可安全重放。上传服务器缓冲上限由 `OPC_SECURE_FILE_UPLOAD_MAX_BYTES` 控制，默认 64 MiB、最大 512 MiB；超大文件应使用 multipart，不应发送 base64 JSON。

公开 DTO 不含 `object_key`、`upload_id`、`storage_url`、原始 provider metadata、scanner request id、lease 或 worker id。下载响应带 `X-Content-SHA256` 与 `Content-Disposition`。扫描后图片生成缩略图，视频生成缩略图和转码，音频生成转码；派生任务失败时父文件 fail-closed，不会伪装 ready。清理 worker 默认 dry-run，只有部署同时启用和确认后才删除对象。

SDK 对应方法为 `createSecureFile()`、`uploadSecureFileContent()`、`uploadSecureFilePart()`、`listSecureFileParts()`、`completeSecureFile()`、`getSecureFile()`、`abortSecureFile()` 和 `downloadSecureFile()`。状态事件为 `collaboration.secure_file.created`、`collaboration.secure_file.part_uploaded`、`collaboration.secure_file.uploaded` 和 `collaboration.secure_file.aborted`，payload 使用同一安全 DTO。

### 3.8 Tinode 入站安全文件与生产运维

Tinode Drafty 外链附件不会直接成为消息附件。worker 只接受显式 `OPC_TINODE_ATTACHMENT_ALLOWED_HOSTS` 内的 HTTPS URL，禁止凭据 URL 和重定向，并按 `OPC_TINODE_INBOUND_ATTACHMENT_MAX_BYTES`、`OPC_TINODE_INBOUND_ATTACHMENT_TIMEOUT_MS` 有界读取。下载字节进入与 3.7 相同的安全文件状态机；声明 MIME 不可信，最终以 magic-byte、病毒扫描和派生结果为准。网络/超时保持 cursor 重试；超限、重定向等确定性拒绝写入不含源 URL 的 dead letter；扫描等待写为 retryable dead letter，文件 ready 后在 binding lease 内投影消息。最终 attachment 只保存 `secure_file_id` 和权威 MIME/大小/摘要。

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/ivekit/chat/operations/tinode` | owner/admin/system 查看 delivery queue、cursor lag、dead letter 和文件门禁快照 |
| GET | `/api/ivekit/chat/operations/tinode/dead-letters?state=open&limit=100` | 脱敏死信；不返回 normalized payload、外链或附件字节 |
| POST | `/api/ivekit/chat/operations/tinode/dead-letters/:dead_letter_id/replay` | 带 `Idempotency-Key` 请求人工重放；写独立审计记录，不 inline 投影 |
| GET | `/api/ivekit/chat/operations/tinode/mutation-dead-letters?limit=100` | 列出 edit/delete 原生同步死信；不返回消息正文或 Provider payload |
| POST | `/api/ivekit/chat/operations/tinode/mutation-dead-letters/:outbox_id/replay` | 管理员核对 Provider 状态后带 `Idempotency-Key` 人工重放；不确定 edit 禁止自动重放 |

Prometheus 指标为 `opc_ivekit_tinode_delivery_queue_messages`、`opc_ivekit_tinode_delivery_queue_lag_seconds`、`opc_ivekit_tinode_inbound_cursor_lag_sequences`、`opc_ivekit_tinode_inbound_dead_letters`、`opc_ivekit_tinode_file_blocked_messages` 和 `opc_ivekit_tinode_file_gate_transitions_total`。快照和标签均使用有界状态，不带 tenant、message、file 或 provider user 等高基数字段。

SDK 方法为 `getTinodeOperations()`、`listTinodeDeadLetters()`、`replayTinodeDeadLetter()`、`listTinodeMutationDeadLetters()` 和 `replayTinodeMutationDeadLetter()`。文件门禁事件为 `collaboration.message.delivery_blocked_by_file_security`、`collaboration.message.delivery_unblocked`、`collaboration.message.delivery_blocked`；人工重放事件为 `collaboration.tinode.dead_letter.replay_requested` 和 `collaboration.tinode.mutation_dead_letter.replay_requested`。

### 3.9 finding、AI 质检和人审

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/ivekit/chat/sessions/:session_id/findings` | query: `message_id/source/review_status/limit` |
| GET | `/api/ivekit/chat/sessions/:session_id/findings/:finding_id` | finding + review history |
| POST | `/api/ivekit/chat/sessions/:session_id/findings/:finding_id/review` | confirmed/false_positive/escalated/resolved |
| GET | `/api/ivekit/chat/sessions/:session_id/messages/:message_id/quality-review` | AI job |
| POST | `/api/ivekit/chat/sessions/:session_id/messages/:message_id/quality-review` | 按当前内容哈希入队 |
| POST | `/api/ivekit/chat/quality-review/run` | 运维/测试 due batch |

确定性扫描支持混淆手机号、邮箱和微信/WhatsApp/Telegram/QQ 意图。每次单源扫描还会读取同租户同会话最近 20 条未删除消息及附件识别结果，在 20,000 字符上限内检测分段号码、上一条联系意图加下一条账号、文字意图加视觉码；会话级 finding 使用 `source=aggregate`、空 `message_id` 和版本化 evidence refs。窗口外、已删除和跨租户内容不参与，聚合原文不入库。

AI 质检输入为目标消息加最近 20 条会话上下文，单项最多 4,000 字符、总计最多 40,000 字符，并带明确 message/attachment source label。任务 `input_hash` 同时绑定消息编辑版本、附件 checksum/识别版本、规则 finding fingerprint、detector/policy/evidence 版本；任一变化会先重排任务，不会用旧快照调用 Provider。AI finding 的执行 action 固定为 `review`；provider 的建议只进入脱敏 metadata。模型不能直接封单、处罚或执行不可逆动作。

人工复核只允许会话内仍活跃的 `agent/engineer/supervisor/admin` 参与人；`customer/ai`、已离开参与人和跨租户身份返回 `403`。参考客户端按 `high/medium/low` 排序并按 fingerprint 去重，消息只显示克制的风险标记；详情仅呈现二次脱敏 rationale、证据类型和不可变 review history，不展示 `matched_text_hash`、fingerprint、checksum 或 provider 私有 metadata。复核提交必须填写原因，切换 finding/会话会清空未提交原因，实时 finding 更新按 `updated_at` 重新加载详情；窄屏通过可关闭抽屉完成同一复核流程。重复提交当前状态返回 `200` 和 `review=null`，不广播重复事件，客户端也按 review audit ID 去重。

### 3.10 Intelligence policy、Provider 与租户审核队列

| Method | Path | RBAC | 说明 |
| --- | --- | --- | --- |
| GET | `/api/ivekit/intelligence/capabilities` | authenticated | 返回 enabled/automatic/available/reason、有序 `provider_profile_ids` 和逐候选可用性 |
| GET | `/api/ivekit/intelligence/policy` | owner/admin/system | 返回租户策略和乐观锁 `version` |
| PUT | `/api/ivekit/intelligence/policy` | owner/admin/system | 全量策略写入；每种能力支持最多 10 个有序 profile；版本冲突 409 |
| GET | `/api/ivekit/intelligence/providers` | owner/admin/system | 返回脱敏 profile、凭据状态、配额/并发/熔断预算 |
| GET | `/api/ivekit/intelligence/providers/runtime` | owner/admin/system | 返回租户级计数器、熔断状态和最近成功/失败，不返回 URL/token |
| POST | `/api/ivekit/intelligence/providers/health` | owner/admin/system | 可选 `profile_ids[]`，返回健康等级和延迟，不返回 URL/token |
| GET | `/api/ivekit/intelligence/findings` | operator/admin/system | 租户审核队列；支持 session/source/severity/status/time/cursor/limit |
| GET | `/api/ivekit/intelligence/findings/:finding_id` | operator/admin/system | finding 与不可变 review history |
| POST | `/api/ivekit/intelligence/findings/:finding_id/review` | operator/admin/system | confirmed/false_positive/resolved/escalated |

policy 字段包括四类 enabled、兼容主 profile id、有序 `*_profile_ids`、automatic、`allow_third_party`、目标语言和 OCR/ASR confidence threshold。路由仅按数组顺序执行；只对可重试错误、配额、熔断或不可用候选执行 fallback，普通 4xx/非法输入等终态错误不会跨 Provider 转发。第三方 profile 只有在 `allow_third_party=true` 时可选。路由耗尽统一使用 `provider_route_unavailable`；运行时拒绝原因包括 `minute_quota_exhausted`、`day_quota_exhausted`、`concurrency_exhausted`、`circuit_open` 和 `circuit_half_open_busy`。租户队列的 `source` 支持 `text|ocr|asr|aggregate|ai`，finding 返回 detector/policy/evidence snapshot/content version。该队列供 Quality 工作区使用，不要求审核员仍是每个会话的 participant，但仍受 tenant、RBAC、软删除和 RLS 约束；普通 viewer 返回 403。

### 3.11 录制源导入与翻译

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
| POST | `/api/ivekit/rustdesk/edge/heartbeat` | device-bound token 心跳；只匹配预注册的 tenant/business ref/RustDesk ID |
| POST | `/api/ivekit/rustdesk/devices/:device_id/commands/claim` | edge 领取精准断开命令；返回指定 `controller_rustdesk_id` 和短期 claim token |
| POST | `/api/ivekit/rustdesk/devices/:device_id/commands/:command_id/progress` | edge 上报精准断开中间状态 |
| POST | `/api/ivekit/rustdesk/devices/:device_id/commands/:command_id/result` | edge 幂等提交命令结果 |
| POST | `/api/ivekit/rustdesk/devices/:device_id/commands/:command_id/recover` | companion 重启后恢复 durable command |
| POST | `/api/ivekit/rustdesk/devices/:device_id/observations` | device-bound token 批量上报 operation observation，1-100 条 |
| GET | `/api/ivekit/rustdesk/devices/:device_id/evidence-context` | edge 获取 30 秒有效的设备/控制者/操作授权绑定，不返回 token、内容或本地路径 |
| POST | `/api/ivekit/rustdesk/devices/:device_id/evidence` | 创建与 gateway operation 绑定的安全文件/录屏上传；要求 `Idempotency-Key` |
| PUT | `/api/ivekit/rustdesk/devices/:device_id/evidence/:file_id/content` | 单文件上传；要求 `X-Content-SHA256` |
| GET/PUT | `/api/ivekit/rustdesk/devices/:device_id/evidence/:file_id/parts[/:part_number]` | 查询已上传分片或上传单个分片 |
| POST | `/api/ivekit/rustdesk/devices/:device_id/evidence/:file_id/complete` | 按总字节数和 SHA-256 完成分片上传 |
| GET/DELETE | `/api/ivekit/rustdesk/devices/:device_id/evidence/:file_id` | 读取脱敏状态或终止上传；不返回 object key/storage URL |
| POST | `/api/ivekit/rustdesk/authorization-codes` | 客户/admin 创建 attended 一次性授权码；要求 `Idempotency-Key` |
| GET | `/api/ivekit/rustdesk/authorization-codes/:authorization_id` | active participant 读取脱敏状态，不返回 code/salt/HMAC |
| POST | `/api/ivekit/rustdesk/authorization-codes/:authorization_id/verify` | agent/engineer/supervisor/admin 提交 8 位 code 并绑定身份 |
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
| POST | `/api/ivekit/rustdesk/gateway-sessions/:external_id/disconnect/emergency-fallback` | 精准断开失败后，由 owner/admin 显式确认可能影响同机其它会话的服务重启降级 |

attended 授权码不是 RustDesk password，也不能替代 active consent、participant、device、
business ref、scope 或 control ownership。创建请求只允许当前会话的 active `customer/admin`，
并要求 device 与 remote session 指向同一 business ref、请求 scopes 被 active consent 覆盖。
首次 `201` 响应为 `{authorization,code,replayed:false}`，`code` 是 8 位数字且只返回一次；同一
`Idempotency-Key` 的等价重试返回 `{authorization,code:null,replayed:true}`。数据库只保存随机
salt 与 server-side pepper HMAC，默认 TTL 300 秒、范围 60-900 秒，默认最多 5 次、范围 1-10 次。
错误 code 使用统一 403，不披露 pending/expired/locked/not-found 差异。

验证成功后 authorization 绑定当前 active engineer identity。`OPC_RUSTDESK_REQUIRE_AUTHORIZATION_CODE=1`
时，attended `POST .../gateway-sessions` 必须携带顶层 `authorization_id`；启动前后都会重新检查
tenant/remote/device/scopes/engineer/consent，网关激活与 consume 位于同一 PostgreSQL 事务。
上游创建或复核失败不会消耗 code；成功后状态为 `consumed` 并绑定唯一
`consumed_external_id`，重放失败。该开关关闭时保持旧 attended 合同；调用方一旦主动传入
`authorization_id`，仍按严格规则验证并消费。unattended 不使用此 code，继续执行 access policy
与 `unattended_launch` 二次确认。部署严格模式还必须注入至少 32 bytes 的
`OPC_RUSTDESK_AUTHORIZATION_CODE_SECRET`。

SDK 对应方法为 `requestAuthorizationCode(input,{idempotencyKey})`、
`getAuthorizationCode(id)`、`verifyAuthorizationCode(id,{code})`；
`startGatewaySession()` 和 LED 高层 `startSession()` 分别接受 `authorization_id` 与
`authorizationId`。raw code 只能由客户侧首次响应安全转交工程师，禁止写日志、事件、metrics、
metadata、URL、spool 或持久化；所有事件只携带 `authorization_id` 和非秘密状态。

Windows companion 的 edge 路由不接受业务 API key/JWT，固定使用
`x-rustdesk-edge-token`。token 签名身份绑定 tenant、RustDesk runtime ID 和 edge instance；heartbeat
只允许解析已有 active device，不允许终端自注册。观测 URL 中的 `device_id` 还必须与 token、目标
gateway session 和 RustDesk ID 一致。LED/OPC 业务服务不调用这些路由，也不得持有 device token。

观测批次 body 固定为 `{observations:[...]}`，禁止其它顶层字段。每条观测允许字段为
`external_id/operation_id/operation/status/observer/source_adapter/observed_at/evidence_refs` 及受限的
provider ID、direction、display ID、byte count、SHA-256、duration、reason、status detail、control
version。`source_adapter` 只允许 `native_client|rustdesk_log|companion_hook`，并与 `observer` 配对；
终端不能提交 actor、target 或任意 metadata。结束会话、错误设备、过期 control version、越权 scope、
敏感正文和未来/会话前时间均拒绝。control/file/clipboard 的 actor 由服务端当前 control owner 决定，
存储事务会再次校验 ownership，避免检查后换人的竞态。

companion 监听 `OPC_RUSTDESK_EDGE_OBSERVATION_INPUT_DIR` 中通过原子 rename 放入的 `.json` 文件，先
写入 `OPC_RUSTDESK_EDGE_OBSERVATION_SPOOL_DIR`，再删除 inbox 文件并上传。状态机为
`received -> forwarding -> forwarded|dead_letter`；重启会回收过期 forwarding lease，批次重试依赖
服务端幂等键。成功终态删除原始 observation，仅保留 SHA-256；非法输入进入只含文件名、hash、
原因和时间的脱敏 quarantine。token、剪贴板/文件/画面/按键/录屏正文不会写入 spool。

文件和录屏有三种明确且不可混淆的安全标签：`ivekit_secure_file` 表示字节已进入 iveKit 安全文件
状态机；`native_unscanned` 表示 RustDesk 原生文件传输未经过 iveKit 扫描；`local_only` 表示录屏只在
终端本地。`native_unscanned` 和 `local_only` 不能生成已扫描/可下载结论。`ivekit_secure_file` observation
必须携带实际 byte count、完整 SHA-256 和唯一 `ivekit-secure-file://<file_id>` 引用；服务端会复核
tenant、device、edge instance、gateway session、operation、size 和 hash。文件仍处于 `scanning` 或
`processing` 时可写审计引用，但在 Stage 2 安全状态机进入 `ready` 前不可下载或进入 OCR/ASR。

定制 RustDesk 1.4.7 客户端默认从 `%ProgramData%\iveKit\RustDesk\state\native-evidence-roots-v1.txt`
读取文件传输和录屏白名单。启动时只建立现有文件基线；之后的新文件必须是非链接普通文件、连续两次
扫描保持大小稳定，才会在 `OPC_RUSTDESK_NATIVE_EVIDENCE_CANDIDATE_DIR` 原子生成不含文件正文的候选记录。
候选记录只携带根类型、受控源路径、文件名、字节数、观察时间和当时 active controller RustDesk ID。

companion 使用 device token 调用 `/evidence-context`，按 device、controller、operation、预期文件名和
时间窗做唯一匹配。零个或多个匹配都不会上传；超过 `OPC_RUSTDESK_NATIVE_EVIDENCE_MAX_PENDING_MS`
仍不能唯一匹配时，只写脱敏 quarantine。唯一匹配会转换为固定 `rustdesk-native-evidence-v1` event，
再由 watcher 将受控副本送入 `OPC_RUSTDESK_EDGE_EVIDENCE_INPUT_DIR`，恢复状态写入
`OPC_RUSTDESK_EDGE_EVIDENCE_SPOOL_DIR`。uploader 随后进入统一 secure-file 流程。

gateway session 结束后保留 15 分钟 finalization window，用于 RustDesk 在断开后 flush 并稳定录屏文件。`observed_at` 和服务端收到时间都必须不晚于 `ended_at + 15min`；超过窗口仍返回 409，不会因为客户端回拨时钟而无限延长。

`Publish-IveKitRustDeskEvidence.ps1` 仅是故障恢复工具，不是正常 producer。它生成的 manifest 只允许：

```json
{
  "schema_version": 1,
  "external_id": "rdgw-session-id",
  "operation_id": "stable-operation-id",
  "kind": "screen_recording",
  "payload_filename": "opaque-payload-name.webm",
  "filename": "remote-session.webm",
  "declared_mime": "video/webm",
  "observed_at": "2026-07-15T08:00:00.000Z",
  "retention_until": "2026-08-15T00:00:00.000Z"
}
```

`kind=file` 还必须有 `direction=upload|download` 和当前 `control_version`。manifest 禁止 `local_path`
和任意未知字段，payload filename 必须是 basename。上传器流式计算 SHA-256，小文件单次上传，大文件
分片；每次重启从服务端 `/parts` 恢复，secure file ID、part size 和幂等键保持不变。成功后原子生成
`ivekit_secure_file` observation，并先持久化 `uploaded + manifest` 清理状态；删除 payload 成功或确认
文件已不存在后才移除 manifest。Windows 文件锁、杀毒软件或 ACL 导致删除失败时，重启后只重试本地
删除，不会再次上传远端内容，也不会留下失去索引的敏感孤儿文件。状态文件不保存 token 或绝对路径。非法
manifest 只留下文件名、原文 hash、原因和时间。LED/OPC 业务 SDK 不直接调用这些 device-token 路由。

不可重试 4xx 或达到最大尝试次数的记录进入本地 `dead_letter`，payload 与可追踪状态一起保留，不会被终态压缩单独抛弃。`OPC_RUSTDESK_EDGE_EVIDENCE_DEAD_LETTER_RETENTION_MS` 默认 7 天；到期或超过 `OPC_RUSTDESK_EDGE_EVIDENCE_MAX_TERMINAL_RECORDS` 时先删除受管 payload，再原子移除状态。secure-file 已成功上传的服务端保留策略不受该设备侧参数影响。ready/clean 证据的智能补偿会对确定的 `unsupported|ignored` 写持久终态标记，使其退出候选队列；`not_ready` 和异常仍保持可重试，旧不支持文件不会饿死后续 OCR/ASR/AI 任务。

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
| POST | `/api/ivekit/voice/providers/:profile_id/recording-spool/segments` | RustPBX sidecar 服务密钥；注册或幂等重放 owner-fenced segment manifest，租户由 profile 鉴权上下文派生 |
| PUT | `/api/ivekit/voice/providers/:profile_id/recording-spool/segments/:segment_id/parts/:part_number` | RustPBX sidecar 服务密钥；流式写入分片并以 segment upload lease 约束并发 |
| POST | `/api/ivekit/voice/providers/:profile_id/recording-spool/segments/:segment_id/complete` | RustPBX sidecar 服务密钥；校验完整字节数和 SHA-256 后幂等确认 segment |
| POST | `/api/ivekit/voice/providers/:profile_id/recording-spool/recordings/:recording_id/complete` | RustPBX sidecar 服务密钥；校验 owner/topology 与连续 `1..N` 已上传 segment 后封账整通录音 |

上述 `/voice/providers/*` 路径是组件到 iveKit 的内部接口，不面向 LED 浏览器、普通 API key
或第三方客户端，因此不进入公共 `docs/openapi.yaml`；其合同以本表、固定 Provider 鉴权测试和
RustPBX sidecar 实现为准。业务集成只查询录音 metadata 和订阅状态事件，不直接上传分段。

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

### 5.5 通知 HTTP 路径与状态语义

通知模块以 PostgreSQL Notification/Delivery 为权威，不在业务请求事务内直连发送。用户态接口绑定当前 tenant 和用户；Endpoint、模板、全租户 Delivery、测试、归档及重试要求 `owner|admin|system`。Provider receipt 使用独立签名鉴权，不接受用户 JWT 代替。

| Method | Path | 角色与结果 |
| --- | --- | --- |
| GET | `/api/ivekit/notifications/capabilities` | 返回四 channel、管理面、投递操作和 `active_health_checks`；`mobile_push=false` |
| POST | `/api/ivekit/notifications` | operator + `Idempotency-Key`；创建逻辑通知和每 channel 的耐久 Delivery |
| GET | `/api/ivekit/notifications/:notification_id` | tenant-scoped safe projection，不返回 content ciphertext |
| GET | `/api/ivekit/notifications/inbox` | 当前用户游标页；admin 可显式查询 tenant 内用户 |
| GET | `/api/ivekit/notifications/inbox/unread-count` | 当前用户未读数 |
| POST | `/api/ivekit/notifications/inbox/:item_id/:action` | `action=read|unread|archive|unarchive` |
| GET/POST | `/api/ivekit/notifications/endpoints` | admin 查询/幂等创建 Webhook、SMTP、HTTP 邮件/短信 Endpoint |
| GET/PUT | `/api/ivekit/notifications/endpoints/:endpoint_id` | admin 查询；`expected_revision` 乐观更新 |
| POST | `/api/ivekit/notifications/endpoints/:endpoint_id/test` | admin + `Idempotency-Key`；经正常队列创建 `max_attempts=1` 测试投递 |
| POST | `/api/ivekit/notifications/endpoints/:endpoint_id/archive` | admin + `expected_revision`；逻辑归档 |
| GET/POST | `/api/ivekit/notifications/templates` | admin 查询/创建模板和 revision 1 |
| GET/PUT | `/api/ivekit/notifications/templates/:template_id` | admin 查询；追加不可变草稿版本 |
| GET | `/api/ivekit/notifications/templates/:template_id/versions` | admin 按 locale/cursor 查询版本 |
| POST | `/api/ivekit/notifications/templates/:template_id/publish` | admin + revision；发布指定 locale 版本 |
| POST | `/api/ivekit/notifications/templates/:template_id/archive` | admin + revision；归档模板 |
| GET | `/api/ivekit/notifications/preferences` | 当前用户偏好；admin 可显式指定用户 |
| PUT | `/api/ivekit/notifications/preferences/:event_type/:channel` | 当前用户 revisioned upsert |
| GET | `/api/ivekit/notifications/deliveries` | admin 按 notification/endpoint/channel/state 游标查询 |
| GET | `/api/ivekit/notifications/deliveries/:delivery_id` | admin 查询 safe Delivery，不返回 recipient/payload ciphertext |
| POST | `/api/ivekit/notifications/deliveries/:delivery_id/retry` | admin；提交 `expected_state`，通常执行 `failed|dead_letter -> retry_wait` |
| POST | `/api/ivekit/notifications/provider-receipts/:endpoint_id` | Provider 签名回执；按 event id/canonical hash 幂等 |

Notification 输入包含 `event_type`、`recipient`、`targets[]`、`content`、`business_ref`，可选模板 revision、locale、priority、schedule、retention 和 policy。Recipient 与 content 在入库前分别加密，检索/幂等使用独立 HMAC；API、审计、指标和日志只输出脱敏投影。Endpoint 只保存 `env://NAME` 引用，API 仅返回 `secret_configured`/`signing_secret_configured`，不返回引用名和值。

投递状态为 `pending -> processing -> delivered|accepted|retry_wait|uncertain|failed|dead_letter`。`accepted` 不是最终送达，需等待 Provider receipt；Webhook 或无回执 Provider 可在 2xx 后以明确语义写 `delivered`。请求超时且 Provider 是否接收未知时进入 `uncertain`，禁止自动重放。只有具备 `notifications.force_delivery` 的管理员在 Provider 侧查重后才能提交 `allow_uncertain=true`；状态或 revision 已变化返回 409。

Endpoint 主动健康 Worker 由 `OPC_IVEKIT_NOTIFICATION_HEALTH_WORKER_ENABLED` 显式开启。HTTP 探针做 DNS/公网地址复验、端口 allowlist、禁重定向和超时控制；SMTP 只调用 `verify()`，不发送测试邮件。多实例通过 `FOR UPDATE SKIP LOCKED`、随机 lease hash 和完成 fencing 协作。主要指标包括 `opc_ivekit_notification_queue_oldest_age_seconds`、`opc_ivekit_notification_health_probes_total` 和 `opc_ivekit_notification_health_probe_duration_seconds`。完整参数、告警、人工重试与真实 Provider `not_run` 边界见《iveKit 通知底座运维手册》。

### 5.6 集成事件与签名 Webhook

HTTP replay、WebSocket 和 Webhook 共用 PostgreSQL `ivekit_tenant_events`。Webhook Bridge 不使用旧 call-center `/api/webhooks/*` 或 SQLite；migration 073 只增加 tenant-scoped subscription/cursor/lease，并复用 Notification 的加密、SSRF、HMAC、配额、熔断、重试和死信链路。

| Method | Path | 角色与结果 |
| --- | --- | --- |
| GET | `/api/ivekit/events` | 当前 tenant 的 opaque cursor replay；409 返回 `snapshot_required` |
| GET | `/api/ivekit/events/catalog` | 版本化 family、pattern、payload 和签名合同 |
| GET/POST | `/api/ivekit/events/webhook-subscriptions` | admin 查询；`Idempotency-Key` 幂等创建 |
| GET/PUT | `/api/ivekit/events/webhook-subscriptions/:subscription_id` | admin 查询；revisioned 更新/暂停 |
| POST | `/api/ivekit/events/webhook-subscriptions/:subscription_id/archive` | admin + revision + `Idempotency-Key` 归档 |

事件模式只接受精确名称或尾部 `.*`，Endpoint event allowlist 不能被订阅放宽。Worker 对 `subscription_id + event_id` 生成稳定 Notification 幂等键，Notification 创建成功后才单调推进 cursor；失败按 PostgreSQL lease 重试，归档记录不可恢复。所有 mutation 使用 tenant/actor/source-IP 分布式限流并写不可变审计。运行时由 `OPC_IVEKIT_EVENT_WEBHOOK_WORKER_ENABLED=1` 显式启用，并要求 Notification delivery runtime 与加密/HMAC key 同时可用。

Webhook body 是 `IveKitIntegrationWebhookDelivery`：outer delivery 包裹 schema-v1 `IveKitIntegrationEventEnvelope`。`x-ivekit-signature` 对 `x-ivekit-timestamp + '.' + rawBody` 做 HMAC-SHA256；`x-ivekit-event-id` 标识 journal event。SDK `verifyIveKitWebhook` 使用 Web Crypto，校验 1 MiB body、最少 32 字节 secret、30–3600 秒时间窗、outer/inner tenant 和 event type 一致性。外部 `IveKitWebhookReplayStore.claim` 接收完整已验证 envelope、body SHA-256 和默认 7 天 expiry，必须在 PostgreSQL/Redis 原子写入 durable inbox，不能用内存 Set。

### 5.7 SDK 与事件映射

- `IveKitVoiceHttpClient` 覆盖本节全部 Voice 配置、call、recording、bridge 和 policy 路径；`createIveKitVoiceController` 提供 durable call 高层控制；`@opc/ivekit-sdk/sip-webphone` 管理浏览器 SIP.js 生命周期。
- `IveKitIvrHttpClient` 覆盖 flow/version/validate/publish/rollback/simulation/session/resource/settings。
- `IveKitContactCenterHttpClient` 覆盖配置、Presence、ACD、assignment、callback、monitor 和 supervisor。
- `IveKitNotificationHttpClient` 覆盖 inbox、偏好、模板、Endpoint、Delivery、Endpoint test、归档和 guarded retry；列表 cursor 与 tenant/filter 绑定。
- `IveKitEventHttpClient` 覆盖 cursor replay、catalog 和 Webhook subscription create/list/get/update/archive；`verifyIveKitWebhook` 与 `IveKitWebhookReplayStore` 负责接收方验签和持久防重放入口。
- Voice/IVR/Contact Center/Notification 变更通过租户 durable event 加速刷新；HTTP/PostgreSQL projection 仍是恢复后的权威 snapshot，消费者按 event ID 去重并使用 opaque cursor replay。

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
| `collaboration.message.delivery_blocked_by_file_security` | Tinode 投递等待安全文件 |
| `collaboration.message.delivery_unblocked` | 所有安全文件 ready，投递重新入队 |
| `collaboration.message.delivery_blocked` | 文件安全终态阻止投递 |
| `collaboration.message.provider_mutation_updated` | Tinode edit/delete 执行状态；迟到 echo 纠正时包含 `reconciled_from_status` |
| `collaboration.tinode.dead_letter.replay_requested` | 幂等人工死信重放已排队 |
| `collaboration.attachment.processed` | OCR/ASR 回填完成 |
| `collaboration.quality_review.completed` | AI job 完成 |
| `collaboration.policy.finding_reviewed` | 人审状态迁移 |
| `notification.created` | 用户定向逻辑通知已创建；不含正文或 recipient |
| `notification.delivery.updated` | 用户定向 Delivery 安全状态投影 |
| `notification.inbox.created` | 用户定向 Inbox 安全内容投影 |
| `notification.inbox.updated` | 用户定向 read/unread/archive/unarchive 状态 |

Notification/Delivery/Inbox 状态与上述通知事件在同一 PostgreSQL transaction 中提交。migration 072 为事件生产者增加 tenant-scoped 稳定幂等键；migration 073 增加产品中立的 Webhook subscription/cursor/lease。提交后的 WebSocket/Redis fan-out 复用 producer key，因此重复回调不会创建第二条事件。外部联系人通知不会广播为 tenant-wide 事件，用户通知必须包含目标 `audience_user_ids`。通知事件禁止携带 recipient 明文、content/recipient ciphertext、Provider request/message id 和原始响应。

浏览器 WebSocket 使用 `Sec-WebSocket-Protocol: ivekit.v1, ivekit.jwt.<access-token>`
完成握手认证，不把 access token 放入 URL。服务端在 JWT `exp` 到期时以 `4001`
主动关闭连接；参考客户端提前 60 秒刷新短令牌并重新建立 HTTP/WS 客户端。

首次连接不带 cursor，`connected.data` 返回当前 `head_cursor`。重连时在 WebSocket URL 增加 `cursor=<opaque-cursor>`；cursor 不是凭据，但仍不得写入日志或长期浏览器存储。服务端先冻结 live delivery，完成 replay 后再释放连接期间积压事件。`connected.data` 同时返回 `head_cursor/replay_from/replayed_events/snapshot_required/reason?`。

也可通过 `GET /api/ivekit/events?cursor=<opaque>&limit=50` 拉取 `{items,next_cursor,has_more,snapshot_required}`。不带 cursor 时返回空 items 和当前 head。签名错误、跨 tenant、超过 retention 或单次 WS replay 超限时明确返回 `snapshot_required`；HTTP 状态为 409，WebSocket 在 connected data 中给出 reason。此时客户端必须重新获取 snapshot/message-state/realtime-state，再以新的 head cursor 继续。

Replay 每次按当前权限重新判断：定向事件只对 audience 用户可见；chat/media/remote 事件检查当前 participant，离开或被移除后不能读取历史私有事件；owner/admin/system 仅可旁路非定向资源事件，不能读取发给其他用户的定向事件。

## 7. SDK 方法映射

`createIveKitHttpSdk({baseUrl, tenantId, apiKey|accessToken, userId?, timeoutMs?, fetch?})` 返回：

- `sdk.media.*`：capabilities、room、join、participant、recording、Egress job、object、export、cleanup。
- `sdk.chat.*`：`listSessions()`、`closeSession()`、`listMessagesPage()`、session、binding、client-plan、participant、message、delivery、Tinode operations/dead-letter replay、receipt、state、mutation、安全文件/断点续传、attachment、finding、quality。
- `sdk.voice.*`：profile、trunk、DID、extension、route、call、command、bridge、recording、policy 和 consent。
- `sdk.ivr.*`：flow、version、publish/rollback、simulation、session、audio/time/region/ring resource 和 settings。
- `sdk.contactCenter.*`：skill、agent、Presence、queue、membership、ACD assignment、callback、monitor 和 supervisor。
- `sdk.notifications.*`：通知创建/查询、inbox、偏好、模板版本、Endpoint 管理/测试及 Delivery 查询/重试。
- `sdk.audit.*`：tenant audit 游标查询和 JSONL 导出；`sdk.retention.*`：typed policy 和 legal hold。
- `sdk.events.getHeadCursor()`、`listPage()`、有界 `replay()`、`getCatalog()` 和 Webhook subscription 管理已交付；409 snapshot fallback 返回类型化 `snapshot_required` 结果，调用方按第 6 节刷新三工作区 snapshot 后取得新 head cursor。
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
