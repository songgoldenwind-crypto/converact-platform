# iveKit V5 阶段一内容智能增强实施计划

**目标：** 在不绑定真实 OCR、ASR、翻译或大模型厂商的前提下，完成混淆联系方式、二维码/条码、视频帧 OCR、跨消息聚合、会话级 AI 质检以及版本化证据的代码、协议、迁移、SDK 和受控验收。

**架构：** 文本和 OCR/ASR 输出先进入确定性 detector；OCR Provider 同时返回文本和结构化视觉 observation。图片直接 OCR，视频/屏幕录制同时建立 ASR 与 OCR 任务，其中 OCR 请求明确声明 `video_frame_sampling`，由自建或第三方 Provider 完成抽帧和识别。单条 finding 与会话 aggregate finding 共用同一不可逆哈希、版本化证据和人工审核模型；AI 质检接收有限会话窗口及证据引用，不保存 Provider 原始正文。

**技术栈：** TypeScript、Node.js、PostgreSQL FORCE RLS、现有 Provider route/governance、tenant events、`@opc/ivekit-sdk`、Node test runner。

## 1. 范围与边界

### 1.1 本阶段完成

1. 常见混淆手机号、邮箱、微信/WhatsApp/Telegram/QQ 联系意图的确定性识别。
2. 同一会话内分散在多条消息或附件识别文本中的联系方式聚合。
3. OCR Provider 的二维码、条码和视频帧结构化 observation 合同。
4. 图片 OCR；视频和屏幕录制的 ASR + 帧 OCR 双任务入口。
5. observation 的原始值只在当前处理内存中参与检测；数据库只保存哈希、类型、symbology、帧时间和证据引用。
6. AI 质检使用有限会话窗口、规则 finding 和结构化证据。
7. finding 保存 detector/policy/evidence snapshot 版本；算法升级产生新 fingerprint，不覆盖旧证据。
8. OpenAPI、SDK、运维文档、受控 Provider 和 standalone 迁移覆盖新增合同。

### 1.2 环境待验收

1. 真实 OCR 对二维码、条码、复杂图片和视频抽帧的准确率。
2. 真实 ASR 对数字口述、方言和噪声的准确率。
3. 真实 AI 质检模型的召回率、误报率和业务语义效果。
4. 真实 Provider 的额度、时延、网络、数据出境和生产并发。

这些项目继续标记 `not_run`，受控 Provider 只能证明协议、路由、持久化和恢复行为。

## 2. 文件职责

新增：

- `src/migrations/060_ivekit_content_intelligence.sql`：finding 版本字段、视觉 observation 表、RLS、索引和 runtime 权限。
- `src/agent-runtime/collaboration/contact-normalization.ts`：Unicode/分隔符/中英文数字规范化和安全 token 化。
- `src/agent-runtime/collaboration/session-policy-aggregation.ts`：有限窗口的跨消息/附件确定性聚合。
- `test/ivekit-content-intelligence.test.ts`：detector、observation、聚合、版本和 secret-safety 合同。

修改：

- `src/agent-runtime/collaboration/policy-scan.ts`：V2 detector、match 版本、类别和置信度。
- `src/agent-runtime/collaboration/policy-finding-store.ts`：版本化 fingerprint、evidence snapshot hash 和结构化 observation finding。
- `src/agent-runtime/collaboration/collaboration-store.ts`：单源扫描后触发会话聚合。
- `src/agent-runtime/collaboration/attachment-text-provider.ts`：媒体模式与结构化 observation 请求/响应合同。
- `src/agent-runtime/collaboration/attachment-processing.ts`：视频双任务、observation 持久化和聚合扫描。
- `src/agent-runtime/collaboration/quality-review.ts`：会话窗口内容、版本化输入 hash 和多证据引用。
- `src/agent-runtime/collaboration/types.ts`：新增 source、observation、版本字段和 processor 类型。
- `src/db-pg.ts`：MemoryPg 对 migration 060 新查询的测试实现。
- `scripts/ivekit-controlled-provider.ts`：受控二维码、条码和视频帧 fixtures。
- `scripts/ivekit-delivery-bundle.ts`、`services/ivekit-service/source-policy.json`：交付 migration 060。
- `docs/openapi.yaml`、`docs/ivekit-openapi.md`、`docs/ivekit-v3-intelligence-operations.md`：合同、边界和运维说明。
- `sdk/ivekit/src/chat-types.ts`：finding/observation/版本字段。

## 3. 数据合同

### 3.1 Detector 输出

```ts
interface TextPolicyMatch {
  policy_type: string;
  severity: 'low' | 'medium' | 'high';
  matched_text_hash: string;
  action: 'record';
  detector_version: 'contact-v2';
  policy_version: 'anti-circumvention-v2';
  confidence: number;
  match_kind: 'direct' | 'obfuscated' | 'intent' | 'aggregate' | 'visual_code';
}
```

