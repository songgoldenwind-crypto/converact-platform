# iveKit HTTP API 与事件契约

> 契约版本：v1-draft / 2026-07-11。Base path 为 `/api/ivekit`。本文是 LED/OPC 对接用的 Markdown 契约；真实运行能力先读取 capabilities。更完整背景见《iveKit视频IM通用能力详细设计》。

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

### 1.2 数据与错误

- JSON 请求使用 `Content-Type: application/json`。
- 附件上传直接发送二进制 body，并在 query 传 `kind/filename`。
- 成功 HTTP 响应直接返回 route `data`，没有额外 `{ data: ... }` 包装。
- 受控录制导出返回二进制和 `Content-Disposition`。
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
| 502 | provider 终态失败，本地记录仍保留 |
| 503 | PostgreSQL/provider/必要配置不可用 |

## 2. Media Core

### 2.1 Capabilities

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/ivekit/media/capabilities` | 返回 tenant、LiveKit/Egress/SIP/object/recording 能力和配置布尔状态 |

Media Core 不返回 URL、API key 或 secret。与 LiveKit 浏览器接入有关的配置状态为：

```json
{
  "provider": "livekit",
  "tenant_id": "tenant_led",
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

### 2.2 房间和 Join

| Method | Path | 说明 |
| --- | --- | --- |
| POST | `/api/ivekit/media/rooms` | 创建 tenant room；可带 business_ref |
| GET | `/api/ivekit/media/rooms/:room_name` | 查询房间 |
| POST | `/api/ivekit/media/rooms/:room_name/close` | 关闭房间，之后拒绝 join/recording/dispatch |
| POST | `/api/ivekit/media/rooms/:room_name/join` | 返回 WebRTC 或 SIP/VoLTE join plan |
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

WebRTC 返回 LiveKit token/URL/join path；SIP bridge 返回 dial target/trunk 等 metadata。WebRTC 响应中的 `livekit_url` 是浏览器可连接的 `LIVEKIT_PUBLIC_URL`，不是服务端使用的 `LIVEKIT_URL`。生产环境缺少公网 URL 或使用 `ws://` 时，Join 会失败关闭，不会把容器内地址返回给浏览器。Token 不应写日志或持久化到 LED 业务表。

### 2.3 Recording/Egress

| Method | Path | 说明 |
| --- | --- | --- |
| POST | `/api/ivekit/media/rooms/:room_name/recordings/start` | 启动录制，要求 call_session_id 或 business_ref |
| POST | `/api/ivekit/media/recordings/:egress_id/stop` | 按 egress ID 停止 |
| GET | `/api/ivekit/media/recordings?limit=50` | tenant 录制列表 |
| GET | `/api/ivekit/media/recordings/:recording_id` | 录制状态、对象和失败信息 |
| GET | `/api/ivekit/media/recordings/:recording_id/object` | 对象存在性/可读性/checksum 检查并写审计 |
| GET | `/api/ivekit/media/recordings/:recording_id/export` | 鉴权受控二进制导出并写审计 |
| POST | `/api/ivekit/media/recordings/retention/cleanup` | 默认 dry-run；真实删除要求 `dry_run=false, confirm=true` 和高权限角色 |

Recording start：

```json
{
  "business_ref": { "type": "service_order", "id": "SO-1001" },
  "format": "webm",
  "has_video": true,
  "retention_days": 90
}
```

## 3. Collaboration Session / Chat

### 3.1 Capabilities 和 session

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/ivekit/chat/capabilities` | provider、功能开关、配置布尔状态和 delivery policy |
| POST | `/api/ivekit/chat/sessions` | 按 business_ref 建会话 |
| GET | `/api/ivekit/chat/sessions/by-ref` | query: `business_ref_type/business_ref_id/limit` |
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
| POST | `/api/ivekit/chat/sessions/:session_id/messages` | 本地事务 + policy + durable provider delivery |
| GET | `/api/ivekit/chat/sessions/:session_id/messages/:message_id/delivery` | delivery 状态和 attempt history |
| POST | `/api/ivekit/chat/sessions/:session_id/messages/:message_id/delivery/retry` | 对到期 work 做 lease 保护的重试 |

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
| POST | `/api/ivekit/chat/sessions/:session_id/attachments/:attachment_id/retry` | 重新排 OCR/ASR |
| POST | `/api/ivekit/chat/attachment-processing/run` | 运维/测试 due batch；生产通常 worker 驱动 |

上传返回 descriptor，再放进消息 `attachments`。图片走 OCR，audio/video/screen_recording 走 ASR；提取文本回填后重新执行 policy 和 AI 质检。真实 provider 仍需服务器选型/验收。

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

## 4. Remote Assistance / RustDesk

RustDesk 稳定路径前缀为 `/api/ivekit/rustdesk`，推荐使用 `createIveKitRustDeskLedSdk`。

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/ivekit/rustdesk/client-config` | ID/relay/API server、public key/fingerprint |
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
| `collaboration.attachment.processed` | OCR/ASR 回填完成 |
| `collaboration.quality_review.completed` | AI job 完成 |
| `collaboration.policy.finding_reviewed` | 人审状态迁移 |

WebSocket 可能断线或丢失瞬时事件。重连后必须 GET snapshot/message-state/realtime-state；事件不是唯一数据源。

## 6. SDK 方法映射

`createIveKitHttpSdk({baseUrl, tenantId, apiKey|accessToken, userId?, timeoutMs?, fetch?})` 返回：

- `sdk.media.*`：capabilities、room、join、participant、recording、object、export、cleanup。
- `sdk.chat.*`：session、binding、client-plan、participant、message、delivery、receipt、state、mutation、attachment、finding、quality。
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
