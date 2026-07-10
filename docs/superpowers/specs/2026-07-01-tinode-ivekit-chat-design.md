# Tinode iveKit Chat Design

> 日期：2026-07-01
> 状态：设计已由用户确认，Tinode GPL-3.0 风险由项目方接受
> 范围：为 OPC/iveKit/LED 接入 Tinode 作为开源 IM 底座，先落地文本聊天闭环，再接图片 OCR、语音 ASR 和 AI 质检。

---

## 1. 结论

采用 Tinode 作为 IM 引擎是可行的，但不要把 OPC 直接改造成 Tinode 的业务插件，也不要第一版深 fork Tinode。

推荐架构：

```text
OPC / LED 页面
  -> iveKit.chat HTTP facade
  -> CollaborationStore 本地镜像、审计、防绕单、证据链
  -> TinodeChatGateway 适配层
  -> Tinode server / Tinode topics / Tinode realtime clients
```

OPC/iveKit 只依赖 `iveKit.chat` 和 `collaboration` 契约。Tinode 负责 IM 实时能力；OPC 负责租户、订单/工单绑定、防绕单、OCR/ASR/AI 质检、证据链、审计和业务权限。

第一版先做文本聊天 MVP：

- 会话绑定一个 Tinode topic。
- 支持添加参与人。
- 支持发送文本消息。
- 支持拉历史消息。
- 支持租户 WebSocket 广播新消息。
- 发送文本后自动执行当前规则版防绕单扫描。
- 命中策略时写 `collaboration_policy_events` 并广播。
- 前端提供一个可嵌入的聊天页面/面板。

图片、文件、语音消息先保留数据类型和接口边界，第二阶段接 OCR/ASR job。

---

## 2. Tinode 选型依据

Tinode 官方仓库说明它是完整 IM 栈，后端是 Go，Web 客户端是 React，传输支持 JSON over WebSocket 和 protobuf/gRPC，后端 GPL-3.0，客户端 Apache-2.0。

Tinode 已有能力覆盖本项目需要的 IM 基础：

- 1v1 和群聊。
- 多设备消息同步。
- 权限控制。
- 附件、图片、视频、文件。
- 服务端送达、已读和 typing 通知。
- 匿名用户，适合技术支持聊天。
- PostgreSQL 存储后端。
- 管理工具、插件、机器人扩展点。

Tinode 安装文档显示它支持 PostgreSQL 13+，可通过二进制、源码或 Docker 方式运行。

许可证裁决：

- 用户已明确接受 Tinode GPL-3.0 风险。
- 本设计仍保留 adapter 边界，减少未来替换或改许可证策略时的冲击。
- Tinode 源码不直接复制进 OPC 主源码树；第一版以外部服务/容器方式接入。

---

## 3. 产品目标

### 3.1 OPC 目标

OPC 需要把聊天作为协作/远程协助的一部分：

- 坐席、工程师、客户能围绕一个业务对象聊天。
- 聊天能绑定 `BusinessRef`，例如 `service_order`、`support_ticket`、`call_session`。
- 聊天内容能进入审计、证据链和风控。
- 远程协助页面可以复用同一会话聊天。
- 后续视频、录屏、OCR、ASR、AI 质检都能关联同一会话。

### 3.2 LED 目标

LED 项目的重点不是泛 Slack，而是订单内沟通和防绕单：

- 买卖双方或客户/服务人员围绕 LED 服务订单沟通。
- 文本聊天必须自动防绕单扫描。
- 图片里的手机号、二维码后续走 OCR。
- 语音/视频中说出的联系方式后续走 ASR + AI 质检。
- 违规结果要能留证、审核、复核、处理。

---

## 4. 非目标

第一版不做：

- Tinode 源码深 fork。
- Tinode 客户端完整搬进 OPC 页面。
- 自研完整 IM 协议。
- 端到端加密。
- 全文搜索。
- 多端离线冲突解决。
- 图片 OCR、语音 ASR 的真实 provider 接入。
- 用大模型替代规则版文本防绕单。

这些能力保留接口扩展点，按后续阶段接入。

---

## 5. 架构边界

### 5.1 OPC/iveKit 负责

- 租户鉴权。
- 用户身份和业务角色。
- `BusinessRef` 到聊天会话的绑定。
- 参与人业务身份记录。
- 本地消息镜像。
- 防绕单规则扫描。
- 策略命中事件。
- 证据链和审计。
- HTTP facade。
- 前端可嵌入聊天面板。

### 5.2 Tinode 负责

- 实时 IM topic。
- 多端连接和同步。
- 送达/已读/typing。
- 附件上传和富消息。
- Tinode 自己的用户、订阅、权限模型。

### 5.3 Adapter 负责

新增 `TinodeChatGateway`，把 OPC 的业务语义翻译为 Tinode 语义：

```ts
export interface ChatGateway {
  provider: 'tinode' | 'local';
  ensureTopic(input: ChatTopicInput): Promise<ChatTopicBinding>;
  ensureUser(input: ChatUserInput): Promise<ChatUserBinding>;
  addParticipant(input: ChatParticipantInput): Promise<void>;
  publishMessage(input: ChatPublishInput): Promise<ChatPublishResult>;
}
```

