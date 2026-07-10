# 坐席视频通话 + 坐席间互通 使用指南

两条实时音视频流程，共用 LiveKit 房间作为媒体中枢，并通过可插拔媒体网关支持未来的 VoLTE-SIP 接入。

## 功能概览

| 流程 | 发起方 | 接收方 | 媒体 |
|------|--------|--------|------|
| 坐席 ↔ 客户视频 | 坐席工作台「发起视频」 | 客户 H5 链接 | 视频 / 屏幕共享 |
| 坐席 ↔ 坐席互通 | 坐席工作台「团队对讲」 | 另一坐席（来电弹窗） | 语音 / 视频 |

## 架构

```
            ┌─────────────────────────────────────┐
编排层       │ /video/start  /intercom/start         │
            │   registry.prepareJoin(channel, ctx) │
            └──────────────┬──────────────────────┘
                           │
            ┌──────────────▼──────────────────────┐
媒体网关注册表 │ MediaGatewayRegistry                 │
            └──┬────────────┬──────────────────────┘
        ┌──────▼───┐  ┌─────▼──────┐
        │ webrtc   │  │ sip_volte  │
        │ (active) │  │ (planned)  │
        └────┬─────┘  └─────┬──────┘
          签发token      SIP拨号指令
          浏览器直连   RustPBX→livekit-sip→房间
```

## 本地验证（无需 GPU / 真实 SMS / SIP）

### 准备
```bash
# 后端（dev 模式，LiveKit 未配置时返回 dev-token，UI 显示链接但不建真实连接）
npm run dev   # 或对应启动脚本

# 前端
cd frontend && npm run dev
```

要看到**真实视频画面**，需配置 LiveKit（否则是 dev-token 模式，只显示链接不连真实媒体）：
```bash
export LIVEKIT_URL=ws://localhost:7880
export LIVEKIT_API_KEY=...
export LIVEKIT_API_SECRET=...
export OPC_MEDIA_API_TOKEN=dev-media-token
export OPC_MEDIA_INVITE_SECRET=dev-media-invite-secret
export OPC_MEDIA_INVITE_TTL_MS=86400000
# 本地起 LiveKit（docker）
docker run --rm -p 7880:7880 -p 7881:7881 livekit/livekit-server --dev
```

使用 `npm run dev:callcenter` 或 `npm run dev:callcenter:detach` 启动本地全栈时，脚本会显式使用 `.env.example` 作为 compose 默认环境，并禁用 Docker Compose 自动读取根目录私人 `.env`。`opc` 容器默认会带 `OPC_MEDIA_API_TOKEN`、`OPC_MEDIA_INVITE_SECRET`、`OPC_MEDIA_INVITE_TTL_MS` 和 MinIO 录制配置；如果你在宿主机覆盖这些值，跑 smoke/readiness 的终端也要使用同一套值，避免脚本拿到的 token 或邀请密钥与容器内服务不一致。

本地 compose 挂载的是 `config/livekit.yaml` 和 `config/egress.yaml`，其中 LiveKit key/secret 与 MinIO 凭证固定为开发值：`devkey` / `secret`、`minioadmin` / `minioadmin`。因此 compose 内的 `opc`、`livekit-sip`、`ai-agent` 也固定使用这组值，避免只覆盖 shell 环境变量导致 LiveKit 服务端、Egress 和客户端容器互相不认。若确实要换这几组底层凭证，需要同步修改配置文件和 smoke/readiness 运行环境。

`infra/docker-compose.production.yml` 不再直接挂载开发用的 `config/livekit.yaml` / `config/egress.yaml`。生产或准生产环境先用真实 `LIVEKIT_API_KEY`、`LIVEKIT_API_SECRET`、MinIO 凭证执行 `npm run render:media-configs`，把 LiveKit server 与 Egress 配置渲染到 `.runtime/media`，再启动 production compose；compose 默认挂载 `${OPC_MEDIA_CONFIG_DIR:-../.runtime/media}/livekit.yaml` 和 `${OPC_MEDIA_CONFIG_DIR:-../.runtime/media}/egress.yaml`。`infra/env.example` 也声明了 `OPC_MEDIA_API_TOKEN`、`OPC_MEDIA_INVITE_SECRET`、`OPC_MEDIA_INVITE_TTL_MS`、`OPC_API_KEY`、`OPC_MEDIA_CONFIG_DIR` 和 MinIO 录制配置。`OPC_API_KEY` 要同时传给 `opc` 与 `ai-agent`：前者负责校验，后者负责调用。

