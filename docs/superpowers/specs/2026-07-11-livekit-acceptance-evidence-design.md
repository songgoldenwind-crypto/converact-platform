# LiveKit 真实环境验收与证据链设计

> 状态：代码已实现并完成本地验证；真实环境证据待执行
>
> 日期：2026-07-11
>
> 约束更新：验收工具先在本地实现；2026-07-11 已完成目标服务器 SSH 与资源的只读盘点，尚未上传、部署或修改服务。真实执行仍需域名、DNS 和部署位置确认。

## 1. 背景

iveKit Media Core 已具备 LiveKit 房间、Token、Join Plan、参与人、Webhook、音视频、屏幕共享、Web Assist、Egress 录制、对象检查、受控导出和 retention；生产边缘也已具备独立 Linux VM 与外置 Kubernetes 接入方案。

当前仍缺少一条严格、可归档、可交给部署/QA/LED 研发执行的真实验收证据链。现有能力包括：

1. `livekit:deployment-preflight`：离线检查环境变量与部署模式。
2. `smoke:media`：检查房间、Join、参与人、录制和对象接口。
3. `smoke:media:browser`：检查两个坐席浏览器视频和可选屏幕共享。
4. `smoke:media:customer-browser`：检查客户 H5 加房。
5. `smoke:media:web-assist-browser`：检查远协屏幕共享。
6. `smoke:media:readiness`：按目标串行执行上述 smoke。

这些脚本能执行动作，但还存在以下证据缺口：

- readiness 只向 stdout 输出，缺少固定、脱敏的 JSON artifact。
- 没有自动采集 signal/turn DNS、可信 TLS、RTC TCP、TURN/RTC UDP 发包和内部健康证据。
- 没有记录真实 ICE candidate 类型、强制 relay、声音/画面质量和操作者观察的结构化模板。
- 没有把 Egress 对象、受控导出、checksum、Webhook、租户隔离、LED SDK 串联、恢复和性能纳入统一门禁。
- 没有最终 evidence pack 判断必需文件是否存在、内容是否通过、是否仍是占位值。
- 因此无法只凭一份可审计产物判断“可以交付”还是“仍缺真实环境证据”。

## 2. 目标

本设计新增 LiveKit 专用验收工具链：

1. 把 readiness 结果写成不包含 token、签名链接或原始 stdout 的 JSON 报告。
2. 自动采集服务器侧 DNS、TLS、TCP、UDP 发包和健康检查证据。
3. 生成真实浏览器、录制、隔离、恢复、性能与 LED 对接验收模板和操作 runbook。
4. 严格验证人工报告：每项必须通过、必须有具体证据、不得保留占位文本，且必须声明来源为真实环境。
5. 汇总 preflight、server evidence、readiness 和 client acceptance，只有全部通过才输出 `ready_for_customer_review`。
6. 生成一个可整体交给部署、QA 和 LED 研发的 acceptance bundle。
7. 当前不执行网络探针，不制造真实环境报告，不把模板或 fake probe 单测写成生产通过。

## 3. 非目标

- 不替代 LiveKit Server、Egress、SIP 或客户端 SDK。
- 不重新实现现有 smoke 的业务动作。
- 不在当前阶段连接真实服务器。
- 不把 UDP `send()` 成功描述为 ICE/TURN 协议成功。
- 不把 Playwright DOM 出现单独描述为音视频质量通过。
- 不把数字人纳入 Media Core 第一版必需证据。
- 不处理 Tinode、RustDesk、OCR、ASR 和 AI 质检的专用证据包；它们使用各自工具链。

## 4. 四层证据模型

### 4.1 Layer A：离线部署预检

来源：`livekit:deployment-preflight`。

证明：

- 内部 `LIVEKIT_URL` 和浏览器 `LIVEKIT_PUBLIC_URL` 的配置形态。
- production 公网地址使用 `wss://`。
- API key/secret、Media API token、邀请签名、对象存储配置已填写且不是已知占位值。
- standalone VM 的 signal/turn 域名、ACME 邮箱和固定镜像 tag 合法。

不证明：DNS、证书、端口、容器、浏览器或对象真实可用。

### 4.2 Layer B：服务器自动证据

来源：新增 `livekit:server-evidence`。

自动检查：

- signal 和 turn 域名分别解析。
- signal `443/tcp` 和 turn `443/tcp` 可连接。
- 两个域名的 TLS 握手通过系统信任链、hostname 校验和有效期检查。
- RTC TCP 端口可连接。
- TURN UDP 与 RTC UDP 采样端口可以从证据采集机发包。
- 公网 signal HTTPS health 可响应。
- 可选内部 LiveKit HTTP health 可响应。

UDP 结果字段必须命名为 `udp_probe_sent`，details 必须说明它不证明 ICE/TURN handshake。

### 4.3 Layer C：自动 readiness

来源：现有 `smoke:media:readiness`，新增 `OPC_VIDEO_READINESS_REPORT_FILE`。

持久化报告只保存：

- schema version、运行时间、整体状态。
- 每个 target 的 command、exit code、duration、通过状态。
- stdout/stderr 的 SHA-256 和脱敏错误摘要。
- 不保存原始 stdout、LiveKit token、JWT、API key、signed invite 或 query string。

