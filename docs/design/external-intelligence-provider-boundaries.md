# 外部 OCR、ASR、翻译与模型 Provider 边界

更新日期：2026-07-22

## 1. 架构裁决

当前阶段不部署 PaddleOCR、sherpa-onnx、vLLM、SGLang 或其他自建模型服务。iveKit 交付可替换的 Provider 协议、媒体旁路、治理、故障隔离和验收合同，真实能力由外部服务提供。

自建服务以后只能作为同一 Provider Port 的另一种 adapter，不得要求 OPC、LED、Tinode、LiveKit、RustPBX 或 Quality Service 修改领域模型。

本阶段覆盖：

1. 外部 OCR：图片、PDF、视频抽帧、屏幕和远控证据；
2. 外部批量 ASR：录音、录像和语音附件，用于离线质检；
3. 外部实时 ASR：电话和视频音轨的流式转写；
4. 外部实时翻译：实时字幕或语音翻译文本；
5. 外部文本翻译和质量模型；
6. Provider 健康、配额、并发、熔断、故障切换和数据治理。

不包含模型镜像、GPU 调度、权重下载和自建推理集群。

## 2. 两条 ASR 链路

### 2.1 实时流式 ASR 与翻译

```text
RustPBX decoded audio fork / LiveKit subscribed audio track
  -> RealtimeAudioTapPort
  -> bounded in-memory audio queue
  -> RealtimeSpeechTranslationProviderPort
  -> transcript.partial / transcript.final
  -> translation.partial / translation.final
  -> captions, agent assist and governed transcript projection
```

固定边界：

- RustPBX/LiveKit 媒体继续独立转发；Provider 不参与 call admission、SFU forwarding、RTP relay 或房间 readiness。
- `tryWriteAudio` 是同步非阻塞接口。adapter 必须使用有界队列，只能返回 `accepted`、`dropped_overflow` 或 `closed`。
- Provider 变慢、断开、限流或熔断时，系统丢弃或重建翻译旁路，不得等待、暂停或终止原通话。
- 音频帧只在内存中短暂存在，不写应用日志、NATS、PostgreSQL 或普通审计事件。
- partial 结果默认只用于瞬时 UI；final 结果按租户 consent、retention 和数据分类策略持久化。
- 每个 session 绑定 `tenant_id`、`interaction_id`、媒体 session、participant、track、consent 和 provider revision。
- 外部实时连接仅允许 WSS 或 TLS gRPC；凭据只能通过 `env://...` Secret Ref 解析。

实时翻译支持两种 adapter：

1. Provider 原生同时输出 ASR 和 translation events；
2. Provider 只输出 ASR final segment，由独立低延迟 Translation Provider 继续翻译。

两种 adapter 必须输出相同的 normalized event。当前合同输出翻译文本和字幕；需要语音播报时，后续通过独立 TTS Port 合成，不能把 TTS 写死进 ASR Provider。

### 2.2 机器人 STT -> LLM -> TTS

机器人应答与字幕翻译共享外部 Provider 治理，但由 LiveKit Agents 1.6.6 负责 turn、barge-in、tool 和音频输出，不能再引入第二套会话运行时：

```text
LiveKit audio input
  -> worker-prewarmed VAD + streaming STT
  -> preemptive streaming LLM
  -> sentence/chunk streaming TTS
  -> LiveKit audio output
  -> final heard transcript + latency projection
```

当前已固定 direct/transitive Python 依赖，完成 worker 级 VAD 预热、低延迟 endpointing、interruption、preemptive generation 和 LiveKit 1.6 当前事件合同。AVA 和 Pipecat 只作为流水线机制参考，不导入其 Asterisk/agent session 控制面。真实外部 STT/LLM/TTS 尚未提供凭据时，延迟、barge-in 和 failover 状态仍为 `not_run`。

### 2.3 离线批量 ASR 与质检

```text
recording / video / audio attachment
  -> immutable staging
  -> MIME and ClamAV gate
  -> durable ASR job
  -> external batch ASR
  -> text + language + confidence + diarized segments + word timestamps
  -> Quality Service finding and human review
```

批量路径与实时路径共享 provider identity、语言和 transcript segment 语义，但使用不同的 transport、超时、重试和计费预算。禁止把长录音塞进实时 WebSocket，也禁止把实时音频帧先写对象存储再逐帧调用 ASR。

外部 ASR 返回的 segment 具有：

- `segment_id`；
- `speaker_id`；
- `start_ms`、`end_ms`；
- 文本、语言、置信度；
- 可选 word timestamps。

Quality Service 是质检 finding 和评分版本的唯一权威。ASR Provider 只产生证据结果，不能直接改变质检、合规、路由或坐席状态。

## 3. 外部 OCR

现有 HTTP OCR Port 继续作为正式边界：

```text
POST /v1/ocr
multipart: file + attachment_id + tenant_id + session_id + message_id + source_ref
response: text + confidence + language + observations[]
```

适用输入：