```bash
# 在仓库根目录执行；会写入 .runtime/media/livekit.yaml 与 .runtime/media/egress.yaml
set -a
. infra/env.example
set +a
npm run render:media-configs
COMPOSE_DISABLE_ENV_FILE=1 docker compose --env-file infra/env.example -f infra/docker-compose.production.yml up -d
```

Kubernetes/Helm 部署同样需要这些环境变量：`infra/k8s/templates/opc-deployment.yaml` 会把 LiveKit key/secret、Media Core token、客户邀请签名 TTL、`OPC_API_KEY` 和 MinIO 录制配置传入 `opc`；`infra/k8s/templates/ai-agent-deployment.yaml` 会把同一个 `OPC_API_KEY` 传入 AI agent。chart 现在也提供基础媒体运行时模板：LiveKit server、MinIO、LiveKit Egress、livekit-sip。默认走 release 内的 `{{ release }}-livekit` / `{{ release }}-minio`，也可用 `values.yaml` 的 `livekit.url` 指向外部 Media Core，用 `media.minioEndpoint` 指向外部对象存储。默认数据库连接也按 release name 指向 `{{ release }}-postgres`，不是固定 `opc-postgres`。生产必须替换 `livekit`、`media`、`opc.apiKey` 下的默认密钥；当前 chart 仍不包含 RustPBX/Kamailio/运营商 SIP trunk 的完整生产拓扑，这部分仍需按部署环境单独落地。

根目录 `.env.example` 已集中列出 `npm run smoke:media:readiness` 需要的本地验收变量，包括 Media API、AI avatar、坐席浏览器、客户 H5、Collaboration/Remote Assistance、SIP/VoLTE 和 MinIO 录制配置。真实验收时可以先复制这份样例，再把空的坐席 token、客户邀请或生产密钥替换成真实值。

`OPC_MEDIA_API_TOKEN` 用来保护可复用媒体管理接口。生产环境必须配置 `OPC_MEDIA_API_TOKEN` 或 `LIVEKIT_MEDIA_API_TOKEN`；若 `NODE_ENV=production` 且没有配置，创建房间、签发坐席/主管 token、agent dispatch、录制启停与参与人查询等 `/api/media/livekit/*` 管理请求会直接 fail-closed 返回 401。配置后，管理请求都必须带：

```http
Authorization: Bearer dev-media-token
```

后端和 LiveKit 配好后，可以先跑一条服务端媒体冒烟，验证通用 Media Core API 的创建房间、直接签 token、AI dispatch、签 join、启动录制、查询录制、停止录制、参与人查询、关闭房间和关闭后拒绝 join：

```bash
export OPC_BASE_URL=http://localhost:3000
export OPC_MEDIA_API_TOKEN=dev-media-token
export OPC_MEDIA_SMOKE_TENANT_ID=tenant_demo
npm run smoke:media
```

这条冒烟不打开浏览器，也不替代真实双方视频画面 E2E；它用于先确认媒体服务 API、LiveKit Egress 行为、token/dispatch 管理动作和租户参数契约能跑通。

浏览器双坐席视频冒烟需要真实前端、后端、LiveKit 和两个已创建的坐席账号。验收机器先安装 Playwright：

```bash
npm i -D playwright
npx playwright install chromium
```

然后配置两个坐席的登录态并运行：

```bash
export OPC_FRONTEND_URL=http://localhost:5173
export OPC_BROWSER_SMOKE_TENANT_ID=tenant_demo
export OPC_BROWSER_SMOKE_AGENT_A_TOKEN=agent-a-jwt
export OPC_BROWSER_SMOKE_AGENT_A_USER_ID=user_a
export OPC_BROWSER_SMOKE_AGENT_A_SEAT_ID=seat_a
export OPC_BROWSER_SMOKE_AGENT_B_TOKEN=agent-b-jwt
export OPC_BROWSER_SMOKE_AGENT_B_USER_ID=user_b
export OPC_BROWSER_SMOKE_AGENT_B_SEAT_ID=seat_b
npm run smoke:media:browser
```

