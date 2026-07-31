# LED 多模态防绕单设计

> 日期：2026-07-01
> 状态：设计规格，ASR/OCR 供应方式待裁决
> 范围：面向 LED 项目的聊天、图片、语音、视频/远程协助证据，设计可复用到 iveKit/OPC 的多模态防绕单能力。本文只定产品、架构、数据契约和实施边界，不绑定具体 OCR/ASR 厂商。

---

## 1. 结论

LED 的防绕单不能只扫聊天文本，必须升级为多模态风控：

1. 聊天文本：用户直接发手机号、微信、邮箱、线下付款等。
2. 图片 OCR：用户把手机号、微信号、二维码、线下收款信息做成图片或截图发给对方。
3. 语音/视频 AI 质检：用户在通话、视频、远程协助过程中口头说号码、微信号、平台外交易方式。
4. 录屏/远程协助证据：远程协助画面里出现联系方式、付款码、站外引导文案。

第一版建议采用“统一防绕单策略引擎 + OCR/ASR provider 适配层”的方式。上层只关心输入内容、提取结果、命中规则、证据链和审核结果；OCR/ASR 可以后续选择自建或第三方，不影响业务代码。

---

## 2. 当前现状

当前仓库已有基础能力：

- `CollaborationStore.postMessage()`：保存协作消息。
- `CollaborationStore.scanPolicy()`：对文本做基础策略扫描。
- `scanTextPolicy()`：识别手机号、邮箱、微信、WhatsApp、Telegram、`pay me directly`、`outside app`、`call me`、`text me`。
- `collaboration_policy_events`：保存策略命中事件。
- `BusinessRef`：把协作、远程协助、录屏、证据绑定到订单/工单。
- `evidence_records`：保存录音、录像、录屏、授权、远控日志等证据。
- call-center 已有 QM 质检模块，但目前偏通话质量评估，不是 LED 防绕单专项质检。

当前缺口：

- 文字消息不会强制自动扫描，需要调用方主动调用 `scanPolicy()`。
- 图片、附件没有 OCR 流程。
- 录音/视频没有 ASR 后的防绕单专项扫描。
- 没有多模态统一 findings 模型。
- 没有审核状态、处置动作、误判处理和运营看板。
- 没有自建/第三方 OCR/ASR 的 provider 抽象。

---

## 3. 产品目标

第一版目标是“可发现、可留证、可审核”，不是一开始就追求百分百实时拦截。

必须做到：

- 双方聊天文字自动扫描。
- 图片/附件 OCR 后自动扫描。
- 录音/视频转写文本后自动扫描。
- 所有命中都绑定 `BusinessRef`，能按 LED 服务订单、远程支持单、纠纷单查询。
- 命中结果进入统一 policy finding，包含来源、风险类型、严重级别、置信度、处置建议和证据引用。
- 原始手机号/微信号等敏感片段默认不明文入库，只保存 hash、脱敏摘要和必要上下文。
- 支持人工审核：待审核、确认违规、误报、已处理。
- 支持自建 OCR/ASR 和第三方 OCR/ASR 两种部署场景。

暂不作为第一版目标：

- 实时阻断语音通话。
- 实时视频流逐帧 OCR。
- 自动扣款、罚款、封号。
- 复杂账号关系图谱和跨订单串联风控。
- 直接训练自有 OCR/ASR 模型。

---

## 4. 检测来源

### 4.1 文本消息

触发点：

- 用户发送聊天消息。
- 坐席/工程师发送聊天消息。
- 系统导入聊天历史。

处理：

1. 保存消息。
2. 同步调用轻量规则扫描。
3. 高风险命中可返回 `block` 或 `review`。
4. 低中风险命中记录为 `record` 或 `warn`。

第一版建议：先默认 `record + review`，只对明显手机号/邮箱/微信号提供可配置 `block`。

### 4.2 图片和附件 OCR

触发点：

- 聊天图片。
- 工单附件。
- 远程协助截图。
- 录屏抽帧。

处理：

1. 生成 `policy_scan_job`，来源为 `image` / `file` / `screen_frame`。
2. 调 OCR provider。
3. 得到 `extracted_text` 和区域信息。
4. 对 `extracted_text` 走统一规则扫描。
5. 命中结果写入 finding，并引用原始文件证据。

第一版 OCR 不要求实时阻断，可以异步处理。但如果聊天图片发送后几秒内 OCR 命中高风险，可以把会话标为 `needs_review`，并通知运营或客服主管。

### 4.3 语音/视频 ASR

