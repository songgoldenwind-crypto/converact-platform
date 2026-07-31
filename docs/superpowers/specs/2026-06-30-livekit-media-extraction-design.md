# LiveKit Media 可抽取边界设计

> 日期：2026-06-30
> 状态：方案 C 已落地核心边界，仍待真实 LiveKit/SIP/浏览器 E2E 验收
> 范围：仅整理 LiveKit 音视频基础能力的可抽取边界；不直接拆包、不微服务化、不改变当前 OPC 行为。

> 实现校准：当前代码已新增 `LiveKitMediaModule`、独立 `/api/media/livekit/*` 入口、recording service、参与人追踪与服务级媒体 API 鉴权。本文保留原设计脉络，同时记录实现后的准入口径。

## 1. 背景

当前 OPC 项目里已经有多处 LiveKit 能力：

- `src/agent-runtime/livekit/`：LiveKit config、token、room、agent dispatch、webhook。
- `src/agent-runtime/media-gateway/`：WebRTC join plan、未来 SIP/VoLTE gateway 接缝。
- `src/agent-runtime/call-center/egress-manager.ts`：LiveKit Egress 录音/录像。
- `services/ai-agent-py/`：LiveKit Agents，包含 AI 对话和 avatar 视频轨道。
- `frontend/` 与 `services/agent-panel/`：通过 LiveKit token 加入房间。

后续别的项目也会复用音视频能力。因此需要把 LiveKit 基础媒体能力从 call-center 业务中剥离出来，形成一个稳定、可测试、可迁移的 Module。

本次采用方案 C：**先建“可抽取边界”，不立即拆成 npm 包或独立服务**。

## 2. 目标

### 2.1 第一阶段目标

把 LiveKit 基础能力整理成一个深 Module：

```text
LiveKitMediaModule
  ├── room       创建/关闭/查询房间
  ├── token      签发 agent/customer/supervisor token
  ├── join       生成 WebRTC join plan / H5 join path
  ├── recording  start/stop LiveKit egress
  ├── dispatch   dispatch AI Agent 到房间
  ├── webhook    解析 LiveKit webhook 并更新房间状态
  └── gateway    WebRTC gateway + planned SIP/VoLTE gateway
```

对当前 OPC 来说，它仍然在 `src/agent-runtime/livekit/` 和 `src/agent-runtime/media-gateway/` 下工作。

对未来复用来说，它应该可以低成本搬到：

```text
packages/livekit-media/
```

或者被包装成：

```text
services/livekit-media-service/
```

### 2.2 设计原则

1. 当前项目行为不变。
2. 第一阶段不迁移目录到 `packages/`。
3. 第一阶段不引入独立部署服务。
4. LiveKit media Module 不允许 import `call-center/*`。
5. call-center 可以依赖 LiveKit media Module。
6. 业务概念保留在 call-center：外呼任务、坐席状态、转人工、合规、计费、QM。
7. LiveKit media Module 只处理媒体基础能力：房间、token、join、recording、dispatch、webhook、gateway。
8. 所有外部依赖通过 Interface 注入，避免包化时拖走 OPC 核心。

## 3. 非目标

本设计不做：

- 不拆 `@opc/voice`。
- 不拆 `@opc/video`。
- 不移动 RustPBX/RWI。
- 不改外呼拨号流程。
- 不改坐席状态模型。
- 不改合规路径。
- 不改计费/QM/outcome。
- 不把 AI Agent Python 代码包进 TypeScript media Module。
- 不实现 SIP/VoLTE 视频桥，只保留 planned gateway 接口。
- 不改数据库 schema，除非实现中发现当前 `livekit_rooms` 或 `call_recordings` 缺字段。

## 4. 当前耦合问题

### 4.1 `livekit/room-store.ts` 反向依赖 call-center 类型

当前 `LiveKitRoomStore` 从 `../call-center/types.js` import `LiveKitRoomPurpose`。

这会阻止 `livekit/` 独立抽取。LiveKit 基础能力不应该知道 call-center。

裁决：

- 新增 `src/agent-runtime/livekit/types.ts`。
- 将 `LiveKitRoomPurpose` 移到 livekit 类型层，或在 livekit 内定义 `MediaRoomPurpose`。
- call-center 如果需要业务枚举，可以复用 livekit 的基础枚举，或做自己的业务映射。

### 4.2 EgressManager 放在 call-center 下

`src/agent-runtime/call-center/egress-manager.ts` 实际是 LiveKit egress 录音/录像能力，不应属于 call-center。

裁决：

- 第一阶段先新增 livekit recording service。
- 保留旧 `EgressManager` 作为兼容 facade 或改为从 livekit recording service re-export。
- 不一次性删除旧路径，避免影响现有 imports。

### 4.3 config 读取直接绑 env

`readLiveKitConfig()` 直接读环境变量。这对 OPC 内部没问题，但未来包化时，别的项目可能需要传入 config。

裁决：

- `createLiveKitMediaModule(input)` 接收可选 `config`。
- 未传入时仍使用当前 env 读取逻辑。
- 这样当前项目行为不变，未来项目可以直接注入配置。

### 4.4 room/token/dispatch/recording 分散

当前能力分散在：

