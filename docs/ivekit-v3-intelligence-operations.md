# iveKit V3 多模态智能与翻译部署运维手册

更新日期：2026-07-15。本文对应 iveKit V3 的 OCR、ASR、AI 防绕单质检、人工复核、录制源导入和消息/附件翻译；第 14 节补充 V5 Stage 2 的 Tinode、LiveKit 与文件安全生产部署要求。它只描述可复用 iveKit 边界，不包含 SIP/VoLTE、RTMP/HLS、数字人或 OPC call-center 业务编排。

## 1. 交付状态与边界

| 能力 | 代码状态 | 当前验收边界 |
| --- | --- | --- |
| Provider registry | 已完成 | 支持 `self_hosted`、`third_party`、四类 capability、健康探测和脱敏清单 |
| 租户策略 | 已完成 | PostgreSQL 持久化、乐观版本、RBAC、third-party 开关、自动任务开关 |
| 图片/视频帧 OCR | 已完成 | 图片 OCR；视频/录屏独立帧 OCR；二维码/条码 hash-only observation；真实厂商与真实抽帧效果 `not_run` |
| 音频/视频/录屏 ASR | 已完成 | 附件和录制源统一进入 durable job；视频与帧 OCR 双任务互不覆盖；真实厂商 `not_run` |
| 聚合防绕单 | 已完成 | 混淆联系方式、最近 20 条跨消息/附件、删除/窗口/租户隔离、版本化 finding |
| AI 质检 | 已完成 | 最近 20 条会话上下文、OCR/ASR、规则 finding 版本化输入、AI finding、人审；真实模型 `not_run` |
| 翻译 | 已完成 | 消息/附件、自动/手动、幂等、source hash、防陈旧覆盖、重试和事件 |
| 参考客户端 | 已完成 | Quality 审核队列、翻译工作区、原文保留、失败重试；本机真实浏览器环境验证待服务器执行 |
| 受控 Provider | 已完成 | success、timeout、transient/terminal failure、invalid JSON、oversized response/observations、图片/视频视觉 fixture |
| 真实厂商数据面 | 未执行 | 准确率、限流、区域合规、真实延迟、账单和供应商 SLA 均为 `not_run` |

LED 和 OPC 都是租户客户端。它们只能通过 `@opc/ivekit-sdk`、`/api/ivekit/*` 和租户事件接入，不得直连 PostgreSQL、MinIO/S3 管理 API、Provider 或 worker 表。

## 2. 运行架构

```text
LED/OPC backend or short-lived browser JWT
                 |
                 | @opc/ivekit-sdk / HTTPS / tenant WebSocket
                 v
       iveKit facade + RBAC + tenant policy
          |             |             |
          v             v             v
     PostgreSQL       Redis       Object storage
    RLS + jobs       events        source bytes
          |
          v
 attachment worker / quality worker / translation worker
          |
          v
 self_hosted or third_party HTTP providers
```

任务状态统一为 `pending -> processing -> succeeded`，可重试失败进入 `retry_wait`，不可重试或超过次数进入 `failed`，源删除/变更进入 `cancelled`。worker 使用租约 claim；进程在 Provider 调用期间退出时，过期租约会被下一轮恢复，不会永久卡在 `processing`。

## 3. Provider Profile

`CONVERACT_FABRIC_PROVIDER_PROFILES_JSON` 只保存非敏感路由元数据。token 只放环境变量或 Kubernetes Secret，JSON 中只能写 `token_env` 名称。

### 3.1 自建场景

```json
[
  {
    "id": "ocr-local",
    "capability": "ocr",
    "mode": "self_hosted",
    "base_url": "http://ocr.internal:8080",
    "endpoint": "/v1/ocr",
    "health_endpoint": "/health",
    "token_env": "OPC_IVEKIT_OCR_TOKEN",
    "timeout_ms": 30000,
    "name": "internal-ocr"
  },
  {
    "id": "asr-local",
    "capability": "asr",
    "mode": "self_hosted",
    "base_url": "http://asr.internal:8080",
    "endpoint": "/v1/asr",
    "health_endpoint": "/health",
    "token_env": "OPC_IVEKIT_ASR_TOKEN",
    "timeout_ms": 60000,
    "name": "internal-asr"
  }
]
```

