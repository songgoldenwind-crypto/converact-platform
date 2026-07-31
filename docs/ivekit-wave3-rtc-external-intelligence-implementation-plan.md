# iveKit Wave 3 RTC 与外部智能能力实施计划

更新日期：2026-07-24
状态：实施中
适用范围：OPC 与 LED 共用通信底座，不包含 LED 业务逻辑，不部署自建模型

## 1. 目标

Wave 3 交付两组可以独立验收、但共享同一容量与治理原则的能力：

1. `Cell-10K` 与 `MIX-100K` 共用的 RTC 性能合同、弱网注入、原始证据和 finalizer；
2. 外部 OCR、批量/实时 ASR、翻译、TTS、Model Gateway，以及 RustPBX/LiveKit 实时音频旁路。

固定完成标准：

- 代码、迁移、部署配置、API、SDK、指标、告警、故障语义和自动化验收完整；
- Provider、存储、字幕或审计依赖故障不能终止正在进行的 SIP、RTP、LiveKit 或 RustDesk 会话；
- 所有队列有上限，实时辅助能力只能降级、丢弃或重建，不能向媒体主链路反压；
- 本机只做编辑和静态检查；Node/Python/Rust 回归、Docker、Helm、故障注入和运行验收只在 `64.225.122.227` 执行；
- 未提供真实 Provider、PSTN、双 Windows、目标 Kubernetes 或跨地域环境的项目保持 `not_run`。

## 2. 已有基础与真实缺口

| 交付面 | 当前状态 | 本计划剩余工作 |
| --- | --- | --- |
| RTC performance contract | `performance_contract`、弱网 sidecar 和 finalizer 已实现 | 实际端点采集器、资源/成本汇总、服务器 campaign |
| 批量 OCR/ASR | HTTP Port、附件安全门、durable job、路由和治理已实现 | 真实 Provider 证据；不部署 PaddleOCR/sherpa-onnx |
| 文本翻译/质检 | HTTP Port、worker、策略、route、配额、熔断和故障切换已实现 | Model Gateway/TTS 纳入同一权威；真实 Provider 证据 |
| 实时 ASR/翻译 | profile/policy/governance、WSS adapter、租约、应用 wiring 和受控故障矩阵已实现 | 真实 WSS Provider、弱网、延迟与准确率证据 |
| RustPBX audio tap | decoded PCM、会话授权、有界无等待 tee、指标和关闭语义已实现 | 真实 RTP 媒体与故障注入 |
| LiveKit audio tap | subscribed track、PCM 标准化、有界队列、重连和关闭已实现 | 真实 LiveKit track、TURN/弱网与故障注入 |
| 字幕与结果 | partial 瞬时事件、final 幂等投影、保留、分页和删除已实现 | 真实客户端字幕与长稳证据 |
| TTS/Model Gateway | Provider-neutral Port、HTTP adapter、取消、治理和 AI Agent Provider 链已实现 | 真实 Provider 与 speech-to-speech P50/P95/P99 |

## 3. 架构裁决

### 3.1 一个 Provider 权威

扩展现有 `IntelligenceProviderRegistry`、`IntelligencePolicyStore` 和
`IntelligenceProviderGovernanceStore`，不创建第二套租户、配额、熔断或审计系统。

新增 capability：

- `realtime_speech`：流式 ASR 与实时文本翻译；
- `tts`：流式或分块语音合成；
- `model_gateway`：结构化质检、Agent 或通用模型调用。

现有 `ocr|asr|translation|quality_review` 保持兼容。老配置不填写新增字段时，新增能力默认关闭。

### 3.2 实时媒体只做旁路复制

```text
RustPBX decoded PCM tee ----\
                            -> bounded source queue -> stream gateway
LiveKit subscribed track ---/                         -> governed provider route
                                                       -> external WSS provider

provider events -> partial WebSocket broadcast
                -> final PostgreSQL projection + durable tenant event
```

媒体进程的同步工作只能是：读取内存中的订阅快照、检查本地关闭标志、`try_send` 一个有界队列。禁止同步 DNS、TLS、HTTP、PostgreSQL、NATS、日志格式化和 Provider 调用。

过载顺序固定为：保留音频转发 -> 降视频 -> 丢辅助 tap 帧 -> 关闭字幕/翻译 -> 拒绝新会话。辅助 tap 永远不能排在音频转发之前。

### 3.3 通用外部协议

当前 Provider 尚未选型，因此实现 `ivekit-realtime-speech-v1` WSS adapter：

- WSS 握手使用 Authorization header，URL 禁止凭据、query 和 fragment；
- JSON 控制帧传递 session、音频格式、语言、能力、结束和 normalized events；
- PCM/PCMU/PCMA/Opus 使用二进制 audio envelope，避免 base64 的 CPU 与 33% 带宽开销；
- adapter 只持有 `max_buffered_audio_ms` 范围内的帧；`bufferedAmount` 或队列超限立即返回 `dropped_overflow`；
- timeout、429、5xx、连接关闭和协议错误按统一 retryable/terminal 分类；
- 供应商专用协议以后只增加 adapter，不改变 OPC/LED API、事件或数据库。

