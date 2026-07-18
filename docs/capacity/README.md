# iveKit 容量合同与架构治理

> 状态：Active
> 版本：3.3
> 日期：2026-07-17
> 上级评审：[`../MIX-100K双Zone与Cell架构评审.md`](../MIX-100K双Zone与Cell架构评审.md)
> 调研依据：[`../CCaaS十万并发容量对标与架构优化调研.md`](../CCaaS十万并发容量对标与架构优化调研.md)

## 1. 目的

本目录保存 iveKit 单套平台提高单节点密度、保持横向扩展边际效率并最终验证 100,000 并发通信所需的机器可读合同和版本化配置。它解决六个问题：

1. 每次 benchmark 使用完全相同的 interaction、连接、消息、媒体、录制和 Provider 负载。
2. 节点、Cell 和 Zone 使用同一个 CapacityVector 交换容量，不以 CPU 或一个模糊并发数调度。
3. 所有容量结果可以追溯到 profile、Git commit、镜像、硬件和配置。
4. RustPBX、LiveKit、Tinode、RustDesk 的 iveKit fork 可以独立演进，但必须保持可重现和可回退。
5. 单节点 hard/safe capacity、单位资源密度和 1/2/4/8 节点曲线使用统一公式验收。
6. 现实部署按需求扩容，不因为 100K endpoint 目标预分配完整计算资源。

本目录不代表任何容量已经通过。未经 evidence bundle 验证的数字均为 `target` 或 `assumption`。

## 2. 文件清单

| 文件 | 责任 |
| --- | --- |
| [`schemas/workload-profile.schema.json`](schemas/workload-profile.schema.json) | 所有负载 profile 的 JSON Schema |
| [`profiles/mix-100k-v1.json`](profiles/mix-100k-v1.json) | 第一版 100k 混合交互合同 |
| [`profiles/cell-10k-v1.json`](profiles/cell-10k-v1.json) | MIX-100K 的 10% Cell 校准切片，不可乘十冒充平台通过 |
| [`schemas/capacity-vector.schema.json`](schemas/capacity-vector.schema.json) | 节点、Cell、Zone 容量、使用量和 admission 合同 |
| [`schemas/scaling-efficiency.schema.json`](schemas/scaling-efficiency.schema.json) | 单节点密度、聚合线性度和区段边际效率 Schema |
| [`targets/mix-100k-efficiency-v1.json`](targets/mix-100k-efficiency-v1.json) | 单节点优先、component 90%/Cell 95% 边际门槛 |
| [`cell-10k-pilot-budget.md`](cell-10k-pilot-budget.md) | 10K 派生网络/录制/文件/Provider 预算和最少节点求解 |
| [`schemas/fork-manifest.schema.json`](schemas/fork-manifest.schema.json) | 开源 fork/patch queue 清单 Schema |
| [`forks/ivekit-forks-v1.json`](forks/ivekit-forks-v1.json) | RustPBX、LiveKit、Tinode、RustDesk 的精确源码、补丁、构建、验证和发布阻断清单 |
| [`component-node-admission-protocol-v1.md`](component-node-admission-protocol-v1.md) | Cell 到 LiveKit/Tinode/RustDesk/RustPBX 节点的 lease、checkpoint、epoch、drain 和重启恢复内部合同 |
| [`implementation-plan-phase1.md`](implementation-plan-phase1.md) | 容量 harness 第一阶段实施顺序、测试合同和完成门槛 |
| [`implementation-plan-phase2.md`](implementation-plan-phase2.md) | Cell placement、持久编排器、组件探针和媒体 generator 第二阶段实现与服务器待验收清单 |
| [`campaign-finalization-runbook.md`](campaign-finalization-runbook.md) | run、组件/Cell 曲线、平台 100K 聚合的不可变提交、终结和证据归档手册 |
| [`rustpbx-recording-spool-implementation-plan.md`](rustpbx-recording-spool-implementation-plan.md) | RustPBX 编码分片、owner-fenced intake、断点续传 sidecar、时间线事件和本地水位 admission |
| [`../../infra/ivekit/rustpbx/patches/rustpbx-ivekit-media-hot-path.patch`](../../infra/ivekit/rustpbx/patches/rustpbx-ivekit-media-hot-path.patch) | 将录音编解码、文件创建和收尾移出 RTP/信令循环，使用有界执行器、非阻塞控制和显式失败/丢弃证据 |
| [`../../infra/capacity/kubernetes/worker-statefulset.yaml`](../../infra/capacity/kubernetes/worker-statefulset.yaml) | 每个 generator fleet 的稳定 Worker 身份、单分片背压和 S3 evidence 部署模板 |
| [`../../infra/capacity/kubernetes/controller-deployment.yaml`](../../infra/capacity/kubernetes/controller-deployment.yaml) | 双副本 fenced run/phase Controller |
| [`../../infra/capacity/kubernetes/cell-admission-deployment.yaml`](../../infra/capacity/kubernetes/cell-admission-deployment.yaml) | 双副本主动/待命 Cell admission、PostgreSQL lease 接管、PDB 和就绪端点隔离 |
| [`../../infra/capacity/kubernetes/finalizer-job.yaml`](../../infra/capacity/kubernetes/finalizer-job.yaml) | run 级三方核对、evidence manifest 上传和最终状态裁决 |
| [`../../infra/capacity/kubernetes/scaling-finalizer-job.yaml`](../../infra/capacity/kubernetes/scaling-finalizer-job.yaml) | 从数据库和 S3 重读已验证 run evidence，重放 frontier 并裁决 1/2/4/8 曲线 |
| [`../../infra/capacity/kubernetes/platform-finalizer-job.yaml`](../../infra/capacity/kubernetes/platform-finalizer-job.yaml) | 复算九个组件角色、Cell、共享数据面和 100K endpoint 后裁决平台结果 |
| [`run-config.example.json`](run-config.example.json) | manifest 编译配置模板；占位值必须替换，不能直接用于证据 |
| [`phase1-controlled-status.json`](phase1-controlled-status.json) | 第一阶段工具实现快照；容量声明为 `none`，真实环境项目保持 `not_run` |
| [`phase2-code-status.json`](phase2-code-status.json) | 第二阶段代码实现快照；真实 PostgreSQL/NATS/媒体/Windows/容量结果保持 `not_run` |
| [`../adr/ccaas-1-cell-placement.md`](../adr/ccaas-1-cell-placement.md) | Region/Zone/Cell/owner placement、epoch 和 fencing |
| [`../adr/ccaas-2-dual-zone-quorum.md`](../adr/ccaas-2-dual-zone-quorum.md) | 双 Active Data Zone 与第三仲裁故障域 |
| [`../adr/ccaas-3-recording-evidence.md`](../adr/ccaas-3-recording-evidence.md) | 语音、LiveKit、RustDesk 录制和证据数据面 |
| [`../adr/ccaas-4-open-source-fork-governance.md`](../adr/ccaas-4-open-source-fork-governance.md) | 开源核心源码改造与升级治理 |
| [`../adr/ccaas-5-distributed-load-generation.md`](../adr/ccaas-5-distributed-load-generation.md) | 多协议 generator、shard、headroom 和证据核对 |
| [`../adr/ccaas-6-single-node-density-and-scaling-efficiency.md`](../adr/ccaas-6-single-node-density-and-scaling-efficiency.md) | 单节点极致密度、近恒定边际容量和按需部署 |

