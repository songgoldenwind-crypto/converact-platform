# iveKit 可复用音视频协作模块设计

> 日期：2026-07-01
> 状态：设计规格，待用户确认后拆实现计划
> 范围：把 OPC 已经落地的 LiveKit Media Core、Collaboration Session、Remote Assistance 整理成可被 LED 项目复用的库内通用模块。第一版远程协助以自研 Web Remote Assist 为主；数字人、运营商 SIP/VoLTE 视频和需要安装客户端的完整桌面远控先不进入第一版主线。

---

## 1. 结论

iveKit 第一版应该按“库内模块化，后续可抽包”的方式落地。

第一版不新建微服务，不立刻搬到 `packages/`，而是在 OPC 当前仓库内新增稳定 public entry：

```text
src/agent-runtime/ivekit/
├── index.ts
├── module.ts
├── types.ts
├── http.ts
└── adapters/
    ├── livekit-media.ts
    ├── collaboration.ts
    └── remote-assistance.ts
```

它封装现有：

- `src/agent-runtime/livekit/`
- `src/agent-runtime/collaboration/`
- `src/agent-runtime/media-gateway/`

LED、OPC 或其它项目只接 iveKit 的 interface，不直接 import OPC call-center、内部 Store 或具体网关实现。

## 2. 第一版产品范围

iveKit v1 覆盖五类能力：

1. **语音/视频会话**
   - 创建媒体房间。
   - 生成坐席、客户、工程师加入计划。
   - 支持 voice / video 媒体类型。
   - 支持浏览器 WebRTC 链路。
   - 支持屏幕共享轨道。

2. **聊天与协作**
   - 创建绑定业务对象的协作会话。
   - 加入参与人。
   - 发送文本、图片、视频、文件、系统消息。
   - 保存翻译结果。
   - 执行基础防绕单文本扫描。
   - 输出统一 timeline。

3. **录制与证据**
   - 启动/停止 LiveKit Egress 录音录像。
   - 远控录屏证据入库。
   - 授权、撤销、远控日志入证据链。
   - 所有证据按 `BusinessRef` 聚合。

4. **自研 Web 远程协助**
   - 创建远程协助会话。
   - 申请、授予、拒绝、撤销授权。
   - 客户浏览器共享屏幕。
   - 坐席/工程师观看共享画面。
   - 坐席/工程师发送鼠标指示、标注、引导点击等协助事件。
   - 支持对 iveKit/LED/OPC 自己页面内的协同操作，不承诺控制客户整台电脑。
   - 录制屏幕共享与远程协助事件。
   - 全部操作写入审计 timeline 和证据链。

5. **跨项目绑定**
   - OPC 绑定 `call_session` / `support_ticket`。
   - LED 绑定 `service_order` / `remote_support_order` / `dispute_case`。
   - iveKit 不读取、不更新业务项目自己的订单表或通话表。

## 3. 第一版非目标

第一版明确不做这些：

- 不做 AI 数字人主线。现有 avatar smoke 保留，但不作为 iveKit v1 完成标准。
- 不把运营商 SIP/VoLTE 视频算作 v1 必须完成。保留 readiness、dial plan 和状态探针，但真实运营商联调单独推进。
- 不 fork RustDesk，不深改远控协议。
- 不在 v1 自研完整桌面被控端；完整鼠标键盘控制客户电脑需要后续轻量客户端。
- RustDesk 作为系统级远控主 provider；MeshCentral、Guacamole、TeamViewer、AnyDesk、向日葵等保留为 fallback adapter 或客户已有系统接入。
- 不把 OPC call-center 业务规则塞进 iveKit。
- 不把 LED 订单状态流转塞进 iveKit。
- 不直接暴露媒体管理 token 给浏览器。
- 不承诺第一版达到 TeamViewer/AnyDesk 的整机远控体验。

## 4. 模块分层

```text
iveKit
├── Media
│   ├── room
│   ├── join plan
│   ├── token
│   ├── participant
│   ├── recording
│   └── webhook
├── Collaboration
│   ├── session
│   ├── participant
│   ├── message
│   ├── translation
│   ├── policy scan
│   └── timeline
└── Remote Assistance
    ├── remote session
    ├── consent
    ├── web remote assist session
    ├── screen-share control events
    ├── annotations
    ├── audit event
    └── evidence
```

设计原则：