TTS 与 Model Gateway 采用 HTTPS JSON/SSE 合同。取消、超时和客户端断开必须向下传播；响应 metadata 不能保存 prompt、完整 transcript、audio、token 或凭据。

### 3.4 长会话治理

实时 Provider session 在建立前占用现有治理 lease，成功建立后保持并周期续租，正常关闭时记 success，连接/协议异常记 retryable failure。续租故障只把辅助链路标记 degraded，不影响通话；租约最终过期后由数据库清理并释放并发额度。

建立阶段按租户有序 route failover。已建立 session 不在一个音频帧中间切换 Provider；仅在连接失效后以新 provider session、连续的 iveKit sequence 和新的 provider revision 重建。

## 4. 实施任务

### Task 1：统一 Provider profile、策略与治理

修改：

- `src/agent-runtime/collaboration/intelligence-provider-registry.ts`
- `src/agent-runtime/collaboration/intelligence-policy-store.ts`
- `src/agent-runtime/collaboration/intelligence-provider-governance-store.ts`
- `src/agent-runtime/collaboration/intelligence-provider-health.ts`
- `src/agent-runtime/collaboration/intelligence-provider-metrics.ts`
- `src/agent-runtime/ivekit/intelligence-http.ts`
- `src/agent-runtime/ivekit/intelligence-preflight.ts`
- `sdk/ivekit/src/intelligence-types.ts`
- `src/migrations/097_ivekit_realtime_intelligence.sql`

测试：

- profile 严格拒绝明文 secret、第三方非 TLS、URL query/fragment 和未知字段；
- 新 capability 可被策略启停、排序、限制第三方和返回安全摘要；
- 实时 lease 可续期，过期、half-open 和并发额度行为确定；
- 老 policy/profile 无新增字段时行为不变；
- PostgreSQL CHECK、RLS 和升级迁移覆盖新增 capability。

### Task 2：外部实时语音 WSS adapter

新增：

- `src/agent-runtime/ivekit/voice/adapters/external-realtime-speech.ts`
- `src/agent-runtime/ivekit/voice/realtime-speech-routing.ts`
- `test/ivekit-external-realtime-speech.test.ts`
- `test/ivekit-realtime-speech-routing.test.ts`

修改：

- `src/agent-runtime/ivekit/voice/realtime-speech-translation.ts`
- `src/agent-runtime/ivekit/voice/index.ts`

验收：

- `tryWriteAudio()` 不返回 Promise，不等待 socket；
- 队列按音频毫秒和字节双重限制；
- 二进制 envelope 可稳定编解码，sequence、timestamp、duration 和 payload 一致；
- 慢消费者产生 `dropped_overflow`，内存不继续增长；
- connect timeout、idle timeout、max session、close、取消和 retryable failover 完整；
- Provider metadata 清洗后不含原始内容和凭据。

### Task 3：TTS 与 Model Gateway Port

新增：

- `src/agent-runtime/collaboration/tts-provider.ts`
- `src/agent-runtime/collaboration/model-gateway-provider.ts`
- `src/agent-runtime/collaboration/generic-provider-routing.ts`
- `test/ivekit-tts-provider.test.ts`
- `test/ivekit-model-gateway-provider.test.ts`

验收：

- HTTPS、SSE/JSON、连接池复用、AbortSignal、timeout、最大请求/响应和 metadata 清洗；
- TTS 可返回分块音频且声明 encoding/sample rate/channel；
- Model Gateway 支持 JSON Schema 结构化输出，不把供应商响应直接当领域命令执行；
- 配额、并发、熔断、route failover 和第三方策略复用 Task 1 权威。

### Task 4：实时字幕投影、事件与删除

新增：

- `src/agent-runtime/ivekit/voice/realtime-speech-store.ts`
- `src/agent-runtime/ivekit/voice/realtime-speech-projection.ts`
- `src/migrations/098_ivekit_realtime_speech_projection.sql`
- `test/ivekit-realtime-speech-projection.test.ts`

修改：

- `src/agent-runtime/ivekit/application.ts`
- `src/agent-runtime/ivekit/operations/retention/runtime.ts`
- `sdk/ivekit/src/media-types.ts`
- `sdk/ivekit/src/http-sdk.ts`

固定语义：

- partial 只走目标租户/会话 WebSocket，不入 PostgreSQL/NATS/普通审计；
- final 以 tenant + interaction + provider session + segment + language 幂等；
- 持久记录保存 provider/model revision、置信度、时间轴、consent 和 retention，不保存原始 PCM；
- 删除 interaction/recording 时同步删除对应 transcript/translation projection；
- Event/Webhook 只发送 final 摘要和引用，不携带音频或明文 secret。

### Task 5：RustPBX decoded PCM tap