## 3. 术语

| 术语 | 精确定义 |
| --- | --- |
| Interaction | 一次逻辑业务交互，例如一个 IM topic、SIP call、LiveKit room 或 RustDesk session |
| Connection | 一个 WebSocket、SIP registration、TCP/UDP flow；不自动等于 interaction |
| Participant | interaction 中的逻辑参与人；一人可以拥有多个 connection |
| Track | LiveKit audio/video/screen published 或 subscribed track |
| VoiceCall | 一个逻辑双腿 SIP 通话，不自动等于 media session |
| RtpLeg | 一个终端与媒体节点之间的媒体腿 |
| CapacityVector | 同时表达 SIP、RTP、WS、消息、媒体、录制、Provider 和数据资源的向量 |
| Safe capacity | 满足 profile SLO 且保留故障余量时可接纳的容量，不是进程崩溃前峰值 |
| Hard capacity | 满足功能 SLO 但尚未扣 production headroom 的测量极限，只用于优化 |
| Aggregate linearity | `L(n)=C_safe(n)/(n*C_safe(1))` |
| Marginal efficiency | `M(a,b)=(C_safe(b)-C_safe(a))/((b-a)*C_safe(1))` |
| Cell | 有界实时计算、会话 owner、admission、drain 和发布故障域 |
| Data shard | durable 数据分片；ID 与 Cell 解耦，可服务多个 Cell |
| Data Zone | 承载完整实时数据面的 Active Zone |
| Quorum fault domain | 第三投票/副本故障域，不要求承载完整媒体容量 |
| Owner epoch | interaction owner 的单调递增 fencing 版本 |
| Evidence bundle | 绑定版本、硬件、配置、profile、指标、错误和故障时间线的容量证据包 |

## 4. 版本规则

### 4.1 Profile

Profile ID 不可覆盖更新：

```text
mix-100k-v1
mix-100k-v2
voice-100k-v1
im-100k-v1
```

以下任一变化都必须产生新版本：

- interaction 构成或数量。
- 消息率、CPS 或重连比例。
- codec、码率、分辨率、帧率、simulcast。
- TURN/relay/录制/ASR/监听比例。
- SLO 或故障模型。
- steady、burst、soak 或 endurance 时长。

只修改描述、来源或拼写而不改变负载语义时，可以增加 `revision`，但不得改 `profile_id` 的行为。

### 4.2 CapacityVector

CapacityVector Schema 使用语义版本：

- 新增可选字段：minor。
- 修改单位、含义、必填性或 admission 语义：major。
- 文档修正：patch。

生产调度器遇到不支持的 major version 必须 fail closed，不得忽略未知维度继续接纳媒体会话。