- iveKit 的 interface 是项目复用面。
- LiveKit 是 Media adapter；自研 Web Remote Assist 负责浏览器内协助；RustDesk 是系统级远控主 provider；MeshCentral、Guacamole、TeamViewer 等只作为 fallback adapter，不是业务 interface。
- OPC 和 LED 都通过 `BusinessRef` 把自己的业务对象绑定到 iveKit。
- 通用模块只知道租户、业务对象、参与人、证据和审计，不知道订单状态、坐席排班或结算规则。

## 5. 统一领域模型

### 5.1 BusinessRef

```ts
export interface IveBusinessRef {
  tenant_id: string;
  type: 'call_session' | 'service_order' | 'support_ticket' | 'remote_support_order' | 'dispute_case' | string;
  id: string;
  display_name?: string;
  metadata?: Record<string, unknown>;
}
```

规则：

- `tenant_id` 必须和调用方租户一致。
- `type + id` 是跨模块聚合键。
- iveKit 不验证业务对象是否存在；由 OPC/LED 适配层在调用前验证。
- 所有 room、collaboration session、remote assistance session、recording、evidence 都必须能追溯到同一个 `BusinessRef`。

### 5.2 Participant

```ts
export type IveParticipantRole =
  | 'customer'
  | 'agent'
  | 'engineer'
  | 'supervisor'
  | 'ai'
  | 'admin'
  | 'system';

export interface IveParticipantRef {
  identity: string;
  role: IveParticipantRole;
  display_name?: string;
  user_ref?: {
    type: string;
    id: string;
  };
}
```

LED 用法：

- 买家：`role='customer'`
- 服务工程师：`role='engineer'`
- 平台客服：`role='agent'`

OPC 用法：

- 呼入客户：`role='customer'`
- 坐席：`role='agent'`
- 主管：`role='supervisor'`

### 5.3 Session Bundle

LED 和 OPC 最常用的不是底层 room 或 remote session，而是一个可以一次创建完整协作上下文的 bundle。

```ts
export interface IveSessionBundle {
  business_ref: IveBusinessRef;
  collaboration_session_id: string;
  media_room_name: string;
  customer_join_path?: string;
  agent_join_plan?: IveMediaJoinPlan;
  remote_session_id?: string;
  remote_assist_request_path?: string;
  timeline_url?: string;
}
```

## 6. Public Interface

### 6.0 Public Types

iveKit public interface 使用自己的类型名，对底层 LiveKit / Collaboration / Remote Store 类型做收敛。第一版可以在实现中直接映射到底层类型，但 LED 和 OPC 新代码不应依赖底层类型。

```ts
export interface IveMediaRoom {
  id: string;
  tenant_id: string;
  room_name: string;
  purpose: 'voice_service' | 'video_service' | 'screen_share' | 'conference' | 'pstn_bridge';
  status: 'created' | 'active' | 'closed';
  business_ref: IveBusinessRef;
  metadata: Record<string, unknown>;
}

export interface IveMediaJoinPlan {
  channel: 'webrtc' | 'sip_volte';
  room_name: string;
  identity: string;
  role: IveParticipantRole;
  media: 'voice' | 'video';
  token?: string;
  livekit_url?: string;
  join_path?: string;
  expires_at?: string;
  metadata?: Record<string, unknown>;
}

export interface IveEvidenceRecord {
  id: string;
  tenant_id: string;
  business_ref: IveBusinessRef;
  session_id: string;
  kind:
    | 'audio_recording'
    | 'video_recording'
    | 'screen_recording'
    | 'remote_control_log'
    | 'consent_grant'
    | 'consent_revocation'
    | 'chat_export'
    | 'file_snapshot';
  storage_url: string;
  checksum?: string;
  retention_until?: string | null;
  created_by: string;
  created_at: string;
  metadata: Record<string, unknown>;
}

export interface IveMessage {
  id: string;
  tenant_id: string;
  session_id: string;
  sender_identity: string;
  message_type: 'text' | 'image' | 'video' | 'file' | 'system';
  body: string;
  original_language: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface IveMessageTranslation {
  id: string;
  tenant_id: string;
  message_id: string;
  target_language: string;
  translated_body: string;
  provider: string;
  confidence: number | null;
  created_at: string;
}

export interface IvePolicyScanResult {
  matched: boolean;
  events: Array<{
    id: string;
    policy_type: string;
    severity: 'low' | 'medium' | 'high';
    action: string;
  }>;
}

export type IveTimelineItem =
  | { type: 'participant'; item: Record<string, unknown> }
  | { type: 'message'; item: IveMessage }
  | { type: 'remote_audit'; item: IveRemoteAuditEvent }
  | { type: 'evidence'; item: IveEvidenceRecord };

export type IveRemoteConsentScope =
  | 'view_screen'
  | 'control_mouse_keyboard'
  | 'record_screen'
  | 'transfer_file'
  | 'clipboard';

export interface IveConsentInput {
  tenant_id: string;
  remote_session_id: string;
  actor_identity: string;
  scopes: IveRemoteConsentScope[];
  expires_at?: string | null;
  metadata?: Record<string, unknown>;
}

export interface IveConsentEvent {
  id: string;
  tenant_id: string;
  remote_session_id: string;
  actor_identity: string;
  event_type: 'requested' | 'granted' | 'denied' | 'revoked' | 'expired';
  scopes: IveRemoteConsentScope[];
  expires_at: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
}

export interface IveRemoteSession {
  id: string;
  tenant_id: string;
  collaboration_session_id: string;
  business_ref: IveBusinessRef;
  status: 'created' | 'active' | 'ended';
  mode: 'web_remote_assist' | 'third_party_remote_tool' | 'remote_desktop_gateway' | 'platform_remote_control';
  adapter_provider: string;
  started_by: string;
  started_at: string | null;
  ended_at: string | null;
  metadata: Record<string, unknown>;
}

export interface IveRemoteToolSession {
  id: string;
  tenant_id: string;
  remote_session_id: string;
  provider: string;
  external_id: string;
  launch_url: string;
  status: 'active' | 'ended';
  started_by: string;
  started_at: string;
  ended_at: string | null;
  metadata: Record<string, unknown>;
}

export type IveRemoteAssistEventType =
  | 'pointer.move'
  | 'pointer.click_hint'
  | 'annotation.draw'
  | 'annotation.clear'
  | 'viewport.changed'
  | 'page.action_hint'
  | 'control.requested'
  | 'control.released';

export interface IveRemoteAssistEvent {
  id: string;
  tenant_id: string;
  remote_session_id: string;
  actor_identity: string;
  event_type: IveRemoteAssistEventType;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface IveRemoteAuditEvent {
  id: string;
  tenant_id: string;
  remote_session_id: string;
  actor_identity: string;
  event_type: string;
  target: string;
  metadata: Record<string, unknown>;
  created_at: string;
}
```