Media Core 客户交付必需 target：

- `media`
- `agent-browser`
- `customer-browser`
- `web-assist-browser`
- `sip-volte`

其它 `avatar`、`ai-callback`、`collaboration` 可作为扩展证据，但不替代上述 target。

### 4.4 Layer D：真实客户端与人工观察

来源：新增 `livekit:client-acceptance`。

报告必须声明：

- `source=real_environment`
- environment ID、deployment mode、deployed commit、operator、checked_at。
- signal/turn 域名与部署版本。
- 每个必需 check 的 `passed=true` 和非空、非占位 evidence。

必需检查组：

| Group | Required evidence |
| --- | --- |
| deployment | LiveKit/Egress/Redis/Caddy or official Helm workload healthy; versions match; storage private/persistent |
| network | trusted WSS; direct ICE/UDP; ICE/TCP fallback; forced TURN/UDP; forced TURN/TLS |
| media | two-browser audio/video; screen share; customer join; Web Assist; reconnect |
| recording | Egress complete; object non-empty/readable; controlled export/checksum; webhook idempotency |
| lifecycle | participant join/leave; room close; closed room rejects new join |
| isolation | cross-tenant API denied; PostgreSQL RLS context verified |
| LED | HTTP SDK room/join flow; business_ref and tenant traceability |
| resilience | media restart reconnect; Redis recovery; multi-replica routing/draining |
| performance | configured concurrency reached; join p95, packet loss and error rate recorded and within declared targets |
| SIP | real inbound and outbound bridge with audio confirmed |

报告不允许 `todo`、`n/a`、`replace-with-*`、`fake`、`mock`、`local-only` 等文本作为通过证据。

## 5. Artifact 契约

Acceptance bundle 目录包含：

| File | Generated locally | Required for final ready |
| --- | --- | --- |
| `env-checklist.md` | yes | yes |
| `preflight.json` | yes, may fail | yes, `ok=true` |
| `server-evidence.json` | placeholder path only | yes, `ok=true` |
| `readiness.json` | placeholder path only | yes, `ok=true` and required targets pass |
| `client-acceptance-template.json` | yes | filled report must pass validator |
| `client-acceptance-result.json` | no, generated after validation | yes, `ok=true` |
| `server-runbook.md` | yes | yes |
| `client-acceptance-runbook.md` | yes | yes |
| `evidence-pack.md` | yes, initially incomplete | yes, final status ready |
| `manifest.json` | yes | yes |

每个 artifact 在 evidence pack 中记录 size、line count、SHA-256 和 path。Evidence pack 不嵌入原始 artifact 内容或 secret。

## 6. Server Evidence Schema

```json
{
  "schema_version": 1,
  "ok": false,
  "checked_at": "2026-07-11T00:00:00.000Z",
  "topology": "standalone-vm",
  "summary": {
    "signal_dns_resolved": false,
    "turn_dns_resolved": false,
    "signal_tls_valid": false,
    "turn_tls_valid": false,
    "signal_health_reachable": false,
    "internal_health_reachable": false,
    "rtc_tcp_reachable": false,
    "turn_udp_probe_sent": false,
    "rtc_udp_probe_sent": false
  },
  "checks": []
}
```

报告只保存 host、port、证书非敏感 metadata、状态和错误，不保存 URL userinfo、query、fragment、token 或 secret。

## 7. Readiness Artifact Schema

```json
{
  "schema_version": 1,
  "ok": true,
  "checked_at": "2026-07-11T00:00:00.000Z",
  "steps": [
    {
      "target": "media",
      "command": "npm run smoke:media",
      "ok": true,
      "exit_code": 0,
      "duration_ms": 1000,
      "stdout_sha256": "...",
      "stderr_sha256": "...",
      "error_summary": ""
    }
  ]
}
```

### 7.1 失败写入

即使 readiness 抛出 `VideoReadinessSuiteError`，也必须写出 partial report，便于定位第一个失败 target 和已经完成的步骤。

### 7.2 脱敏

- stdout/stderr 原文不进入 artifact。
- error summary 移除 URL query、Bearer/JWT、常见 secret assignment。
- SHA-256 用于证明运行输出存在且后续没有悄悄变化，不用于恢复原文。

## 8. Client Acceptance Schema

模板顶层：

```json
{
  "schema_version": 1,
  "source": "real_environment",
  "environment_id": "replace-with-environment-id",
  "deployment_mode": "standalone-vm",
  "deployed_commit": "replace-with-40-char-git-sha",
  "operator": "replace-with-operator",
  "checked_at": "",
  "versions": {},
  "checks": {},
  "performance": {}
}
```

性能字段至少包括：

- `target_concurrent_rooms`
- `observed_concurrent_rooms`
- `target_participants_per_room`
- `observed_participants_per_room`
- `join_p95_ms`
- `packet_loss_pct`
- `error_rate_pct`
- `passed`
- `evidence`