### 4.3 Fork manifest

每次上游 commit、patch、构建特性、镜像 digest 或协议版本变化都生成新的 component release。禁止复用可变 `latest` 作为容量证据身份。

### 4.4 Scaling efficiency

Scaling contract 单独版本化。修改 priority、headroom、linearity/marginal floor、硬件可比性或 endpoint 语义必须产生新的 contract ID；100K endpoint 通过不能覆盖密度或边际效率失败。

## 5. 状态模型

容量结果只能使用以下状态：

| 状态 | 含义 |
| --- | --- |
| `target` | 设计目标，未执行 |
| `not_run` | 已定义验收但环境或运行尚未完成 |
| `running` | 运行中，不可用于承诺 |
| `failed` | 已运行但没有满足门槛 |
| `component_pass` | 单组件 profile 通过 |
| `cell_pass` | Cell profile、owner 和节点故障通过 |
| `platform_pass` | 双 Zone 平台内部 profile 通过 |
| `external_not_run` | 平台通过，但真实 PSTN/Provider/Windows/对象存储等外部验收未执行 |
| `production_pass` | 声明范围内平台和外部环境均通过 |

状态只能由 evidence validator 根据原始证据生成，不能手工把 `not_run` 改成 `pass`。

## 6. 单位规范

- 时间：`ms`、`seconds`、`minutes`、`hours`，字段名必须带单位。
- 网络：`mbps` 使用十进制 bit/s；`gbps = 1000 mbps`。
- 存储：`bytes_per_second` 使用 byte/s。
- CPU：`cpu_cores` 表示核数；`cpu_utilization_ratio` 范围 0-1。
- 内存：`memory_bytes`。
- 消息：`messages_per_second` 指服务端接收业务消息；fanout 必须单列。
- PPS：RX、TX 和 packet operations 分开。
- 容量：绝对值，不使用“高/中/低”替代。

## 7. 计数规则

`mix-100k-v1` 的五类 interaction ID 必须互斥：

```text
60k IM
+ 25k voice
+ 10k 1:1 A/V
+ 3k screen collaboration
+ 2k remote assistance
= 100k active interactions
```

连接、participant、track、registration、recording job 和 Provider stream 是派生向量，不能再次加到 interaction 总数中。

任何运行必须输出至少以下计数校验：

```text
count(distinct interaction_id) == profile.interactions.total
sum(interaction_type_counts) == profile.interactions.total
intersection(interaction_id sets) == empty
```

## 8. Evidence bundle 最小内容

```text
manifest.json
profile.json
capacity-vector-samples.jsonl
versions.json
hardware.json
config-digests.json
summary.json
errors.jsonl
failure-timeline.jsonl
metrics/
logs/
traces/
```

`manifest.json` 必须绑定：

- profile ID 和 SHA-256。
- Git commit。
- 所有容器 image digest。
- fork manifest ID 和 SHA-256。
- Kubernetes/OS/kernel/NIC/CPU/NUMA。
- generator 数量、硬件和 commit。
- 开始/结束时间。
- 数据 Zone 和 Cell 列表。
- 外部依赖状态。

## 9. 设计约束

1. 控制面不在 RTP、WebRTC track、RustDesk frame 或每条 Tinode fanout 热路径。
2. Cell compute 和 durable data shard 解耦。
3. 每个 interaction 在同一 epoch 只有一个 owner。
4. 双 Zone 正常各承载约 50%，任一 Zone 的 safe capacity 覆盖完整目标。
5. NATS/Redis/PostgreSQL 自动 failover 使用第三仲裁故障域或等价托管仲裁。
6. RoomComposite、转码、OCR/ASR/AI 和离线处理不得抢占核心实时池。
7. 开源组件允许 fork；fork 内部接口不得直接成为 LED/OPC 对外合同。
8. 所有未知或未验证容量保持 `target/not_run`。
9. 单节点 safe density 是第一优化目标，component 每区段 marginal >=90%，Cell/shared-data marginal >=95%。
10. 生产按实测需求和 safe capacity 扩容，不预分配 100K endpoint 的完整资源。
11. 主备 Cell admission 必须使用同一规范化 topology SHA-256；不同拓扑只能在旧 lease 释放或过期后以新 epoch 接管。

## 10. 变更流程

修改本目录合同：

1. 提交对应 ADR 或 ADR amendment。
2. 更新 Schema 和 profile/manifest 实例。
3. 运行 JSON 语法与 Schema 校验。
4. 更新生成器、调度器和 evidence validator 的兼容测试。
5. 保留旧 profile 读取能力；禁止重写已有证据。
6. 在新 profile 通过前，旧生产承诺不自动继承。

## 11. Phase 1 工具状态

当前仓库已实现以下控制面代码：