### 6.1 createIveKitModule

```ts
export interface IveKitModuleInput {
  db: unknown;
  pg: PgQueryable;
  media?: {
    livekit?: LiveKitConfig;
  };
  remoteGateway?: RemoteGatewayClient;
  evidence?: {
    base_url?: string;
  };
}

export interface IveKitModule {
  sessions: IveSessionFacade;
  media: IveMediaFacade;
  collaboration: IveCollaborationFacade;
  remote: IveRemoteAssistanceFacade;
  evidence: IveEvidenceFacade;
}

export function createIveKitModule(input: IveKitModuleInput): IveKitModule;
```

`db` 保留给当前 SQLite/dev 和 LiveKit room store 兼容路径；`pg` 是 collaboration、remote assistance、evidence 主路径。第一版不引入 SQLite 新主路径。

### 6.1.1 Evidence Facade

证据 facade 第一版只做查询与统一写入入口，不负责对象存储上传本身。上传可以先由业务层或现有 evidence/upload 完成，再把 storage URL、checksum 和 metadata 交给 iveKit。

```ts
export interface IveEvidenceFacade {
  record(input: {
    tenant_id: string;
    business_ref: IveBusinessRef;
    session_id: string;
    kind: IveEvidenceRecord['kind'];
    storage_url?: string;
    checksum?: string;
    retention_until?: string | null;
    created_by: string;
    metadata?: Record<string, unknown>;
  }): Promise<IveEvidenceRecord>;

  listByBusinessRef(input: {
    tenant_id: string;
    business_ref: IveBusinessRef;
    limit?: number;
  }): Promise<IveEvidenceRecord[]>;

  listBySession(input: {
    tenant_id: string;
    session_id: string;
    limit?: number;
  }): Promise<IveEvidenceRecord[]>;
}
```

### 6.2 Session Facade

```ts
export interface OpenIveSessionInput {
  tenant_id: string;
  business_ref: IveBusinessRef;
  title?: string;
  participants?: IveParticipantRef[];
  media?: {
    enabled: boolean;
    kind: 'voice' | 'video';
    room_name?: string;
    customer_identity?: string;
    agent_identity?: string;
    create_customer_join_path?: boolean;
  };
  remote_assistance?: {
    enabled: boolean;
    mode: 'web_remote_assist' | 'third_party_remote_tool' | 'remote_desktop_gateway';
    adapter_provider?: string;
    started_by: string;
  };
  metadata?: Record<string, unknown>;
}

export interface IveSessionFacade {
  open(input: OpenIveSessionInput): Promise<IveSessionBundle>;
  getByBusinessRef(input: {
    tenant_id: string;
    business_ref: IveBusinessRef;
  }): Promise<IveSessionBundle[]>;
  close(input: {
    tenant_id: string;
    collaboration_session_id: string;
    actor_identity: string;
  }): Promise<void>;
}
```

