# iveKit 组件治理与部署 Profile

> 状态：V1 已落地
> 范围：OPC 与 LED 共用的 IM、音视频、语音呼叫、远程协助及其异步支撑能力
> 权威数据源：`docs/architecture/component-authority-matrix-v1.json`

## 1. 结论

当前项目不是“已经搞乱”，但已经到达必须收敛的节点。此前引入的项目分为三类：

1. 替换现有薄弱组件，例如 Redis 到 Valkey、MinIO 到 SeaweedFS、旧 Node NATS 客户端到新客户端。
2. 保留现有主系统，只吸收外部项目的机制，例如从 AVA、Pipecat、SIPhon 等项目借鉴低延迟流水线、信令实现和可观测性做法。
3. 仅用于同机基准或技术验证，例如 RTPengine、SIPhon、Centrifugo、Cilium/Hubble。

真正会把系统搞乱的不是项目数量，而是多个组件同时拥有同一份状态或同一条热路径的控制权。V1 治理将每个能力域限制为一个 `primary` authority；其他组件只能是 adapter、extension、observer、candidate、operator、tooling、legacy 或 rejected。

## 2. 两份数据的边界

`communication-technology-baseline-v1.json` 回答“为什么选、升级、替换或拒绝某项技术”。

`component-authority-matrix-v1.json` 回答“谁负责、在哪个 Profile、默认是否启动、怎么开关、怎么回滚、资源预算是什么”。技术基线的 46 条决策必须在矩阵中各出现一次，不能遗漏或重复。矩阵另外记录 iveKit API 控制面，因此当前共有 47 个治理条目。

设计理由可以继续扩展，但运行 authority 只能通过矩阵变更。这样避免调研文档、Helm、交付包分别形成互相冲突的事实源。

## 3. Authority 规则

| 能力域 | 唯一主责 | 其他项目的位置 |
| --- | --- | --- |
| SIP 边缘路由 | Kamailio | OpenSIPS 已拒绝；SIPhon 只做 benchmark candidate |
| 语音会话与 RTP | RustPBX | rsipstack 是内嵌扩展；RTPengine 只做 candidate |
| WebRTC SFU | LiveKit Server | Ingress、Egress、SIP 是边界明确的配套服务 |
| 持久 IM | Tinode | Centrifugo 只能验证临时 fanout，不持有消息历史 |
| 远程协助中继 | RustDesk Server | Guacamole 是可选浏览器协议适配器 |
| 事务数据 | PostgreSQL | CloudNativePG 只负责运维，不成为第二数据库 |
| 集成事件 | NATS | Kafka/Redpanda 在 NATS 达到实测瓶颈前不引入 |
| 对象存储 | 通用 S3 provider；SeaweedFS 4.40 是已受控验证的自建实现 | MinIO 是有截止日期的 legacy 迁移端；WORM 使用经验证的外部 S3 |
| AI 会话运行时 | LiveKit Agents | AVA、Pipecat 仅提供实现机制，不引入第二套 session runtime |

CI 对每个 `authority.domain` 最多允许一个 `role=primary`。候选项目即使代码已下载，也不得出现在生产 Profile、默认 Chart 或正式部署制品中。

## 4. 四种 Profile

### 4.1 core

`core` 是唯一默认 Profile，也是其他 Profile 的强制基础。默认 Chart 只启动 iveKit API，不自动启动 ClamAV、RustPBX、Kamailio、Tinode 或任何 AI/监控/benchmark 组件。

这里的“core 组件”表示获准进入生产架构，并不表示全部由一个 Helm release 自动启动。LiveKit、RustDesk、PostgreSQL、NATS 等外部集群仍由各自部署单元管理；只有在提供 immutable image、Secret、网络和容量预算后，才显式打开 Chart 内的可选工作负载。

### 4.2 ai

`ai` 打开附件 OCR/ASR、质检和翻译等有界异步循环。实时语音 AI worker 继续独立部署，通过 LiveKit Agents 接入媒体流。模型和供应商不随 Profile 固化，第三方与自建实现都经过同一 Provider 接口、健康检查、配额、熔断和降级策略。

AI 失败不得结束人工通话、视频房间或 IM 会话。未设置 `deploymentProfiles.ai=true` 时，Chart 会拒绝开启 AI worker。

### 4.3 observability

`observability` 打开 ServiceMonitor、PrometheusRule、Grafana dashboard、低频 backlog observer 和可选 trace SDK。OpenTelemetry Collector 与 VictoriaMetrics 已提供独立平台 Profile，不由应用 Chart 隐式安装：Collector 只处理 traces，VictoriaMetrics 只接收 Prometheus remote-write，二者故障都不得改变通信 readiness。ClickHouse 继续按数据量门槛单独部署。