| 路径 | 状态 | 能力边界 |
| --- | --- | --- |
| `scripts/capacity/profile-compiler.ts` | controlled code pass | profile/fork/release SHA 绑定、确定性 ID、完整且不重叠的 interaction/connection shard；曲线点以最大余数法按完整 workload 比例精确分摊 |
| `scripts/capacity/shard-lease.ts` | controlled code pass | 单调 lease epoch、续租、过期接管和 stale worker fencing |
| `scripts/capacity/generator-qualification.ts` | controlled code pass | fleet 150% safe capacity、单 worker 70% safe/20% fleet target、CPU/NIC/memory/drop/scheduler 门禁 |
| `scripts/capacity/evidence-validator.ts` | controlled code pass | generator/SUT/independent 三方核对和 `passed/failed/invalid_generator_capacity/not_run` 分类 |
| `scripts/capacity/frontier-runner.ts` | controlled code pass | step ramp、bracket、binary search、三次 frontier 复测和 1/2/4/8 曲线调度；可重放并拒绝遗漏、乱序、虚构或额外 probe |
| `scripts/capacity/scaling-campaign.ts` | controlled code pass | 绑定 contract SHA、精确硬件/配置/故障预留/fork/SUT/generator 身份，裁决 aggregate 与 marginal efficiency |
| `scripts/ivekit-capacity-scaling-finalizer.ts` | controlled code pass | 只读取 PostgreSQL 终态与 S3 已验证 SHA 一致的 run evidence；受控模式始终输出 `capacity_claim=none` |
| `scripts/ivekit-capacity-platform-finalizer.ts` | controlled code pass | 只从终态 scaling/run 证据聚合九个必需角色、Cell、共享数据面与 endpoint；生产全通过才输出 `platform_pass` |
| `scripts/capacity/generators/ivekit-event-ws.ts` | controlled protocol pass | 真实 WS 鉴权、durable cursor、reconnect、重复/乱序和 journal hash |
| `scripts/capacity/generators/tinode.ts` | controlled protocol pass | 真实 Tinode hello/login/sub/presence/typing/publish/receipt/reconnect 和 journal hash |
| `scripts/capacity/generators/sipp.ts` | controlled parser/runner pass | SIPp CPS/并发计划、统计、watchdog 和 SUT/generator 故障分类；本机无 SIPp，真实进程为 `not_run` |
| `scripts/ivekit-capacity-worker.ts` | controlled code pass | PostgreSQL heartbeat/assignment、JetStream fenced consume、固定 SHA 外部生成器、结果检查点、S3 evidence 和可恢复完成；真实 generator binary 为 `not_run` |
| `scripts/ivekit-capacity-controller.ts` | controlled code pass | immutable run 创建/恢复、controller lease、动态 phase 推进、失败 phase 收口和 finalizing barrier |
| `scripts/ivekit-capacity-finalizer.ts` | controlled code pass | `phase_id + shard_id` 三方核对、fleet qualification、生产依赖门禁、run evidence manifest 和 passed/failed/not_run 裁决 |
| `scripts/ivekit-cell-admission.ts` | controlled code pass | PostgreSQL reservation ledger、Cell lease fencing、双副本主动/待命接管、重启恢复、节点 checkpoint 同步和故障隔离 |
| `scripts/ivekit-component-node-admission.ts` | controlled code pass | 可作为 LiveKit/Tinode/RustDesk/RustPBX sidecar 部署的 node lease、epoch、drain、授权和容量 agent |
| `integrations/component-hook-go/` | controlled code pass | LiveKit/Tinode 的无第三方依赖 source hook；mutate 热路径只读内存 epoch/lease |
| `integrations/livekit-v1.13.3/` | controlled code pass | LiveKit 房间 owner registry；首次入房打开 owner、后续信令/管理操作本地 fencing、最多 64 房间批量续租 |
| `infra/ivekit/livekit/` | controlled overlay, compile and local image pass | 精确绑定 `v1.13.3@8f6a9cb...` 的 owner 覆盖层、小房间 SFU 热路径补丁和离线 vendor 构建入口；干净源码重复应用、Go 1.26 根模块/嵌套模块测试、SFU race 测试及 arm64 custom image/fork marker smoke 通过；不可变 Registry 制品与真实媒体仍为 `not_run` |
| `integrations/tinode-v0.25.3/` | controlled code pass | Tinode topic owner registry；ROOT-only Trusted placement、owner 预加载、最多 64 topic 批量续租和 stale owner 隔离 |
| `infra/ivekit/tinode/` | controlled overlay, compile and local image pass | 精确绑定 `v0.25.3@22a7c18...`，将 `cluster_self` 对齐稳定 ordinal，在 actor 启动前开 owner，并对 publish/meta mutation 做本地 fencing；普通前台会话延迟创建后台 timer，本地普通群聊扇出复用只读消息；干净源码重复 overlay、Go 1.26 server/race/嵌套模块测试及 arm64 source-built custom image/fork marker smoke 通过；不可变 Registry 制品与真实多节点仍为 `not_run` |
| `integrations/component-hook-rs/` | controlled code pass | RustDesk/RustPBX 的无第三方依赖 source hook；mutate 热路径只读内存 epoch/lease |
| `src/agent-runtime/ivekit/placement/rustdesk-owner-binding.ts` | controlled code pass | target 到 relay UUID 的短期精确绑定、歧义拒绝、过期回收和文件 checkpoint 重启恢复 |
| `infra/ivekit/rustdesk-server/` | controlled overlay, compile and local image pass | 精确绑定 root `1.1.15@9bae9f2...` 与 `hbb_common@83419b6...`；hbbs/hbbr owner fencing、每会话原子 usage 和同协议 owned frame 补丁在干净源码幂等应用，`cargo test --locked`、digest-pinned multi-stage arm64 custom image、非 root 运行和 fork marker smoke 通过；不可变 Registry 制品、双 Windows 和物理容量仍为 `not_run` |
| `infra/capacity/kubernetes/rustdesk-statefulset.yaml` | controlled deployment pass | 每个稳定 ordinal 同 Pod 部署 hbbs、hbbr、binding broker 和 component sidecar；不以随机 LoadBalancer 作为 owner 边界 |