这是 LED 最优先使用的入口。

LED 创建订单内支持会话时，只需要调用：

```ts
await iveKit.sessions.open({
  tenant_id: 'tenant_led',
  business_ref: {
    tenant_id: 'tenant_led',
    type: 'service_order',
    id: 'order_123',
    display_name: 'LED installation order #123'
  },
  participants: [
    { identity: 'buyer_9', role: 'customer', display_name: 'Buyer' },
    { identity: 'engineer_7', role: 'engineer', display_name: 'Engineer' }
  ],
  media: {
    enabled: true,
    kind: 'video',
    customer_identity: 'buyer_9',
    agent_identity: 'engineer_7',
    create_customer_join_path: true
  },
  remote_assistance: {
    enabled: true,
    mode: 'web_remote_assist',
    adapter_provider: 'ivekit_web',
    started_by: 'engineer_7'
  }
});
```

### 6.3 Media Facade

```ts
export interface IveMediaFacade {
  createRoom(input: {
    tenant_id: string;
    business_ref: IveBusinessRef;
    purpose: 'voice_service' | 'video_service' | 'screen_share' | 'conference';
    room_name?: string;
    metadata?: Record<string, unknown>;
  }): Promise<IveMediaRoom>;

  issueJoinPlan(input: {
    tenant_id: string;
    room_name: string;
    identity: string;
    role: 'customer' | 'agent' | 'engineer' | 'supervisor';
    media: 'voice' | 'video';
    channel?: 'webrtc' | 'sip_volte';
  }): Promise<IveMediaJoinPlan>;

  startRecording(input: {
    tenant_id: string;
    room_name: string;
    business_ref: IveBusinessRef;
    format?: 'mp4' | 'webm' | 'wav' | 'ogg';
    has_video?: boolean;
  }): Promise<IveEvidenceRecord>;

  closeRoom(input: {
    tenant_id: string;
    room_name: string;
  }): Promise<void>;
}
```

映射到现有实现：

- `createRoom` 调 `LiveKitMediaModule.rooms.createRoom`
- `issueJoinPlan` 调 `LiveKitMediaModule.joins.prepareJoin`
- `startRecording` 调 `LiveKitMediaModule.recordings.startRecording`
- `closeRoom` 调 `LiveKitMediaModule.rooms.closeRoom`
- 当前底层 `MediaRoomPurpose` 尚无 `voice_service`；Phase 1 可以把 iveKit 的 `voice_service` 映射为底层 `video_service`，并在 room metadata 写入 `{ media_kind: 'voice' }`。后续若底层类型扩展，再迁移成原生 `voice_service`。

### 6.4 Collaboration Facade

```ts
export interface IveCollaborationFacade {
  postMessage(input: {
    tenant_id: string;
    session_id: string;
    sender_identity: string;
    message_type: 'text' | 'image' | 'video' | 'file' | 'system';
    body: string;
    original_language?: string;
    metadata?: Record<string, unknown>;
  }): Promise<IveMessage>;

  addTranslation(input: {
    tenant_id: string;
    message_id: string;
    target_language: string;
    translated_body: string;
    provider?: string;
    confidence?: number | null;
  }): Promise<IveMessageTranslation>;

  scanPolicy(input: {
    tenant_id: string;
    session_id: string;
    message_id?: string;
    text: string;
  }): Promise<IvePolicyScanResult>;

  listTimeline(input: {
    tenant_id: string;
    session_id: string;
  }): Promise<IveTimelineItem[]>;
}
```

第一版翻译不强绑定具体翻译供应商。LED 可以先由业务层调用翻译服务，再把结果写入 `addTranslation`。后续再把 translation provider adapter 放进 iveKit。

### 6.5 Remote Assistance Facade