自建 HTTP 只允许 localhost、私网 IP 或容器/内部主机名；公网主机应使用 HTTPS。iveKit 不负责部署具体 OCR/ASR 模型，Provider 可以由 PaddleOCR、Whisper 类服务或公司内部推理网关实现，只要满足第 4 节协议。

### 3.2 第三方场景

```json
[
  {
    "id": "quality-vendor",
    "capability": "quality_review",
    "mode": "third_party",
    "base_url": "https://quality.vendor.example",
    "endpoint": "/v1/quality-review",
    "health_endpoint": "/health",
    "token_env": "OPC_IVEKIT_QUALITY_TOKEN",
    "timeout_ms": 30000,
    "name": "vendor-quality"
  },
  {
    "id": "translation-vendor",
    "capability": "translation",
    "mode": "third_party",
    "base_url": "https://translation.vendor.example",
    "endpoint": "/v1/translate",
    "health_endpoint": "/health",
    "token_env": "OPC_IVEKIT_TRANSLATION_TOKEN",
    "timeout_ms": 30000,
    "name": "vendor-translation"
  }
]
```

`third_party` 强制 HTTPS，且租户策略必须同时设置 `allow_third_party=true`。只配置 profile 不会自动放行，也不会自动启动 worker。

### 3.3 约束

- capability 只能是 `ocr|asr|quality_review|translation`。
- mode 只能是 `self_hosted|third_party`。
- profile id 为小写字母开头，最多 64 字符；总数最多 100。
- endpoint/health endpoint 必须是无 query、fragment 和路径穿越的绝对路径。
- timeout 为 1,000 到 300,000 ms；claim lease 至少比 timeout 多 5 秒。
- URL 不得内嵌用户名、密码、token 或 query secret。
- 安全 API 只返回 `token_configured`，不返回 token、base URL 或 `token_env`。

旧的 `OPC_OCR_*`、`OPC_ASR_*`、`OPC_QUALITY_REVIEW_*`、`OPC_TRANSLATION_*` 仍可生成兼容 profile；新部署应使用 profile JSON，避免能力配置继续分散。

## 4. Provider HTTP 协议

所有数据接口为 `POST`，配置 token 时发送 `Authorization: Bearer <token>`。OCR/ASR 使用 `multipart/form-data`，质检/翻译使用 `application/json`；健康接口为 `GET`。3xx 不跟随；响应 JSON 上限 1 MiB；metadata 和 request id 入库前会限制长度并脱敏。

| Capability | 默认路径 | 请求核心字段 | 成功响应核心字段 |
| --- | --- | --- | --- |
| OCR | `/v1/ocr` | multipart `file/attachment_id/tenant_id/session_id/message_id/source_ref/media_mode`；视频另带 `frame_interval_ms/max_frames` | `text`，可选 `confidence/language/provider_request_id/metadata/observations` |
| ASR | `/v1/asr` | multipart `file/attachment_id/tenant_id/session_id/message_id/source_ref` | `text`，可选 `confidence/language/provider_request_id/metadata` |
| 质检 | `/v1/quality-review` | JSON `tenant_id/session_id/message_id/content/content_hash/rule_findings/evidence_refs` | `findings[]`；每项含 policy/severity/confidence/rationale/recommended action |
| 翻译 | `/v1/translate` | `source_ref/text/source_language/target_language` | `translated_text`，可选 `detected_language/confidence/provider_request_id/metadata` |

iveKit 不信任 Provider 的执行建议。AI finding 的业务动作固定进入人工 `review`，模型不能直接封禁、处罚、删除内容或关闭订单。

OCR/ASR 的文件字节由 iveKit 从私有对象存储读取后转发；请求不包含 S3/MinIO 凭据或 `storage_url`，Provider 不应回源 iveKit 数据库或对象存储。

`media_mode=text` 用于图片/文档；`media_mode=video_frame_sampling` 用于视频和屏幕录制，默认每 2,000 ms 一帧、最多 120 帧。Provider 可返回最多 500 个 observation：`type=qr_code|barcode|text_region`、`value`、可选 `symbology/confidence/frame_timestamp_ms/page/metadata`。`value` 最大 4,096 字节，只能在当前处理内存中用于检测，不得写数据库、日志、事件、错误消息或 API；iveKit 仅保存 SHA-256。