新增：

- `infra/ivekit/rustpbx/patches/rustpbx-ivekit-realtime-audio-tap.patch`
- `test/ivekit-rustpbx-audio-tap.test.ts`

修改：

- `infra/ivekit/rustpbx/build.sh`
- `infra/ivekit/rustpbx/Cargo.lock`
- `infra/ivekit/rustpbx/README.md`
- RustPBX 镜像/Helm 环境和 NetworkPolicy

固定实现：

- 只对已授权、明确启用的 session 创建 tap；
- RTP 接收循环仅 `try_send` encoded sample 到独立 bounded decoder task；
- decoder task 输出单声道 PCM16，并通过 sidecar-local stream gateway 发送；
- 队列满、decoder 错误、sidecar 断开时只累计低基数计数并丢 tap 帧；
- 会话销毁、转接、重 INVITE、codec 变化和 drain 时精确关闭 tap；
- Rust 单测/race 等价验证必须在服务器构建固定 commit + patchset 后执行。

### Task 6：LiveKit subscribed audio track tap

新增：

- `services/ai-agent-py/livekit_audio_tap.py`
- `services/ai-agent-py/tests/test_livekit_audio_tap.py`

修改：

- `services/ai-agent-py/session_handler.py`
- `services/ai-agent-py/opc_client.py`
- `services/ai-agent-py/requirements.lock`
- LiveKit worker Helm/Compose profile 和 NetworkPolicy

固定实现：

- worker 使用 LiveKit 官方 RTC API 订阅 audio track，不通过 Egress/对象存储绕行；
- 每个 track 独立有界 queue，标准化为 PCM16；
- queue 满时丢辅助帧，不能暂停 SDK track read 或房间媒体；
- participant leave、track unpublish、room reconnect 和 worker drain 精确结束 session；
- 同一 worker 可复用连接和预热资源，但每租户/房间/track 的配额、事件和内容隔离独立。

### Task 7：部署、可观测性与受控故障验收

新增：

- stream gateway 独立 worker Deployment、Service、PDB、NetworkPolicy 和 KEDA backlog/active-session 指标；
- Prometheus/VictoriaMetrics rules：queue drops、provider connect/TTFT/final latency、active sessions、reconnect、route failover、circuit 和 projection lag；
- OpenTelemetry span 只记录低基数 provider/profile/status，不记录音频和 transcript；
- 服务器 acceptance：受控 WSS Provider、慢消费、断连、429、5xx、协议错误、数据库短停和 gateway 重启。

通过条件：

- Provider 全停时已建立 SIP/LiveKit 媒体继续；
- PostgreSQL、NATS、对象存储和字幕消费者短停不终止媒体；
- queue/drop 指标与证据一致，无无界增长；
- failover 只发生在 session 建立/重建边界；
- Helm 渲染、NetworkPolicy、non-root、read-only root、capability drop 和 digest 门禁通过；
- LED 七个既有容器保持不变。

受控服务器进展（2026-07-23）：

- `npm run ivekit:realtime-speech-provider-acceptance` 已使用正式 WSS adapter、正式策略路由和治理
  存储覆盖二进制音频、429、5xx、终态拒绝、认证失败、协议错误、启动超时、有界溢出、启动期
  failover、终态不 failover 和已建立会话断开不切换 Provider；
- 报告固定声明
  `verification_scope=controlled_loopback_realtime_provider`、`real_vendor_evidence=false`；
- final projection 已从 gateway 回调移入最大 `4096` 项的独立有界 dispatcher；受控数据库失败注入
  证明 final 会按 `100/250/500/1000/2000 ms` 重试，partial 失败即丢弃，满载时 final 优先淘汰
  已排队 partial，投影和观测故障均不关闭媒体 gateway；
- LiveKit audio tap transport 会在初次连接和断线后最多执行 8 次有界重连，并在每次成功恢复后重置
  预算；服务器 loopback 实测已关闭监听器、短暂停机并在同一端口重启，当前帧在重新授权后送达；
- 两份 Compose、standalone/full-platform Helm lint/template 和部署合同在服务器通过；投影队列与
  shutdown 值均有 Helm fail-closed 范围校验；
- `npm run ivekit:realtime-recovery-acceptance` 已在隔离服务器停止并恢复实际 PostgreSQL 16
  容器进程；final 投影观察到 3 次重试，恢复后成功且幂等表只有 1 行；
- 同一验收在送达 PCM 序号 1 后终止实际 Node gateway 子进程，使用不同 PID 重启后 transport
  重新授权并送达序号 2；Python 容器固定 `/workspace` 优先导入，并校验模块路径和源码 SHA-256；
- 实际停库发现并修复了 `pg.Pool` 空闲连接 `error(57P01)` 未监听会终止 Node 进程的问题；
  listener 只记录低敏错误码，同步和异步 reporter 故障均被隔离，查询失败仍交给上层有界重试；