这条浏览器冒烟会打开两个 `/workbench` 页面，执行“坐席 A 点视频呼叫坐席 B、坐席 B 接听、双方进入视频通话”，并等待双方页面的远端视频 DOM 挂载完成，避免只凭连接文案误判通过。如果要把屏幕共享也纳入闸门，追加：

```bash
export OPC_BROWSER_SMOKE_SCREEN_SHARE=1
```

开启屏幕共享闸门后，脚本还会等待坐席 B 页面出现屏幕共享 video DOM。浏览器冒烟仍不替代 SIP/VoLTE 或 AI 数字人真实发布验收；它专门证明坐席浏览器到坐席浏览器的 LiveKit 页面链路。

整套视频 readiness 可以用总门禁统一执行：

```bash
# 默认依次跑 media、avatar、ai-callback、agent-browser、customer-browser、collaboration、sip-volte
npm run smoke:media:readiness

# 也可以只跑部分目标，适合分阶段验收
export OPC_VIDEO_READINESS_TARGETS=media,avatar,ai-callback,customer-browser,collaboration
npm run smoke:media:readiness

# 需要把 RustDesk 真实网关控制面也纳入时，再显式追加 remote-gateway
export OPC_VIDEO_READINESS_TARGETS=media,customer-browser,collaboration,remote-gateway
npm run smoke:media:readiness
```

总门禁会先检查每个目标所需的环境变量，缺配置时会按目标列出缺项；默认遇到第一个失败就退出。若想一次性收集所有失败项，可设置 `OPC_VIDEO_READINESS_CONTINUE_ON_FAILURE=1`。

当 `media` 目标排在 `customer-browser` 前面时，总门禁会自动让 `smoke:media` 保留房间，读取它返回的 `customerJoinPath`，并作为 `OPC_CUSTOMER_VIDEO_URL` 传给客户 H5 浏览器 smoke；客户浏览器验完后，总门禁再调用媒体 close API 清理该房间。如果 `media` 成功但没有输出 `customerJoinPath`，总门禁会立刻记录失败并清理已知 room，不会继续跑缺输入的客户浏览器 smoke。如果 avatar、坐席浏览器等中间目标先失败，总门禁也会先清理这个保留房间再退出。这样真实验收不需要手工复制客户 `/video?...` 链接，也不会把客户浏览器指向已关闭房间。若 `OPC_MEDIA_INVITE_SECRET` 或 `LIVEKIT_MEDIA_INVITE_SECRET` 已配置，`smoke:media` 还会在服务端阶段校验 `customerJoinPath` 必须带 `invite` 和 `expires_at`，避免未签名链接拖到浏览器阶段才失败。若你显式设置了 `OPC_CUSTOMER_VIDEO_URL`，则优先使用你提供的链接，media 自己仍按默认行为收尾关闭。

`sip-volte` 目标默认输出配置检查、SIP dial plan 和 `gatewayStatus`。由于代码内置 `sip_volte` gateway 仍是 planned，未配置运行时探针时会提示需要人工激活，但不会默认让整套 readiness 失败；如果本次验收要求 SIP/VoLTE 已经真正激活，设置 `OPC_SIP_VOLTE_REQUIRE_ACTIVE=1`。生产环境可再配置 `OPC_SIP_VOLTE_GATEWAY_STATUS_URL` 和可选 `OPC_SIP_VOLTE_GATEWAY_STATUS_TOKEN`，让脚本读取 livekit-sip/RustPBX 桥的运行时状态；探针返回 active、bridge target/trunk 对齐且 `video=true` 时，`gatewayStatus` 才会提升为 active，否则硬门禁仍会失败。

`ai-callback` 目标会运行 `npm run smoke:media:ai-callback`，专门验证 Python AI agent 未来要调用的旧 OPC 业务回调入口 `/api/livekit/agent-dispatch`：脚本先创建一个旧 LiveKit room，再带 `OPC_API_KEY` 与显式 `tenant_id` 触发 `transfer_to_human`，最后通过 Media Core close API 清理房间；如果 dispatch 失败，也会尽力清理已创建的测试 room。注意它和 Media Core 的 `/api/media/livekit/agent-dispatch` 不同，后者是“派 AI 入房”，前者是“AI 已在房间内，回调 OPC 执行业务动作”。