```ts
export interface IveRemoteAssistanceFacade {
  create(input: {
    tenant_id: string;
    collaboration_session_id: string;
    business_ref: IveBusinessRef;
    mode: 'web_remote_assist' | 'third_party_remote_tool' | 'remote_desktop_gateway' | 'platform_remote_control';
    adapter_provider?: string;
    started_by: string;
    metadata?: Record<string, unknown>;
  }): Promise<IveRemoteSession>;

  requestConsent(input: IveConsentInput): Promise<IveConsentEvent>;
  grantConsent(input: IveConsentInput): Promise<IveConsentEvent>;
  denyConsent(input: IveConsentInput): Promise<IveConsentEvent>;
  revokeConsent(input: IveConsentInput): Promise<IveConsentEvent>;

  createWebAssistJoin(input: {
    tenant_id: string;
    remote_session_id: string;
    actor_identity: string;
    role: 'customer' | 'agent' | 'engineer';
    expires_in_ms?: number;
  }): Promise<{
    remote_session_id: string;
    role: 'customer' | 'agent' | 'engineer';
    join_path: string;
    expires_at: string;
  }>;

  recordAssistEvent(input: {
    tenant_id: string;
    remote_session_id: string;
    actor_identity: string;
    event_type: IveRemoteAssistEventType;
    payload?: Record<string, unknown>;
  }): Promise<IveRemoteAssistEvent>;

  startExternalTool(input: {
    tenant_id: string;
    remote_session_id: string;
    actor_identity: string;
    provider: string;
    external_id?: string;
    launch_url?: string;
    metadata?: Record<string, unknown>;
  }): Promise<IveRemoteToolSession>;

  startGatewayTool(input: {
    tenant_id: string;
    remote_session_id: string;
    actor_identity: string;
    target: {
      type: 'device' | 'connection' | 'session';
      id: string;
      display_name?: string;
      metadata?: Record<string, unknown>;
    };
    permissions: IveRemoteConsentScope[];
    metadata?: Record<string, unknown>;
  }): Promise<IveRemoteToolSession>;

  syncGatewayAudit(input: {
    tenant_id: string;
    remote_session_id: string;
    tool_session_id: string;
    actor_identity: string;
  }): Promise<{ synced: number; events: IveRemoteAuditEvent[] }>;
}
```

规则：

- v1 主路径是 `createWebAssistJoin` + `recordAssistEvent`，用于浏览器屏幕共享、指针、标注、引导操作、录屏和审计。
- `createWebAssistJoin` 必须先检查 active consent；客户加入链接必须短期签名。
- `recordAssistEvent` 必须按 remote session、tenant 和 actor_identity 写审计。
- `startExternalTool` 和 `startGatewayTool` 是 fallback adapter，也必须先检查 active consent。
- `revokeConsent` 必须关闭当前 active tool session。
- 如果 active tool 来自 MeshCentral / Guacamole gateway，`revokeConsent` 必须先关闭上游 gateway session，再同步审计。
- 所有授权和撤销必须写 evidence。
- 所有 Web assist event、工具启动、结束、上游 audit sync 必须写 remote audit timeline。

## 7. HTTP Facade

第一版保留现有 OPC route，同时新增通用 iveKit route。LED 后续可以选择服务端 SDK 调用，也可以走 HTTP。

建议路径：

```text
POST   /api/ivekit/sessions
GET    /api/ivekit/sessions/by-business-ref
POST   /api/ivekit/sessions/:id/messages
GET    /api/ivekit/sessions/:id/timeline

POST   /api/ivekit/media/rooms
GET    /api/ivekit/media/join
POST   /api/ivekit/media/recordings/start
POST   /api/ivekit/media/rooms/:room/close

POST   /api/ivekit/remote
POST   /api/ivekit/remote/:id/consent/request
POST   /api/ivekit/remote/:id/consent/grant
POST   /api/ivekit/remote/:id/consent/deny
POST   /api/ivekit/remote/:id/consent/revoke
POST   /api/ivekit/remote/:id/web-assist/join
POST   /api/ivekit/remote/:id/web-assist/events
POST   /api/ivekit/remote/:id/tools/external
POST   /api/ivekit/remote/:id/tools/gateway
POST   /api/ivekit/remote/:id/audit/gateway-sync
```

鉴权口径：

- 管理类接口必须服务端到服务端调用。
- 继续支持 `OPC_MEDIA_API_TOKEN` / `LIVEKIT_MEDIA_API_TOKEN`，但新命名建议增加 `IVEKIT_API_TOKEN`。
- 客户浏览器 join 只允许使用签名 invite，不允许携带管理 token。
- LiveKit webhook 继续走 LiveKit key/secret 验签。
- LED 项目通过服务端代理调用 iveKit，不让浏览器直接创建 room、录制或远控工具。

## 8. OPC 接入方式

OPC 现有功能保持兼容，逐步迁移。

现有 OPC 路由继续可用：