`controlled code pass` 只表示工具自身的自动化测试通过；它不表示 RustPBX、Tinode、iveKit、Cell-10K 或 MIX-100K 容量已经通过。

### 11.1 编译 manifest

先复制并修改 `run-config.example.json`。必须填入真实、不可变的 SUT/generator release ID 和运行时间，且 topology 必须来自 generator 校准结果。

```bash
node --import tsx scripts/ivekit-capacity.ts compile-manifest \
  --profile docs/capacity/profiles/cell-10k-v1.json \
  --fork-manifest docs/capacity/forks/ivekit-forks-v1.json \
  --run-config /path/to/run-config.json \
  --output /path/to/evidence/load-run-manifest.json
```

编译结果包含 `manifest` 和 `manifest_sha256`。manifest 生成后禁止编辑；任何 workload、release、seed、shard 或时间变化都创建新 run。

### 11.2 离线验证

```bash
node --import tsx scripts/ivekit-capacity.ts validate-manifest \
  --profile docs/capacity/profiles/cell-10k-v1.json \
  --fork-manifest docs/capacity/forks/ivekit-forks-v1.json \
  --bundle /path/to/evidence/load-run-manifest.json
```

验证会重新计算 profile、fork 和 manifest SHA，并检查所有 shard 的完整覆盖、无重叠、fleet 绑定和确定性 seed。它不检查运行时流量；运行时仍需 generator qualification、三方计数和 SLO evidence。

## 12. 变更日志

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| 1.0 | 2026-07-16 | 建立 MIX-100K、CapacityVector、Cell/Zone、录制和 fork 设计合同入口 |
| 1.1 | 2026-07-16 | 增加 Cell-10K、分布式 generator、单节点密度、边际扩展效率和按需部署合同 |
| 1.2 | 2026-07-16 | 增加 manifest compiler/validator、lease/evidence/frontier harness 和首批 Event WS/Tinode/SIPp controlled generator |
| 1.3 | 2026-07-16 | 增加 Cell placement、PostgreSQL/JetStream durable orchestrator、五类组件探针、RTP/LiveKit/RustDesk generator 合同与部署模板 |
| 1.4 | 2026-07-16 | 加固重复命令执行权、周期租约、run evidence manifest、生成器版本锁定、流式探针上限和 JetStream 配置门禁 |
| 1.5 | 2026-07-16 | 增加可部署 capacity worker、重启安全 run controller/finalizer、S3 evidence 和 worker 单分片背压 |
| 1.6 | 2026-07-16 | 增加独立通知分区 Worker，并校正文档与 Tinode 原生 mutation 的实现状态 |
| 1.7 | 2026-07-16 | 增加 migration 083 Cell reservation 账本、component-node agent/synchronizer、重启自动重放和 Go/Rust fork hook |
| 1.8 | 2026-07-16 | 增加 Cell admission 双副本主动/待命、可中断 lease 竞争、滚动升级/PDB、仅主实例容量探测和 Service 就绪隔离 |
| 1.9 | 2026-07-16 | 接通 RustPBX inbound/RWI owner epoch、停车双腿 fencing、本地 component-node sidecar 与精确锁定源码补丁队列验证 |
| 2.0 | 2026-07-16 | 增加稳定 ordinal 组件节点池、Cell 容量精确聚合校验，以及 migration 084 topology SHA-256 绑定的主备 lease/epoch 隔离 |
| 2.1 | 2026-07-16 | 增加 LiveKit 精确 tag/commit owner overlay、64 房间批量续租、信令/管理操作本地 fencing、稳定 ordinal StatefulSet 与交付/CI 接线 |
| 2.2 | 2026-07-16 | 将 LiveKit 内部 `currentNode.NodeID()`、Redis room routing、iveKit placement 和本地 sidecar 对齐到同一稳定 ordinal 节点身份 |
| 2.3 | 2026-07-17 | 增加 Tinode 精确 release/commit topic-owner overlay、ROOT-only Trusted placement、selected-node topic create、稳定 `cluster_self`、三节点 StatefulSet 与交付/CI 接线 |
| 2.4 | 2026-07-17 | 增加 RustDesk Server 精确 commit 覆盖层、target/relay UUID binding broker、hbbs/hbbr owner fencing、稳定配对 StatefulSet 与交付/CI 接线 |
| 2.5 | 2026-07-17 | 将 placement 入口边界纳入固定容量门禁，增加独立 Capacity CI，并交付可独立类型检查和重建的最小 `capacity-runtime/` 镜像上下文 |
| 2.6 | 2026-07-17 | 完成 LiveKit CAS room-owner rebuild 与客户端恢复元数据；完成 RustDesk package v6/native-control v2 全链 owner epoch fencing，并将本地状态改为每会话 O(1) 分片写入；参考客户端按能力懒加载 RustDesk SDK |
| 2.7 | 2026-07-17 | 增加 rsipstack/RustPBX 有界事务、retransmission cache、事务队列、可靠连接、显式 SIP 503 过载拒绝、容量配置、指标和告警闭环 |
| 2.8 | 2026-07-17 | 将 RustPBX 录音编解码与磁盘工作移出 RTP 转发循环，增加固定工作线程、有界捕获队列、丢弃证据和部署参数 |
| 2.9 | 2026-07-17 | 在精确 LiveKit v1.13.3 源码通过 owner overlay 与 Go 1.26 编译，增加 lock-free downtrack 快照及普通/RED 小房间无原子串行 RTP fanout |
| 3.0 | 2026-07-17 | 在精确 Tinode v0.25.3 源码通过幂等 overlay、Go 1.26 编译与 race 测试，增加前台会话 lazy timer 和普通本地群聊零拷贝消息扇出 |
| 3.1 | 2026-07-17 | 在精确 RustDesk Server 1.1.15 与固定 hbb_common 子模块通过幂等 overlay 和锁定 Cargo 测试，将 usage 更新移出全局映射写锁并保留同协议 relay frame 所有权；增加可交付操作级基准 |
| 3.2 | 2026-07-17 | 增加完整 MIX 比例曲线点编译、精确运行身份、frontier 历史重放、migration 091、数据库/S3 验证型 scaling campaign finalizer 与 Kubernetes/交付接线 |
| 3.3 | 2026-07-17 | 增加 component role 不可变身份、migration 092、曲线二次复算和九组件+Cell+共享数据+100K endpoint 平台聚合 finalizer；受控结果禁止平台声明 |