触发点：

- 语音通话录音完成。
- 视频通话录制完成。
- Web Assist 录屏完成。
- 后续接入实时 ASR 时的分片转写。

处理：

1. 录音/录像证据写入 `evidence_records`。
2. 生成 `policy_scan_job`，来源为 `audio_recording` / `video_recording` / `screen_recording`。
3. 调 ASR provider 生成 transcript。
4. 对 transcript 走规则扫描。
5. 对疑似绕单片段调用 AI 复核，判断是否真的在交换联系方式或引导平台外交易。
6. 写入 finding，引用 recording/evidence 和 transcript segment。

第一版建议先做“离线质检”：录制完成后 1-5 分钟内出结果。实时提醒可以作为第二阶段。

### 4.4 远程协助录屏/屏幕共享

远程协助里有两种风险：

- 客户在页面/图片里展示联系方式。
- 工程师在远程协助过程中引导客户保存站外联系方式。

第一版处理：

- 录屏完成后做离线 ASR/OCR。
- 对录屏关键帧做抽帧 OCR，频率建议先是每 5-10 秒一帧，避免成本过高。
- 对工程师发送的 `annotation.draw`、`control.action`、聊天文字、语音转写同时进 timeline。

实时屏幕 OCR 不进入第一版。

---

## 5. 统一策略模型

### 5.1 风险类型

建议第一版内置这些 `policy_type`：

| policy_type | 说明 | 默认严重级别 |
|---|---|---|
| `phone_number` | 手机号、座机、分段号码 | high |
| `email` | 邮箱地址 | high |
| `wechat` | 微信、微信号、加 V、weixin、wx | high |
| `whatsapp` | WhatsApp 联系方式 | medium |
| `telegram` | Telegram 联系方式 | medium |
| `line` | LINE 联系方式，日本/海外场景常见 | medium |
| `qr_code` | 二维码，未解析或解析出站外链接/联系方式 | high |
| `direct_payment` | 私下付款、线下转账、支付宝/银行卡/收款码 | high |
| `outside_platform` | 平台外交易、私聊、绕过平台 | high |
| `split_contact` | 分段报号码、拆图展示号码等规避行为 | high |
| `suspicious_intent` | AI 复核后认为有绕单意图 | medium/high |

### 5.2 处置动作

`action` 不再只写 `record`，升级为：

| action | 语义 |
|---|---|
| `record` | 只记录，不打断用户 |
| `warn` | 给发送方提示风险 |
| `block` | 阻止消息或附件继续发送 |
| `review` | 进入人工审核 |
| `escalate` | 通知主管/风控 |

第一版默认策略：

- 文本手机号、邮箱、微信：`review`，可配置为 `block`。
- OCR 图片手机号、二维码、收款码：`review`。
- ASR 命中号码但置信度不足：`record + review`。
- AI 复核确认绕单意图：`escalate`。

### 5.3 证据原则

必须保留：

- 来源类型：text/image/audio/video/screen_frame。
- 来源对象：message_id、evidence_id、recording_id、frame_id、transcript_segment_id。
- 命中规则：policy_type、severity、confidence。
- 脱敏摘要：如 `138****8000`。
- hash：对原始命中片段做 sha256。
- provider 信息：ocr/asr/ai_review provider、模型版本、耗时、错误原因。

默认不保存完整敏感片段。只有在租户策略开启“合规审核明文保留”时，才可加密保存短上下文。

---

## 6. Provider 设计

### 6.1 统一接口

```ts
export interface OcrProvider {
  readonly provider: string;
  recognize(input: OcrRecognizeInput): Promise<OcrRecognizeResult>;
}

export interface AsrProvider {
  readonly provider: string;
  transcribe(input: AsrTranscribeInput): Promise<AsrTranscribeResult>;
}

export interface AiQualityReviewProvider {
  readonly provider: string;
  reviewAntiCircumvention(input: AntiCircumventionReviewInput): Promise<AntiCircumventionReviewResult>;
}
```

所有 provider 返回统一结果：

- `provider`
- `model`
- `language`
- `text`
- `segments`
- `confidence`
- `duration_ms`
- `raw_ref` 或 `raw_metadata`

### 6.2 自建场景

自建 OCR/ASR 适合数据敏感、成本可控、部署可控的客户。

建议实现：