- `token-service.ts`
- `room-store.ts`
- `agent-dispatch-service.ts`
- `webhook-handler.ts`
- `call-center/egress-manager.ts`
- `media-gateway/*`

裁决：

- 新增 `src/agent-runtime/livekit/index.ts` 作为唯一 public entry。
- 新增 `createLiveKitMediaModule()` 聚合这些能力。
- 旧文件可以继续存在，但新调用优先走 Module interface。

## 5. 推荐文件结构

第一阶段目标结构：

```text
src/agent-runtime/livekit/
  index.ts                 public entry, exports createLiveKitMediaModule
  types.ts                 livekit/media 基础类型
  config.ts                现有 config，增加可注入 config 支持
  token-service.ts         现有 token 逻辑
  room-store.ts            现有 room persistence，去掉 call-center import
  recording-service.ts     从 call-center/egress-manager 下沉过来
  agent-dispatch-service.ts
  webhook-handler.ts

src/agent-runtime/media-gateway/
  index.ts
  media-gateway-registry.ts
  adapters/webrtc-gateway.ts
  adapters/sip-volte-gateway.ts

src/agent-runtime/call-center/egress-manager.ts
  兼容 facade，调用 livekit/recording-service
```

未来包化目标结构：

```text
packages/livekit-media/
  src/
    index.ts
    types.ts
    config.ts
    token-service.ts
    room-store.ts
    recording-service.ts
    agent-dispatch-service.ts
    webhook-handler.ts
    media-gateway/
  package.json
```

## 6. Module Interface

### 6.1 创建入口

```ts
export interface LiveKitMediaModuleInput {
  db: unknown;
  config?: LiveKitMediaConfig;
  idGenerator?: (prefix: string) => string;
  logger?: LiveKitMediaLogger;
}

export interface LiveKitMediaModule {
  rooms: LiveKitRoomService;
  tokens: LiveKitTokenService;
  joins: MediaJoinService;
  recordings: LiveKitRecordingService;
  dispatch: LiveKitAgentDispatchService;
  webhooks: LiveKitWebhookService;
  gateways: MediaGatewayRegistry;
}

export function createLiveKitMediaModule(input: LiveKitMediaModuleInput): LiveKitMediaModule;
```

### 6.2 配置 Interface

```ts
export interface LiveKitMediaConfig {
  url?: string;
  apiKey?: string;
  apiSecret?: string;
  minioBucket?: string;
}

export interface LiveKitMediaLogger {
  warn(message: string, error?: unknown): void;
  info?(message: string, data?: unknown): void;
  error?(message: string, error?: unknown): void;
}
```

默认行为：

- 未传 `config` 时读取当前 `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`。
- 未传 `logger` 时使用 `console.warn`。
- 未传 `idGenerator` 时使用当前 `id(prefix)`。

### 6.3 Room Service

```ts
export interface LiveKitRoomService {
  createRoom(input: CreateMediaRoomInput): Promise<LiveKitRoomRow>;
  getRoomByName(roomName: string): LiveKitRoomRow | null;
  getRoomByCallSession(callSessionId: string): LiveKitRoomRow | null;
  markRoomActive(roomName: string, roomSid?: string): LiveKitRoomRow | null;
  closeRoom(roomName: string): Promise<LiveKitRoomRow | null>;
}
```

`CreateMediaRoomInput` 保持现有字段：

```ts
export interface CreateMediaRoomInput {
  tenant_id: string;
  purpose: MediaRoomPurpose;
  call_session_id?: string | null;
  metadata?: Record<string, unknown>;
  room_name?: string;
}
```

`purpose` 属于媒体层，不属于 call-center：

```ts
export type MediaRoomPurpose =
  | 'ai_outbound'
  | 'video_service'
  | 'screen_share'
  | 'conference'
  | 'pstn_bridge';
```

### 6.4 Token Service

```ts
export interface LiveKitTokenService {
  issueParticipantToken(input: IssueLiveKitTokenInput): Promise<LiveKitTokenResult>;
  issueSupervisorToken(input: IssueSupervisorTokenInput): Promise<LiveKitTokenResult>;
}
```

保持现有 dev-token 行为，方便测试和本地开发。

### 6.5 Join Service

```ts
export interface MediaJoinService {
  prepareJoin(channel: MediaChannel, ctx: MediaJoinContext): Promise<MediaJoinPlan>;
}
```

当前支持：

- `webrtc`：active，返回 LiveKit token 和可选 H5 join path。
- `sip_volte`：planned，返回 501 或 planned error，保留未来接口。

### 6.6 Recording Service

```ts
export interface LiveKitRecordingService {
  startRecording(
    tenantId: string,
    callSessionId: string,
    roomName: string,
    opts?: { format?: 'ogg' | 'mp4' | 'webm' | 'wav'; hasVideo?: boolean }
  ): Promise<EgressRecord>;

  stopRecording(egressId: string): Promise<EgressRecord | null>;
  getRecording(recordingId: string): EgressRecord | null;
  getRecordingByEgressId(egressId: string): EgressRecord | null;
  getRecordingBySession(callSessionId: string): EgressRecord | null;
  listRecordings(tenantId: string, opts?: { limit?: number }): EgressRecord[];
}
```

迁移方式：