`collaboration` 目标会运行 `npm run smoke:collaboration`，验证通用协作和远程协助链路：创建 business ref 绑定的 session、授权前阻断远控工具、grant 后启动第三方工具会话、上传录屏证据、写审计 timeline、revoke 后确认工具会话结束。默认走 `/tools` 外部工具链接模式；如果后端已配置 RustDesk 网关控制面，可设置 `OPC_COLLAB_SMOKE_USE_GATEWAY_TOOL=1`，脚本会改打 `/tools/gateway`，验证 OPC 后端通过远程桌面网关创建工具会话。MeshCentral / Guacamole 仍可作为 fallback provider 显式配置。`collab`、`remote`、`remote-assistance` 都是这个目标的别名；同一个目标通过多个别名出现时只会执行一次。

`remote-gateway` 是可选目标，不在默认 readiness 内。它会运行 `npm run smoke:remote-gateway`，当前主路径面向 RustDesk OSS 自托管运行时 + iveKit 控制面，验证“client-config → 创建网关会话 → launch plan / launch page → 操作事件审计 → 结束网关会话 → ended 后拒绝旧事件”。需要配置 `OPC_REMOTE_GATEWAY_TARGET_ID`，RustDesk provider 默认启用，并优先读取 `OPC_RUSTDESK_CONTROL_PLANE_BASE_URL` / `OPC_RUSTDESK_API_TOKEN`，也兼容 `OPC_REMOTE_GATEWAY_BASE_URL` / `OPC_REMOTE_GATEWAY_API_TOKEN`。默认授权 scope 为 `view_screen,control_mouse_keyboard,record_screen,transfer_file,clipboard`，和控制动作、文件传输、录屏、剪贴板四类 operation audit probe 对齐。`gateway`、`rustdesk`、`meshcentral`、`guacamole` 都是这个目标的别名；MeshCentral / Guacamole 只作为已有客户环境的 fallback 联调路径。

总门禁输出统一 JSON 报告：`ok` 表示整体结果，`steps[]` 逐项记录 `target`、执行命令、退出码、耗时，以及 `stdout`/`stderr` 摘要。命令返回非 0、命令启动/runner 抛错或保留房间清理失败时，也会先输出已经完成的部分报告，再以非 0 状态退出；排查真实环境问题时优先看失败 step 和 `media-cleanup` step。

客户 H5 浏览器冒烟需要一个可用的 `/video?...` 客户邀请链接。可以直接传完整链接：

```bash
export OPC_FRONTEND_URL=http://localhost:5173
export OPC_CUSTOMER_VIDEO_URL='/video?room=tenant-demo-room&tenant_id=tenant_demo&invite=signature&expires_at=1893456000000'
npm run smoke:media:customer-browser
```

也可以让脚本按 room 参数拼出客户链接：

```bash
export OPC_FRONTEND_URL=http://localhost:5173
export OPC_CUSTOMER_BROWSER_SMOKE_ROOM_NAME=tenant-demo-room
export OPC_CUSTOMER_BROWSER_SMOKE_TENANT_ID=tenant_demo
export OPC_CUSTOMER_BROWSER_SMOKE_INVITE=signature
export OPC_CUSTOMER_BROWSER_SMOKE_EXPIRES_AT=1893456000000
npm run smoke:media:customer-browser
```

这条 smoke 会打开真实客户 `/video` 页面，等待页面完成 join 并显示“已连接房间”。如果要把远端数字人/坐席接入或屏幕共享也纳入闸门，追加 `OPC_CUSTOMER_BROWSER_SMOKE_EXPECT_REMOTE=1` 或 `OPC_CUSTOMER_BROWSER_SMOKE_EXPECT_SCREEN_SHARE=1`；开启后脚本会分别等待客户页远端视频 DOM 和屏幕共享 video DOM，而不只检查文字状态。

客户 H5 链接仍保持公开邀请语义，但生产环境必须配置 `OPC_MEDIA_INVITE_SECRET` 或 `LIVEKIT_MEDIA_INVITE_SECRET`。配置后，系统生成的 `/video?...` 链接会带 `expires_at` 和 HMAC `invite`，客户页会透传这两个参数到 `/api/media/livekit/join?...&role=customer`；缺失、过期或篡改签名都会返回 401。若 `NODE_ENV=production` 且没有配置邀请签名密钥，客户 join 会直接 fail-closed 返回 401，避免生产环境退回到“知道 room+tenant 就能入房”的开发模式。