质检 `content` 使用带 source label 的最近 20 条有效会话消息和附件文本，单项 4,000、总计 40,000 字符。`content_hash` 还绑定消息/附件版本与规则 finding 版本，不能按普通正文 SHA-256 理解。Provider 收到的 `rule_findings` 包含 fingerprint、detector/policy/evidence snapshot/content version，输出仍只作为人工复核建议。

HTTP `408/425/429/5xx`、超时和网络错误可重试；普通 `4xx`、非法 JSON、响应过大、缺字段和非法字段属于终态错误。Provider 返回的原始错误 body 不进入客户端响应。

## 5. 租户策略与 RBAC

策略由 `GET/PUT /api/ivekit/intelligence/policy` 管理。`PUT` 必须携带当前 `version`；版本冲突返回 `409`，防止两个管理员互相覆盖。

每种能力用 `ocr_profile_ids/asr_profile_ids/quality_profile_ids/translation_profile_ids` 保存最多 10 个有序候选；旧的单 profile 字段保留为兼容主候选，并始终与数组第一项同步。系统不根据环境变量、声明顺序或 Provider 模式暗中增加 fallback。候选缺凭据、配额耗尽、熔断打开或发生可重试错误时才继续下一项；终态错误立即停止。

### 5.1 五种 Provider 路由场景

以下示例只展示 policy 片段；profile 的 URL、token 和预算仍通过部署配置注入。

1. 自建优先，第三方 fallback：`allow_third_party=true`，例如 `ocr_profile_ids=["ocr-self","ocr-cloud"]`。自建发生 408/425/429/5xx、超时、网络错误、配额或熔断拒绝时才尝试云服务。
2. 全自建：所有 `*_profile_ids` 只含 `mode=self_hosted` 的 profile；可配置两个独立自建集群形成容灾。
3. 全第三方：`allow_third_party=true`，路由只含第三方 profile；每个 token 使用独立 Secret 环境变量。
4. 第三方优先，自建 fallback：`allow_third_party=true`，例如 `translation_profile_ids=["translation-cloud","translation-self"]`，适用于优先追求质量、故障时保底。
5. 禁止跨境 fallback：`allow_third_party=false`，路由只能引用自建 profile。策略写入阶段会拒绝任何第三方候选，运行时也不会寻找或推断第三方替代项。

`GET /api/ivekit/intelligence/capabilities` 返回有序 route 和逐候选可用性；`GET /api/ivekit/intelligence/providers/runtime` 返回租户级配额计数、`closed|open|half_open`、最近成功/失败及安全错误码。两者都不返回 URL、token 或 token 环境变量名。

| 动作 | system | owner/admin | operator | viewer/普通成员 |
| --- | --- | --- | --- | --- |
| 读 capabilities | 是 | 是 | 是 | 是，需已认证 |
| 读/改 policy | 是 | 是 | 否 | 否 |
| 列 provider/探测健康 | 是 | 是 | 否 | 否 |
| 导入/重试录制源 | 是 | 是 | 否 | 否 |
| 查看租户审核队列 | 是 | 是 | 是 | 否 |
| 提交人工复核 | 是 | 是 | 是 | 否 |
| 请求会话内翻译 | 按会话权限 | 按会话权限 | 按会话权限 | 必须是当前会话成员 |
| 运行 worker HTTP endpoint | 仅 system | 否 | 否 | 否 |

tenant id 来自可信 API key/JWT 上下文，不接受 body 覆盖。所有 V3 表启用并强制 PostgreSQL RLS；长驻账号 `opc_runtime` 必须是 `NOSUPERUSER NOBYPASSRLS`。

## 6. Worker 配置

默认全部关闭，先完成 migration、profile、token、policy、storage 和 preflight，再逐类启用。