## 13. Phase 2 代码状态

第二阶段新增：

| 路径 | 能力 |
| --- | --- |
| `src/agent-runtime/ivekit/placement/` | signed snapshot/token、Cell top-two placement、原子 CapacityVector reservation、drain、owner epoch |
| `src/migrations/083_ivekit_cell_admission_reservations.sql` | Cell reservation PostgreSQL 权威账本、状态恢复和 lease-fenced 写入 |
| `src/migrations/084_ivekit_cell_lease_topology.sql` | 将 Cell lease 绑定到规范化 topology SHA-256，阻止不同节点/容量配置复用同一活动 epoch |
| `src/migrations/085_ivekit_interaction_placement_handoffs.sql` | interaction placement generation、旧 owner CAS replacement 与 durable handoff reconciliation |
| `src/migrations/091_ivekit_capacity_scaling_campaigns.sql` | 不可变 scaling campaign、来源 run 引用、fenced lease、终态与证据对象元数据 |
| `src/migrations/092_ivekit_capacity_platform_campaigns.sql` | 平台 campaign、十一条 scaling 来源、100K endpoint 来源、fenced lease 与 `platform_pass` 证据 |
| `src/agent-runtime/ivekit/placement/component-node-topology.ts` | Stateful ordinal 节点身份、节点池编译、Cell 容量精确聚合和顺序无关拓扑指纹 |
| `scripts/ivekit-component-node-admission.ts` | 通用组件节点 sidecar；默认 draining，恢复完成前不 ready |
| `src/ivekit-component-node-admission.ts` | 独立 iveKit 镜像可编译的 component-node sidecar 入口，供 Helm/Compose 与 RustPBX 同 Pod/网络命名空间部署 |
| `infra/capacity/kubernetes/cell-admission-deployment.yaml` | 两个 admission 副本共同竞争 PostgreSQL Cell lease；待命实例只暴露 liveness，主实例恢复账本和节点 checkpoint 后才 ready |
| `integrations/component-hook-go/`、`integrations/component-hook-rs/` | 上游 fork 可嵌入的本地 epoch/lease guard，不在媒体/帧/fanout 热路径发远程请求 |
| `infra/ivekit/rustpbx/patches/rsipstack-ivekit-capacity.patch`、`rustpbx-ivekit-sip-capacity.patch` | 精确源码上的事务/缓存/队列/连接硬上限、503 overload、RustPBX 参数接线和低基数指标 |
| `integrations/livekit-v1.13.3/`、`infra/ivekit/livekit/` | 房间 owner registry、批量授权客户端、内部 router 节点身份对齐、精确 tag/commit 覆盖层、lock-free downtrack snapshot、小房间 RTP/RED 串行快路径和受控构建入口 |
| `infra/capacity/kubernetes/livekit-statefulset.yaml` | LiveKit fork 与 sidecar 共用稳定 ordinal node ID；横向副本不依赖易变 IP 或随机 Pod 身份 |
| `integrations/tinode-v0.25.3/`、`infra/ivekit/tinode/` | topic owner registry、ROOT-only Trusted placement、稳定 `cluster_self`、精确 tag/commit 覆盖层和受控构建入口 |
| `infra/capacity/kubernetes/tinode-statefulset.yaml` | 三节点 Tinode cluster 与各自 sidecar 共用稳定 ordinal node ID；headless cluster DNS 和客户端 Service 分离，PDB 保留至少两个节点 |
| `src/agent-runtime/ivekit/placement/rustdesk-owner-binding.ts`、`infra/ivekit/rustdesk-server/` | gateway 创建时向 selected owner 预登记 target；hbbs 认领 relay UUID，hbbr 打开 owner 并在原定时分支执行本地 lease fencing |
| `infra/capacity/kubernetes/rustdesk-statefulset.yaml` | 每个 ordinal 是一组精确 hbbs/hbbr owner；binding 和 component sidecar 共用同一 Pod 身份与持久卷，外部 public endpoint 由 placement runtime 映射 |
| `scripts/rustdesk-owner-epoch-fence.ts`、Windows package v6 | command/observation/evidence/native close 携带精确 owner identity；每 external session 独立原子状态分片，拒绝 stale epoch 且无全局 O(N) 重写 |
| `scripts/capacity/orchestrator/` | PostgreSQL run/phase/shard/worker/evidence、transactional outbox、JetStream durable command、周期续租、重复命令原子执行权和 stale worker fencing |
| `scripts/capacity/scaling-campaign*.ts`、`scripts/ivekit-capacity-scaling-finalizer.ts` | 重放来源 run 的完整 frontier，锁定相同 profile/hardware/config/failure reserve/release 身份并按 contract 门槛形成组件或 Cell 曲线结论 |
| `scripts/capacity/platform-campaign*.ts`、`scripts/ivekit-capacity-platform-finalizer.ts` | 重新读取并复算每条曲线，强制九个组件角色唯一齐全，并以 Cell/shared-data/100K endpoint 同时通过作为唯一平台声明入口 |
| `scripts/capacity/probes/` | iveKit Edge、Tinode、RustPBX、LiveKit、RustDesk health/Prometheus capacity observation |
| `scripts/capacity/generators/rtp-media-twin.ts` | SIP session manifest 驱动的 RTP packet/quality 计划和证据 |
| `scripts/capacity/generators/livekit.ts` | 多小房间、screen、TURN、TrackEgress、RoomComposite 计划和证据 |
| `scripts/capacity/generators/rustdesk.ts` | native hbbs/hbbr synthetic fleet 计划和证据，独立于 Windows correctness lane |
| `infra/capacity/` | controlled Compose、dispatcher image 和 Kubernetes dispatcher 模板 |
| 交付包 `capacity-runtime/` | 保留专用 tsconfig、锁文件、Dockerfile、dispatcher/controller/finalizer/worker、Cell/sidecar/binding 入口及最小 placement/SQL 端口；可独立类型检查并从该目录重建 capacity-tools 镜像 |