detector 可读取原文，但输出不得包含命中原文、规范化手机号、账号、二维码 payload 或上下文片段。

### 3.2 OCR/视频 observation

```ts
interface AttachmentVisualObservation {
  type: 'qr_code' | 'barcode' | 'text_region';
  value: string;              // 仅处理期间存在，不写数据库
  symbology?: string;         // QR_CODE、EAN_13、CODE_128 等白名单安全值
  confidence?: number;        // 0..1
  frame_timestamp_ms?: number;// 视频帧时间，0..24h
  page?: number;              // 文档页，1..10000
  metadata?: Record<string, unknown>;
}

interface AttachmentTextExtractionResult {
  text: string;
  observations?: AttachmentVisualObservation[];
  // 其余现有字段保持不变
}
```

HTTP multipart 请求增加：

- `media_mode=text`：图片或文档直接 OCR。
- `media_mode=video_frame_sampling`：视频/屏幕录制帧 OCR。
- `frame_interval_ms`：默认 2000，范围 500..60000。
- `max_frames`：默认 120，范围 1..600。

Provider 最多返回 500 个 observation；单 value 最大 4096 字节；响应总量继续受 1 MiB 限制。服务持久化时只保存 `value_hash`，不得保存 `value`。

### 3.3 数据库

`collaboration_policy_findings` 新增：

- `detector_version TEXT NOT NULL DEFAULT 'legacy-v1'`
- `policy_version TEXT NOT NULL DEFAULT 'legacy-v1'`
- `evidence_snapshot_hash TEXT NOT NULL DEFAULT <64-zero-hash>`
- `content_version INTEGER NOT NULL DEFAULT 1`

新表 `collaboration_visual_observations`：

- `(id, tenant_id, session_id, message_id, attachment_id, processor_job_id)`
- `observation_type`、`value_hash`、`symbology`、`confidence`
- `frame_timestamp_ms`、`page_number`、`metadata`
- `detector_version`、`created_at`
- 唯一键包含 tenant、attachment、job、type、value hash、帧时间和页码
- `ENABLE ROW LEVEL SECURITY`、`FORCE ROW LEVEL SECURITY`

finding fingerprint V2 包含 tenant、session、source identity、policy type、matched hash、detector version、policy version 和 evidence snapshot hash。旧 finding 不改写；同版本重放幂等，新 detector/policy 版本生成独立 finding。

## 4. 实施任务

### Task 1：V2 联系方式 detector

- [x] 在 `test/ivekit-content-intelligence.test.ts` 写失败测试，覆盖全角数字、空格/点/短横线、中文数字口述、`wx/微 信/V信/加v`、WhatsApp、Telegram、QQ 和直接支付意图。
- [x] 增加误报测试：普通订单号、时间、金额、IPv4、无联系意图的短数字不得命中手机号。
- [x] 实现 `contact-normalization.ts`，只产生内部 canonical token 和位置映射，不导出或持久化明文。
- [x] 修改 `policy-scan.ts` 输出 V2 版本、match kind、置信度和 canonical value hash。
- [x] 运行 `node --import tsx --test test/ivekit-content-intelligence.test.ts test/collaboration-policy-finding.test.ts`。

### Task 2：版本化 finding 与证据快照

- [x] 先写 migration 合同测试，断言 060 字段、observation 表、唯一约束、FORCE RLS、权限和 secret-safe schema。
- [x] 创建 migration 060，并加入 standalone source policy、delivery bundle 和顺序测试。
- [x] 修改 finding 类型、decode、insert 和 fingerprint；evidence snapshot hash 由排序后的安全 evidence refs 计算。
- [x] 测试同一 detector/policy/evidence 重放只有一个 finding；版本变化保留两条 finding；序列化结果不含原始联系方式。
- [x] 运行 standalone migration tests 和 `npm run typecheck`。

### Task 3：二维码、条码和视频帧 Provider 合同

- [x] 在 attachment provider 测试中增加结构化 observation、数量/长度/类型/置信度/帧时间边界和超限拒绝。
- [x] 给请求增加 `media_mode`、`frame_interval_ms`、`max_frames`，并测试图片与视频请求字段不同。
- [x] 修改受控 Provider：图片 fixture 返回 QR observation，视频 fixture 返回带帧时间的 QR/条码 observation。
- [x] 确保 Provider URL、token、响应原文和 observation value 不进入 metadata、事件或错误消息。
- [x] 运行 attachment provider、受控 Provider 和 route/failover tests。

### Task 4：视频双任务与 observation 持久化