| Worker | Enabled | Interval | Batch | Attempts | Lease | Retry delays |
| --- | --- | --- | --- | --- | --- | --- |
| Attachment OCR/ASR | `OPC_ATTACHMENT_PROCESSING_WORKER_ENABLED` | `...INTERVAL_MS` | `...BATCH_SIZE` | `...MAX_ATTEMPTS` | `...CLAIM_LEASE_MS` | `...RETRY_DELAYS_MS` |
| Quality | `OPC_QUALITY_REVIEW_WORKER_ENABLED` | `...INTERVAL_MS` | `...BATCH_SIZE` | `...MAX_ATTEMPTS` | `...CLAIM_LEASE_MS` | `...RETRY_DELAYS_MS` |
| Translation | `OPC_TRANSLATION_WORKER_ENABLED` | `...INTERVAL_MS` | `...BATCH_SIZE` | `...MAX_ATTEMPTS` | `...CLAIM_LEASE_MS` | `...RETRY_DELAYS_MS` |

建议初始值：interval `5000`、batch `25`、attempts `3`、lease `120000`、retry `5000,30000`。批量和副本数应按 Provider QPS/并发限制扩容，不能只提高 worker 数量。

`OPC_QUALITY_REVIEW_AUTO_ENQUEUE=0` 是部署安全默认；真正是否自动质检还受租户 `auto_quality_review` 控制。自动翻译还要求 `translation_enabled=true`、`auto_translation=true` 和非空 `translation_target_languages`。

## 7. 数据、幂等和证据链

Migration 顺序：

- `043_ivekit_intelligence_translation.sql`：策略、录制源 link、翻译 job、翻译结果扩展和 RLS。
- `044_quality_review_policy_routing.sql`：标记自动质检 job。
- `045_translation_worker_routing.sql`：自动翻译标记和多租户 worker queue selector。
- `059_ivekit_provider_governance.sql`：有序 Provider 路由、租户级配额/熔断 runtime、并发 reservation lease 和强制 RLS。

录制源导入和翻译请求必须带稳定 `Idempotency-Key`。同 key 同 payload 返回原结果；同 key 不同 payload 返回 `409`。翻译结果以 `(tenant, source_type, source_ref_id, target_language, source_hash)` 唯一，编辑或删除原文后旧 job 会取消，旧结果不会覆盖新原文。

evidence 只保存脱敏引用、hash、confidence、provider profile id/mode/name/request id 和有限 metadata。API key、Provider token、原始 Authorization、对象存储 secret 不得进入表、事件、日志或验收报告。

## 8. 部署步骤

### 8.1 Compose

1. 复制 `infra/ivekit/env.example` 到权限为 `0600` 的环境文件。
2. 填写 profile JSON 与独立 token；保持 worker 为 `0`。
3. 渲染：

```bash
docker compose --project-name ivekit-app \
  --env-file /secure/path/application.env \
  -f infra/ivekit/docker-compose.yml config --quiet
```

4. 启动 migration 和应用，确认 one-shot 服务退出码为 0。
5. 运行 preflight 和 Provider health。
6. 配置租户 policy，再逐个将所需 worker 改成 `1` 并重建 `opc` 服务。

### 8.2 Kubernetes

- 非敏感 profile JSON 放 `intelligence.providerProfilesJson`。
- 四个 token 放 `intelligence.ocrToken/asrToken/qualityToken/translationToken`，chart 只通过 Secret 引用注入。
- 翻译 worker 位于 `intelligence.translationWorker`；附件和质检 worker 保留各自 values section。
- 不要把 token 写进 `providerProfilesJson`、ConfigMap、Deployment `value`、Helm 命令行历史或 Git values 文件。

生产建议使用外部 Secret 管理器覆盖 chart Secret。`values.yaml` 中的空 token 只是结构默认，不表示已配置。

## 9. Preflight 与受控验收

配置检查：

```bash
npm run ivekit:intelligence-preflight
```

输出只包含 `ready/issues`、数据库/存储是否配置、脱敏 profiles 和 worker lease。`verification_scope=configuration_only`，成功不证明 Provider 数据面可用。

启动受控 Provider：