LiveKit webhook 不走 Media API token 或客户 invite，而是用 LiveKit webhook 自身的 auth header 验签。生产环境必须配置 `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`（或 `OPC_LIVEKIT_API_KEY` / `OPC_LIVEKIT_API_SECRET`）；若 `NODE_ENV=production` 且缺少这组 webhook 凭证，`/api/media/webhooks/livekit` 和旧 `/api/webhooks/livekit` 会 fail-closed 返回 401。Webhook 验签只需要 key/secret，不依赖 `LIVEKIT_URL` 是否配置。

客户页在换取 LiveKit token 前会先校验媒体 API 响应：401/404/409 等错误会显示服务端业务错误，响应体没有 token、或生产 token 没有 LiveKit URL，都会被视为无效 join 响应，不再继续调用 LiveKit connect。dev-token 模式仍允许无 LiveKit URL，便于本地无 LiveKit 集群时展示开发态。

关闭房间后，`/api/media/livekit/token`、`join`、`agent-dispatch` 和 `recordings/start` 都会拒绝继续工作。也就是说旧客户链接即使还没到 `expires_at`，只要房间已经 `closed`，也不能再换取 LiveKit token；服务端也不能继续给这个房间派 AI 或启动录制。

LiveKit webhook 可能晚到或乱序。当前实现会保护关闭态：迟到的 `room_started` 不会把房间改回 active，迟到的 `participant_joined` 不会写新参与人或触发加入通知；`participant_left` 即使先于 joined 到达，也会留下 left 状态参与人审计记录；left 事件缺 metadata/role 时不会清空 joined 阶段已记录的参与人画像；`room_finished` 会把仍显示在线的参与人标记为 left；录制完成类事件仍可在关闭后落库，避免丢失录制结果。

这条生命周期规则不只在 HTTP 入口生效，也在 `LiveKitMediaModule` public API 生效。其他项目直接 import module 复用时，也必须先创建未关闭 room，才能签 token、生成 join plan、派 AI 或启动录制。

OPC 旧入口也已接入这条规则：旧 `/api/livekit/token` 命令、坐席间 intercom start/accept、全渠道 `escalate-video`、坐席 `/api/call-center/video/start`、外呼 `video_link_sms`、主管监听、conference、warm transfer 都走 `LiveKitMediaModule`，不会绕过关闭态门禁、租户参数或客户邀请签名。

外呼视频短信不得再使用 `/call/{room}?token={LiveKit token}`。当前短信链接统一生成 `/video?...` 邀请链接，浏览器通过 `/api/media/livekit/join` 换取短期 LiveKit token。

### 流程一：坐席 ↔ 客户视频
1. 登录坐席工作台，状态置「在线空闲」
2. （可选）接听一个客户来电，或直接点「发起视频」
3. 视频面板出现「客户加入链接」——点「新窗口打开（模拟客户）」
4. 新标签页作为客户加入；双方互看视频（远端大画面 + 本地 PiP 小窗）
5. 坐席点「共享屏幕」后，客户页主画面显示屏幕共享，坐席摄像头/数字人保留 PiP 小窗
6. 状态提示「等待对方加入 / 对方已接入」

### 流程二：坐席 ↔ 坐席互通
1. 开两个浏览器（或一个正常 + 一个隐身窗），各登录不同坐席账号
2. 坐席A 在「团队对讲」看到坐席B（需 B 状态为 idle）
3. A 点「语音」或「视频」呼叫 B
4. B 收到来电弹窗（坐席呼叫 · 语音/视频）→ 点「接听」
5. 双方互通；A 可在等待时取消，B 可拒接

## API

### 坐席发起客户视频
```
POST /api/call-center/video/start
  { call_session_id?, customer_phone?, customer_channel?, enable_screen_share? }
  → { room, agent_token, customer_channel, customer_join_path?, customer_join_plan }
```
`customer_channel` 默认 `webrtc`（H5）；未来传 `sip_volte` 走 SIP 拨号方案。
`customer_join_path` 来自统一媒体 join plan，不允许调用方手工拼 `/video?room=...`。配置 `OPC_MEDIA_INVITE_SECRET` 后，该路径会包含 `tenant_id`、`expires_at`、`invite`。