- 先复制/下沉 `EgressManager` 的实现到 `livekit/recording-service.ts`。
- `call-center/egress-manager.ts` 改成兼容 re-export。
- 所有旧 import 暂时不动，后续逐步迁到新入口。

### 6.7 Dispatch Service

```ts
export interface LiveKitAgentDispatchService {
  dispatchAiAgent(roomName: string, metadata: Record<string, unknown>, agentName?: string): Promise<boolean>;
}
```

注意：

- dispatch 只负责把 agent 派进 LiveKit room。
- 不负责选择话术、合规、任务状态或业务摘要。

### 6.8 Webhook Service

```ts
export interface LiveKitWebhookService {
  handleWebhook(rawBody: string, authHeader?: string): Promise<unknown>;
}
```

注意：

- 只负责 LiveKit webhook 验签、解析、更新 room 状态。
- 不负责 call-center 业务事件分发。

## 7. 数据职责

第一阶段以现有表为主：

- `livekit_rooms`
- `call_recordings`
- `voice_call_sessions` 中的 `livekit_room_name` / `livekit_room_sid` / `media_type`

实现中新增了一个媒体基础表：

- `livekit_participants`：由 LiveKit webhook 写入 joined/left 状态、role、metadata，用于通用媒体参与人查询。

设计裁决：

- 不新增业务表；允许新增媒体基础表。
- 不改 `voice_call_sessions` 生命周期。
- `LiveKitRoomService.createRoom()` 可以继续在有 `call_session_id` 时更新 `voice_call_sessions`。
- 这属于兼容行为；未来包化时要通过 hook 或 callback 注入，避免直接依赖 voice 表。

未来包化时推荐将“更新 call session”改为注入 hook：

```ts
export interface LiveKitMediaHooks {
  onRoomLinkedToCallSession?(event: {
    tenantId: string;
    callSessionId: string;
    roomName: string;
    roomSid: string;
    mediaType: 'audio' | 'video';
  }): void | Promise<void>;
}
```

第一阶段不引入 hook，避免扩散改动；但实现时不能增加新的 call-center 依赖。

## 8. 与 call-center 的关系

call-center 可以调用：

```ts
const media = createLiveKitMediaModule({ db });
await media.rooms.createRoom({
  tenant_id: 'tenant_1',
  purpose: 'video_service',
  call_session_id: 'call_1'
});
await media.tokens.issueParticipantToken({
  room_name: 'tenant_1-video_service-demo',
  identity: 'agent_1',
  role: 'agent',
  tenant_id: 'tenant_1'
});
await media.recordings.startRecording('tenant_1', 'call_1', 'tenant_1-video_service-demo', {
  format: 'mp4',
  hasVideo: true
});
await media.dispatch.dispatchAiAgent('tenant_1-video_service-demo', {
  tenant_id: 'tenant_1',
  call_session_id: 'call_1'
});
```

livekit media 不能调用：

- `call-center/application.ts`
- `call-center/types.ts`
- `call-center/outbound-dialer.ts`
- `call-center/transfer-orchestrator.ts`
- `call-center/compliance/*`
- `call-center/billing/*`
- `call-center/qm/*`

允许依赖：

- `../../db.js`，第一阶段保留。
- `livekit-server-sdk`。
- `media-gateway/*`。

未来包化时，`../../db.js` 要替换成注入的 persistence adapter。

## 9. 实施策略

### 阶段 1：原地建立可抽取边界

目标：

- 新增 `livekit/index.ts`。
- 新增 `livekit/types.ts`。
- 新增 `livekit/recording-service.ts`。
- `room-store.ts` 去掉 call-center 类型 import。
- `call-center/egress-manager.ts` 保持兼容。
- 旧 call-center HTTP 行为不破坏；允许新增独立 `/api/media/livekit/*` 通用入口。

### 阶段 2：调用方逐步迁移

目标：

- `call-center/application.ts` 的 LiveKit room/token 调用逐步改走 media Module。
- `call-center-http.ts` 不直接知道多个 LiveKit service 文件。
- 新增功能只允许从 `livekit/index.ts` import。

### 阶段 3：包化准备

目标：

- 引入 persistence adapter。
- 引入 hooks。
- 消除 `../../db.js` 直接 import。
- 将 `src/agent-runtime/livekit/` 和 `media-gateway/` 移入 `packages/livekit-media/`。

### 阶段 4：可选服务化

仅当其他项目无法 import npm 包或需要独立扩缩容时再做。

服务化形态：

```text
POST /media/rooms
POST /media/tokens
POST /media/join-plans
POST /media/recordings/start
POST /media/recordings/stop
POST /media/dispatch
POST /media/webhooks/livekit
```

服务化或跨项目复用时的安全口径：