```bash
OPC_IVEKIT_CONTROLLED_HOST=127.0.0.1 \
OPC_IVEKIT_CONTROLLED_PORT=8790 \
OPC_IVEKIT_CONTROLLED_TOKEN=replace_with_test_service_token \
OPC_IVEKIT_CONTROL_TOKEN=replace_with_test_control_token \
  npm run ivekit:controlled-provider
```

控制模式：`success|timeout|rate_limited|transient_failure|terminal_failure|invalid_json|oversized_response|oversized_observations`。成功 OCR fixture 会按 `media_mode` 返回图片页或视频帧 QR/条码 observation。模式切换接口 `/__control/mode` 必须使用独立 control token；该服务只用于隔离验收，不能作为生产 Provider。

无需启动外部服务即可运行 Provider 协议与治理矩阵：

```bash
npm run ivekit:provider-governance-acceptance
```

该命令使用正式 HTTP Translation Provider、正式路由执行器和治理存储，覆盖 success、429、5xx、timeout、终态不切换、quota、circuit open、half-open recovery 与 failover。输出固定声明 `verification_scope=controlled_provider_and_in_memory_governance`、`real_vendor_evidence=false`；它是代码级自动验收，不替代真实 OCR/ASR/翻译供应商效果和并发验收。

实时 ASR/翻译 WSS adapter 与路由矩阵：

```bash
npm run ivekit:realtime-speech-provider-acceptance
```

该命令在当前主机 loopback 启动临时 WebSocket Provider，并直接使用正式
`ivekit-realtime-speech-v1` adapter、策略路由和治理存储。固定覆盖二进制 PCM envelope、
429、5xx、终态拒绝、认证失败、协议错误、启动超时、有界音频溢出、启动期 failover、终态
不 failover，以及已建立会话断开后不自动切换 Provider。每个临时监听器和 socket 都在检查后
关闭；报告不包含 URL、Authorization、token、音频或 Provider 原始错误，只声明
`verification_scope=controlled_loopback_realtime_provider`、`real_vendor_evidence=false`。
该命令不替代真实 WSS、真实 RustPBX/LiveKit 音频、弱网、准确率、延迟或容量验收。

健康检查可由 admin 调 `POST /api/ivekit/intelligence/providers/health`。缺 token 返回 `http_class=not_run`，网络/超时不会回显 URL 或 secret。

Provider 路由状态事件为 `collaboration.intelligence.provider.selected`、`collaboration.intelligence.provider.failed_over` 和 `collaboration.intelligence.provider.circuit_changed`。事件只含 capability、profile id、尝试次数和状态变化；事件写入失败不会回滚已经完成的 Provider 结果。

### 9.1 把受控验收证据装入交付包

服务器验收完成后，可准备一个不含凭据的目录：根目录为 `report.json`，实际日志/截图放在 `evidence/`。报告 schema v1 必须绑定完整 40 位 source commit，`controlled_tests_are_real_vendor_evidence` 必须为 `false`，并为 `postgres/provider_protocol/browser/restart_recovery` 四个固定检查分别声明 `passed|not_run` 和证据文件名。`evidence` 清单记录每个文件的字节数与 SHA-256；`passed` 不允许没有证据，`not_run` 不允许引用证据。

生成最终包：

```bash
OPC_IVEKIT_DELIVERY_DIR=/absolute/output/ivekit-led-delivery \
OPC_IVEKIT_DELIVERY_CONTROLLED_ACCEPTANCE_DIR=/absolute/input/controlled-acceptance \
OPC_IVEKIT_DELIVERY_IMAGE_REFERENCE=ivekit-service:<release-commit> \
OPC_IVEKIT_DELIVERY_IMAGE_DIGEST=sha256:<64-hex> \
  npm run ivekit:delivery-bundle
```

生成器会重新计算所有证据大小/hash、拒绝符号链接/额外文件/提交漂移/秘密材料，并把通过项写入 `acceptance/status.json`、把证据复制到 `acceptance/evidence/`。该状态只提升受控环境；真实 LiveKit/Tinode/RustDesk 客户端与真实 OCR/ASR/AI/翻译厂商不受影响，仍按 `not_run` 裁决。

## 10. 监控与告警

`GET /metrics` 提供 HTTP、Node 和 Provider 路由指标。V3 队列状态仍以 PostgreSQL durable job 为权威，部署侧应按 tenant 聚合，禁止在 Prometheus label 中放 tenant/message/session/job id。