Validator 要求 target/observed 为正整数，observed 不低于 target，百分比为 0-100，`passed=true` 且 evidence 合法。具体性能阈值由项目/客户填写，工具不擅自伪造业务目标。

## 9. Evidence Pack 完成门禁

状态只有：

- `incomplete`
- `ready_for_customer_review`

`ready_for_customer_review` 同时要求：

1. 所有 required artifact 存在并可读。
2. preflight `ok=true` 且没有 fail check。
3. server evidence `ok=true` 且必需 summary 全为 true；可选 internal health 只有配置时才要求。
4. readiness `ok=true` 且所有必需 target 都有成功 step。
5. client acceptance validator `ok=true`。
6. 不存在 JSON 解析错误、占位字段或缺失证据。

Evidence pack 的 ready 只表示证据满足交付审查门禁，最终生产上线仍由部署负责人、QA 与业务负责人共同签字。

## 10. 命令

```bash
npm run livekit:acceptance-bundle
npm run livekit:server-evidence
npm run smoke:media:readiness
npm run livekit:client-acceptance
npm run livekit:evidence-pack
```

Bundle manifest 固定记录每一步的标准环境变量和输出路径，避免同一轮验收使用不同报告文件。

## 11. 安全

1. 生成器和 evidence pack 不输出 key、secret、JWT、signed invite 或对象存储凭据。
2. 报告中的 URL 只保留 scheme/host/port/path，移除 userinfo/query/fragment。
3. 人工 evidence 是描述和外部证据引用，不应粘贴 access token。
4. Artifact 默认写到用户指定目录，不提交 Git。
5. Bundle 初始状态必须是 `awaiting_real_environment_evidence`，evidence pack 必须是 `incomplete`。
6. fake probes 仅用于单元测试，不得生成 `source=real_environment` 的可交付报告。
7. 每轮 bundle 使用唯一 `run_id`，并绑定 `environment_id`、完整 Git SHA 和部署 SHA-256 指纹；preflight、server、readiness、client report/result 必须完全一致且时间跨度不超过 24 小时。
8. 客户端 passed check 不接受自由文本。每项必须使用独立 artifact，并提供 `artifact_file`、完整 SHA-256、`captured_at`、采集工具和同一 `run_id`；artifact 本身必须是 JSON，声明唯一 `check_id`、run/environment/commit/mode/fingerprint、时间和该检查专属 details schema，validator 会解析并重新计算摘要。
9. client report 必须有不同于执行人的 QA approver、24 小时内的 attestation 时间和独立 attestation JSON；attestation 的批准决策和 preflight/server/readiness/31 份 client evidence 哈希清单必须由 Ed25519 签名。validator 同时校验受信任公钥文件与预配置公钥 SHA-256 指纹，QA artifact 不能与普通检查复用。
10. bundle 不允许复用已经含 server/readiness/client-result 的目录，防止新旧验收混用。

## 12. 验证

本地完成定义：

- 所有生成器、validator 和 evidence pack 有成功/失败/占位/脱敏测试。
- readiness success/error 都能写脱敏 artifact。
- bundle 在没有真实证据时稳定返回 incomplete，而不是异常或误报 ready。
- TypeScript、全量 Node、前端、AI Agent、sidecar、Compose 和 `git diff --check` 通过。

真实完成定义仍要求在服务器和真实客户端生成全部 required artifact，并由 final evidence pack 输出 `ready_for_customer_review`。

## 13. 实现状态（2026-07-11）

以下代码级工作已完成：

1. `smoke:media:readiness` 可写脱敏 JSON，只记录状态、耗时和 stdout/stderr 哈希。
2. `livekit:server-evidence` 采集 DNS、可信 TLS、内外健康、RTC TCP 和 UDP 发包证据，并明确 UDP 发包不等于 ICE/TURN 成功。
3. `livekit:client-acceptance` 生成并严格验证 30 项真实环境检查及性能字段；passed 项必须引用实际可读且 SHA-256 匹配的 artifact，并要求独立 QA attestation，拒绝自由文本、占位、fake/mock/local-only 和疑似密钥。
4. `livekit:evidence-pack` 重新校验各报告并生成只含元数据、哈希和缺口的最终索引。
5. `livekit:acceptance-bundle` 一次性生成清单、runbook、空白模板、manifest 和初始 `incomplete` evidence pack，不伪造三份真实执行产物。
6. 代码审查后补齐 fail-closed：错误 schema、缺失 `ok`、`ok=true` 但含 fail check、缺少 preflight ID、readiness persisted step 字段不完整、client result 与重新计算结果不一致、跨 run/环境/commit/mode/指纹、旧/未来或跨 24 小时证据都会拒绝 ready；Markdown 保存完整 64 位 SHA-256。

当前目标服务器已确认 Ubuntu 24.04、Docker/Compose 可用，4 CPU、约 8 GiB 内存、约 145 GiB 可用磁盘；现有 LED 栈占用 80/3001/4000，443、3478、5349、6379、7880、7881、8091、9000 当前未占用。该盘点只证明具备第一版低并发联调条件，Egress 与性能目标仍须实测；云防火墙、域名、DNS、证书和与 LED 反向代理的共存方案尚未确认。