- 验收使用预留的固定 loopback PostgreSQL 端口，避免 Docker 的动态发布端口在进程重启时漂移；
  端口绑定竞争最多重新分配 3 次；transport 使用不含 PostgreSQL/LED 的专属 internal 网络，
  宿主状态、只读事件/控制和 transport 可写输出相互分离；所有等待均有 TERM/KILL 硬截止，
  失败注入和成功路径都会清理专用容器、网络和卷，机器报告同时验证 internal 网络及 LED 七容器
  的 ID、启动时间与健康状态不变；
- 实时语音、媒体旁路、投影、部署和恢复相关 Node 回归在服务器通过 `78/78`，AI Agent Python
  当前源码全量 `67/67`，`tsc --noEmit` 与 `git diff --check` 退出码均为 `0`；
- 完整机器报告和未运行边界见
  `docs/evidence/wave3-realtime-process-recovery-server-validation-2026-07-23.md`。实际进程恢复仍是
  受控 loopback，不是 CloudNativePG 主备切换、gateway Kubernetes Pod 滚动或真实
  RTP/WebRTC 媒体连续性；真实 WSS Provider、弱网和容量仍为 `not_run`，因此 Task 7 保持
  `implemented_controlled_server`。

### Task 8：RTC 真实采集器与容量 campaign

在服务器和后续真实环境实现并运行：

- SIP/RTP 音频 marker 与 mouth-to-ear/MOS 输入采集；
- LiveKit join、首音频、首视频、glass-to-glass、freeze、A/V sync；
- Tinode ACK、断线补偿、重复/乱序；
- RustDesk 双 Windows input-to-photon；
- baseline、限带宽、loss+jitter、handoff、cross-region；
- 1/2/4/8 节点扩展效率、资源、成本和公平性。

没有对应真实端点时，该项保持 `not_run`，但不得降低合同阈值或使用 mock 数值填充 finalizer。

受控服务器进展（2026-07-23）：

- Tinode collector 与通用 capacity worker 已实现真实 WebSocket
  `hi/login/sub/get/pub/data/note`，覆盖 ACK、delivery、presence、typing、receipt、长连接、
  重连、cursor 离线补偿、丢失、重复和顺序；
- 真实自编译 Tinode + PostgreSQL 低负载回归完成 20/20 delivery、5/5 离线恢复和 2/2 长连接，
  focused 回归 `9/9`、capacity TypeScript 与相关 diff gate 通过；
- Tinode 历史回放的 wire order 与最终业务 order 已分开统计：倒序 wire 回放保留为观测，
  provider sequence 无法收敛才阻断质量门；
- 容量审计发现旧执行方式会把 Profile 的 9000 个设备连接和 6000 个活跃 IM 会话分别开成
  socket，错误地产生 15000 条连接。新增 composite generator、runner 和 provisioner，
  由同一连接池承载会话：客户设备每会话一条连接、坐席主设备平均承载 3 个主题，额外坐席
  设备复用同一身份和主题集合；
- 历史 composite generator 已通过 100/250/500/1000 条物理连接的 ramped staircase；
  每个点客户端 attempted/accepted/active/closed 与 Tinode `LiveSessions` 完全一致，四个点均
  为零丢失、零重复、零业务乱序。1000 点建连 P95/P99 为 `8.096/11.730 ms`，消息 ACK
  P95/P99 为 `13.686/24.923 ms`，Tinode 峰值内存约 `88.3 MB`；
- 详细结果见
  `docs/evidence/wave3-tinode-capacity-collector-server-validation-2026-07-23.md` 和
  `docs/evidence/wave3-tinode-composite-frontier-2026-07-23.json`。阶梯结果使用
  `observation_scope=client_plus_tinode_expvar_and_container_resources`；
- 当前严格限速源码已重新执行相同的 100/250/500/1000 阶梯，四点全部通过 start-window
  速率门禁并与 Tinode `LiveSessions` 精确对账。1000 点为 1000/1000
  attempted/accepted/active/closed、666/666 interactions、1332/1332 delivery，零丢失、零重复、
  零乱序、零协议错误；建连 P95/P99 为 `6.342/9.603 ms`，delivery P95/P99 为
  `3.728/5.689 ms`，Tinode 峰值 CPU `29.85%`、内存 `92,620,718.08 bytes`。当前机器证据为
  `docs/evidence/wave3-tinode-composite-strict-staircase-2026-07-23.json`；
- distributed manifest/finalizer 已原生表达复合负载：`tinode_websocket` 物理分片通过
  `covered_workloads` 覆盖 `tinode_im` 会话范围，不再生成额外 IM socket 分片。migration
  100、PostgreSQL 写入/租约/outbox、命令校验、双维度 evidence reconciliation 和 run
  finalizer 已在服务器临时 PostgreSQL 中通过。正式 Tinode worker 已按物理分片调用
  composite runner，在同一连接池执行覆盖的 IM 会话，并分别输出连接/交互 evidence。
  所有 worker 共享不可变 binding table，按 `run_id + phase_id + shard_id` 精确选择私有
  bundle 并校验 SHA-256；provisioner 支持非零 connection/interaction 全局 ordinal，
  账号身份也绑定全局 connection ordinal，避免同一 campaign namespace 跨分片冲突；
