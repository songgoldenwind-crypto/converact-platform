# Wave 3 AI 语音 Provider 故障切换服务器验证证据

> 日期：2026-07-23
> 环境：`root@64.225.122.227`
> 源码目录：`/opt/opc-wave123-validation-20260722/source`
> 范围：LiveKit Agents STT/LLM/TTS Provider 链、超时、可用性指标和部署合同
> 容量声明：`capacity_claim=none`

## 1. 验证结论

本轮在服务器验证了以下代码与部署合同：

1. STT、LLM 和 TTS 使用 LiveKit Agents `1.6.6` 官方 `FallbackAdapter`，按显式、去重且最多四个
   候选的顺序运行。
2. 未配置 URL 或 API key 的候选不会进入运行链；整条链没有可用候选时启动失败，不会伪装成可用。
3. 每个候选禁用内部重复重试，默认 STT/LLM/TTS 尝试上限为 `2000/1200/1500 ms`。LLM 已输出
   token 或 TTS 已输出音频后不跨 Provider 重放，避免重复回答和混合音色。
4. CosyVoice HTTP 客户端不再使用独立的 60 秒超时，而是继承 AgentSession 的 TTS 尝试上限。
5. Provider 可用性变化通过 loopback-only 非阻塞 UDP 汇聚为
   `opc_ai_voice_provider_transitions_total{capability,provider,state}`；标签只来自固定 allowlist。
6. Compose 和 Kubernetes 均提供候选顺序、尝试上限和不可恢复错误阈值；Kubernetes Provider
   凭据只通过既有 Secret 引用进入 Pod。
7. Provider 指标、Prometheus 或告警链故障只允许丢失观测，不进入媒体或 Provider 等待链。

本轮不证明真实厂商或自建 Provider 已可用，也不证明真实媒体、故障切换时延、P95/P99 或容量。

## 2. 固定输入

| 输入 | 值 |
| --- | --- |
| Python 基础镜像 | `python:3.12-slim@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de` |
| LiveKit Agents | `1.6.6` |
| Helm | `alpine/helm@sha256:e7ecbf4a200dea73d64bfb8cb0936829164945f2b4d02a0274093073ee8d264f` |
| Prometheus | `prom/prometheus@sha256:69f5241418838263316593f7274a304b095c40bcf22e57272865da91bd60a8ac` |
| pytest / pytest-asyncio | `9.0.2` / `1.4.0` |

## 3. 默认运行策略

| 能力 | 主 Provider | 后备顺序 | 单次上限 |
| --- | --- | --- | ---: |
| STT/ASR | `funasr` | `deepgram,openai` | 2000 ms |
| LLM | `primary` | `deepseek` | 1200 ms |
| TTS | `cosyvoice` | `cartesia,openai` | 1500 ms |

这些值是可配置的实时保护边界，不是已经测得的厂商延迟。默认每个候选 `max_retry=0`，避免
AgentSession、adapter 和 Provider SDK 三层重试叠加。

## 4. 服务器结果

| 检查 | 结果 |
| --- | --- |
| Python 聚焦回归 | `14 passed in 3.35s` |
| Python 全量回归 | `63 passed in 5.61s` |
| Node 部署合同 | `4 passed` |
| TypeScript | `tsc --noEmit` 退出码 `0` |
| Compose | call-center 与 production `config --no-interpolate --quiet` 均退出 `0` |
| Helm | 生产必填值和不可变 digest 门禁下，AI Agent Provider env、ServiceMonitor 与 PrometheusRule 渲染成功 |
| Prometheus | 配置有效，发现 1 个 rule file、10 条规则 |
| 严格镜像运行 | `--network none --read-only --security-opt no-new-privileges --cap-drop ALL` 下 `63/63` |
| VAD 预热冒烟 | 同一严格容器约束下 `silero.VAD.load()` 成功 |
| 运行身份 | 固定用户 `ai-agent`，UID/GID `10001:10001` |
| 候选镜像 | `sha256:0f83a1c0814365dddff5d3d917751a9f6928e8a06c359f39d50b122664c8a74b`，369,173,833 bytes |
| LED 隔离 | 既有 7 个 LED 容器保持运行，无 OPC 验证容器遗留 |

## 5. 故障语义

- STT 可以在没有 final transcript 前切换；非流式 STT 由官方 adapter 配合同一个 VAD 包装。
- LLM 只有在尚未向会话交付 token 时切换。
- TTS 只有在尚未交付音频时切换；已经产生音频后保持当前输出，不拼接后备音色。
- Provider 进入 unavailable 会触发低基数 transition counter；恢复后记录 available。
- 所有候选失败时，错误交给 AgentSession 的不可恢复错误门限处理，不允许无限重试。

## 6. 保留的 `not_run`

- 真实 third-party/self-hosted ASR、LLM 和 TTS 凭据及请求；
- 真实 429、连接拒绝、DNS、超时、慢首包、断流和区域故障注入；
- 真实 SIP/RustPBX/LiveKit 音频中的切换、重复内容检查和主媒体连续性；
- 多副本滚动、Provider Secret 轮换、告警投递和人工接管；
- 真实 P50/P95/P99、长稳、单机 frontier、Cell-10K 和 MIX-100K。

因此本轮状态是 `implemented_controlled_server`，不是 Provider 或生产性能验收完成。
