# Converact Fabric V6 真实环境验收与采证规范

> 日期：2026-07-22
> 适用范围：Converact Fabric/LED 共享通信底座
> 当前状态：八组真实环境均为 `not_run`

## 1. 用途

本规范用于把真实 Provider、Tinode、LiveKit、RustDesk、Voice、通知、对象存储和 Kubernetes 的验收结果绑定到一个明确 release。它不执行 LED 业务逻辑，也不允许把单元测试、受控 Provider、Playwright、静态配置或模板升级为真实环境证据。

机器可读合同由 `scripts/converact-v6-real-acceptance.ts` 实现。只有通过该校验器的清单才能进入交付归档；通过校验只证明证据结构、来源绑定和哈希一致，最终生产放行仍需人工检查实际观察内容和脱敏结果。

正式交付包把同一校验器复制到 `acceptance/tools/converact-v6-real-acceptance.ts`，并生成 source-bound `acceptance/v6-real-template.json`。两者以及本文档均进入 `manifest.json` 和 `SHA256SUMS`；接收方不得从其他提交复制模板后补录结果。

## 2. 八组矩阵

| Group ID | 验收对象 | 当前状态 | 当前阻断原因 |
| --- | --- | --- | --- |
| `providers` | OCR、ASR、翻译、AI 质检 Provider | `not_run` | 尚无真实凭据、Endpoint、配额和准确率语料 |
| `tinode` | 外部或 bundled Tinode、真实多客户端 | `not_run` | 尚无部署后的真实客户端环境 |
| `livekit_turn_egress` | LiveKit、TURN/UDP/TLS、Egress、双浏览器 | `not_run` | 尚无公网 DNS/证书/媒体节点和真实终端 |
| `rustdesk_windows` | 两台 Windows、RustDesk 1.4.9 Converact Fabric build、文件/录屏/精准断开 | `not_run` | 尚无两台物理 Windows 和已签名制品 |
| `voice_pstn` | RustPBX、SIP、IVR、WebPhone、PSTN、RTP | `not_run` | 尚无真实 trunk、DID 和物理音频环境 |
| `notifications` | 商业邮件、短信、回执与退信 | `not_run` | 尚无商业账号和已验证发件身份 |
| `object_storage` | 生产 S3、生命周期、扫描、隔离、恢复 | `not_run` | 尚无生产对象存储和安全扫描集成 |
| `kubernetes` | Helm rollout、扩缩容、故障、监控、恢复 | `not_run` | 尚无生产等价集群、Ingress、StorageClass 和监控栈 |

## 3. 创建清单

从待验收的完整 Git commit 创建一个全 `not_run` 模板：

```bash
node --import tsx scripts/converact-v6-real-acceptance.ts \
  --mode template \
  --source-commit <40-hex-commit> \
  --manifest /secure/converact-v6-real/report.json
```

输出目录必须是本轮新目录。模板不会创建 `passed`，不会探测或记录任何秘密。

校验清单：

```bash
CONVERACT_FABRIC_ACCEPTANCE_SOURCE_COMMIT=<40-hex-commit> \
node --import tsx scripts/converact-v6-real-acceptance.ts \
  --mode validate \
  --manifest /secure/converact-v6-real/report.json
```

## 4. 真实运行字段

某组从 `not_run` 改为 `passed` 或 `failed` 时，必须同时填写：

- `run_id`：本轮唯一，不能复用历史 run。
- `environment_id`：可稳定识别目标环境，不能写 `staging` 之类模糊占位。
- `deployed_source_commit`：必须等于清单顶层完整 commit。
- `artifact_digest`：必须是实际部署镜像或不可变安装制品的 `sha256:<64-hex>`。
- `started_at/finished_at`：规范 UTC ISO-8601，结束时间不能早于开始时间。
- `operator` 与 `qa_approver`：必须为不同身份。
- `redaction_confirmed=true`：operator 和 QA 已确认 observation 不含秘密或用户内容。
- 至少一项 `checks`；`passed` 组不得包含失败 check，`failed` 组必须至少有一项失败 check。

`not_run` 组只能保留固定 reason code、原因和后续命令，`run=null` 且 `checks=[]`。不能把截图、空日志或受控测试挂在 `not_run` 下暗示已验证。

## 5. Observation 合同

每个 check 使用一个独立 JSON 文件，路径固定为：

```text
evidence/<group_id>/<check_id>.json
```

最小结构：

```json
{
  "schema_version": 1,
  "real_environment": true,
  "controlled": false,
  "redacted": true,
  "group_id": "tinode",
  "check_id": "two_client_native_mutation",
  "source_commit": "<40-hex>",
  "artifact_digest": "sha256:<64-hex>",
  "run_id": "run-tinode-20260716-01",
  "environment_id": "led-staging-cn-1",
  "observed_at": "2026-07-16T09:02:00.000Z",
  "result": "passed",
  "data": {
    "client_count": 2,
    "edit_converged": true,
    "delete_converged": true
  }
}
```

清单中的 `size_bytes` 和 `sha256` 必须与文件完全一致。校验器拒绝绝对路径、目录穿越、符号链接、重复路径、source/run/environment/artifact 不一致、`controlled=true` 以及 secret-like JSON key。Observation 不应包含 token、Authorization、cookie、密码、私钥、原始消息、文件内容、剪贴板正文、按键或屏幕像素。