Provider 专用指标：

- `opc_ivekit_intelligence_provider_reservations_total`
- `opc_ivekit_intelligence_provider_requests_total`
- `opc_ivekit_intelligence_provider_request_duration_seconds`
- `opc_ivekit_intelligence_provider_failovers_total`
- `opc_ivekit_intelligence_provider_routes_exhausted_total`
- `opc_ivekit_intelligence_provider_circuit_transitions_total`

标签只使用受限 capability、profile id、结果类别和安全错误码，不包含 URL、密钥、租户或内容。

建议告警：

| 告警 | 建议条件 | 处置 |
| --- | --- | --- |
| Provider unavailable | 连续 3 次 health 为 unavailable | 保持 job，不盲目手工重试；检查 DNS/TLS/token/限流 |
| Provider degraded | 429/5xx 或 p95 超预算 10 分钟 | 降低 batch/副本数，联系供应商或切 profile |
| retry backlog | `retry_wait` 数量或最老年龄持续增长 | 检查 Provider、worker enabled、租约与 QPS |
| stuck processing | `processing` 且 `lease_until < now()` | worker 会自动回收；持续出现则检查进程退出或 timeout/lease 配比 |
| terminal failures | `failed` 比率超过业务阈值 | 按 `error_code/profile_id` 聚合，修复后从 API 重试允许重试的资源 |
| review backlog | pending high severity finding 超 SLA | 通知审核员；不得自动改成 resolved |

当前仍没有专用 queue backlog/oldest-age gauge；上线监控必须显式配置上述 SQL/日志采集，不能把 Provider 请求指标误当作完整 worker 队列可观测性。这是运维实现边界，不影响 durable queue 正确性。

实时音频旁路的 PostgreSQL 投影使用独立有界 dispatcher，不在 LiveKit/RustPBX gateway 回调中
等待数据库。`opc_ivekit_voice_audio_tap_events_total` 的 `event_type=tap.projection.failed` 只允许
`projection_failed`、`projection_queue_overflow` 和 `projection_shutdown_timeout` 三种低基数
reason，不包含 SQL、租户、会话、正文或 Provider 原始错误。

## 11. 故障恢复

1. Provider 故障：不删除 job；保留 worker 或暂时关闭 worker，恢复后按 due 时间继续。
2. worker 崩溃：等待 lease 到期；下一轮自动把过期 `processing` 转为 `retry_wait/failed`。
3. 配置错 profile：先关闭对应 worker，修正 profile/token，运行 preflight/health，更新租户 policy 后再启用。
4. 原文变化：系统按 source hash 取消旧翻译；客户端保留原文并只显示当前 hash 对应结果。
5. 终态 job：附件/录制源使用 retry API；翻译只允许 `failed` job retry，并重新校验 source/policy/profile。
6. 跨租户或 RLS 异常：立即停 worker 和应用写流量；不得通过给 runtime 账号 `BYPASSRLS` 临时修复。
7. 实时投影数据库短停：保持主媒体和 gateway；final 按固定退避重试，partial 不重试。队列满时先
   淘汰已排队 partial；全部为 final 时拒绝新项并告警，禁止改成无界 Promise 或无限队列。
8. LiveKit audio tap gateway 短停：客户端重新申请一次性 token 后重连当前签发实例；成功后重置
   重连预算。预算耗尽只关闭辅助 tap，不离开 LiveKit room，也不重启主媒体。
9. PostgreSQL 空闲连接被服务端终止：`pg.Pool` 记录
   `postgres.pool.idle_client_error` 和合法错误码，丢弃失效连接；不得记录连接串、SQL 或原始
   数据库错误正文。活跃查询继续失败给上层重试，禁止在 Pool listener 中重放业务写入。

运行参数：

| 环境变量 | 默认值 | 合法范围 | 语义 |
| --- | ---: | ---: | --- |
| `OPC_IVEKIT_REALTIME_PROJECTION_QUEUE_MAX_ITEMS` | `4096` | `1..100000` | 等待投影项上限，不含当前正在执行的 1 项 |
| `OPC_IVEKIT_REALTIME_PROJECTION_SHUTDOWN_TIMEOUT_MS` | `1000` | `10..30000` | 关闭时等待投影排空的硬上限 |