SIP exporter 和 HEP trace 仍需二次显式开启，因为它们还依赖主机接口、内核权限、节点选择、标签基数、隐私保留和不可变镜像。未设置 `deploymentProfiles.observability=true` 时，Chart 会拒绝开启任何监控资源或 SIP trace。

### 4.4 benchmark

`benchmark` 永远标记为 `production_eligible=false`。它关闭无关的文件、AI、通知和 Webhook worker，让容量证据只对应被测通信路径。

RTPengine、SIPhon、Centrifugo、Cilium/Hubble 只属于该 Profile，并通过独立 benchmark harness 部署。生产 Chart 不提供这些组件的 Deployment、镜像或默认值；正式交付包也不包含其运行制品。

## 5. 替换组件退场

| 替换项 | 旧组件 | 最晚退场日期 | 退场门槛 |
| --- | --- | --- | --- |
| `nats-js-client` | legacy `nats` Node package | 2026-09-30 | 发布者与消费者全部迁移到 `@nats-io/transport-node` |
| `redis-to-valkey` | Redis 7 部署 | 2026-12-31 | Valkey soak、故障切换和客户端兼容证据通过 |
| `minio` | bundled MinIO | 2026-12-31 | 对象核对完成且生产端点切换到外部 S3 或 SeaweedFS；WORM 场景不得依赖 SeaweedFS |
| `gateway-api-envoy` | legacy ingress/Kong path | 2027-03-31 | 全部 HTTP Route 与策略通过 Gateway API 验收 |

截止日到达后仍处于 `replacement` 状态会使 CI 失败。双轨只能用于可回滚迁移窗口，不能成为长期架构。

## 6. 镜像与交付约束

生产 Chart 当前管理的 iveKit API、RustPBX、Kamailio、Tinode、ClamAV 和 SIP exporter 都必须使用 `repository@sha256:digest`。Helm helper 对 digest 格式执行强校验，tag 不能作为生产身份。

正式交付包包含：

- 四个 Profile 覆盖文件；
- 技术基线与组件 authority 矩阵；
- 生产 Chart、API、SDK、运维和验收资料；
- 已获准的构建上下文和不可变来源说明。

正式交付包不包含：

- POC 项目的镜像、Dockerfile、Deployment 或运行脚本；
- 只用于调研的 QUIC/DPDK 默认替换方案；
- 被拒绝项目的代码；
- 未锁 digest 的生产镜像定义。

## 7. CI 阻断项

`npm run verify:component-governance` 会阻断以下变更：

1. 同一能力域出现两个 primary authority。
2. POC 不再是 benchmark-only，或进入生产交付。
3. deferred/rejected 组件出现在任意部署 Profile。
4. 可选或计划组件被默认开启。
5. 替换项没有退场日期、日期已过或缺少 exit gate。
6. 技术基线与组件矩阵没有一一对应。
7. Chart 中受管生产镜像缺少 digest 路径或 sha256 helper。
8. 四个 Profile 文件缺失、默认 Profile 不是 core，或生产 Profile 引用了 POC。
9. Stage 2 CI 没有执行治理校验，或交付包缺少治理文件。

## 8. 新组件准入

任何新组件进入代码库前必须先回答：

1. 它解决哪个当前组件无法解决且已经量化的问题？
2. 它是 primary、adapter、extension、observer、candidate 还是 tooling？
3. 是否与已有 authority 重复？若是替换，旧组件何时删除？
4. 是否进入热路径？失败、变慢或存储中断时，正在进行的通话/视频/远控是否继续？
5. 属于哪个 Profile，默认是否关闭，配置开关在哪里？
6. CPU、内存、网络、磁盘、连接和并发预算是什么？
7. 镜像/源码如何锁定，健康、drain、监控、回滚和验收如何完成？
8. OPC 与 LED 是否仍通过稳定 API/SDK/事件边界使用能力，而不是依赖项目私有接口？

答案先进入技术基线和 authority 矩阵，再进入 Helm 或代码。只“下载并接上”但没有 authority、Profile、预算和回滚信息的组件不允许合入。

## 9. 维护方式

矩阵是架构评审入口，不是静态清单。每次组件升级、替换、状态变化或 Profile 调整，都必须同时更新：

1. 技术基线中的决策、版本和验收门槛；
2. authority 矩阵中的状态、依赖、开关、回滚和预算；
3. 对应 Profile 覆盖文件；
4. 自动化验证和交付清单；
5. 真实环境证据状态。

这个机制允许继续大胆修改开源源码，但修改发生在明确的主责组件内。外部项目可以持续提供算法、协议和性能优化思路，而不会把 OPC/LED 底座变成多套系统永久并行的集合。