关键真值边界：

- `passed` 必须绑定数据库中已验证且 SHA-256 一致的 `run_evidence_manifest`。
- worker `release_id` 必须与 manifest 的 `generator_release_id` 一致。
- JetStream 保持至少一次投递，但同一 shard/epoch 只有首次数据库状态迁移可以启动生成器。
- 生成器执行期间持续续租；失去租约会通过 `AbortSignal` 终止外部进程。
- 探针和生成器结果均流式或文件级限长，不允许无界响应进入控制面内存。
- scaling campaign 不接受调用方直接提交测量值；它按不可变 run 引用从 PostgreSQL 和 S3 重新读取证据、复算哈希并重放搜索历史。任何身份漂移、缺点、乱序或受控模式都会阻止生产容量声明。
- platform campaign 不信任来源曲线的 `outcome` 标签，会从 frontier repetitions 再算 aggregate/marginal gate；endpoint 通过不能覆盖任何角色曲线失败，真实环境缺失则保持 `not_run`。
- RustPBX 完整补丁队列已在精确 `6c49ee76...` 源码上重放；rsipstack `8318e97...` 现在严格限制活动事务、finished retransmission state、入站事务队列和 TCP/TLS/WebSocket 连接，过载以 SIP 503 + `Retry-After` 或显式 outbound error 收口。RustPBX 统一接入四项 profile 参数、`rustpbx_sip_*` 指标、ServiceMonitor 和饱和/拒绝告警。固定源码 release 编译、本地 custom image 和 12 个受控 SIPp 信令场景已通过；真实 SIPp overload 曲线、RTP/PSTN、故障切换和容量仍为 `not_run`。
- LiveKit participant token 现在携带签名的 interaction、reservation、node、owner epoch、placement generation 和 recovery metadata。普通刷新不迁移房间；terminal reconnect 只有在旧 owner 被权威状态判定为不可恢复时，才以旧 reservation/epoch 为 CAS 前置条件生成更高代 placement，并用 durable handoff 关闭旧 reservation。并发恢复收敛到同一代，且不会重复创建 Egress。房间首次打开 owner，后续 join、signal 和管理 mutation 只检查进程内 guard；续租最多每批 64 个 owner。覆盖层还会在 Prometheus、SignalClient 和 Router 初始化前，将内部 `currentNode.NodeID()` 设置为 `IVEKIT_COMPONENT_NODE_ID`，因此 Redis room routing、placement 和 sidecar checkpoint 使用同一稳定 ordinal。精确 `v1.13.3@8f6a9cb...` 源码已通过重复 overlay、Go 1.26 编译、SFU 单测、race 测试及 arm64 source-built custom image/fork marker smoke；downtrack 快照读取微基准从 3.62-3.66 ns/op 降至 0.49-0.52 ns/op，但不可变 Registry 制品、真实 SFU 故障恢复、RTP/TURN 媒体和容量仍为 `not_run`。
- Tinode 新 group topic 先持久化 Cell reservation，再直连被选中的 owner endpoint，由 ROOT 在 `desc.trusted.ivekit_placement` 写入 interaction、reservation、node 和 epoch；fork 在 actor 启动前开 owner，publish、typing/receipt 和 metadata mutation 只检查进程内 lease。续租最多每批 64 个 topic；owner open 失败会硬删除本次刚写入的 topic，避免孤儿绑定。`cluster_self`、ringhash 节点名、placement 和 sidecar checkpoint 共用稳定 StatefulSet ordinal。普通前台连接不再预分配后台 timer，background 状态用原子转换避免读写协程竞争；普通本地 group fanout 复用不可变消息，P2P、channel 和 cluster 仍保留独立 copy。精确 `v0.25.3@22a7c18...` 已通过重复 overlay、Go 1.26 server/race/嵌套模块测试及 arm64 source-built custom image/fork marker smoke；Apple M5 单次消息准备微基准从 41.19-42.81 ns/op、240 B/op、2 allocs/op 降到 1.580-1.586 ns/op、0 B/op、0 allocs/op。该结果不是整机吞吐证明；不可变 Registry 制品、三节点重连、native client 收敛和容量仍为 `not_run`。
- RustDesk gateway 在现有 session 创建流程中向 selected ordinal 预登记 target、reservation 和 owner epoch；hbbs 收到 `RequestRelay` 后先将 target 原子认领为 relay UUID，hbbr 在 UUID 配对前打开 owner。数据转发仍是上游 opaque byte pipe，仅复用原三秒 timer 做进程内 lease 判断；无 HTTP、数据库或 broker 调用进入帧复制。覆盖层固定 root `1.1.15@9bae9f2...` 与 `hbb_common@83419b6...`，已在干净源码重复应用并通过 `cargo test --locked`、digest-pinned 多阶段 arm64 custom image、非 root 运行和 fork marker smoke。relay 配对时只向全局 `USAGE` 注册一次 `Arc`，周期更新改为每会话 sequence-fenced atomics；TCP `BytesMut.freeze()` 与 WebSocket 原生 `Vec` 在同协议转发时直接移动，仅混合协议边界发生转换。三次 Apple M5 操作级基准中，usage 更新下界由 `34.14-35.41 ns/op` 降至 `3.53-3.59 ns/op`，64 KiB WebSocket 接收转发分配路径由 `4003.95-4084.75 ns/op` 降至 `1029.67-1168.72 ns/op`；它们不证明 relay 吞吐或节点容量。不可变 Registry digest、SBOM/provenance、双 Windows 正确性、真实 desktop/file/reconnect 和物理容量仍为 `not_run`。
- RustDesk Windows package v6 在 placement 启用时强制 native-control v2。command claim、progress/result/recover、operation observation、evidence context/correlation/upload 和 native close 都校验同一 interaction/reservation/owner epoch；companion 只重写当前 external session 的小状态分片，旧 epoch 不会触发原生 API、上传或 emergency restart。签名客户端制品、双 Windows owner handoff 与物理行为仍为 `not_run`。
- Cell admission 的主备 lease 现在同时校验 topology SHA-256。节点顺序不影响指纹，但节点 ID、endpoint、控制 endpoint、状态、能力、profile 或容量变化都会产生新指纹；活动 lease 不匹配时保持待命，只有释放/过期后才以递增 epoch 接管。

本地验证：

```bash
npm run test:ivekit:capacity
npm run typecheck:ivekit:capacity-runtime
npm run verify:ivekit:component-hooks
node --import tsx --test \
  test/ivekit-capacity-event-ws-generator.test.ts \
  test/ivekit-capacity-tinode-generator.test.ts
npm run typecheck
COMPOSE_DISABLE_ENV_FILE=1 docker compose \
  --env-file infra/capacity/env.example \
  -f infra/capacity/docker-compose.yml config --quiet
```

这些命令验证代码合同和部署配置，不验证真实容量。服务器恢复后按
[`implementation-plan-phase2.md`](implementation-plan-phase2.md) 第 9 节执行真实验收。