- 管理端点必须服务端到服务端调用。
- 当前原地实现已支持 `OPC_MEDIA_API_TOKEN` / `LIVEKIT_MEDIA_API_TOKEN`，请求头为 `Authorization: Bearer <token>`；若 `NODE_ENV=production` 且未配置媒体服务令牌，管理端点会 fail-closed 返回 401，本地开发仍保留无 token 兼容。
- 当前原地实现已支持客户邀请链接签名：配置 `OPC_MEDIA_INVITE_SECRET` / `LIVEKIT_MEDIA_INVITE_SECRET` 后，customer joinPath 携带 `expires_at` + HMAC `invite`；`join?role=customer` 必须带有效签名才能换取 LiveKit token。若 `NODE_ENV=production` 且没有配置邀请签名密钥，customer join 会 fail-closed 返回 401；带 Media service token 的服务端内部 join 仍可执行。
- 当前原地实现已支持房间生命周期门禁：HTTP 入口与 `LiveKitMediaModule` public API 的 `token`、`join`、`agent-dispatch`、`recordings.startRecording` 都只对当前租户下未关闭的 room 工作；关闭后的 room 返回 409。HTTP `token` 与 `agent-dispatch` 必须显式携带 `tenant_id`。
- 当前原地实现已支持录制业务对象绑定：`recordings.startRecording` 和 `/api/media/livekit/recordings/start` 可传 `businessRef` / `business_ref`；旧 `call_session_id` 保留，并自动映射成 `call_session` business ref。
- 当前原地实现已支持媒体录制到证据链的桥接：总 HTTP 入口有 Postgres 时，`recordings/start` 会通过中立桥接层写入 `evidence_records`，LiveKit 模块本身不反向依赖 collaboration。
- 当前原地实现已支持 `egress_ended` 录制完成回调：可按 room metadata 的 `business_ref` 或旧 `call_session_id` 写入/更新录制，并触发同一证据桥；`egress_id` 和 `recording_id` 均做幂等处理。
- 当前原地实现已支持 LiveKit webhook 生产 fail-closed：`NODE_ENV=production` 且缺少 `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`（或 `OPC_LIVEKIT_API_KEY` / `OPC_LIVEKIT_API_SECRET`）时，webhook 不再按开发 JSON 解析，而是返回 401；webhook 验签只要求 key/secret，不要求 `LIVEKIT_URL`。
- 当前原地实现已支持迟到 webhook 防护：`room_started` 不能复活 closed room，closed room 的 `participant_joined` 不写参与人、不发 joined 通知。
- 当前原地实现已支持 `room_finished` 参与人状态收敛：关闭 room 时会把仍处于 `joined` 的参与人批量标记为 `left`，避免通用 participants 查询返回过期在线状态。
- 当前原地实现已支持 `participant_left` 乱序兜底：即使 joined webhook 丢失或晚到，也会按 room 租户创建 `left` 参与人记录，保留 role、metadata 与 left_at。
- 当前原地实现已支持参与人画像保留式更新：left 事件或重复事件未携带 metadata、且 role 只能推断为 `unknown` 时，不覆盖 joined 阶段已记录的 role/metadata。
- 当前原地实现已支持媒体管理端点强制租户校验：token、agent-dispatch、room 查询、参与人查询、关闭房间、录制读取和停止录制必须携带 `tenant_id`，且必须匹配资源租户；缺失返回 400，不匹配返回 404。
- 当前原地实现已提供 `npm run smoke:media` 冒烟脚本：在真实后端/LiveKit 环境中验证创建房间、直接签 token、AI dispatch、签 join、录制启停、参与人查询、关闭房间和关闭后拒绝 join 的 Media Core API 链路；设置 `OPC_MEDIA_SMOKE_REQUIRE_CONFIGURED_LIVEKIT=1` 后，会拒绝服务端返回的 `dev-token` / `configured=false` token；配置 `OPC_MEDIA_INVITE_SECRET` 或 `LIVEKIT_MEDIA_INVITE_SECRET` 时，会要求返回的客户 `customerJoinPath` 带 `invite` 与 `expires_at`；房间创建成功后若后续步骤失败，脚本会尽力关闭刚创建的测试房间，避免真实验收留下脏 room。
- 当前原地实现已提供 `npm run smoke:media:browser` 浏览器冒烟入口：在真实前端/后端/LiveKit + Playwright 环境中，用两个已认证坐席会话验证坐席间视频呼叫、接听、进入视频通话，并等待双方远端 video DOM；开启屏幕共享时还会等待接收方屏幕共享 video DOM。
- 当前原地实现已提供 `npm run smoke:media:customer-browser` 客户 H5 浏览器冒烟入口：在真实前端/后端/LiveKit + Playwright 环境中打开客户 `/video?...` 邀请链接，验证客户页换取 join token、进入房间；开启远端/屏幕共享期望时会分别等待客户页远端 video DOM 与屏幕共享 video DOM。
- 当前原地实现已提供 `npm run smoke:media:sip-volte` readiness 入口：检查 LiveKit、livekit-sip bridge target、RustPBX trunk/RWI 配置，并生成 `sip_volte` SIP dial plan；gateway 默认仍保持 `planned`，不冒充真实 VoLTE 已可拨。设置 `OPC_SIP_VOLTE_GATEWAY_STATUS_URL` 和可选 `OPC_SIP_VOLTE_GATEWAY_STATUS_TOKEN` 后，脚本会读取 livekit-sip/RustPBX 桥运行时状态，只有 active/ready/healthy、bridge target、trunk 与 video 标志都匹配时，才把本次 readiness 的 `gatewayStatus` 提升为 `active`。设置 `OPC_SIP_VOLTE_REQUIRE_ACTIVE=1` 后，未配置探针或探针不 active 都会让脚本返回非 0，适合生产上线把 SIP/VoLTE 纳入硬门禁。
- 当前原地实现已提供 `npm run smoke:media:avatar` AI 数字人发布冒烟入口：在真实 LiveKit 环境中连接房间、发布 `avatar-video`、启动渲染循环、喂探测音频、等待帧捕获并清理退出；清理阶段会独立尝试 stop 与 disconnect，避免 avatar stop 失败时跳过 LiveKit room disconnect；当前单测只锁动作契约，真实环境仍需执行该 smoke。
- 当前原地实现已提供 `npm run smoke:media:ai-callback` 业务回调冒烟入口：创建旧 LiveKit room 后，带 `OPC_API_KEY` 与显式 `tenant_id` 调用旧 `/api/livekit/agent-dispatch` 的 `transfer_to_human` 动作，并通过 Media Core close API 清理房间；若 dispatch 失败，也会尽力关闭已创建的测试 room；这条 smoke 验证的是 AI agent 回调 OPC 执行业务动作，不是 Media Core 派 AI 入房。
- 当前原地实现已提供 `npm run smoke:media:readiness` 整套视频 readiness 总门禁：串行执行 Media API、AI avatar、AI 业务回调、坐席浏览器、客户 H5 浏览器、Collaboration/Remote Assistance smoke、SIP/VoLTE readiness，并在执行前按目标报告缺失环境变量；`collaboration` 目标会运行 `npm run smoke:collaboration`，覆盖协作 session、远程协助授权、第三方工具会话、录屏证据、审计 timeline 和 revoke 后工具会话结束，设置 `OPC_COLLAB_SMOKE_USE_GATEWAY_TOOL=1` 时会通过 `/tools/gateway` 验证 OPC 后端调用 MeshCentral / Guacamole 网关创建工具会话；`collab` / `remote` / `remote-assistance` alias 会归一为同一个目标并去重，避免同一 smoke 重复跑；`remote-gateway` 是可选目标，会运行 `npm run smoke:remote-gateway`，显式验证 MeshCentral / Guacamole 网关会话创建、审计读取和结束；`media` 目标会预检查 `OPC_MEDIA_INVITE_SECRET` / `LIVEKIT_MEDIA_INVITE_SECRET`，并自动开启 `OPC_MEDIA_SMOKE_REQUIRE_CONFIGURED_LIVEKIT=1`，避免真实客户 H5 链路到最后一步才发现生产邀请签名缺失，或后端仍在签发 dev-token；当 `media` 排在 `customer-browser` 前面时，会自动保留媒体房间、把 `smoke:media` 返回的 `customerJoinPath` 传给客户 H5 浏览器 smoke，并在客户浏览器 smoke 后关闭该房间；如果 `media` 成功但没有输出 `customerJoinPath`，总门禁会立刻记录结构化失败、清理已知 room，并跳过依赖该链接的 customer-browser 目标；若中间目标失败，也会先清理保留房间。命令返回非 0、命令启动/runner 抛错或 cleanup 失败时，总门禁会输出结构化部分报告，保留每个已执行 step 的 stdout/stderr 摘要和清理证据。
- 当前 `docker-compose.callcenter.yml` 已把 `OPC_MEDIA_API_TOKEN`、`OPC_MEDIA_INVITE_SECRET`、`OPC_MEDIA_INVITE_TTL_MS` 和 MinIO 录制配置传入 `opc` 服务；`dev:callcenter` / `dev:callcenter:detach` 脚本显式使用 `.env.example` 并禁用自动读取根目录私人 `.env`，避免本地真实栈与宿主机 smoke/readiness 使用不同媒体安全口径，或被私人备注阻断启动。
- 当前 `config/livekit.yaml` 已把 LiveKit webhook URL 指向 `/api/media/webhooks/livekit`，让真实房间、参与人和录制完成事件进入通用 Media Core；旧 `/api/webhooks/livekit` 仅作为 call-center 兼容入口保留。
- 当前本地 compose 栈已固定 LiveKit 与 Egress 底层 dev 凭证：`devkey` / `secret`、`minioadmin` / `minioadmin`，并让 `opc`、`livekit-sip`、`ai-agent`、`minio` 与 mounted config 保持一致，避免只覆盖 shell env 导致容器间鉴权错位。
- 当前 `infra/docker-compose.production.yml` 已改为挂载 `OPC_MEDIA_CONFIG_DIR` 下的渲染后媒体配置，默认路径是 `../.runtime/media/livekit.yaml` 与 `../.runtime/media/egress.yaml`，避免 production compose 继续挂开发 `devkey` 配置；新增 `npm run render:media-configs`，从真实 `LIVEKIT_API_KEY`、`LIVEKIT_API_SECRET`、MinIO 凭证渲染 LiveKit server 与 Egress 配置。production compose 仍挂载 `../config/rustpbx.docker.toml`，并把 Media Core 管理令牌、邀请签名 TTL、`OPC_API_KEY` 与 MinIO 录制配置传入 `opc`；`infra/env.example` 已声明这些生产/准生产必填项。
- 当前 Kubernetes/Helm 模板已把 LiveKit key/secret、Media Core token、客户邀请签名 TTL、`OPC_API_KEY` 与 MinIO 录制配置传入 `opc`，并把同一个 `OPC_API_KEY` 传入 AI agent；`infra/k8s/values.yaml` 已声明 `livekit`、`media` 与 `opc.apiKey` 配置项。chart 已补基础媒体运行时模板：LiveKit server、MinIO、LiveKit Egress、livekit-sip；`livekit.url` 可把 OPC、AI agent、Egress、SIP 指向外部 Media Core，`media.minioEndpoint` 可指向外部对象存储。默认 database-url 已按 release name 指向 `{{ release }}-postgres`，不再固定 `opc-postgres`。
- 当前根目录 `.env.example` 已集中声明 `npm run smoke:media:readiness` 所需的 Media API、AI avatar、坐席浏览器、客户 H5、Collaboration/Remote Assistance、SIP/VoLTE 与 MinIO 录制变量；CI 单测会防止 smoke 脚本需要的变量和样例文件漂移。
- 当前 OPC 旧入口已开始迁入模块边界：`issueLiveKitTokenCommand`、intercom start/accept、全渠道 `escalate-video`、`/api/call-center/video/start`、外呼 video_link_sms、supervisor、conference、warm transfer 均走 `LiveKitMediaModule`，不再直接裸调 token service / gateway、手工拼客户视频链接，或在客户 URL 中暴露 LiveKit token。
- 当前 AI agent 回调 OPC 的旧业务动作入口 `/api/livekit/agent-dispatch` 已补租户门禁：它处理转人工、结束通话、预约回拨，和 Media Core 的 `/api/media/livekit/agent-dispatch` 派 AI 入房不是同一语义；旧入口现在要求 `tenant_id` 并校验 room 租户，Python AI agent 三个业务动作都会发送 `tenant_id`。
- 当前旧 `/api/livekit/rooms` 与 `/api/livekit/token` 兼容入口也已接入 `OPC_API_KEY` 门禁：生产环境必须配置 `OPC_API_KEY`，创建旧 room、直接签旧 token 和旧 agent business dispatch 都必须带 `X-API-Key`；`NODE_ENV=production` 未配置 key 时 fail-closed 返回 401，开发环境未配置 key 时保留本地兼容。
- 客户邀请链接只允许走受限 join plan，例如 `join?role=customer`，不要把服务管理令牌下发到浏览器。
- LiveKit webhook 不使用媒体服务令牌，继续走 LiveKit webhook auth header 验签。

