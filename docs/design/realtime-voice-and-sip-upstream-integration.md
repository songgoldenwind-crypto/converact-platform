# 实时语音机器人与 SIP 上游项目融合设计

更新日期：2026-07-22

## 1. 目标与结论

本设计解决两个问题：一是降低电话、视频机器人从用户停顿到首段语音响应的延迟；二是在不侵入 SIP/RTP 热路径的前提下补足信令、媒体质量和报表观测。

最终裁决不是把四个项目整套拼入 iveKit，而是按 authority 和性能边界吸收：

| 上游项目 | 裁决 | iveKit 用法 | 当前状态 |
| --- | --- | --- | --- |
| AVA AI Voice Agent for Asterisk | 吸收流水线机制，不引入 Asterisk/ARI 控制面 | VAD、barge-in、提前生成、流式 LLM/TTS、陈旧输出取消、最终可听文本 | 已在 LiveKit Agents 运行时落地第一版 |
| SIPhon | 同机同口径 POC，不替换现有组件 | 评估 Rust SIP 信令密度；借鉴 Python policy、HEP、RTPengine、SIPREC 和热加载机制 | 仅进入基准候选 |
| sip-exporter | 可选旁路集成 | eBPF 被动采集 SIP/RTP Prometheus 指标 | Helm DaemonSet 已实现，默认关闭，待服务器证据 |
| CCS-CallReport | 不引入代码 | 仅参考报表字段 | 已拒绝直接集成 |
| Pipecat | 吸收 frame、interruption 和 latency 机制 | 作为 LiveKit Agents 的设计对照，不建立第二机器人运行时 | 参考项 |

LiveKit Agents 继续是机器人会话、媒体参与人、turn、tool、interruption 和 transcript 的唯一运行时。RustPBX 继续拥有电话 B2BUA、IVR 和 RTP；Kamailio 继续拥有 SIP Edge、dispatcher、dialog affinity 和 WSS；OPC/iveKit 继续拥有租户、会话、审计、Provider 和业务 API。

## 2. 为什么不整套搬入 AVA 或 Pipecat

AVA 的 Asterisk AudioSocket/ExternalMedia 和 ARI 会话控制适合 Asterisk 项目，但 iveKit 已有 RustPBX、LiveKit SIP 和 LiveKit Agents。整套引入会造成两份：

- call/session 生命周期；
- VAD 和 turn 判断；
- STT/LLM/TTS Provider 选择；
- barge-in 和取消状态；
- transcript 与审计写入；
- 失败恢复和容量调度。

Pipecat 的 frame pipeline 很成熟，但同样会和 LiveKit Agents 重复拥有 turn 和 agent session。第一阶段应把它们已证明有效的机制实现到现有运行时；只有同机基准证明 LiveKit Agents 无法达到目标，并且问题不能通过插件或局部 fork 修复时，才重新评审运行时替换。

## 3. 目标架构

```text
PSTN/SIP/WebRTC caller
        |
Kamailio -> RustPBX / LiveKit SIP -> LiveKit room
                                      |
                              LiveKit Agent worker
                                      |
        +-----------------------------+-----------------------------+
        |                             |                             |
   streaming STT                 streaming LLM                 streaming TTS
   external/self-hosted         external gateway              external/self-hosted
        |                             |                             |
        +---------- bounded turn/interruption pipeline ------------+
                                      |
                         LiveKit audio output + heard text
                                      |
                    OPC transcript / latency / audit projection

Off path:
Kamailio HEP -> HOMER                 host interface -> sip-exporter -> Prometheus
recording/evidence -> batch ASR/OCR/translation/quality workers -> PostgreSQL/ClickHouse
```

任何 ASR、LLM、TTS、OCR、HOMER、Prometheus 或存储故障都不得终止既有 SIP dialog、RTP、LiveKit room 或 SFU 转发。

## 4. 低延迟语音流水线

### 4.1 已实现机制

`services/ai-agent-py/realtime_pipeline.py` 定义了 Provider 无关的运行策略：

1. Silero VAD 在 worker `prewarm_fnc` 中加载一次，不再为每个呼叫重新加载模型；
2. 电话默认 endpointing 为 350 ms，WebRTC 为 250 ms，租户调参被硬边界限制；
3. 默认开启 barge-in 和 false-interruption resume；
4. 默认开启 preemptive LLM generation，preemptive TTS 仅显式开启，防止为仍在变化的输入浪费合成；
5. 使用 LiveKit Agents 1.6.6 的 `conversation_item_added` 和 `agent_state_changed`；
6. assistant 被打断后写入 LiveKit 已裁剪的实际可听文本，不把未播放内容冒充成已告知用户；
7. 客户 STT confidence、end-of-turn latency 和 assistant speech-to-speech latency进入 OPC turn projection；
8. 直接依赖和 80 个传递依赖均由 exact requirements 与 `requirements.lock` 固定。