### 坐席间互通
```
POST /api/call-center/intercom/start
  { from_seat_id, target_seat_id, media?: 'voice'|'video' }
  → { room_name, media, caller_token, target_seat_id, target_user_id }

POST /api/call-center/intercom/accept
  { room_name, seat_id }
  → { room_name, livekit, seat_id }

POST /api/call-center/intercom/decline
  { room_name, reason?: 'declined'|'cancelled'|'timeout' }
  → { room_name, ok }
```

### 通用媒体能力入口
```
POST /api/media/livekit/rooms
GET  /api/media/livekit/token
GET  /api/media/livekit/join
POST /api/media/livekit/agent-dispatch
GET  /api/media/livekit/rooms/:room/participants
POST /api/media/livekit/recordings/start
GET  /api/media/livekit/recordings
GET  /api/media/livekit/recordings/:id
POST /api/media/livekit/recordings/:egressId/stop
POST /api/media/webhooks/livekit
```

这些入口用于把 LiveKit 基础能力拆给 OPC 以外的项目复用。除签名后的客户 `join?role=customer` 和 LiveKit webhook 外，生产环境必须配置 `OPC_MEDIA_API_TOKEN` 或 `LIVEKIT_MEDIA_API_TOKEN`，由调用方服务端转发；未配置时管理端点 fail-closed 返回 401。不要让浏览器直接持有管理令牌。LiveKit webhook 用 LiveKit key/secret 验签，生产缺 key/secret 时也会 fail-closed。客户 H5 链接由服务端生成并发送给客户，浏览器只持有短期 `invite`，不持有管理令牌。

调用方服务端必须在媒体管理请求中带 `tenant_id`。当前实现会对 token、agent dispatch、room 查询、参与人查询、关闭房间、录制读取和停止录制做租户匹配校验：缺少 `tenant_id` 返回 400，请求携带的 `tenant_id` 与资源租户不一致时返回 404。`agent-dispatch` 的 `tenant_id` 放在 body 顶层；metadata 内若也携带 `tenant_id`，必须与顶层一致。

另有一个旧 call-center 业务入口 `/api/livekit/agent-dispatch`，它不是用来派 AI agent 入房，而是给 AI agent 回调 OPC 执行“转人工/结束通话/预约回拨”。这个入口同样要求 body 顶层 `tenant_id`，并会校验 room 属于该租户；Python AI agent 已在 `transfer_to_human`、`end_call`、`schedule_callback` 三个动作中发送该字段。

旧兼容入口 `/api/livekit/rooms`、`/api/livekit/token` 和 `/api/livekit/agent-dispatch` 在生产环境必须配置 `OPC_API_KEY`，并且请求必须带 `X-API-Key`。若 `NODE_ENV=production` 且未配置 `OPC_API_KEY`，这些旧内部入口会 fail-closed 返回 401；未配置 `OPC_API_KEY` 的开发环境仍保留本地兼容行为。真实环境不要把这三个入口当作公开浏览器 API，客户侧应走 `/api/media/livekit/join` 邀请签名换 token。

`recordings/start` 兼容两种业务绑定：OPC 旧链路可以继续传 `call_session_id`；其它项目可以传 `business_ref: { type, id, display_name?, metadata? }`，例如 LED 的 `service_order`。服务端会把旧 `call_session_id` 自动映射成 `business_ref.type='call_session'`，方便后续按统一证据链查询。有 Postgres 证据库时，总 HTTP 入口还会把录制同步写入 `evidence_records`，返回中带 `evidence_record_id` / `evidence_record`。LiveKit `egress_ended` webhook 也会按 room metadata 的 `business_ref` 或旧 `call_session_id` 写入/更新录制和证据；同一个 `egress_id` / `recording_id` 幂等处理。

### 通用协作/远程协助入口
```
POST /api/collaboration/sessions
GET  /api/collaboration/sessions/by-ref
POST /api/collaboration/remote-assistance/sessions
GET  /api/collaboration/remote-assistance/:id/timeline
POST /api/collaboration/remote-assistance/:id/consent/request
POST /api/collaboration/remote-assistance/:id/consent/grant
POST /api/collaboration/remote-assistance/:id/consent/deny
POST /api/collaboration/remote-assistance/:id/consent/revoke
POST /api/collaboration/remote-assistance/:id/tools
POST /api/collaboration/remote-assistance/:id/tools/gateway
POST /api/collaboration/remote-assistance/:id/audit
POST /api/collaboration/remote-assistance/:id/audit/gateway-sync
POST /api/collaboration/remote-assistance/:id/evidence
POST /api/collaboration/remote-assistance/:id/evidence/upload
GET  /api/collaboration/media/:key
```

