# iveKit V3 多模态智能与翻译部署运维手册

更新日期：2026-07-13。本文对应 iveKit V3 的 OCR、ASR、AI 防绕单质检、人工复核、录制源导入和消息/附件翻译。它只描述可复用 iveKit 边界，不包含 SIP/VoLTE、RTMP/HLS、数字人或 OPC call-center 业务编排。

## 1. 交付状态与边界

| 能力 | 代码状态 | 当前验收边界 |
| --- | --- | --- |
| Provider registry | 已完成 | 支持 `self_hosted`、`third_party`、四类 capability、健康探测和脱敏清单 |
| 租户策略 | 已完成 | PostgreSQL 持久化、乐观版本、RBAC、third-party 开关、自动任务开关 |
| 图片 OCR | 已完成 | durable job、对象存储取源、重试、证据链、finding；真实厂商 `not_run` |
| 音频/视频/录屏 ASR | 已完成 | 附件和录制源统一进入 durable job；真实厂商 `not_run` |
| AI 质检 | 已完成 | 文本、OCR、ASR 输入、规则 finding 上下文、AI finding、人审；真实模型 `not_run` |
| 翻译 | 已完成 | 消息/附件、自动/手动、幂等、source hash、防陈旧覆盖、重试和事件 |
| 参考客户端 | 已完成 | Quality 审核队列、翻译工作区、原文保留、失败重试；本机真实浏览器环境验证待服务器执行 |
| 受控 Provider | 已完成 | success、timeout、transient/terminal failure、invalid JSON、oversized response |
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

`OPC_IVEKIT_PROVIDER_PROFILES_JSON` 只保存非敏感路由元数据。token 只放环境变量或 Kubernetes Secret，JSON 中只能写 `token_env` 名称。

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
| OCR | `/v1/ocr` | multipart `file/attachment_id/tenant_id/session_id/message_id/source_ref` | `text`，可选 `confidence/language/provider_request_id/metadata` |
| ASR | `/v1/asr` | multipart `file/attachment_id/tenant_id/session_id/message_id/source_ref` | `text`，可选 `confidence/language/provider_request_id/metadata` |
| 质检 | `/v1/quality-review` | JSON `tenant_id/session_id/message_id/content/content_hash/rule_findings/evidence_refs` | `findings[]`；每项含 policy/severity/confidence/rationale/recommended action |
| 翻译 | `/v1/translate` | `source_ref/text/source_language/target_language` | `translated_text`，可选 `detected_language/confidence/provider_request_id/metadata` |

iveKit 不信任 Provider 的执行建议。AI finding 的业务动作固定进入人工 `review`，模型不能直接封禁、处罚、删除内容或关闭订单。

OCR/ASR 的文件字节由 iveKit 从私有对象存储读取后转发；请求不包含 S3/MinIO 凭据或 `storage_url`，Provider 不应回源 iveKit 数据库或对象存储。

HTTP `408/425/429/5xx`、超时和网络错误可重试；普通 `4xx`、非法 JSON、响应过大、缺字段和非法字段属于终态错误。Provider 返回的原始错误 body 不进入客户端响应。

## 5. 租户策略与 RBAC

策略由 `GET/PUT /api/ivekit/intelligence/policy` 管理。`PUT` 必须携带当前 `version`；版本冲突返回 `409`，防止两个管理员互相覆盖。

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

控制模式：`success|timeout|transient_failure|terminal_failure|invalid_json|oversized_response`。模式切换接口 `/__control/mode` 必须使用独立 control token；该服务只用于隔离验收，不能作为生产 Provider。

健康检查可由 admin 调 `POST /api/ivekit/intelligence/providers/health`。缺 token 返回 `http_class=not_run`，网络/超时不会回显 URL 或 secret。

## 10. 监控与告警