- `/api/media/livekit/*`
- `/api/collaboration/*`
- `/api/call-center/video/start`
- `/api/livekit/*` 旧兼容入口

但后续新增 OPC 业务不再直接 import：

- `src/agent-runtime/livekit/*` 内部文件
- `src/agent-runtime/collaboration/*` Store
- `src/agent-runtime/media-gateway/*`

新增 OPC 业务应优先 import：

```ts
import { createIveKitModule } from '../ivekit/index.js';
```

OPC 适配层负责：

- 把 `call_session_id` 变成 `BusinessRef(type='call_session')`。
- 把坐席、客户、主管身份变成 `IveParticipantRef`。
- 把呼叫中心状态、弹屏、质检、坐席排班留在 OPC 自己的模块。

## 9. LED 接入方式

LED 项目第一版推荐只接三个入口：

1. `iveKit.sessions.open`
2. `iveKit.collaboration.postMessage`
3. `iveKit.remote.*`

LED 创建服务订单支持会话：

```ts
const session = await iveKit.sessions.open({
  tenant_id,
  business_ref: {
    tenant_id,
    type: 'service_order',
    id: orderId,
    display_name: orderNumber,
    metadata: { product_model: model, store_id: storeId }
  },
  participants: [
    { identity: buyerId, role: 'customer', display_name: buyerName },
    { identity: engineerId, role: 'engineer', display_name: engineerName }
  ],
  media: {
    enabled: true,
    kind: 'video',
    customer_identity: buyerId,
    agent_identity: engineerId,
    create_customer_join_path: true
  },
  remote_assistance: {
    enabled: true,
    mode: 'web_remote_assist',
    adapter_provider: 'ivekit_web',
    started_by: engineerId
  }
});
```

LED 订单页展示：

- `session.customer_join_path`：发给客户的视频入口。
- `session.collaboration_session_id`：聊天和 timeline。
- `session.remote_session_id`：远程协助授权、Web Assist 加入和审计。
- `session.remote_assist_request_path`：客户打开后看到远程协助授权页；真正的 Web Assist join path 只能在授权后由 `createWebAssistJoin()` 短期生成。

LED 自己仍负责：

- 订单状态。
- 支付与结算。
- 退款、纠纷、评价。
- 服务工程师派单。
- 商品和设备资料。

iveKit 负责：

- 沟通和媒体能力。
- 自研 Web 远程协助。
- 远控授权、撤销、事件审计。
- 证据留痕。
- 审计 timeline。

## 10. 数据与迁移

第一版继续复用已经新增的表：

- `collaboration_sessions`
- `collaboration_participants`
- `collaboration_messages`
- `collaboration_message_translations`
- `collaboration_policy_events`
- `remote_assistance_sessions`
- `remote_consent_events`
- `remote_tool_sessions`
- `remote_audit_events`
- `evidence_records`
- `livekit_rooms`
- `livekit_participants`
- `call_recordings`

需要补齐的约束：

- iveKit public interface 必须要求 `tenant_id`。
- business_ref tenant mismatch 必须返回 400。
- 跨租户查询必须返回 404 或空列表。
- Web Assist join 必须 consent granted 后才能生成。
- Web Assist event 必须 consent granted 后才能记录。
- revoke 后必须拒绝新的 Web Assist event。
- fallback remote tool 必须 consent granted 后才能启动。
- revoke 必须结束 active fallback tool。
- gateway tool 作为 fallback adapter 时，必须同步上游 audit 到 `remote_audit_events`。

## 11. 配置

iveKit v1 需要统一声明这些 env：

```text
IVEKIT_API_TOKEN
IVEKIT_INVITE_SECRET
IVEKIT_INVITE_TTL_MS

LIVEKIT_URL
LIVEKIT_API_KEY
LIVEKIT_API_SECRET
```

兼容旧 env：

```text
OPC_MEDIA_API_TOKEN
LIVEKIT_MEDIA_API_TOKEN
OPC_MEDIA_INVITE_SECRET
LIVEKIT_MEDIA_INVITE_SECRET
```

规则：