## 6. 各组执行入口

### 6.1 Providers

```bash
npm run converact:intelligence-preflight
npm run converact:provider-governance-acceptance
```

至少验证真实 OCR/ASR/翻译/AI 质检的健康、正确率、延迟、429/5xx、配额、熔断、降级、数据区域和删除策略。受控 HTTP Provider 只能作为自动化合同，不能用于此组。

### 6.2 Tinode

```bash
npm run tinode:deployment-preflight
npm run smoke:chat:tinode
```

至少验证两个原生 Tinode 客户端与 Converact Fabric SDK 的消息收发、附件、receipt/presence/typing、编辑 replacement、删除、乱序、断网恢复、dead-letter replay 和租户隔离。bundled Helm 只允许单副本；高可用使用外部 Tinode 集群。

### 6.3 LiveKit/TURN/Egress

```bash
npm run livekit:deployment-preflight
npm run livekit:server-evidence
npm run livekit:client-acceptance
```

至少验证双浏览器摄像头/麦克风、屏幕共享、重连、强制 TURN/UDP、TURN/TLS、RTC/TCP、Egress 写入、QoS degraded/recovered、录制保留和跨租户拒绝。

### 6.4 RustDesk Windows

```bash
npm run rustdesk:deployment-preflight
npm run rustdesk:server-evidence
npm run rustdesk:client-acceptance
```

两台物理 Windows 必须安装同一 digest 的 `rustdesk-1.4.9-ivekit*-x86_64.exe`。Windows package manifest `package_version` 必须为 6；启用 Cell placement 时安装制品必须声明 `ivekit-rustdesk-native-control-v2` 与 `rustdesk-native-evidence-v1`，并验证 stale epoch 在 native close、operation observation 和 evidence upload 之前被拒绝。v1 只允许用于 placement 明确关闭的滚动兼容包。验收覆盖画面、键鼠、剪贴板、文件、多显示器、录屏、UAC、重连、owner handoff、指定会话精准断开及同机其他会话不受影响。

文件/录屏必须由定制 RustDesk allowlist scanner 在基线后自动产出稳定新文件候选，经 device-token evidence context 唯一关联 controller/operation/文件名/时间窗，再由 watcher/uploader 进入 secure-file。`Publish-IveKitRustDeskEvidence.ps1` 仅用于故障恢复。检查病毒/MIME/隔离/衍生物/OCR/ASR/AI 状态事件与原 operation ID 一致；验证无匹配、多匹配、路径逃逸、链接和复制期间变化均不上传。未被自动链路捕获或未上传的原生内容仍是 `native_unscanned/local_only`。

### 6.5 Voice/PSTN

```bash
npm run converact:voice-preflight
npm run converact:voice-acceptance
npm run converact:rustpbx-sipp-acceptance
```

按 Voice runbook 验证真实 trunk、DID、呼入呼出、REGISTER、WSS/SDP/ICE/RTP、DTMF、Hold/Transfer、IVR、录音、PSTN-LiveKit bridge、失败码、恢复和物理音频。

### 6.6 Notifications

使用真实 SMTP/Email HTTP/SMS HTTP Endpoint 创建通知，保存请求的安全摘要和 Provider 回执状态，不保存地址、正文或 Provider 原始响应。验证成功、永久失败、429、重试、死信、退信/回执、配额、熔断和 Webhook 签名。完成 observation 后运行总清单 validator。

### 6.7 Object Storage

```bash
npm run attachment:deployment-preflight
npm run quality:deployment-preflight
```

在生产 S3 等价环境验证 multipart/resume、checksum、magic MIME、ClamAV/HTTP scanner、quarantine、thumbnail/transcode、生命周期、legal hold、对象先删、备份 inventory 和恢复校验。

必须额外执行实时通信隔离演练：先建立一通 SIP 语音和一个 LiveKit 视频/屏幕共享会话，再阻断
Egress/录音上传侧到对象存储的网络或停止对象存储服务。观察期间既有 SIP dialog、RTP/SRTP、
LiveKit publisher/subscriber track 不得断开，媒体时延和丢包不得因同步重试出现突增；录音状态必须
转为失败、延迟或不完整并产生告警，不能伪装成功。恢复对象存储后验证 durable spool/multipart
按策略续传或进入人工处置，且不得通过重建实时房间来“恢复”录音。保存开始故障、媒体连续性、
录音失败事件、恢复和最终对象校验五段时间戳。当前本机结果不替代这项生产等价演练。

### 6.8 Kubernetes

先对 release values 执行 `helm lint/template`，再在目标集群执行 `helm upgrade --install`。检查 migration hook、API/Tinode/RustPBX、Secret ref、PVC、PDB、HPA、NetworkPolicy、ServiceMonitor、滚动升级、节点故障、扩缩容、备份与回滚。不得使用模板渲染代替实际 rollout observation。

## 7. 当前发布判断

截至 2026-07-16，本地代码、部署模板和自动化合同可以继续收敛，但上述八组没有真实外部资源，因此全部保持 `not_run`。这不会把代码完成状态降为失败，也不能被解释为生产验收完成。
