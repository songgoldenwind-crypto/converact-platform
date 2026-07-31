# Wave 3 AI 语音分段延迟服务器验证证据

> 日期：2026-07-23
> 环境：`root@64.225.122.227`
> 源码目录：`/opt/opc-wave123-validation-20260722/source`
> 范围：LiveKit Agents turn metrics、UDP 跨进程聚合、Prometheus、部署合同与 AI Agent 镜像
> 容量声明：`capacity_claim=none`

## 1. 验证结论

本轮在服务器验证了以下代码合同：

1. 已提交的用户/助手消息可以产生 ASR final、end-of-turn、LLM 首 token、TTS 首音频和
   speech-to-speech 五段延迟。
2. 指标只有固定 `stage` 和 `media_source` 标签，不包含 tenant、call、room、participant 或文本。
3. LiveKit job 子进程使用 loopback-only 非阻塞 UDP 上报；每个报文不超过 4 KiB，最多五条观测。
4. worker 父进程更新普通 Prometheus Registry，并通过 `9090/metrics` 供 Compose/ServiceMonitor 抓取。
5. UDP、collector 或 Prometheus 故障只允许丢失监控样本，不进入媒体或 Provider 等待链。
6. AI Agent 镜像和 Kubernetes Pod 以固定非 root 身份运行，并可在只读根文件系统下执行测试。

本轮不证明真实 Provider、真实媒体、真实 P50/P95/P99、容量或生产 SLA。

## 2. 固定输入

| 输入 | 值 |
| --- | --- |
| Python 基础镜像 | `python:3.12-slim@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de` |
| LiveKit Agents | `1.6.6`，来自锁文件和实际运行镜像 |
| Helm | `alpine/helm@sha256:e7ecbf4a200dea73d64bfb8cb0936829164945f2b4d02a0274093073ee8d264f` |
| Prometheus | `prom/prometheus@sha256:69f5241418838263316593f7274a304b095c40bcf22e57272865da91bd60a8ac` |
| pytest / pytest-asyncio | `9.0.2` / `1.4.0` |

LiveKit 字段语义参考官方 Data hooks 文档：
`https://docs.livekit.io/deploy/observability/data/`。

## 3. 指标与预算

| Stage | LiveKit 字段 | P95 预算 |
| --- | --- | ---: |
| `asr_final` | `transcription_delay` | 350 ms |
| `end_of_turn` | `end_of_turn_delay` | 500 ms |
| `llm_first_token` | `llm_node_ttft` | 350 ms |
| `tts_first_audio` | `tts_node_ttfb` | 300 ms |
| `speech_to_speech` | `e2e_latency` | 1200 ms |

Prometheus 指标：

- `opc_ai_voice_stage_latency_seconds{stage,media_source}`；
- `opc_ai_voice_latency_budget_exceeded_total{stage,media_source}`。

`llm_node_ttft` 与 `tts_node_ttfb` 只在独立 STT-LLM-TTS pipeline 有意义；realtime model 缺失这些字段
时不会伪造样本。

## 4. 服务器结果

| 检查 | 结果 |
| --- | --- |
| Python 聚焦回归 | `23 passed` |
| Python 全量回归 | `54 passed in 4.93s` |
| Node 部署合同 | `3 passed` |
| TypeScript | `tsc --noEmit` 退出码 `0` |
| Compose | call-center 与 production `config --no-interpolate --quiet` 均退出 `0` |
| Helm | AI Agent Deployment、Service、ServiceMonitor、PrometheusRule 渲染成功 |
| Prometheus | 配置有效，发现 1 个 rule file、9 条规则 |
| 严格镜像运行 | `--network none --read-only --security-opt no-new-privileges --cap-drop ALL` 下全量测试通过 |
| VAD 预热冒烟 | 同一严格容器约束下 `silero.VAD.load(sample_rate=16000, force_cpu=True)` 成功 |
| 运行身份 | UID/GID `10001:10001` |
| 候选镜像 | `sha256:1aa05385c424d1e23d5e63f4db8ee4b7d545e0929b8b53446ef2744fceb16f78`，369,169,680 bytes |
| LED 隔离 | 既有 7 个 LED 容器保持运行，无 OPC 验收容器遗留 |

## 5. 发现并关闭的缺陷

最初候选镜像 `Config.User` 为空，会以 root 启动，因此未被接受。修复包括：

- Dockerfile 创建固定 UID/GID `10001` 的 `ai-agent` 用户并切换 `USER ai-agent`；
- Pod 禁止自动挂载 ServiceAccount token；
- Pod 强制 `runAsNonRoot`、`RuntimeDefault` seccomp；
- container 禁止提权、只读根文件系统并 drop 全部 capability；
- `/tmp` 使用 256 MiB memory `emptyDir`，避免安全加固破坏 Python/LiveKit 临时文件。

修复后的候选镜像在上述严格约束下完成全量回归。

## 6. 保留的 `not_run`

- 真实 third-party/self-hosted ASR、LLM 和 TTS；
- 真实 SIP/PSTN/RustPBX/LiveKit 音频；
- Provider 429、超时、断流、区域故障和自动 failover；
- 弱网、主媒体连续性、P50/P95/P99 和长稳；
- 单机性能边界、Cell-10K 和 MIX-100K。

因此本轮状态为 `implemented_controlled_server`，不是生产性能验收完成。