- 新代码优先读 `IVEKIT_*`。
- 未配置 `IVEKIT_*` 时兼容读现有 `OPC_MEDIA_*` / `LIVEKIT_MEDIA_*`。
- 文档和 `.env.example` 应同时展示新旧变量关系。
- RustDesk / MeshCentral / Guacamole 等 remote gateway adapter 的 `OPC_REMOTE_GATEWAY_*` 变量保留；它们不作为 iveKit Web Remote Assist 的必填配置，但 RustDesk 是系统级远控部署的推荐 provider。RustDesk 自托管运行时通过 Docker Compose/K8s 启动 `hbbs`/`hbbr`；OPC 控制面自调用优先使用 `OPC_RUSTDESK_CONTROL_PLANE_BASE_URL` 和 `OPC_RUSTDESK_API_TOKEN`；OPC 从 `OPC_RUSTDESK_PUBLIC_KEY` 或 `OPC_RUSTDESK_PUBLIC_KEY_FILE=/rustdesk/id_ed25519.pub` 提供客户端配置 key；RustDesk 客户端拉起协议用可选 `OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE` 描述，不在代码里写死客户端 URI。

## 12. 测试策略

新增测试应以 iveKit interface 为主，而不是继续只测底层 Store。

必须新增：

```text
test/ivekit-module.test.ts
test/ivekit-http.test.ts
test/ivekit-led-integration.test.ts
test/ivekit-boundaries.test.ts
```

覆盖：

1. `createIveKitModule()` 返回 sessions/media/collaboration/remote/evidence。
2. `sessions.open()` 能一次创建 collaboration session、media room、参与人和可选 remote session。
3. LED `service_order` 能生成 customer join path。
4. OPC `call_session` 兼容旧 call session 绑定。
5. `postMessage()` 写消息并可触发防绕单扫描。
6. `addTranslation()` 写翻译结果。
7. `requestConsent()` / `grantConsent()` / `revokeConsent()` 写授权和证据。
8. 未授权时 `createWebAssistJoin()` 失败。
9. 授权后 `createWebAssistJoin()` 返回短期签名 join path。
10. 授权后 `recordAssistEvent()` 能写入 `pointer.move`、`annotation.draw` 等 Web Assist 审计事件。
11. revoke 后 `recordAssistEvent()` 失败。
12. fallback adapter：未授权时 `startExternalTool()` 失败。
13. fallback adapter：授权后 `startExternalTool()` 成功并写 audit。
14. business_ref tenant mismatch 失败。
15. iveKit 模块不 import `call-center/*`。
16. LED 示例不需要 import OPC 内部模块。

保留现有验证：

```bash
node --import tsx --test test/livekit-media-module.test.ts test/collaboration-remote-assistance.test.ts test/collaboration-http.test.ts
npm run typecheck
npm --prefix frontend exec tsc -- --noEmit
git diff --check
```

真实环境验收仍走：

```bash
npm run smoke:media:readiness
```

但数字人目标不作为 iveKit v1 必须完成标准。需要时用：

```bash
export OPC_VIDEO_READINESS_TARGETS=media,agent-browser,customer-browser,collaboration
npm run smoke:media:readiness
```

如果要验 MeshCentral / Guacamole fallback adapter：

```bash
export OPC_VIDEO_READINESS_TARGETS=media,customer-browser,collaboration,remote-gateway
npm run smoke:media:readiness
```

## 13. 实施阶段

### Phase 1：库内 public interface + 自研 Web Assist

目标：LED/OPC 可以 import `createIveKitModule()`，并通过 iveKit 创建 Web Remote Assist v1 会话。

任务：

- 新增 `src/agent-runtime/ivekit/types.ts`。
- 新增 `src/agent-runtime/ivekit/module.ts`。
- 新增 `src/agent-runtime/ivekit/index.ts`。
- 新增 `src/agent-runtime/ivekit/remote-assist-token.ts`，生成短期 Web Assist join 签名。
- 用现有 LiveKitMediaModule 和 CollaborationModule 作为 adapter。
- 用现有 RemoteAssistanceStore 作为 Web Assist 授权、审计和证据底座。
- 新增 iveKit module 测试。

完成标准：

- `sessions.open()` 跑通 LED `service_order` 场景。
- `sessions.open()` 在 `remote_assistance.mode='web_remote_assist'` 时返回 `remote_session_id` 和 `remote_assist_request_path`。
- 未授权不能生成 Web Assist join path。
- 授权后可以生成短期 Web Assist join path。
- 授权后可以记录指针/标注/引导事件。
- revoke 后不能继续记录 Web Assist 事件。
- iveKit 不 import `call-center/*`。
- 现有 OPC 视频/协作测试不回归。

### Phase 2：HTTP facade

目标：LED 可以通过服务端 HTTP 方式接 iveKit。

任务：

- 新增 `src/agent-runtime/ivekit/http.ts`。
- 在总 HTTP router 挂 `/api/ivekit/*`。
- 兼容 `IVEKIT_API_TOKEN` 和旧 media token。
- 新增 HTTP 测试。