- 当前代码的服务器 capacity 回归为 `191/191`（另 1 项真实 PostgreSQL 环境门禁默认跳过），
  capacity TypeScript 通过；真实 PostgreSQL
  16 按历史 077、升级 082、新增 100 的顺序迁移后，创建、租约、outbox、证据和完成屏障
  `1/1` 通过；
- LiveKit 浏览器采集器已在真实 Chromium/WebRTC、1 个房间、2 个参与人、1 路 720p30
  simulcast 视频和 1 路 Opus 音频下运行 60 秒。房间 join P95/P99 为 `341/341 ms`，首音频
  P99 `936.9 ms`，首视频 P99 `1117 ms`，glass-to-glass P95/P99 `179/202.8 ms`，端点
  丢包 `0`、jitter P95/P99 `6/6 ms`、freeze ratio `0`；但 A/V sync absolute P95
  `111.7 ms` 超过 `80 ms`，且服务器没有扬声器端点，只能取得 `decoded_frame` 而非
  `playout` 证据，因此机器结果为 `controlled_failed`；
- 官方 LiveKit CLI `2.18.1` 已按发布包 SHA-256 固定为原生容量生成器，并由通用 Linux
  process-tree observer 分别观测生成器和 LiveKit 进程。相同 4-vCPU 主机、loopback、
  60 秒单房间阶梯中，90/90 subscribed tracks 为零丢包、零错误，生成器/LiveKit CPU P95
  分别为 `29.97%/21.39%`，整机 CPU P95 约 `59.95%`，机器结果为 `controlled_pass`；
  160/160 和 250/250 均完成订阅，前者零丢包、后者丢包比约 `0.011%`，但整机 CPU P95
  分别约 `98.5%/99.0%`，均被判为 `invalid_generator_capacity`，不能解释成 SFU 失败边界；
- 原生容量日志解析器和证据 CLI 已实现轨道对账、丢包/错误门禁、生成器退出状态、CPU/NIC/
  host drop 资格校验，以及 `generator` 与 `sut_or_protocol` 故障归类。原生 evidence
  已升级到 schema `1.2.0`：Linux command observer 保存 `lk` 可执行文件 SHA-256、完整
  参数向量数量和 SHA-256，不保存原始参数；独立 workload manifest 从相同参数严格解析
  单大房间拓扑、发布者、订阅者、参与人、预期轨道、ramp、布局、分辨率、codec、simulcast
  和 speaker simulation，并将房间名与 identity prefix 仅保存为哈希。严格模式下缺失
  workload、轨道公式不一致、额外字段或任一 executable/argument witness 不匹配均
  fail-closed；
- RustPBX/Kamailio 持续信令阶梯已运行。首轮定位并修复 503 被误判为硬节点故障后摘除唯一
  dispatcher 目的地的放大问题；503 现在只触发不修改健康状态的下一节点尝试，
  408/500/502/504 继续执行硬故障标记和主动探测。修正后 1,200 CPS 为 72,000/72,000，
  零失败、零重传；细化阶梯的 1,250 CPS 为 75,000/75,000，P95/P99
  `29/90.002 ms`。1,300 CPS 时宿主 CPU P95 `98%` 并产生尾延迟，因 SIPp 与全部 SUT
  组件共用 4 vCPU，只能归类为 `blocked_by_same_host_generator`。当前结果是 486 无 RTP 的
  控制面证据，`capacity_claim=none`；独立 generator/SUT、同场景 PBX A/B 和真实媒体仍未运行；
- Linux observer 已增加宿主启动域见证：只写入
  `/proc/sys/kernel/random/boot_id` 的 SHA-256，不保存原始 ID、主机名、machine-id 或 IP。
  原生证据 schema `1.2.0` 保留 `host_scope` 与 `distinct_hosts_required`；CLI 使用
  `--require-distinct-hosts true` 时，缺少见证或 generator/SUT 哈希相同均判
  `invalid_generator_capacity`，哈希不同时才取得 `distinct_boot_domain`。观察器必须在
  两台宿主机分别运行，两个同机容器不能替代双机。服务器相关真实 Linux 回归 `53/53`、全量
  `tsc --noEmit` 通过；真实双机 160/250+ 重跑仍为 `not_run`；
- workload-binding 专项 Linux 回归 `22/22` 通过；服务器使用官方 `lk 2.18.1` 完成
  3 路视频 + 3 路音频发布、15 个订阅者、21 个参与者、90 条订阅轨道、60 秒的单大房间
  严格绑定复测。结果为 90/90 轨道、聚合码率 `25.9 Mbit/s`、丢包/CLI 错误/host drop
  均为 `0`，生成器/LiveKit/整机 CPU P95 分别约 `12.56%/16.41%/48.45%`，
  `workload_scope=verified`、`controlled_pass`。生成器与 SUT 同机，因此仍保持
  `capacity_claim=none`，不替代双主机失败边界测试；