- [x] 将 attachment processor 扩展为 `ocr | asr | video_frame_ocr`；`video_frame_ocr` 复用 OCR profile route 和 governance capability `ocr`。
- [x] 图片建立 OCR；音频建立 ASR；视频/屏幕录制同时建立 ASR 与 `video_frame_ocr` 两个幂等任务。
- [x] 完成任务时 upsert 结构化 observation，扫描 observation value 后立即丢弃原值，只保留 hash finding 与 observation 行。
- [x] `extracted_text` 按 OCR/视频帧 OCR/ASR 合并；一个 processor 失败不得覆盖另一个成功结果。
- [x] 测试视频两个任务独立重试、重启恢复、Provider 路由、证据帧时间和原值不落库。

### Task 5：跨消息/附件聚合

- [x] 实现 `session-policy-aggregation.ts`，每次源扫描只读取同租户同会话最近 20 个有效消息及附件识别结果，总字符上限 20000。
- [x] 聚合规则覆盖分段手机号、联系意图与下一条账号、二维码/条码联系方式；窗口内 sender、source、message/attachment version 均进入 evidence refs。
- [x] 聚合 finding 使用 source `aggregate`、空 `message_id`、会话级 source ref 和 V2 fingerprint；不得把聚合原文写入数据库。
- [x] 测试跨租户不可见、删除消息不参与、窗口外不参与、重放幂等和 evidence refs 稳定排序。

### Task 6：会话级 AI 质检

- [x] 将 quality input builder 改为目标消息加最近 20 条会话上下文及附件识别文本，使用明确 source label 和单项长度上限。
- [x] input hash 包含内容、消息版本、附件 checksum、规则 finding fingerprint、detector/policy version。
- [x] AI finding evidence refs 指向参与窗口的每条消息/附件，不只指向目标消息。
- [x] 测试后续消息产生的新任务可识别前后组合；消息编辑或附件重识别使旧 claim 转 retry；Provider 输出仍执行数量、长度和 metadata 安全限制。

### Task 7：API、SDK、事件和文档

- [x] OpenAPI/SDK 暴露 observation 安全字段、aggregate source 和 finding 版本字段，不暴露 observation value。
- [x] Provider processed 和 finding 事件仅携带 id、类型、版本、hash 和 evidence refs。
- [x] 运维文档写明自建 OCR 可实现 `/v1/ocr` 的图片/视频模式，第三方 adapter 必须归一化为同一合同。
- [x] 文档明确受控视频 observation 不代表真实抽帧质量通过。
- [x] 构建 SDK、dry-run pack、standalone context 和 delivery bundle。

### Task 8：阶段验收

- [x] 运行所有 Provider/intelligence/attachment/quality/translation/event focused tests。
- [x] 运行真实 PostgreSQL fresh、pre-060 upgrade、RLS、并发 Provider reservation 和 observation 跨租户隔离。
- [x] 运行受控 Provider matrix，加入 image QR、barcode、video frame 和 oversized observation 场景。
- [x] 运行 `npm run typecheck`、SDK build 和 dry-run pack。
- [x] 更新 `docs/ivekit-v5-shared-foundation-design.md`：代码合同有证据的标为 implemented；真实厂商、真实视频抽帧效果和业务准确率继续标为 `not_run`。

### 4.1 验收证据（2026-07-15）

- 108 个 Provider/intelligence/attachment/quality/translation/event focused tests 通过，0 失败。
- 真实 PostgreSQL fresh、pre-060 upgrade、FORCE RLS、Provider 并发配额、视觉 observation 跨租户隔离、worker 恢复、IVR 与受控 RustPBX 共 4 项通过。
- 受控 Provider 函数合同、真实 HTTP multipart 视频 OCR、QR/条码帧结果、501 observations 拒绝和治理失败矩阵通过。
- iveKit 交付契约 23 项、standalone source graph/context 10 项通过；独立 context 编译 218 个源文件。
- TypeScript typecheck、SDK build 和 66 文件 dry-run pack 通过。
- 真实 OCR/ASR/AI/翻译厂商效果、真实视频抽帧准确率、生产额度和并发继续标记 `not_run`。

## 5. 完成标准

1. 文本、OCR、ASR、视觉 observation 和跨消息聚合都生成统一、可审核、版本化 finding。
2. 所有 finding 都可追溯到 tenant/session/message/attachment/job 和 detector/policy/evidence 版本。
3. 数据库、API、SDK、事件、日志和交付证据均不保存或暴露命中的手机号、账号、二维码 payload、Provider token 或原始错误 body。
4. 视频/屏幕录制同时具备 ASR 与帧 OCR 的代码入口、任务恢复和 Provider 切换；真实抽帧准确率保持环境待验收。
5. 同一会话分散发送的联系方式可以由确定性聚合或会话级 AI 质检发现；跨租户、已删除和窗口外内容不得参与。
6. migration、RLS、多实例 lease、重试、重启、幂等、版本升级、SDK/OpenAPI 和交付包都有自动化验收。