第一阶段不做服务化。

## 10. 测试策略

### 10.1 必须新增/调整的测试

建议新增：

```text
test/livekit-media-module.test.ts
```

覆盖：

1. `createLiveKitMediaModule()` 返回 rooms/tokens/joins/recordings/dispatch/webhooks/gateways。
2. room create 在 LiveKit 未配置时仍写入 `livekit_rooms`。
3. token service 在 LiveKit 未配置时返回 dev-token。
4. WebRTC join plan 返回 token 和 customer joinPath。
5. planned `sip_volte` gateway 拒绝 active use。
6. recording service 在 LiveKit 未配置时写入 `call_recordings` row。
7. `call-center/egress-manager.ts` 兼容旧 import。
8. 配置 `OPC_MEDIA_API_TOKEN` 后，媒体管理端点无令牌返回 401；`NODE_ENV=production` 未配置媒体服务令牌时，媒体管理端点也必须 fail-closed 返回 401；客户 `join?role=customer` 与 LiveKit webhook 不被服务令牌误拦。
9. 配置 `OPC_MEDIA_INVITE_SECRET` 后，customer joinPath 带 `expires_at` 与 `invite`；客户 join 缺签名、签名过期或签名不匹配返回 401；`NODE_ENV=production` 未配置邀请签名密钥时，客户 join 必须 fail-closed，不能退回开发模式。
10. room 被 close 后，`/api/media/livekit/token`、`join`、`agent-dispatch`、`recordings/start` 返回 409，不再签发 token、派 AI agent 或启动录制。
11. room 被 close 后，直接调用 `LiveKitMediaModule.tokens`、`joins`、`dispatch`、`recordings.startRecording` 同样返回 409。
12. `NODE_ENV=production` 且缺少 LiveKit webhook key/secret 时，`/api/media/webhooks/livekit` 与旧 `/api/webhooks/livekit` 必须 fail-closed；有 key/secret 时启用 LiveKit SDK 验签，且不要求 `LIVEKIT_URL`。
13. room 被 close 后，迟到 `room_started` 不会将状态改回 `active`；迟到 `participant_joined` 不新增参与人、不触发 joined 通知。
14. 录制启动支持非 call-center `business_ref`，且旧 `call_session_id` 录制行为不变。
15. 有 Postgres 时，媒体录制会写入 `evidence_records`，并保留 recording_id、room_name、egress_id、format 等 metadata。
16. `egress_ended` webhook 支持 business ref room，并按 `egress_id` 更新已有录制、按 `recording_id` 幂等写证据。
17. `room_finished` webhook 会关闭 room，并把仍处于 `joined` 的参与人标记为 `left`。
18. `participant_left` webhook 即使没有对应 joined 记录，也会留下 left 状态参与人审计记录。
19. `participant_left` 或重复 joined 事件缺 metadata/role 时，不会清空此前已保存的参与人画像字段。
20. 媒体管理端点对 token/agent-dispatch/room/participants/recording/close/stop 执行强制 `tenant_id` 校验：缺失返回 400，不匹配返回 404。
21. `npm run smoke:media` 能在真实服务环境中跑通 Media Core API 冒烟，并验证 token、agent-dispatch 与资源管理调用携带 `tenant_id`；开启 `OPC_MEDIA_SMOKE_REQUIRE_CONFIGURED_LIVEKIT=1` 时，`issue_token`、agent join、customer join 必须返回 `configured=true` 的真实 LiveKit token，不接受 dev-token；房间创建成功后若任一步失败，应尽力调用 close 清理该 smoke room。
22. 旧 `issueLiveKitTokenCommand` 和 intercom start/accept 不绕过 module 生命周期门禁。
23. 全渠道 `escalate-video` 和 `/api/call-center/video/start` 的客户链接必须来自 `LiveKitMediaModule.joins.prepareJoin`；配置邀请密钥后返回的链接带 `tenant_id`、`expires_at`、`invite`。
24. 外呼 video_link_sms、supervisor monitor、conference invite、warm transfer consult 遇到 closed room 时必须走 `LiveKitMediaModule` 返回 409/抛出 `media room is closed`，不得直接裸签 token。
25. `npm run smoke:media:browser` 能在真实浏览器环境中驱动双坐席 `/workbench` 页面完成视频呼叫/接听，并等待双方远端 video DOM；开启 `OPC_BROWSER_SMOKE_SCREEN_SHARE=1` 时必须额外验证接收方屏幕共享 video DOM。
26. `npm run smoke:media:sip-volte` 能在真实配置环境中校验 livekit-sip/RustPBX 桥接配置并输出 SIP dial plan；在未配置运行时状态探针且 gateway 仍是 `planned` 时必须明确提示需要人工激活；设置 `OPC_SIP_VOLTE_GATEWAY_STATUS_URL` 后必须能用 active/ready/healthy 状态、bridge target、trunk 与 video 标志把本次 readiness 提升为 `active`；设置 `OPC_SIP_VOLTE_REQUIRE_ACTIVE=1` 时，未配置探针或探针未 active 必须失败。
27. `npm run smoke:media:avatar` 能在真实 LiveKit 环境中连接房间、发布 `avatar-video`、启动数字人渲染循环、喂探测音频并完成清理退出；CI 单测必须覆盖 env 门禁、动作顺序，以及 avatar stop 失败时仍会断开 LiveKit room。
28. `npm run smoke:media:customer-browser` 能在真实浏览器环境中打开客户 `/video?...` 页面并等待“已连接房间”；开启 `OPC_CUSTOMER_BROWSER_SMOKE_EXPECT_REMOTE=1` 或 `OPC_CUSTOMER_BROWSER_SMOKE_EXPECT_SCREEN_SHARE=1` 时必须额外验证远端 video DOM / 屏幕共享 video DOM。
29. `npm run smoke:media:readiness` 能把 Media API、AI avatar、AI 业务回调、坐席浏览器、客户 H5 浏览器、Collaboration/Remote Assistance smoke、SIP/VoLTE readiness 串成单个真实环境验收命令；CI 单测必须覆盖 target 解析、`collab` / `remote` / `remote-assistance` alias 与去重、可选 `remote-gateway` / `gateway` / `meshcentral` / `guacamole` 目标、预检查（包括 media 目标必须带客户邀请签名密钥、collaboration 目标必须带 OPC 后端 key 和 tenant、remote-gateway 目标必须带网关 provider/base URL/token/target id）、media 目标自动启用真实 LiveKit token 强制检查、配置邀请密钥时拒绝未签名 `customerJoinPath`、失败策略、命令顺序，以及 `media` 产出的 `customerJoinPath` 自动传给 `customer-browser`、保留媒体房间、media 缺 `customerJoinPath` 时 fail-fast/跳过依赖目标/清理已知 room、在浏览器 smoke 后清理、在中间目标失败时也清理，并在目标失败、runner 抛错或 cleanup 失败时返回包含 stdout/stderr 摘要的结构化部分报告。
30. `docker-compose.callcenter.yml` 的 `opc` 服务必须显式携带媒体服务令牌、邀请签名 TTL 和 MinIO 录制配置；`dev:callcenter` / `dev:callcenter:detach` 必须显式使用 `.env.example` 并禁用自动读取根目录私人 `.env`；根目录 `.env.example` 必须声明 `smoke:media:readiness` 所需的 Media API、AI avatar、坐席浏览器、客户 H5、Collaboration/Remote Assistance、SIP/VoLTE 与 MinIO 录制变量，包括 `OPC_SIP_VOLTE_REQUIRE_ACTIVE` 生产硬门禁开关，以及 `OPC_SIP_VOLTE_GATEWAY_STATUS_URL` / `OPC_SIP_VOLTE_GATEWAY_STATUS_TOKEN` 运行时状态探针变量；`config/livekit.yaml` 必须指向 `/api/media/webhooks/livekit`；本地 compose 的 `opc`、`livekit-sip`、`ai-agent`、`minio` 必须与 `config/livekit.yaml` / `config/egress.yaml` 的 dev 凭证保持一致；production compose 必须挂载 `npm run render:media-configs` 生成的 LiveKit/Egress 配置，不得直接挂开发配置文件，并在 `infra/env.example` 声明 Media Core、`OPC_API_KEY`、`OPC_MEDIA_CONFIG_DIR` 与 MinIO 录制必填项；Kubernetes/Helm 的 `opc` 与 `ai-agent` 模板必须带齐同一组视频 env，且 `OPC_API_KEY` 必须同时传给调用方和被调用方；chart 必须提供基础媒体运行时依赖（LiveKit server、MinIO、LiveKit Egress、livekit-sip），并支持通过 `livekit.url` / `media.minioEndpoint` 切到外部媒体核心或外部对象存储；默认 database-url 不得引用固定 release 名；CI 单测应防止 compose、npm scripts、LiveKit/Egress config、Helm templates 与 smoke 脚本的环境变量/路径口径漂移。
31. AI agent 回调 OPC 的旧 `/api/livekit/agent-dispatch` 必须要求 `tenant_id` 并校验 room 租户；Python AI agent 的 `transfer_to_human`、`end_call`、`schedule_callback` 必须发送该 `tenant_id`，避免只凭 room 名执行跨租户业务动作；`npm run smoke:media:ai-callback` 必须覆盖真实服务环境下的 OPC_API_KEY 鉴权、租户参数、业务动作响应和 room cleanup，且 dispatch 失败后也应尽力清理已创建的测试 room。
32. 旧 `/api/livekit/rooms` 与 `/api/livekit/token` 在生产环境必须配置 `OPC_API_KEY`，并拒绝缺 key / 错 key 请求，带正确 `X-API-Key` 才允许创建旧 room 或签旧 token；`NODE_ENV=production` 未配置 key 时必须 fail-closed，开发环境未配置 key 时保留兼容。