完成标准：

- `/api/ivekit/sessions` 能创建 LED 服务订单会话。
- `/api/ivekit/remote/:id/consent/*` 能完成授权链路。
- `/api/ivekit/remote/:id/web-assist/join` 能在授权后返回短期 join path。
- `/api/ivekit/remote/:id/web-assist/events` 能在授权后写入指针/标注事件，撤销后拒绝。
- 跨租户访问被拒绝。

### Phase 3：LED 集成样例

目标：给 LED 项目一份可照抄的接入契约。

任务：

- 新增 `docs/integrations/ivekit-led-integration.md`。
- 新增 `test/ivekit-led-integration.test.ts`。
- 写明 LED 订单页、客服页、工程师页各自需要的字段。

完成标准：

- LED 不需要了解 OPC call-center。
- LED 不需要直接处理 LiveKit token。
- LED 能拿到聊天 session、客户视频链接、Web Assist 入口、远程协助 session 和 timeline。

### Phase 4：OPC 逐步迁移

目标：OPC 新增视频/远控能力全部从 iveKit 走。

任务：

- 保留旧路由。
- 新业务调用 `createIveKitModule()`。
- 对旧 `/api/media/livekit/*` 与 `/api/collaboration/*` 做兼容 facade。

完成标准：

- 旧测试通过。
- `rg "from './livekit/|from '../livekit/|from './collaboration/|from '../collaboration/" src/agent-runtime/call-center` 不再新增结果。

## 14. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| interface 太宽 | LED 需要理解太多内部概念 | 第一版让 LED 优先用 `sessions.open()` |
| 过早抽包 | 当前 OPC 回归风险大 | 先库内 `src/agent-runtime/ivekit`，稳定后再搬 |
| 聊天/翻译供应商耦合 | 以后替换困难 | v1 只存翻译结果，provider adapter 后置 |
| Web Assist 授权被绕过 | 安全事故 | Web Assist join 和 event 写入都只在 Remote facade 内开放，并强制 active consent |
| 把 Web Assist 误写成整机远控 | 产品预期失真 | v1 文案、接口和测试都使用 pointer/annotation/action_hint，不暴露键盘鼠标控制整机能力 |
| 业务状态混入通用层 | LED/OPC 互相污染 | 通用层只接受 `BusinessRef`，不更新业务表 |
| 数字人拖慢主线 | iveKit v1 不可交付 | avatar 保留现状，不列入 v1 完成标准 |
| SIP/VoLTE 变成阻塞项 | 运营商联调周期不可控 | v1 只保留 readiness，不列为完成标准 |

## 15. 验收标准

iveKit v1 完成必须同时满足：

1. 有 `src/agent-runtime/ivekit/index.ts` public entry。
2. `createIveKitModule()` 暴露 sessions/media/collaboration/remote/evidence。
3. LED `service_order` 可以通过 `sessions.open()` 创建完整协作 bundle。
4. bundle 至少包含 collaboration session、media room、客户 join path。
5. 开启 remote assistance 时 bundle 包含 remote session。
6. 未授权不能生成 Web Assist join path。
7. 授权后可以生成短期 Web Assist join path。
8. 授权后可以记录 `pointer.move`、`pointer.click_hint`、`annotation.draw`、`annotation.clear`、`page.action_hint` 事件。
9. revoke 后不能继续记录 Web Assist event。
10. fallback external tool 仍可用，但不是 v1 主路径。
11. fallback gateway adapter 仍可用，但不是 v1 主路径。
12. 聊天、翻译、防绕单扫描可通过 Collaboration facade 使用。
13. 录音录像和远程协助证据都能按 `BusinessRef` 查询或聚合。
14. iveKit 模块不 import `call-center/*`。
15. LED 集成文档不要求 LED 调 OPC 内部路由。
16. 现有 OPC 视频、协作、远控测试不回归。
17. `npm run typecheck` 通过。
18. 前端 typecheck 通过。
19. `git diff --check` 通过。

## 16. 后续抽包标准

只有满足以下条件后，才考虑从库内模块升级到 `packages/ivekit` 或独立仓库：

1. OPC 或 LED 至少一条真实视频/Web Assist 链路已经走 iveKit facade。
2. LED 集成样例测试稳定。
3. iveKit public interface 一周内没有频繁破坏式改动。
4. 数据迁移和 env 文档稳定。
5. route 层和 module 层都能独立测试。

抽包时再处理：

- package name。
- peer dependencies。
- migration packaging。
- OpenAPI/SDK 生成。
- 多仓库发布流程。