- 聊天图片和文档；
- 视频文件按固定间隔抽帧；
- RustDesk 文件和录屏证据；
- 屏幕共享按租户策略进行低频截图采样。

实时视频和屏幕共享不得把完整视频流交给 OCR。应由独立 worker 按固定频率和总帧数上限采样，超载时丢弃 OCR 任务而不是回压 LiveKit 或 RustDesk。

OCR Provider 不获得对象存储凭据、数据库连接或可长期回源 URL。iveKit 从私有对象存储读取已通过安全门的字节，再以有界 multipart 请求发送。

## 4. Provider 治理

批量 OCR、ASR、翻译和质量模型复用 `IntelligenceProviderRegistry` 与治理存储：

- ordered provider route；
- third-party/self-hosted adapter mode；
- health probe；
- requests/minute、requests/day 和并发预算；
- circuit open、half-open recovery 和 retryable failover；
- Secret Ref；
- provider、model/version、request ID 和安全 metadata；
- 租户 allow-third-party、目标语言和最低置信度策略。

实时语音使用独立 session port，因为 WebSocket/gRPC 流的生命周期、背压和音频格式与批量 HTTP 不同，但它不得另建租户、配额、审计或 Provider 权威体系。

## 5. 数据和安全

- 外部处理必须绑定租户授权、录音/转写同意和允许的数据区域。
- 原始音频、OCR 图片、转写、翻译和模型输出分别执行保留和删除策略。
- Provider metadata 禁止保存 raw audio、PCM、frame、prompt、完整 transcript、token 或请求 payload。
- 指标只使用 provider/profile/status/language-family 等低基数标签；interaction、call、participant 和 request ID 只能进入受控 trace 或审计字段。
- 第三方 endpoint 必须使用 HTTPS/WSS/TLS gRPC，URL 不能包含凭据、query 或 fragment。
- Provider 不得回调任意 URL；需要事件回调时只能进入经过认证的固定 webhook ingress。

## 6. 故障语义

| 故障 | 实时路径 | 离线路径 |
| --- | --- | --- |
| Provider timeout | 旁路 degraded，媒体继续 | durable retry/failover |
| Queue overflow | 丢弃翻译帧并计数，必要时重建 session | 停止 claim 或延后 job |
| 429/配额耗尽 | 切换允许的实时 profile 或关闭字幕 | 按 route 切换候选 |
| 网络中断 | 关闭 provider session，不触碰 call/room | job 回到 retry_wait |
| 终态输入错误 | 关闭该旁路并告警 | job terminal，进入人工处置 |
| 存储故障 | 不影响活动音视频 | 不启动新的批量处理 |

## 7. 当前实现状态

已实现：

- 外部 HTTP OCR、批量 ASR、文本翻译和质量 Provider；
- Provider profile、健康、配额、并发、熔断和故障切换；
- 视频抽帧 OCR、QR/条码 observation；
- RustPBX decoded PCM 与 LiveKit subscribed track 的实际 gateway、授权、非阻塞有界 tap 和关闭语义；
- `ivekit-realtime-speech-v1` WSS adapter、二进制 audio envelope、统一事件和安全 metadata；
- 实时 Provider 启动期 route failover、长会话 lease、429/5xx/终态/认证/协议错误分类，以及已建立
  session 不自动切换 Provider；
- partial 瞬时处理、final transcript/translation 幂等 PostgreSQL 投影、分页、保留与删除；
- gateway 到 PostgreSQL 投影之间的非阻塞有界 dispatcher；final 短故障重试、partial 优先丢弃、
  overflow/shutdown 低基数观测，以及 LiveKit transport 初连/断线的有界重新授权与重连；
- 隔离服务器上的实际 PostgreSQL 容器进程停启和实际 Node gateway 子进程重启验收；Pool 空闲
  连接错误不会终止进程，final 恢复后幂等落库，transport 在不同 gateway PID 间重新授权；
- 离线 ASR diarized segment 与 word timestamp 返回合同；
- LiveKit Agents 1.6.6 exact/transitive dependency lock、worker VAD 预热、turn/interruption/preemptive-generation 策略；
- 最终可听 assistant 文本、STT confidence、分段 turn latency 和 STT/LLM/TTS Provider fallback 合同；
- 受控 loopback WSS 故障矩阵及可重复服务器验收命令。

仍需完成：

- 至少一个真实外部实时 ASR adapter；
- 真实流式 STT、LLM 和 TTS Provider 的连接池、取消传播及 speech-to-speech P50/P95/P99；
- 真实 RustPBX RTP 与 LiveKit track 上的媒体连续性、字幕客户端和长稳证据；
- 真实 Provider 的弱网、背压、限流、故障切换、准确率和延迟证据；
- CloudNativePG 主备切换、连接池并发恢复、gateway Kubernetes Pod 重启和多副本滚动时的真实
  媒体旁路演练。当前实际进程证据仍是单机受控 loopback，不含真实 RTP/WebRTC 媒体。

真实 Provider 未选择或未提供凭据时，状态保持 `not_run`，不得用 controlled adapter 冒充通过。