### 4.2 延迟预算

| 阶段 | P95 预算 | 说明 |
| --- | ---: | --- |
| end-of-turn 判定 | 500 ms | 用户停止说话到 turn commit |
| ASR final | 350 ms | 流式 ASR 在尾音结束后的 final 延迟 |
| LLM first token | 350 ms | 尽量通过 preemptive generation 与连接复用降低 |
| TTS first audio | 300 ms | 必须使用流式 TTS，不等待完整回答 |
| speech-to-speech | 1200 ms | 用户停止到机器人首个可播放音频 |

这些数值是验收目标，不是假定已达到。必须由真实 Provider 和真实 SIP/LiveKit 媒体链路输出 P50/P95/P99。

### 4.3 Provider 选择和连接复用

当前 selector 支持：

- STT：FunASR OpenAI-compatible、Deepgram、OpenAI；
- TTS：CosyVoice、Cartesia、OpenAI；
- LLM：OpenAI-compatible primary 与 DeepSeek fallback；
- 外部实时字幕/翻译：`RealtimeSpeechTranslationProviderPort`；
- 离线 ASR/OCR/翻译/质检：统一 Provider registry、健康、配额、熔断和 failover。

下一实现批次要把“按请求新建连接”收敛为按 worker/provider/profile 的有界连接池，并完成：

- DNS/TLS/HTTP2/WSS 连接预热；
- 每个 Provider 的最大并发与排队预算；
- session 取消时同时取消 STT、LLM 和 TTS 陈旧输出；
- LLM sentence/chunk 一产生即可送入 TTS；
- TTS PCM 直接进入 LiveKit audio source，禁止写临时文件；
- 429、超时和连接断开按阶段执行 fallback，媒体本身继续。

### 4.4 房间元数据合同

```json
{
  "tenant_id": "tenant-a",
  "call_session_id": "call-123",
  "media_source": "sip",
  "language": "zh",
  "voice_runtime": {
    "endpointing_min_ms": 350,
    "endpointing_max_ms": 1500,
    "interruption_min_ms": 350,
    "false_interruption_timeout_ms": 1000,
    "preemptive_generation": true,
    "preemptive_tts": false
  }
}
```

运行时会限制所有数值范围。业务方不能通过 metadata 关闭租户隔离、无限排队、无限重试或绕过 Provider 治理。

## 5. 实时翻译、离线质检和 OCR

实时电话和视频音轨通过非阻塞 tap 进入外部实时 ASR/翻译：

```text
decoded PCM/audio track -> bounded memory queue -> WSS/TLS gRPC Provider
  -> transcript.partial/final -> translation.partial/final -> caption projection
```

`tryWriteAudio` 只能返回 accepted、dropped_overflow 或 closed。Provider 变慢时丢弃旁路帧或重建 session，不允许反压 RTP/SFU。

录音、录像和语音附件走 durable batch ASR，返回 speaker、segment/word timestamp、language 和 confidence；聊天图片、视频抽帧、屏幕共享低频截图和远控证据走外部 OCR。两条链路均复用 Provider secret、配额、健康、熔断、数据区域和保留策略，但实时音频不能先写对象存储再逐帧识别。

## 6. SIP 可观测性融合

### 6.1 HOMER 与 sip-exporter 的分工

| 组件 | 回答的问题 | 数据形态 | 热路径影响 |
| --- | --- | --- | --- |
| Kamailio/HEP + HOMER | 某次呼叫经过哪些 SIP transaction/branch，在哪里失败 | 可检索的 call flow | 异步镜像，失败丢副本 |
| sip-exporter | CPS、状态码、active dialog、setup delay、RTP loss/jitter/MOS 趋势 | Prometheus 时序指标 | eBPF 被动旁路 |
| OTel | API、NATS、Provider、DB worker 的跨服务延迟 | sampled traces | 批量、采样、fail-open |

三者互补，不能用一个替代全部。

### 6.2 sip-exporter 部署约束

Helm profile 已实现以下默认值：