- OCR：PaddleOCR / EasyOCR / Tesseract 作为适配对象。
- ASR：FunASR / Whisper / faster-whisper 作为适配对象。
- 部署方式：单独 `media-ai-worker` 服务，通过 HTTP 或队列调用。
- 存储：对象文件仍在 MinIO/S3/本地挂载，worker 只拿短期签名 URL 或内部对象 key。
- 优点：数据不出自有环境、可控、长远成本低。
- 缺点：GPU/CPU 资源、模型运维、语言效果、升级成本需要自己承担。

自建配置示例：

```env
IVEKIT_OCR_PROVIDER=self_hosted
IVEKIT_OCR_SELF_HOSTED_URL=http://ocr-worker:8080/ocr
IVEKIT_ASR_PROVIDER=self_hosted
IVEKIT_ASR_SELF_HOSTED_URL=http://asr-worker:8080/transcribe
IVEKIT_QM_PROVIDER=self_hosted
IVEKIT_QM_SELF_HOSTED_URL=http://quality-worker:8080/review
```

### 6.3 第三方场景

第三方 OCR/ASR 适合快速上线、语言覆盖强、无需自运维的阶段。

建议实现：

- OCR adapter：阿里云 OCR、腾讯云 OCR、Google Vision、AWS Textract 等。
- ASR adapter：阿里云智能语音、腾讯云 ASR、Azure Speech、Google Speech 等。
- AI 质检 adapter：可接 OpenAI-compatible API、云厂商大模型或内部大模型网关。
- 优点：上线快、准确率和多语言能力通常更稳。
- 缺点：成本、数据出域、供应商锁定、合规评估。

第三方配置示例：

```env
IVEKIT_OCR_PROVIDER=third_party
IVEKIT_OCR_VENDOR=aliyun
IVEKIT_OCR_API_KEY_REF=ALIYUN_OCR_API_KEY
IVEKIT_ASR_PROVIDER=third_party
IVEKIT_ASR_VENDOR=tencent
IVEKIT_ASR_API_KEY_REF=TENCENT_ASR_API_KEY
IVEKIT_QM_PROVIDER=third_party
IVEKIT_QM_VENDOR=openai_compatible
IVEKIT_QM_BASE_URL=https://llm.example.com/v1
IVEKIT_QM_API_KEY_REF=IVEKIT_QM_API_KEY
```

### 6.4 为什么不把供应商写死

防绕单的核心资产不是 OCR/ASR 本身，而是：

- 订单/会话绑定。
- 多模态证据链。
- 统一策略命中模型。
- 审核、申诉、统计。
- 供应商可替换的处理流水线。

所以第一版必须先把 provider 抽象和数据模型定好。

---

## 7. 数据模型

建议保留现有 `collaboration_policy_events`，并扩展字段，避免另开一套完全平行的风控表。

新增字段建议：

```sql
ALTER TABLE collaboration_policy_events
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'text_message',
  ADD COLUMN IF NOT EXISTS source_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS business_ref_type TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS business_ref_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS evidence_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS model TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS confidence REAL,
  ADD COLUMN IF NOT EXISTS redacted_excerpt TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS reviewed_by TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS reviewed_at TEXT,
  ADD COLUMN IF NOT EXISTS metadata TEXT NOT NULL DEFAULT '{}';
```

新增扫描任务表：

```sql
CREATE TABLE IF NOT EXISTS policy_scan_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  business_ref_type TEXT NOT NULL,
  business_ref_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL DEFAULT '',
  provider_kind TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

`policy_scan_jobs` 用于 OCR/ASR 异步任务。同步文本扫描可以不建 job，也可以写入 completed job 方便统一查询。

---

## 8. API 和模块边界

### 8.1 iveKit facade

新增或扩展：

```ts
iveKit.policy.scanText(input)
iveKit.policy.enqueueOcr(input)
iveKit.policy.enqueueAsr(input)
iveKit.policy.reviewFinding(input)
iveKit.policy.listFindings(input)
iveKit.policy.listJobs(input)
```

保留兼容：

```ts
iveKit.collaboration.scanPolicy(input)
```

但后续 `scanPolicy()` 应委托到新的 `policy.scanText()`。

### 8.2 HTTP API

建议新增：

```text
POST /api/collaboration/sessions/:id/policy/scan-text
POST /api/collaboration/sessions/:id/policy/ocr-jobs
POST /api/collaboration/sessions/:id/policy/asr-jobs
GET  /api/collaboration/sessions/:id/policy/findings
POST /api/collaboration/policy/findings/:id/review
```

第一版不要求公网开放。所有接口必须走租户认证。

---

## 9. 工作流

### 9.1 文字消息

```text
用户发送消息
  -> postMessage()
  -> policy.scanText()
  -> collaboration_policy_events
  -> 返回 action
  -> 前端按 action 展示提示/拦截/继续发送