### 10.2 必须跑的验证

第一阶段实现后至少跑：

```bash
npm run typecheck
node --import tsx --test test/livekit-media-http.test.ts test/livekit-media-module.test.ts test/collaboration-remote-assistance.test.ts test/egress-manager.test.ts test/media-gateway.test.ts
```

如果改到 call-center HTTP 或视频页面，再追加：

```bash
npx tsc -p frontend/tsconfig.json --noEmit
npx tsc -p services/agent-panel/tsconfig.json --noEmit
```

## 11. 验收标准

必须同时满足：

1. 当前项目现有行为不变。
2. `src/agent-runtime/livekit/` 不再 import `call-center/*`。
3. 新的 public entry 是 `src/agent-runtime/livekit/index.ts`。
4. 新功能从 `livekit/index.ts` import，而不是散落 import 内部文件。
5. 旧 `call-center/egress-manager.ts` import 仍可用。
6. LiveKit 未配置的 dev-token / row-only recording 行为不变。
7. WebRTC gateway 行为不变。
8. SIP/VoLTE gateway 仍保持 planned，不被误启用。
9. TypeScript typecheck 通过。
10. 新增 livekit media module 测试通过。
11. 服务级媒体 API 鉴权测试通过，且客户 H5 公开视频链接不回归。
12. 客户 H5 join helper 覆盖签名参数透传、API data envelope、错误透出、缺 token/缺 LiveKit URL fail-closed，以及 dev-token 兼容。
13. 浏览器冒烟脚本契约覆盖双坐席登录态、页面动作顺序、Playwright 缺失提示、远端 video DOM 等待和可选屏幕共享 video DOM 断言。
14. SIP/VoLTE readiness 覆盖必填配置、planned 状态提示、运行时状态探针提升 active 和 SIP dial plan 形状。