第一版可以有两个实现：

- `LocalChatGateway`：用于测试、本地开发和 Tinode 未配置时的降级，不冒充 Tinode 真实能力。
- `TinodeChatGateway`：读取 `TINODE_*` 配置，真实环境通过 Tinode API/SDK/网关服务接入。

---

## 6. 数据设计

现有表继续作为 OPC 本地镜像：

- `collaboration_sessions`
- `collaboration_participants`
- `collaboration_messages`
- `collaboration_policy_events`

新增绑定表：

```sql
CREATE TABLE IF NOT EXISTS collaboration_chat_bindings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES collaboration_sessions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_topic_id TEXT NOT NULL,
  provider_status TEXT NOT NULL DEFAULT 'bound',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, session_id, provider)
);
```

消息 provider 信息先放到 `collaboration_messages.metadata`：

```json
{
  "provider": "tinode",
  "provider_topic_id": "grp...",
  "provider_message_id": "12345",
  "provider_sync_status": "published"
}
```

这样第一版不扩表；如果后续查询量大，再把 provider 字段提升为列。

---

## 7. HTTP API

第一版新增 collaboration chat HTTP：

```text
POST /api/collaboration/sessions/:id/participants
GET  /api/collaboration/sessions/:id/chat
GET  /api/collaboration/sessions/:id/messages?limit=50
POST /api/collaboration/sessions/:id/messages
POST /api/collaboration/sessions/:id/chat/bind
```

行为：

- 所有接口必须认证并校验租户。
- `chat/bind` 创建或返回 Tinode topic 绑定。
- `messages POST` 只允许第一版文本消息。
- 发消息成功后写 `collaboration_messages`。
- 写消息后自动调用 `scanPolicy()`。
- 广播 `collaboration.message.created`。
- 如有策略命中，广播 `collaboration.policy.matched`。

---

## 8. WebSocket 事件

复用现有租户级 `/ws`。

新增事件：

```ts
type CollaborationMessageCreatedEvent = {
  session_id: string;
  message: CollaborationMessage;
  policy: PolicyScanResult;
};

type CollaborationPolicyMatchedEvent = {
  session_id: string;
  message_id: string;
  events: CollaborationPolicyEvent[];
};
```

前端按 `session_id` 过滤，不需要每个会话单独开 WebSocket。

---

## 9. 前端设计

新增可复用聊天页面：

```text
/collaboration/chat?session_id=...
```

页面能力：

- 拉取会话、参与人、消息、Tinode binding。
- 展示消息气泡。
- 输入文本并发送。
- 接收 WebSocket 新消息。
- 显示防绕单命中提醒。
- Tinode 未配置时显示“本地镜像聊天”，不假装真实 Tinode 已连接。

后续可把聊天面板嵌入：

- 远程协助观察页。
- LED 订单详情页。
- OPC 坐席工作台。
- 客户公开协助页。

---

## 10. 错误处理

### 10.1 Tinode 不可用

第一版不阻塞 OPC 本地消息闭环：

- 本地消息仍写入 `collaboration_messages`。
- metadata 标记 `provider_sync_status=skipped` 或 `failed`。
- API 返回消息和 sync 状态。
- 前端显示“Tinode 未连接/同步失败”。

等真实 Tinode 环境完成后，可把 provider fail 策略改成严格模式。

### 10.2 防绕单命中

第一版只记录和提醒：

- 不拦截发送。
- 不替换原消息。
- 不明文保存命中片段，只保存 hash。

后续可以按策略升级为 warning/block/review。

---

## 11. 阶段计划

### Phase 1：文本聊天闭环

- Tinode binding 表。
- Chat gateway 接口。
- CollaborationStore 消息 API。
- HTTP endpoint。
- WebSocket 广播。
- 自动文本防绕单扫描。
- 前端聊天页面。

### Phase 2：Tinode 真实环境接通

- Tinode Docker 配置。
- Tinode Postgres 配置。
- Tinode topic/user/subscription 真实创建。
- 真实 Tinode smoke。

### Phase 3：图片/文件

- 文件消息。
- 图片消息。
- 上传证据。
- OCR job 接线。

### Phase 4：语音/质检

- 语音消息或通话录音入库。
- ASR job。
- AI 质检。
- 多模态防绕单 review queue。

---

## 12. 验收标准

Phase 1 完成时：

- 可以创建 collaboration session。
- 可以给 session 添加参与人。
- 可以绑定 Tinode topic 契约。
- 可以发送文本消息。
- 可以拉取历史消息。
- 前端聊天页能显示历史和新消息。
- WebSocket 能把同租户新消息推给前端。
- 含手机号/微信/站外交易文本会自动写 `collaboration_policy_events`。
- 命中策略后前端能看到提醒。
- Tinode 未配置时不报假成功，明确标记本地镜像模式。

---

## 13. 来源

- Tinode GitHub README：<https://github.com/tinode/chat>
- Tinode INSTALL：<https://github.com/tinode/chat/blob/master/INSTALL.md>
- Tinode LICENSE：<https://github.com/tinode/chat/blob/master/LICENSE>