```

### 9.2 图片 OCR

```text
用户上传图片
  -> evidence_records 或 message attachment
  -> policy.enqueueOcr()
  -> policy_scan_jobs(status=pending)
  -> OCR provider
  -> scan extracted text
  -> collaboration_policy_events
  -> finding 通知/审核
```

### 9.3 语音/视频 ASR + AI 质检

```text
录音/视频/录屏完成
  -> evidence_records
  -> policy.enqueueAsr()
  -> ASR provider
  -> transcript segments
  -> rules scan
  -> high/ambiguous segments call AI review
  -> collaboration_policy_events
  -> quality finding
```

---

## 10. AI 质检设计

AI 质检只复核“疑似绕单片段”，不要把整段长录音直接丢给模型做开放式判断。

输入：

- 业务对象：订单/工单。
- 参与人身份：customer / engineer / agent。
- 来源：聊天、OCR、ASR。
- 命中片段前后上下文。
- 已命中的规则类型。

输出：

```ts
{
  verdict: 'confirmed_violation' | 'likely_violation' | 'unclear' | 'false_positive',
  confidence: number,
  policy_types: string[],
  redacted_summary: string,
  recommended_action: 'record' | 'warn' | 'block' | 'review' | 'escalate',
  reasoning_codes: string[]
}
```

`reasoning_codes` 使用枚举，不保存大模型长推理：

- `shared_direct_phone`
- `shared_wechat`
- `asked_to_leave_platform`
- `shared_payment_method`
- `split_contact_digits`
- `benign_order_number`
- `benign_product_model`
- `benign_address_or_measurement`

这样能减少误判，也方便运营看板统计。

---

## 11. 误判控制

LED 场景容易误判：

- LED 型号、尺寸、序列号像手机号。
- 地址门牌号像联系方式。
- 发票税号、物流单号、订单号。
- 技术支持截图里出现客户自己的账号信息。

所以第一版必须做：

- 红线规则：明确手机号、微信、邮箱、二维码、收款码。
- 白名单上下文：订单号、服务单号、产品型号、尺寸单位、邮编。
- AI 复核：只对高风险或模糊片段复核。
- 人工审核：所有高风险 findings 默认可人工确认/驳回。

---

## 12. 安全与合规

- OCR/ASR provider 不应直接拿长期对象存储凭证。
- 传给第三方的文件应使用短期签名 URL 或临时转发。
- 默认不保存原始敏感片段，只保存 hash 和脱敏摘要。
- 第三方 provider 必须记录 vendor、region、model、request_id。
- 自建 provider 必须记录服务版本和模型版本。
- 租户可配置是否允许第三方处理图片/录音。
- 若租户禁用第三方且未配置自建 provider，OCR/ASR job 应返回 `provider_unavailable`，不能静默成功。

---

## 13. 阶段划分

### Phase 1：统一策略引擎

- 扩展文本规则：中文绕单、LINE、二维码、线下付款。
- 增强 `collaboration_policy_events` 字段。
- `postMessage()` 自动扫描。
- iveKit policy facade。

### Phase 2：OCR 异步扫描

- OCR provider interface。
- fake/test provider。
- self-hosted HTTP provider。
- third-party HTTP provider shell。
- 图片/附件 OCR job。

### Phase 3：ASR + AI 质检

- ASR provider interface。
- transcript segment 数据契约。
- recording/evidence 触发 ASR job。
- AI 复核 provider interface。
- 质检 finding 输出。

### Phase 4：运营闭环

- findings 列表。
- 人工审核接口。
- 误报标记。
- 订单/工单风险状态。
- 风险统计和导出。

### Phase 5：实时能力

- 实时 ASR 分片。
- 屏幕共享抽帧 OCR。
- 高风险实时提醒。
- 可配置实时拦截。

---

## 14. 验收标准

第一版完成时应满足：

- 文本“加我微信 138xxxx”能命中并写 finding。
- 图片 OCR 提取出的手机号能命中并绑定图片 evidence。
- 录音 ASR 文本“我的号码是...”能命中并进入 AI 复核。
- 自建 provider 和第三方 provider 可以通过配置切换。
- provider 不可用时 job 明确失败并可重试。
- findings 可按 `BusinessRef` 查询。
- 高风险 finding 可人工确认、误报、处理。
- 敏感片段默认脱敏和 hash，不明文散落在普通表里。