## 12. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 把 call-center 业务带进 media Module | 未来无法复用 | 禁止 livekit import call-center；测试/rg 检查 |
| 改 recording 路径导致旧代码断 | 通话录音失效 | `call-center/egress-manager.ts` 做兼容 facade |
| 一次性包化影响构建 | 当前项目不稳定 | 第一阶段不建 `packages/` |
| 过早服务化 | 运维和延迟增加 | 先 npm 包思路，服务化只作为阶段 4 |
| token/room 行为变化 | 前端无法加入房间 | 保持现有 token-service 语义 |
| SIP/VoLTE stub 被误用 | 生产调用失败 | gateway status 默认保持 `planned`，prepareJoin 抛 501；上线硬门禁必须通过运行时状态探针或真实 E2E 证明桥接 active |

## 13. 后续与 voice/video 拆分关系

LiveKit media Module 是底座，不是最终全部音视频业务。

未来可叠加：

```text
@opc/livekit-media
  └── 基础房间/token/join/recording/dispatch/webhook

@opc/voice
  └── SIP/PSTN/RustPBX/RWI/voice call session/voice recording

@opc/video
  └── H5 video page/video session/avatar/screen share/video layout
```

本次只做第一层。

## 14. 实现前裁决

用户已确认：

- 两块能力后续都要复用。
- 当前先聚焦 LiveKit 音视频基础能力。
- 不影响当前项目。
- 方便后续拆出来给其他服务用。
- 采用方案 C：先建立可抽取边界。

因此下一步应写实现计划，再按 TDD 执行。