- LiveKit browser evidence 已升级到 schema `1.4.0`：多房间结果除总体 P95/P99 外，还必须
  提供房间样本数、摄像头码率 Jain 公平指数、最弱/中位房间码率比，以及最差房间的 join、
  首音视频、glass-to-glass、丢包、抖动、冻结和 A/V sync；不保存房间 ID 或逐房间明细。
  服务器 4 房间、8 个真实 Chromium/LiveKit 参与人、60 秒回归完成，4/4 房间和 8/8
  参与人对账成功，但 generator/host CPU P95 达 `96.76%/98.23%`，公平指数 `0.9403`
  低于 `0.95`，正式结果为 `invalid_generator_capacity`。这证明最差房间门禁可运行，
  不构成容量点；独立生成器复测仍为 `not_run`；
- 浏览器 evidence 已升级为版本化 latency distribution：join、首音频、首视频、
  glass-to-glass、packet loss、jitter、A/V sync 和 reconnect recovery 均输出样本数及
  P50/P95/P99，evaluator 对缺少 schema、基线零样本和分位数倒序 fail-closed。升级后的
  60 秒真实 WebRTC 重跑得到 join `329.3/329.5/329.5 ms`、glass-to-glass
  `77.2/161.3/213.5 ms`、A/V sync absolute `19.7/84.5/120.6 ms`
  （P50/P95/P99）；仍因 A/V sync P95 超过 `80 ms` 且音频仅到 decoded frame 而
  `controlled_failed`；
- 浏览器采集器已增加真实独立 1080p15 screen-share track、独立码率统计、屏幕首帧和
  visual-marker glass-to-glass 分布。60 秒真实重跑完成 1 路音频、1 路摄像头和 1 路屏幕
  的发布/订阅；屏幕首帧 P99 `1697.9 ms`、屏幕 glass-to-glass P95 `223.2 ms`、平均码率
  `1.867 Mbit/s`，屏幕专项门禁通过，丢包和冻结均为 `0`。但浏览器生成器 CPU P95
  `76.63%` 超过 `60%` 资格线，且摄像头码率、A/V sync 与 speaker playout 仍失败，因此
  正式结果为 `invalid_generator_capacity`，不能作为容量点；
- 浏览器 evidence schema 已升级为 `1.2.0`，新增 CDP 端点断网的注入 scope、计划/实测
  blackout、SDK attempt/success、恢复端点和恢复延迟分布。3000 ms 单房间断网实测
  `3018.5 ms`，两个客户端重连 `2/2`，恢复到新的 decoded audio+video marker 用时
  P99 `2215.4 ms`，低于 `5000 ms` 门禁；生成器/主机 CPU P95 `52.12%/54.96%`，资格
  有效。首轮暴露 LiveKit Client `SignalReconnecting` 与媒体失败时 `Reconnecting` 的
  事件差异，修复后按 participant 去重两类起点。重连专项通过，但整体仍因 A/V sync
  `119 ms` 和缺少 speaker playout 为 `controlled_failed`。服务器相关回归 `46/46`、
  全量 `tsc --noEmit` 均通过；完整结果见
  `docs/evidence/wave3-livekit-capacity-server-validation-2026-07-24.md`；
- 浏览器 process input 已升级到 `1.3.0`，evidence 升级到 schema `1.5.0`，把普通重连与
  多房间重连风暴分开：新证据记录受影响房间数、所有断网注入的起始跨度、滑动 1 秒窗口内
  峰值尝试数和 `multi_room_correlated_cdp_offline` scope，不保存逐房间时间戳、身份、
  房间名或 token。严格 evaluator 在多房间场景拒绝旧 schema、房间数不符、起始跨度超过
  计划窗口、峰值不足或 scope 不符；新增打包 CLI 从私有 input/raw 推导期望值并以 `0600`
  排他写证据，专项回归 `32/32`、服务器全量 `tsc --noEmit` 通过。真实 2 房间/4 参与者
  60 秒复测完成 4/4 尝试和 4/4 恢复，起始跨度 `43.1 ms`、1 秒峰值 `4`、恢复 P99
  `2263 ms`、丢包和冻结为 `0`；但 generator/host CPU P95
  `86.90%/91.18%`，A/V sync P95 `107 ms`，正式结果
  `invalid_generator_capacity`。它证明风暴证据链可运行，不构成容量点；独立浏览器生成器
  复测仍为 `not_run`；