`GET /metrics` 提供 HTTP 延迟/状态和 Node 运行指标。V3 队列状态目前以 PostgreSQL durable job 为权威，部署侧应按 tenant 聚合，禁止在 Prometheus label 中放 message/session/job id。

建议告警：

| 告警 | 建议条件 | 处置 |
| --- | --- | --- |
| Provider unavailable | 连续 3 次 health 为 unavailable | 保持 job，不盲目手工重试；检查 DNS/TLS/token/限流 |
| Provider degraded | 429/5xx 或 p95 超预算 10 分钟 | 降低 batch/副本数，联系供应商或切 profile |
| retry backlog | `retry_wait` 数量或最老年龄持续增长 | 检查 Provider、worker enabled、租约与 QPS |
| stuck processing | `processing` 且 `lease_until < now()` | worker 会自动回收；持续出现则检查进程退出或 timeout/lease 配比 |
| terminal failures | `failed` 比率超过业务阈值 | 按 `error_code/profile_id` 聚合，修复后从 API 重试允许重试的资源 |
| review backlog | pending high severity finding 超 SLA | 通知审核员；不得自动改成 resolved |

当前没有专用 `opc_ivekit_intelligence_*` Prometheus queue gauge；上线监控必须显式配置上述 SQL/日志采集，不能误把只有 HTTP 指标当作完整 worker 可观测性。这是运维实现边界，不影响 durable queue 正确性。

## 11. 故障恢复

1. Provider 故障：不删除 job；保留 worker 或暂时关闭 worker，恢复后按 due 时间继续。
2. worker 崩溃：等待 lease 到期；下一轮自动把过期 `processing` 转为 `retry_wait/failed`。
3. 配置错 profile：先关闭对应 worker，修正 profile/token，运行 preflight/health，更新租户 policy 后再启用。
4. 原文变化：系统按 source hash 取消旧翻译；客户端保留原文并只显示当前 hash 对应结果。
5. 终态 job：附件/录制源使用 retry API；翻译只允许 `failed` job retry，并重新校验 source/policy/profile。
6. 跨租户或 RLS 异常：立即停 worker 和应用写流量；不得通过给 runtime 账号 `BYPASSRLS` 临时修复。

## 12. 升级与回滚

升级顺序：备份数据库；部署包含 043-045 的 migration 镜像；保持新 worker 关闭；执行 migration；部署应用；运行 preflight、health、受控 Provider 契约和 RLS；配置租户 policy；最后逐类启用 worker。

回滚顺序：先把三个 V3 worker 设为 `0`；回滚应用镜像；保留 043-045 新表/列，不执行 destructive downgrade；确认旧应用忽略新增表后恢复原有流量。翻译和智能表可留存供再次升级，禁止 `DROP TABLE`、`down -v` 或复制到 SQLite。

若新版本已经写入 V3 job，旧版本不会消费它们；这属于可控暂停。再次升级后会按 durable 状态恢复。回滚前后都要核对 RLS 未被移除。

## 13. 真实环境验收清单

- self_hosted：模型版本、CPU/GPU、并发、重启恢复、私网 DNS/TLS、准确率和资源上限。
- third_party：区域、DPA/数据留存、限流、账单、超时、429、5xx、证书和 token 轮换。
- OCR：手机号图片、低清、旋转、多语言、超大图和无文字。
- ASR：双方语音、噪声、口音、长录屏、静音、多语言和号码口述。
- AI 质检：规则+模型一致性、误报/漏报、人审 SLA、不可逆动作隔离。
- 翻译：原文保留、语言检测、长文本、附件先提取后翻译、编辑后陈旧结果隔离。
- 多副本：claim 竞争、lease recovery、Provider 限流和事件去重。
- RLS：runtime 账号跨租户读写拒绝，admin migration 账号不进入长驻容器。

在真实 Provider、真实对象存储、多副本和目标网络完成前，报告必须写 `not_run`，不能用 preflight、受控 Provider、MemoryPg 或静态 Compose/Helm 渲染替代。