- `enabled=false`；
- 必须提供 immutable image digest、明确 host interface 和 voice-node selector；
- `hostNetwork=true`，只部署到语音节点；
- 只申请 BPF、NET_ADMIN、NET_RAW capabilities，不申请 unrestricted privileged；
- high-cardinality host labels 和 upstream telemetry 默认关闭；
- ServiceMonitor 仅在外部 Prometheus Operator 已存在时创建。

当前审计源码身份固定为 1.4.0 commit `7dc7e633bc448a8a40ef2aa68fef76d615968b67`；正式部署仍必须把该源码构建结果锁为镜像 digest。

上线前必须证明：目标 CNI/hostNetwork 下确实能看见 Kamailio/RustPBX 流量；TLS SIP 只能看到加密边界而不能解析消息；当前内核、seccomp 与 CAP_BPF 兼容；旁路采集对 CPS、RTP packet loss 和 CPU 的影响在预算内。旧内核若要求 SYS_ADMIN，不应直接扩大权限，应升级节点内核或停用该 profile。

## 7. SIPhon 的定位

SIPhon 当前不进入正式拓扑。它提供值得借鉴的 Rust proxy/B2BUA、Python policy、Registrar、HEP、RTPengine、SIPREC、Redis 和 policy hot reload，但这些能力已经分别由 Kamailio、RustPBX 和 iveKit 控制面拥有。

只有以下同机测试通过后才讨论更深集成：

1. 相同服务器、NIC、内核、SIPp XML、媒体开关和 Call-ID 分布；
2. 比较 steady/burst CPS、active dialogs、P99 setup、timeout/retransmission、RSS 和 CPU；
3. 测节点重启、Redis/DB/RTPEngine/HEP 故障和优雅 drain；
4. 计算迁移现有 dispatcher、WebPhone JWT、DMQ、Cell owner 和审计补丁的长期成本。

上游公开的 10k CPS 数据只能作为线索，不能作为 iveKit 容量证据。

## 8. CCS-CallReport 的处理

不引入其 PHP/MySQL 代码，原因是无明确许可证、PHP 5.3/mysql_* 和 CentOS 6 技术栈过旧，并且会形成第二份报表数据权威。可吸收的字段包括 disposition、duration、billable duration、queue/agent/trunk、hangup cause、carrier 和时间维度；这些字段进入 iveKit PostgreSQL 权威投影，并在量级达到门槛后异步复制到 ClickHouse。

## 9. 验收矩阵

| 能力 | 自动合同 | 真实环境 |
| --- | --- | --- |
| LiveKit 1.6.6 API | exact lock、事件名、turn 配置测试 | Agent worker 加入真实 room |
| 低延迟流水线 | VAD/endpoint/interruption/turn projection 单测 | 真实 STT/LLM/TTS P50/P95/P99 |
| barge-in | interrupted heard-text 合同 | 电话回声、噪声、短插话和连续插话 |
| Provider failover | timeout/429/circuit 单测 | 断开 primary，媒体连续且 fallback 有界 |
| sip-exporter | Helm 默认关闭、权限和标签合同 | 指定节点/接口 eBPF 能见性与 CPU A/B |
| SIPhon | 无默认部署 | 同机 SIPp 基准报告 |
| 报表 | PostgreSQL projection contract | ClickHouse sink 在数据量门槛后验证 |

## 10. 后续开发顺序

1. 完成 Agent worker 的 Provider 连接池、取消传播和分阶段 latency metrics；
2. 完成 RustPBX decoded PCM 与 LiveKit subscribed track 到实时 ASR/翻译 port 的 adapter；
3. 接入一个真实外部流式 ASR、一个流式 TTS、一个 OCR Provider，保留 self-hosted adapter；
4. 在服务器上渲染 Helm 并验证 sip-exporter 的内核、接口、权限和开销；
5. 运行 Kamailio/RustPBX 与 SIPhon 同机 SIPp 对标，不因上游宣传数字替换现有架构；
6. 将 latency、barge-in、Provider failure 和 SIP/RTP 指标纳入发布证据。

## 11. 上游资料

- AVA AI Voice Agent for Asterisk: https://github.com/hkjarral/AVA-AI-Voice-Agent-for-Asterisk
- SIPhon: https://github.com/siphon-project/siphon-sip
- sip-exporter: https://github.com/aibudaevv/sip-exporter
- CCS-CallReport: https://github.com/IslamEdrees/CCS-CallReport
- LiveKit Agents: https://docs.livekit.io/agents/
- LiveKit turn handling: https://docs.livekit.io/agents/logic/turns/
- Pipecat: https://github.com/pipecat-ai/pipecat