- 浏览器 evidence schema 已继续升级为 `1.3.0`，强制 TURN 不再接受声明数量：采集器按
  participant 设置 `iceTransportPolicy=relay`，从 WebRTC stats 的
  `selectedCandidatePairId` 追溯本地 candidate，并且只有全部 selected pair 均为
  `relay` 才计数。服务器 embedded TURN/UDP 隔离实例完成 60 秒真实音视频回归，
  relay-only/proven participant 为 `2/2`，selected/relay pair 为 `2/2`、传输为 UDP，
  LiveKit 服务端同步记录两人 `connectionType=turn`。TURN 专项、首媒体、G2G、丢包、
  jitter、freeze、码率和资源门禁通过；整体仍因 A/V sync P95 `81.5 ms` 略高于 `80 ms`
  且缺少 speaker playout 为 `controlled_failed`；
- 根因审计确认上述 A/V 指标混用了 decoded audio 与 rendered video。服务器 headless
  Chromium 的 `MediaElementAudioSourceNode` 即使播放时钟推进仍输出静音，WebRTC
  `estimatedPlayoutTimestamp` 在当前 LiveKit/SFU 链路也未生成，因此两条路径都按
  fail-closed 保留为失败探针，没有伪造或放宽阈值。最终采集器使用
  `HTMLMediaElement.captureStream()` 获取远端音频元素的播放流，经 Web Audio analyser
  检测 pulse，并与视频 `requestVideoFrameCallback` 的 rendered marker 对齐；
  `MediaStreamTrackProcessor` 仅继续承担 decoded audio 完整性和重连证明。相同强制
  TURN/UDP 场景 60 秒复测得到 A/V sync P50/P95/P99
  `23.9/56.9/126.5 ms`、`audio_endpoint_scope=playout`，join P95/P99
  `615.2/615.2 ms`、G2G P95/P99 `127.9/340.5 ms`，丢包和冻结为 `0`，正式结果
  `controlled_pass`、`failure_class=none`、`capacity_claim=none`。它证明浏览器
  media-element playout，不替代物理扬声器 mouth-to-ear；
- 浏览器 evidence 已升级到 schema `1.7.0`，把连接准备模式、主媒体发布完成、远端轨道
  ready、ready 后首播放音频和 ready 后首渲染视频分开记录。首视频定义已从“识别到第一个
  visual marker”纠正为 `requestVideoFrameCallback` 交付的第一帧，marker 继续只服务
  glass-to-glass；audio playout probe 在 video decoder 之前启动，避免采集器自身制造
  音频尾延迟。capacity plan 显式绑定 `cold|signal_prewarmed`、
  `receiver_jitter_buffer_target_ms` 和 subscriber quality，默认容量基线为 cold、浏览器
  默认缓冲和 auto quality。LiveKit renderer/standalone/Kubernetes 同时写入并审计
  `rtc.pli_throttle`，iveKit 已验证 profile 为 low/mid/high `100/100/100 ms`，每项
  fail-closed 限制在 `50..5000 ms`；
- 相同 1 房间/2 浏览器、60 秒、双向 `3 Mbps`、`120 ms` RTT、`40 ms` jitter、`5%`
  loss 场景在 signal prewarm、接收端 `400 ms` jitter-buffer 和
  `100/100/100 ms` PLI 下完成修正后复测。join P99 `1508.4 ms`、首音频 P99
  `2093.6 ms`、首渲染视频 P99 `2343.5 ms`、G2G P95/P99 `656.8/791.3 ms`、
  freeze ratio `4.205%`、`7.999` freezes/min、接收 FPS `29.946`，正式结果
  `controlled_pass`。该结果只满足 manifest 绑定的 loss+jitter profile，不是
  cold-start、独立主机或容量证据；机器文件为
  `docs/evidence/wave3-livekit-network-loss-jitter-first-frame-controlled-pass-2026-07-24.json`；
- LED 停服后完成启动/缓冲四格校准、浏览器小房间阶梯和官方 `lk` 原生 track 阶梯。只有
  prewarmed/400 ms 在既定弱网 profile 单次通过；同机 Chromium 在 2 房间触发生成器/宿主机
  资格线；原生 90 tracks 为最高合格点，160 tracks 虽然 160/160、零丢包/错误，但宿主机
  CPU P95 `90%`，因此只记为 `invalid_generator_capacity`，不能推导 LiveKit frontier；
- 官方 `livekit/livekit-helm` 已按 commit
  `8f0ad0809c2be8cbed375a6f8bef10625e5e8a2b` 精确 vendored，并补充外部 Valkey
  密码/TLS Secret、双 Zone spread 和 PDB。生产 profile 强制 digest、host network、
  8 CPU request、无 CPU limit、2→32 HPA、10001 RTC UDP ports 和已验证 PLI。服务器
  Helm validator/lint/template 及结构门禁通过；fixture digest 只用于静态渲染，目标
  Kubernetes install/upgrade/rollback、扩缩和故障注入仍为 `not_run`；