这组入口用于屏幕共享之外的服务协作：远控授权、第三方远控工具、录屏证据、审计 timeline。数据以 `business_ref` 绑定业务对象，可绑定 OPC `call_session`，也可绑定其它项目的 `service_order` / `support_ticket`。授权未 grant 时远控工具不能启动；客户 deny 会进入 consent timeline 和 audit trail；客户 revoke 会结束该远程协助会话下仍处于 active 的工具会话，并写入 `remote.tool_session.ended` 审计；若 active 工具来自 `/tools/gateway`，后端会先调用配置的 RustDesk/MeshCentral/Guacamole provider 结束上游会话并同步网关审计。`/tools` 用于记录 RustDesk/TeamViewer/外部链接等第三方工具会话；`/tools/gateway` 会使用后端 `OPC_REMOTE_GATEWAY_*` 配置调用 RustDesk 主路径或 MeshCentral/Guacamole fallback client 创建网关会话，并先检查 active consent，避免未授权时创建外部网关会话；`/audit/gateway-sync` 会按 tool session 从同一个网关拉取上游操作日志并写入 OPC timeline。`evidence/upload` 返回的本地 `/api/collaboration/media/:key` 证据地址需要同租户认证读取，未认证或跨租户请求返回拒绝/404。

真实后端验收可运行 `npm run smoke:collaboration`。它需要 `OPC_BASE_URL`、`OPC_API_KEY`、`OPC_COLLAB_SMOKE_TENANT_ID`，会创建一个绑定 `business_ref` 的协作会话和远程协助会话，先确认未授权时远控工具启动失败，再执行 consent request/grant、启动 RustDesk/第三方工具会话、写审计事件、上传一段录屏证据、查询 timeline，最后 revoke 授权并确认 timeline 里有撤销记录、工具会话已结束、结束审计已写入。设置 `OPC_COLLAB_SMOKE_USE_GATEWAY_TOOL=1` 后，它会用 `/tools/gateway` 代替外部链接工具，要求 OPC 后端已配置 `OPC_REMOTE_GATEWAY_PROVIDER`、`OPC_REMOTE_GATEWAY_BASE_URL`、`OPC_REMOTE_GATEWAY_API_TOKEN`，并通过 `OPC_COLLAB_SMOKE_GATEWAY_TARGET_ID` 或 `OPC_REMOTE_GATEWAY_TARGET_ID` 指定目标设备/连接；工具启动后还会调用 `/audit/gateway-sync`，确认上游网关操作日志能进入 OPC timeline。这个 smoke 验证 OPC 通用编排和证据链；网关 API 本身也可用 `npm run smoke:remote-gateway` 单独验。

### WebSocket 事件
- `intercom.incoming` — 目标坐席响铃（前端按 target_user_id 过滤）
- `intercom.accepted` — 被叫已接入
- `intercom.declined` — 拒接/取消/超时

## 可插拔媒体网关

新增渠道（如 RustPBX 旁的视频网关）= 注册一个适配器，编排代码不动：

```ts
// src/agent-runtime/media-gateway/adapters/your-gateway.ts
export function createYourGateway(): MediaGatewayAdapter {
  return { prepareJoin(ctx) { /* 返回 webrtc token 或 sip_bridge 拨号计划 */ } };
}
// 在 index.ts 注册
registry.register(YOUR_GATEWAY_DEFINITION, createYourGateway());
```

### 未来接 4G VoLTE 视频 SIP 线路
路径：`客户手机(VoLTE视频) → SIP → RustPBX → livekit-sip → LiveKit 房间`

激活步骤（`sip_volte` 适配器当前为 stub，status='planned'）：
1. 给 livekit-sip 容器配置视频支持（docker-compose.callcenter.yml + config/rustpbx.toml trunk livekit-bridge）
2. 设 `LIVEKIT_SIP_BRIDGE_TARGET` + `RUSTPBX_LIVEKIT_TRUNK`
3. 把 `SIP_VOLTE_GATEWAY_DEFINITION.status` 改为 `active` 并实现真实拨号目标解析
4. 调 `/video/start` 时传 `customer_channel: 'sip_volte'`