默认 final 重试间隔为 `100/250/500/1000/2000 ms`。这组值和 gateway 的 8 次有界重连用于吸收短暂
抖动，不是数据库或 gateway 高可用的替代品。持续出现 overflow、retry 或 budget exhaustion 时应
扩容/修复依赖并检查连接池，不得单纯无限增大队列或 timeout。

进程恢复回归入口为 `npm run ivekit:realtime-recovery-acceptance`。它使用唯一 Compose project
实际停止/恢复隔离 PostgreSQL，并终止/重启实际 Node gateway 子进程；Python 容器必须以
`/workspace` 为首个 import path，并校验模块路径和源码 SHA-256。PostgreSQL 使用启动前预留的
固定 loopback 端口，重启后端口不得漂移；验收退出时必须清理专用容器、网络和卷，并确认 LED
容器身份和健康状态未变化。transport 必须使用不含 PostgreSQL/LED 的专属 internal 网络，
宿主状态、只读事件/控制和 transport 可写输出必须分离，禁止回退到 host 网络或共享可写状态目录。
通过后仍不能替代真实 LiveKit/RustPBX 媒体、
CloudNativePG 主备或 Kubernetes Pod rolling 验收。

## 12. 升级与回滚

升级顺序：备份数据库；部署包含 043-045 的 migration 镜像；保持新 worker 关闭；执行 migration；部署应用；运行 preflight、health、受控 Provider 契约和 RLS；配置租户 policy；最后逐类启用 worker。

回滚顺序：先把三个 V3 worker 设为 `0`；回滚应用镜像；保留 043-045 新表/列，不执行 destructive downgrade；确认旧应用忽略新增表后恢复原有流量。翻译和智能表可留存供再次升级，禁止 `DROP TABLE`、`down -v` 或复制到 SQLite。

若新版本已经写入 V3 job，旧版本不会消费它们；这属于可控暂停。再次升级后会按 durable 状态恢复。回滚前后都要核对 RLS 未被移除。

## 13. 真实环境验收清单

- self_hosted：模型版本、CPU/GPU、并发、重启恢复、私网 DNS/TLS、准确率和资源上限。
- third_party：区域、DPA/数据留存、限流、账单、超时、429、5xx、证书和 token 轮换。
- OCR：手机号图片、二维码、条码、低清、旋转、多语言、超大图、无文字和真实视频抽帧准确率。
- ASR：双方语音、噪声、口音、长录屏、静音、多语言和号码口述。
- AI 质检：规则+模型一致性、误报/漏报、人审 SLA、不可逆动作隔离。
- 翻译：原文保留、语言检测、长文本、附件先提取后翻译、编辑后陈旧结果隔离。
- 多副本：claim 竞争、lease recovery、Provider 限流和事件去重。
- RLS：runtime 账号跨租户读写拒绝，admin migration 账号不进入长驻容器。

在真实 Provider、真实对象存储、多副本和目标网络完成前，报告必须写 `not_run`，不能用 preflight、受控 Provider、MemoryPg 或静态 Compose/Helm 渲染替代。

## 14. V5 Stage 2 IM、LiveKit 与文件安全运维

### 14.1 发布前门禁

从仓库根目录执行：

```bash
npm run verify:ivekit:stage2-deployment
npm run verify:ivekit:standalone-context
npm run test:ivekit:delivery
npm run typecheck
npm run build:ivekit-sdk
npm_config_cache=.tmp/npm-cache npm run pack:ivekit-sdk
```

第一条命令要求 Node、Docker Compose 和 Helm，依次执行 standalone Compose quiet render、
Helm lint、Helm template、不可变应用/ClamAV 镜像断言、LiveKit production preflight 合同、
Stage 2 release evidence 和 release operations 测试。CI 使用
`azure/setup-helm@v5.0.0` 安装 Helm `v3.18.4`。缺少 Helm 时命令必须失败，不允许跳过后仍
标记通过。