- 结果仍固定 `capacity_claim=none`：实际分布式 campaign 的逐分片 credential 真实预置与执行、
  超过 1000 的失败边界、独立生成器/SUT 真实双机执行、多节点 campaign、
  LiveKit 独立生成器/物理扬声器与 mouth-to-ear/TURN-TLS 与外部网络/屏幕共享和 TURN 多房间及弱网/Egress、重连风暴、完整媒体
  失败、网络切换、节点重启与多节点恢复、SIP RTP、
  RustDesk 双 Windows 继续为 `not_run`。LiveKit 限带宽与 loss+jitter
  已在服务器用真实 Chromium/RTP 链路执行并生成 apply/measurement/release
  绑定证据；原始限带宽与 loss+jitter 样本保持 `controlled_failed`，修正后的
  loss+jitter profile 已单次 `controlled_pass`。handoff、cross-region、cold/default-buffer
  对照、重复性与独立主机复测仍未完成。相关本地及服务器代码/部署回归为 `102/102`，
  服务器完整 `tsc --noEmit` 通过。
- 历史和当前 100/250/500/1000 阶梯分别保持不可变并绑定各自 composite generator
  SHA-256。当前限速器按客户端实际启动时间发放令牌、拒绝追赶突发，并在计时器提前唤醒时
  重新检查 deadline；严格阶梯已独立重跑通过。它只证明当前 4-vCPU 单机在既定低速 ramp
  下通过 1000 连接上限点，不等于已找到失败 frontier 或取得生产容量结论。

## 5. 验证纪律

### 5.1 本机允许

```text
git diff --check
JSON 解析
bash -n
node --check（仅 JavaScript 语法）
文档、源码和配置静态检查
```

本机禁止运行 Docker、Compose、Helm、Node/Python/Rust 动态回归和媒体测试。

### 5.2 服务器执行

所有测试先同步到 `/opt/opc-wave123-validation-20260722/source`，然后在服务器执行：

```text
TypeScript typecheck 与定向/全量 Node 测试
Python unit/integration tests
RustPBX 固定 commit patch apply、cargo test/race 等价检查和镜像构建
Docker Compose 受控 Provider 与故障注入
Helm lint/template 和 Kubernetes 合同检查
真实 LiveKit/RustPBX/Tinode/Valkey/PostgreSQL/NATS 链路
```

每轮证据记录 source commit/worktree hash、服务器时间、镜像 digest、命令、原始结果、未运行项和 LED 容器不变量。

## 6. 不做事项

- 不部署 PaddleOCR、sherpa-onnx、vLLM、SGLang；
- 不引入 ClickHouse、Envoy Gateway、Cilium/Hubble；
- 不把 Provider、存储、NATS、PostgreSQL 或鉴权 HTTP 放入 RTP/SFU 同步热路径；
- 不创建第二套 agent session runtime，机器人仍由 LiveKit Agents 负责；
- 不用受控 Provider、合成音频或单机 signaling 数字冒充真实生产验收；
- 不在本轮实现 LED 订单、工单、客服业务和移动端。

## 7. 完成顺序

严格按 Task 1 -> 7 开发并在服务器逐批回归；Task 8 在真实端点/服务器资源具备后执行。每个 Task 只有在代码、静态合同、服务器回归和状态文档一致后才标为 `controlled_pass`。真实 Provider、跨地域、PSTN 和双 Windows 未具备时，最终状态最多为 `implemented` 或 `controlled_pass`，不能写成 `real_environment_pass`。

## 8. RustPBX RTP 传输闭环补充（2026-07-24）

- RustPBX 构建现独立固定 `rustrtc@166c6d2...`，通过 Cargo 全局 patch
  避免间接依赖选择第二个版本；`ivekit.19` 已在 4-vCPU Linux 服务器使用固定
  Rust 1.94.1 和 `cargo build --locked --release` 完整编译。
- RTP/直接 RTCP socket 支持受限的收发缓冲配置；Compose、两套 Helm 和基线统一接线。
  1 MiB/512 KiB 请求在活动通话中实测为 Linux `rb=2 MiB/tb=1 MiB`。
- 严格 10 路 PCMU 双向序列回归通过；600/800 路吞吐回归均 SIP 精确对账、零重传、
  零 UDP 错误。150 路严格模式被同机生成器 149/150 限制，不能算通过。
- 900 路同时出现 SIPp 失败、重传和 SUT `RcvbufErrors`，正式归类为
  `mixed_or_inconclusive`。2 MiB 接收缓冲诊断没有稳定收益，因此不继续用内存掩盖
  持续处理瓶颈，默认值恢复为 1 MiB。
- 下一次源码级媒体优化的启动条件是独立 generator/SUT、不同 boot-domain 见证和相同
  workload 的 CPU flamegraph。只有证据仍指向 SUT socket/task 调度时，才实施
  shared receive 或 media worker sharding。
- 完整证据见
  `docs/evidence/wave3-rustpbx-rtp-media-capacity-server-validation-2026-07-24.md`；
  当前结论仍是受控同机 800 路合格线，`capacity_claim=none`，不等于生产单机上限，
  也不等于已证明优于 FreeSWITCH/Asterisk。