激活前先跑 readiness：

```bash
export LIVEKIT_URL=ws://localhost:7880
export LIVEKIT_API_KEY=devkey
export LIVEKIT_API_SECRET=secret
export LIVEKIT_SIP_BRIDGE_TARGET=sip:livekit-bridge@livekit-sip:5061
export RUSTPBX_LIVEKIT_TRUNK=livekit-bridge
export RUSTPBX_RWI_URL=ws://localhost:8080/rwi/v1
export RUSTPBX_RWI_TOKEN=dev-rwi-token
export OPC_SIP_VOLTE_SMOKE_ROOM_NAME=tenant-demo-volte-room
# 可选：真实桥接运行时状态探针，返回 status=active、target/trunk 匹配且 video=true 才能提升为 active。
export OPC_SIP_VOLTE_GATEWAY_STATUS_URL=http://livekit-sip-bridge.local/status
export OPC_SIP_VOLTE_GATEWAY_STATUS_TOKEN=bridge-status-token
# 生产验收要求 SIP/VoLTE 已激活时打开；默认 0 只报告 planned 状态。
export OPC_SIP_VOLTE_REQUIRE_ACTIVE=1
npm run smoke:media:sip-volte
```

这条 readiness 会输出 SIP dial plan，并明确当前 `sip_volte` gateway 是否仍是 `planned`。它不拨真实运营商电话，不替代 RustPBX ↔ livekit-sip ↔ LiveKit 的端到端联调。打开 `OPC_SIP_VOLTE_REQUIRE_ACTIVE=1` 后，若未配置运行时状态探针或探针未返回 active，它会把 planned 状态当成失败；配置探针后，脚本还会校验探针返回的 `sip_bridge_target` / `rustpbx_livekit_trunk` 与本次配置一致，并要求 `video=true`，适合最终上线闸门。

编排层、双画面 UI、intercom 逻辑均无需改动——客户腿从哪条链路接入对其他参与者透明。

## 测试

```bash
# 后端
node --import tsx --test test/media-gateway.test.ts test/intercom.test.ts test/livekit-media-http.test.ts test/livekit-media-module.test.ts test/livekit-media-smoke.test.ts
npm run test:fast
npm run render:media-configs # 生产 compose 启动前渲染 LiveKit/Egress 配置，避免 devkey 与真实 env 错配
npm run smoke:media           # 需要先启动后端，并配置 OPC_BASE_URL / OPC_MEDIA_API_TOKEN / OPC_MEDIA_SMOKE_TENANT_ID；OPC_MEDIA_SMOKE_REQUIRE_CONFIGURED_LIVEKIT=1 时会拒绝 dev-token；配置 invite secret 时会校验客户链接已签名
npm run smoke:media:browser   # 需要真实前端/后端/LiveKit、两个坐席登录态和 Playwright；会等待远端 video DOM，可选等待屏幕共享 video DOM
npm run smoke:media:customer-browser # 需要真实客户 /video 邀请链接和 Playwright；可选要求远端/屏幕共享 video DOM
npm run smoke:media:avatar    # 需要真实 LiveKit，验证 Python 数字人 avatar-video 轨道发布、帧捕获和失败清理链路
npm run smoke:media:ai-callback # 需要 OPC_BASE_URL / OPC_API_KEY / Media API token / tenant，验证 AI 回调 OPC 业务入口
npm run smoke:media:sip-volte # 检查 livekit-sip/RustPBX 桥接配置、SIP dial plan 和可选运行时状态探针；OPC_SIP_VOLTE_REQUIRE_ACTIVE=1 时未 active 会失败
npm run smoke:media:readiness # 按 OPC_VIDEO_READINESS_TARGETS 串行执行上述真实环境门禁；默认也包含 collaboration 目标
npm run smoke:collaboration   # 可单独跑；需要真实后端/Postgres/OPC_API_KEY，验证协作、远程协助授权、第三方工具会话、录屏证据和审计 timeline；OPC_COLLAB_SMOKE_USE_GATEWAY_TOOL=1 时会走 /tools/gateway 并同步网关审计
npm run smoke:remote-gateway  # 可选；需要真实 RustDesk 控制面和目标设备，验证会话创建、launch、操作审计、结束和 ended 后拒绝旧事件

# 前端
cd frontend && npx tsc --noEmit && npm run build
```