发布包中的 `operations/stage2-deployment-evidence.json` 绑定完整 source commit、应用镜像
digest、migration 061/062/063 checksum、LiveKit TURN/Egress 和文件安全配置模板指纹。
`operations/release-contract.json` 再绑定该证据文件的 SHA-256 与 release fingerprint。
构建后还必须用实际运行镜像 digest 生成运行时 deployment fingerprint；模板指纹不等于已部署
环境证据。

### 14.2 LiveKit production preflight

生产 preflight 必须同时满足：

- LiveKit internal/public URL、API key/secret 已配置，public URL 使用 `wss://`。
- `OPC_MEDIA_CONFIG_REDIS_ADDRESS` 是 Redis URL 或 `host:port`，报告中不得输出凭据。
- TURN TLS/UDP 端口有效；RTC UDP 起止端口有效且 start 不大于 end。
- `OPC_MEDIA_EGRESS_ENABLED=1`，S3/MinIO endpoint 和 bucket 合法，access/secret 已配置。
- `OPC_MEDIA_CONFIG_WEBHOOK_URL` 在生产使用 HTTPS。
- `OPC_LIVEKIT_TIME_SYNC_STATUS=synchronized`，绝对时钟偏移不超过
  `OPC_LIVEKIT_TIME_SYNC_MAX_SKEW_MS`。

配置 gate 只证明变量结构与安全边界。目标 TURN 可达性、真实浏览器 WebRTC、真实录制对象、
弱网 QoS 与时钟服务观测仍需发布环境证据。

### 14.3 ClamAV 与派生 worker

Compose 和 Helm 默认启用 `clamd` 扫描及本地 FFmpeg 派生 worker，默认关闭破坏性清理。
ClamAV 使用官方非特权入口 `/init-unprivileged`，签名库持久化在 `/var/lib/clamav`，建议保留
2 GiB memory request 和 4 GiB limit。`clamd` 的 3310 端口没有传输认证，只能留在 Compose
私有网络或 Kubernetes ClusterIP，禁止映射公网、NodePort、LoadBalancer 或 hostPort。

生产交付必须给应用和 ClamAV 都提供 `sha256:<64-hex>` digest。Helm 至少需要：

```bash
helm upgrade --install ivekit services/ivekit-service/helm/ivekit \
  --set-string image.repository=<application-repository> \
  --set-string image.digest=sha256:<application-digest> \
  --set-string clamav.image.repository=<clamav-repository> \
  --set-string clamav.image.digest=sha256:<clamav-digest> \
  --set-string secrets.existingSecret=<runtime-secret-name>
```

真实 secret 不得写入 Helm 命令行、values 文件、Git 或 release evidence。应用多副本共享
PostgreSQL durable jobs，claim 使用 lease 与 `FOR UPDATE SKIP LOCKED`；每个副本不得配置
相同固定 worker id。扫描错误 fail closed，文件在 `ready` 前不得下载、OCR/ASR、翻译、
Tinode 发布或派生外部 URL。

清理 worker 只有在 `OPC_FILE_CLEANUP_WORKER_ENABLED=1` 和
`OPC_FILE_CLEANUP_CONFIRM=1` 同时设置时才执行删除。首次上线应先保持两个值为 `0`，核对
retention、dry-run 和对象补偿日志后，在变更窗口内短时启用并观察。

### 14.4 监控、故障与回滚

- 告警至少覆盖扫描/派生 oldest age、retry/failed/quarantined、Tinode outbound/inbound lag、
  dead letter、blocked-by-file、LiveKit degraded/recovered 和 Egress failure。
- ClamAV 不健康时 API 启动 gate 会等待；不得临时切换为 `disabled` 后放行生产上传。
- FFmpeg 或 scanner 故障时保留 durable job，修复 Provider 后等待 lease/retry 收敛；不要手工把
  文件状态改成 `ready`。
- migration 061-063 为 forward-only。应用可回滚到与 expanded schema 兼容的旧 digest；数据库
  回滚只能恢复升级前验证过的备份，不生成 down migration。
- 公网弱网、目标 TURN/Egress、真实 Tinode 多客户端、生产对象存储和 Helm 集群升级未执行时，
  验收状态必须保持 `not_run`。
