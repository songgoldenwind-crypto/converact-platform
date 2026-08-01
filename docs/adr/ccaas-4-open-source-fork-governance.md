# ADR-CCAAS-4：容量关键开源组件 Fork 与源码优化治理

**Status:** Proposed（2026-07-16）
**Decision owner:** Converact Fabric shared communication foundation
**Related:** [`../capacity/README.md`](../capacity/README.md)、[`../capacity/schemas/fork-manifest.schema.json`](../capacity/schemas/fork-manifest.schema.json)、[`../capacity/forks/ivekit-forks-v1.json`](../capacity/forks/ivekit-forks-v1.json)、[`ccaas-1-cell-placement.md`](ccaas-1-cell-placement.md)、[`ccaas-2-dual-zone-quorum.md`](ccaas-2-dual-zone-quorum.md)、[`ccaas-3-recording-evidence.md`](ccaas-3-recording-evidence.md)

## 1. 背景

Converact Fabric 选择 RustPBX、rsipstack、LiveKit、Tinode 和 RustDesk 作为语音、视频、IM 与远程协助底座。MIX-100K、双 Zone、Cell placement、owner epoch、统一 CapacityVector、精确 drain 和统一录制证据链不是这些项目现有上游版本共同提供的一套合同。

如果只在 Converact Fabric 外层增加适配器，会出现三个结构性问题：

1. 适配器看不到组件内部队列、锁、packet、fanout、codec、relay 和录制 spool 的真实瓶颈，无法做可信 admission。
2. owner epoch 只存在于控制面时，旧媒体节点、旧 topic owner 或旧远控 relay 仍可能在网络分区后执行副作用。
3. drain、过载拒绝、故障重建和录制回压如果没有进入组件状态机，只能靠进程重启或全局熔断兜底。

因此本 ADR 明确授权：

> 当上游接口、状态机、调度或热路径不能满足 Converact Fabric 的架构、性能、故障和审计要求时，可以直接修改开源项目源码并维护 Converact Fabric fork。不得为了保持零源码改动而降低 MIX-100K、双 Zone、Cell、精确控制、录制或一致性目标。

这项授权不等于无证据重写。源码改造仍以 profile、测量、合同、回滚和升级能力为约束。

## 2. 决策

### 2.1 核心决策

1. `Converact Fabric API + SDK + event + webhook` 是 Converact Platform、LED 和其他业务的稳定公共边界。
2. RustPBX、LiveKit、Tinode、RustDesk 的 fork 协议是 Converact Fabric 内部实现，不直接暴露给业务服务。
3. 所有容量关键组件必须进入机器可读 fork manifest；没有精确源身份、patch hash、artifact digest 和验证状态的组件不得成为容量证据的一部分。
4. 结构性能力缺口直接进入 maintained fork；局部、可独立应用的变更可以先用 patch queue 或 fail-closed overlay。
5. 性能改造必须由相同 profile 的前后证据证明；单个 microbenchmark 不能替代 interaction、Cell 和 Zone 验收。
6. 上游兼容是成本目标，不是功能上限。兼容与正确性、隔离、性能或可恢复性冲突时，以 Converact Fabric 合同为准。
7. fork 必须持续吸收上游安全修复和关键 bugfix；不能成为一次性复制后无人维护的代码快照。

### 2.2 不做的决策

本 ADR 不决定：

- 供应商商务授权、商业谈判或产品定价。
- LED、Converact Platform 的业务流程和页面。
- 100K 已经通过。当前所有容量数字仍按 `target/not_run` 管理。
- 未经 profile 的通用“极限性能”宣传口径。

工程仍记录 upstream repository、license 标识、notice、SBOM 和 provenance，目的是构建追溯与发布完整性，不在本文替代商务决策。

## 3. 何时必须改源码

满足下列任一条件，默认进入源码方案评审，不能只靠外层轮询或重启规避：

| 类别 | 触发条件 | 典型例子 |
| --- | --- | --- |
| 所有权 | 组件内部可能在 stale epoch 继续产生副作用 | 旧 SIP owner 发起转接、旧 topic owner 发布消息、旧 relay 接受控制 |
| Admission | 外部只能看到 CPU，无法原子预留关键维度 | RTP legs、track fanout、relay Mbps、recording slots |
| Drain | 上游只能停进程，不能停止新会话并保留旧会话 | RustDesk 精确 drain、LiveKit room drain、Tinode topic drain |
| 恢复 | 上游状态不足以确定性重建或去重 | LiveKit room rebuild、录制 job reconciliation、Tinode mutation |
| 一致性 | 外层投影与原生客户端永久分叉 | Tinode edit/delete 只在 Converact Fabric 生效 |
| 热路径 | profile 显示内部 allocation、lock、timer、copy 或序列化限制 safe capacity | RTP、SFU packet、IM fanout、RustDesk relay |
| 可观测性 | 缺少有界、低基数、可核对的容量与队列指标 | 活跃 dialog、topic owner、track、relay bytes、spool depth |
| 安全隔离 | 只有重启服务才能撤销单个会话或旧授权 | RustDesk exact disconnect、owner epoch fencing |

外部 adapter 仍适合以下情况：

- 上游已经提供完整、有版本的控制 API。
- 能在组件外准确观测并原子预留资源。
- 不需要改变内部状态机、网络协议、数据格式或热路径。
- adapter 失败不会导致旧 owner 继续执行副作用。

是否 fork 由能力合同决定，不以“改源码麻烦”为否决理由。

## 4. 集成模式

### 4.1 模式定义

| 模式 | 用途 | 生产身份 |
| --- | --- | --- |
| `upstream_image` | 上游能力完整，Converact Fabric 仅做外部集成 | release ref + image digest |
| `pinned_source` | 从精确 commit 构建，但无本地源码变化 | commit + lockfile + builder digest + artifact digest |
| `patch_queue` | 少量局部变更，能稳定重放到精确上游 commit | upstream commit + ordered patch hash + artifact digest |
| `overlay` | 对固定源码锚点注入少量平台代码，锚点漂移时 fail closed | upstream commit + overlay hash +生成器 hash + artifact digest |
| `maintained_fork` | 修改内部状态机、协议、热路径、数据格式或持续存在的架构能力 | internal commit + upstream base commit + artifact digest |

### 4.2 Patch queue 到 maintained fork 的升级条件

下面是升级信号，不是为了拖延 fork 的硬门槛：

- 改动跨越多个 crate/package 或核心状态机。
- 引入 owner epoch、reservation、drain、恢复日志或数据格式。
- 修改 packet、RTP、SFU、fanout、relay 等性能热路径。
- 需要维护内部协议的 N/N-1 兼容。
- 补丁经常与上游同一区域冲突。
- patch queue 超过 5 个逻辑补丁或约 1,500 行有效变更。
- 同一上游升级需要反复重写补丁顺序和隐式依赖。

一旦出现 owner、协议、持久状态或热路径改造，即使代码量很小，也可以直接进入 maintained fork。

### 4.3 当前组件分类

| 组件 | 当前模式 | 目标判断 |
| --- | --- | --- |
| RustPBX | 固定 commit + patch queue | 完成 Cell owner、recording fork 和热路径优化后转 maintained fork |
| rsipstack | 固定 commit + patch queue | 传输层改动保持 patch queue；若引入独立 admission/transaction scheduler 则转 fork |
| RustDesk Windows client | 1.4.9 fail-closed overlay | owner epoch、多屏/录制/传输状态深入客户端后转 maintained fork |
| LiveKit Server | 上游 1.13.3 baseline | Cell admission、owner epoch、drain、rebuild 和 hot-path 改造使用 maintained fork |
| LiveKit Egress | 上游 1.13.0 baseline | 先验证 adapter；缺少原子 admission、spool、epoch 或 reconciliation 时直接 fork |
| LiveKit SIP | 上游 1.6.0 baseline | 先明确与 RustPBX 的唯一 owner 边界；进入容量 profile 后再决定 fork |
| Tinode | 上游 0.25.3 baseline | topic owner、native mutation、Cell drain 和 fanout 优化使用 maintained fork |
| RustDesk Server | 上游 1.1.16 baseline | relay admission、epoch、drain、metrics 和 hot-path 优化使用 maintained fork |

## 5. 仓库与分支模型

### 5.1 代码位置

短期 patch queue 和 overlay 可以留在 Converact Platform monorepo：

```text
infra/converact/<component>/build.sh
infra/converact/<component>/patches/
integrations/<component-version>/
docs/capacity/forks/
```

maintained fork 使用独立受控仓库，逻辑命名：

```text
rustpbx-ivekit
livekit-converact
tinode-converact
rustdesk-server-converact
rustdesk-client-converact
```

独立仓库不是对业务拆成多个产品。运行时仍是一套 Converact Fabric 平台；独立 fork 只是隔离上游历史、构建权限和升级工作。

### 5.2 Git remote

每个 maintained fork 保留两个 remote：

```text
origin    -> Converact Fabric controlled fork
upstream  -> official upstream repository
```

禁止把 `origin/main` 直接重置到上游，也禁止在容量证据中引用浮动 branch。

### 5.3 分支与标签

```text
converact/main                    长期集成主线
converact/release/<upstream>      受支持发布线
converact/feature/<change-id>     与 manifest change_id 对应
converact/hotfix/<cve-or-defect>  紧急安全或生产修复
```

发布标签：

```text
converact/<upstream-version>+converact.<revision>
```

示例：

```text
converact/v1.13.4+converact.1
converact/0.25.3+converact.2
converact/1.1.16+converact.1
```

标签只能指向不可变 commit。容器、Windows installer 和符号包使用同一个 release identity，并在 fork manifest 中记录 digest。

## 6. Fork manifest 合同

[`fork-manifest.schema.json`](../capacity/schemas/fork-manifest.schema.json) 是 release identity 的机器可读合同。每个组件至少记录：

- upstream repository、version、exact commit/tag/digest。
- integration mode 和 lifecycle。
- source modification 是否允许；容量关键组件固定为 `true`。
- build script、builder image digest、lockfile、features 和 output identity。
- ordered patch/overlay path、SHA-256 和精确应用目标。
- implemented/planned change ID、涉及容量维度和验收证据。
- source、patch、compile、unit、integration、benchmark、real environment 的独立状态。
- production release gate 和阻塞原因。
- upstream sync、兼容和 rollback policy。

下列情况必须产生新的 manifest revision：

1. upstream commit、tag 或 image digest 变化。
2. patch/overlay 内容或顺序变化。
3. builder image、lockfile、feature、compiler 或 artifact digest 变化。
4. 内部协议版本、状态格式或兼容矩阵变化。
5. 任何 verification 状态获得新 evidence。

旧 manifest 永久只读。证据包通过 manifest ID 和 SHA-256 引用，不接受“当前 main”作为身份。

## 7. 可复现构建

### 7.1 输入必须固定

每个 candidate build 必须固定：

- 40 字符 upstream base commit。
- Converact Fabric fork commit 或 ordered patch SHA-256。
- submodule commit。
- Cargo.lock、go.sum、package lock、vcpkg baseline 等依赖锁。
- compiler/toolchain version。
- builder container digest；Windows build 记录 runner image/version 和依赖缓存 identity。
- build features、target、linker、CGO、CPU baseline 和环境变量白名单。

仅写 `v1.13.4`、`0.25.3` 或 `1.1.16` 不足以成为生产身份。tag 必须解析为 commit，容器 tag 必须解析为 digest。

### 7.2 输出

每个 release 输出：

```text
artifact
artifact.sha256
sbom.spdx.json or sbom.cyclonedx.json
provenance.json
fork-manifest-component.json
licenses-and-notices/
symbols-or-debug-info/
```

容器按 digest 部署。Windows installer、companion、client profile 和 overlay protocol 声明作为一个 release bundle 签名，禁止分别漂移。

### 7.3 Build provenance

provenance 至少包含：

- source repositories 和 commits。
- workflow identity 和 run ID。
- builder identity。
- dependency lock hashes。
- build command 和 feature set。
- artifact digest。
- build start/end time。
- 是否使用网络和外部下载。

不宣称尚未达到的 SLSA 等级；先保证字段完整、签名可验证、artifact 可追溯。

## 8. 内部协议与状态兼容

### 8.1 公共边界

Converact Platform/LED 只依赖：

- Converact Fabric HTTP/OpenAPI。
- Converact Fabric TypeScript/后续语言 SDK。
- Converact Fabric event schema。
- Converact Fabric webhook schema。

业务客户端不得直接依赖：

- `converact-rustpbx-rwi`。
- `ivekit-rustdesk-native-control-v2`；v1 只保留给关闭 Cell placement 的滚动兼容包。
- `rustdesk-native-evidence-v1`。
- fork 内部 placement、epoch、drain 或 CapacityVector transport。

这样可以替换底层实现，也允许 fork 独立升级。

### 8.2 Rolling upgrade

所有跨节点内部协议至少支持：

```text
N <-> N
N <-> N-1
```

发送端声明 protocol major/minor 和 capability bits。规则：

- 未知 major：fail closed，不执行副作用。
- 未知 optional minor capability：降级到双方交集。
- owner epoch、authorization、recording consent 和 tenant isolation 字段不得静默丢弃。
- rolling upgrade 期间 placement 只把 interaction 放到支持所需 profile/capability 的节点。

### 8.3 数据格式

涉及持久状态时采用 expand/migrate/contract：

1. 新版本先支持旧读和双写或可逆投影。
2. 后台迁移并核对计数、checksum 和 owner epoch。
3. 完成 N/N-1 运行窗口后才移除旧字段。

禁止在发布 fork 二进制的同一不可回退步骤中执行破坏性 schema 删除。

## 9. Owner、Admission 与 Drain 的源码合同

每个 interaction owner 组件必须实现相同语义：

```text
Reserve(profile, required_capacity, placement_token)
Activate(reservation_id, owner_epoch)
Heartbeat(owner_epoch, capacity_vector)
BeginDrain(scope, deadline)
Recover(interaction_id, new_owner_epoch)
Close(interaction_id, owner_epoch, reason)
```

组件可以使用自己的语言和内部 API，但行为必须满足：

1. reservation 对所有 required dimensions 原子成功或全部失败。
2. `Activate` 幂等，同一 interaction 不重复扣容量。
3. 低于 current owner epoch 的 command、callback 和 evidence 全部拒绝。
4. drain 后不接受新 interaction；既有 interaction 按策略自然结束或有界重建。
5. CapacityVector 使用绝对单位，不能只报告百分比。
6. owner journal 不进入每个 RTP packet、track packet、IM fanout 或 RustDesk frame 热路径。

## 10. 性能改造方法

### 10.1 先建立可重复 profile

任何热路径改造前先固定：

- profile ID 和 SHA-256。
- component/fork manifest identity。
- CPU、NUMA、RAM、NIC、kernel、IRQ、容器限制和拓扑。
- generator 数量、位置和自身 headroom。
- codec、packetization、码率、分辨率、simulcast、fanout、relay、录制比例。
- steady、burst、soak、故障注入和 SLO。

缺少这些输入的“快了 2 倍”不进入架构结论。

### 10.2 测量顺序

```text
correctness baseline
  -> CPU/flamegraph
  -> allocation/GC
  -> lock/block profile
  -> scheduler/timer
  -> syscall/socket/PPS
  -> memory bandwidth/NUMA
  -> network/packet loss
  -> storage/spool/object upload
  -> database/event bus
```

只优化当前 dominant resource。一个修改如果把 CPU 瓶颈换成不可观测的队列或数据丢失，不算成功。

### 10.3 可采用的源码方向

经 profile 证明后，可以直接采用：

- 减少 packet/frame/message 热路径 allocation 和复制。
- 批处理 socket、fanout、持久化和指标更新。
- 分片锁、actor/mailbox、connection registry 和 timer wheel。
- per-core worker、CPU affinity、NUMA-local queue 和内存池。
- codec passthrough，避免不必要转码。
- recording fork 与异步 uploader 解耦。
- bounded queue、backpressure 和显式 overload rejection。
- Rust async runtime、Go scheduler、buffer pool 和 syscall 路径优化。
- 必要时引入 io_uring、SO_REUSEPORT、eBPF observability 或用户态网络实验。

DPDK、kernel bypass、GPU codec 和专用硬件不是默认前提。只有在标准 Linux 网络栈和源码优化仍不能满足服务器效率目标、且故障与运维成本可接受时进入独立 ADR。

### 10.4 禁止的伪优化

- 关闭 SRTP、鉴权、审计、录制、病毒扫描或 epoch 校验来提高数字。
- 删除重试、幂等、回压或持久化而不修改 profile 语义。
- 只测建立连接，不传真实媒体、消息或远控数据。
- 把 generator 饱和误判为服务端上限。
- 使用平均值掩盖 P95/P99、丢包、重连和失败率。
- 用 crash limit 代替 safe capacity。

## 11. 验证阶梯

每个 fork release 按以下阶梯推进：

| Gate | 内容 | 能否用于生产容量承诺 |
| --- | --- | --- |
| G0 Identity | commit、patch hash、lock、builder、artifact digest 完整 | 否 |
| G1 Build | clean build、SBOM、provenance、重复构建检查 | 否 |
| G2 Functional | unit、protocol、security、migration、compatibility | 否 |
| G3 Component | 单节点 steady/burst/soak、故障和 profiling | 仅 component evidence |
| G4 Cell | Cell-10K/Cell-25K placement、admission、drain、node loss | 仅 Cell evidence |
| G5 Platform | MIX-100K 双 Zone、Zone loss、quorum、reconnect | 可形成 platform_pass |
| G6 External | PSTN、真实 Provider、双 Windows、真实对象存储等 | 才可形成声明范围内 production_pass |

G0-G2 不能因为“只是性能补丁”而跳过。G3 的单节点峰值不能推导 G5。

### 11.1 性能回归门槛

同硬件、同 profile、同配置下：

- safe capacity 不得无解释下降超过 5%。
- P95/P99 latency、packet loss、reconnect、message delivery 和 input latency 不得越过 profile SLO。
- CPU、memory、network、PPS、storage、queue depth 必须同时报告。
- 正确性或安全修复允许有性能成本，但必须记录新 capacity result，不能继承旧承诺。

### 11.2 证据不可替代规则

- compile pass 不等于 functional pass。
- mock integration 不等于真实媒体链路。
- 单机 pass 不等于 Cell pass。
- Cell pass 不等于双 Zone pass。
- 内部环境 pass 不等于真实 Provider、PSTN 或 Windows pass。

## 12. 上游同步

### 12.1 周期

- 每 30 天检查一次上游 release、关键 commit 和依赖变化。
- critical security issue 在 1 个工作日内完成影响判断，目标 7 天内生成通过适用 gates 的修复 release。
- 高影响媒体、SIP、认证、加密和远控 bug 不等待月度窗口。

### 12.2 同步流程

1. 记录 old upstream base、new upstream base 和 release notes。
2. 建立新的 manifest revision，初始所有运行验证为 `not_run`。
3. rebase patch queue 或 merge maintained fork。
4. 冲突逐项关联 change ID；禁止为完成合并而静默删除 Converact Fabric 行为。
5. 运行 G0-G3；容量关键 release 再运行 G4。
6. 生成协议、配置、数据 schema 和性能差异报告。
7. canary 到一个非关键 Cell，再扩大到 Zone。
8. 保留上一 artifact digest 和兼容数据路径，直到观察窗口结束。

### 12.3 放弃某个上游版本

如果新上游版本：

- 破坏必要协议或状态机且修复成本高。
- safe capacity 明显回退且无功能收益。
- 引入无法接受的恢复、隔离或安全风险。

可以继续维护旧 release line，但必须记录安全支持期限和迁移计划。不能无限停留在无安全修复的版本。

## 13. 发布与回滚

### 13.1 发布单位

一个 fork 发布单位包含：

```text
source identity
artifact digest
configuration schema version
internal protocol range
data schema range
capacity evidence references
rollback artifact digest
```

只发布镜像、不发布 manifest 的构建不得进入生产 registry 的 release channel。

### 13.2 Canary

顺序：

```text
isolated component pool
  -> one Cell canary nodes
  -> one Cell
  -> one Zone subset
  -> both Zones
```

canary 期间新 interaction 可以按 profile/capability 定向；既有 interaction 不跨 owner 迁移，除非测试的正是恢复流程。

### 13.3 回滚

回滚要求：

- 上一 artifact digest 已验证且仍可拉取。
- N/N-1 protocol 和数据格式兼容。
- owner epoch 只增不减，回滚二进制不得恢复旧 lease。
- 新版本创建的 interaction 要么由兼容旧版本接管，要么在 drain 后回滚。
- 录制、消息 mutation、evidence 和 audit 不因回滚丢失 terminal state。

如果数据迁移不可逆，不允许把“重新部署旧镜像”写成回滚方案；必须先完成兼容迁移设计。

## 14. 安全与供应链

### 14.1 最小要求

- fork 仓库启用 protected branch、review 和签名 release。
- 构建使用最小权限 token，生产 registry 只接受 CI provenance。
- 依赖和基础镜像做 CVE 扫描。
- 每个 artifact 有 SBOM。
- Windows installer 和 companion 代码签名并核对 signer fingerprint。
- patch/overlay 工具对上游漂移 fail closed。
- secret、tenant data、录制和真实客户流量不得进入 benchmark fixture 或公开 fork issue。

### 14.2 安全边界不可外移

以下检查必须尽可能靠近执行副作用的组件：

- owner epoch。
- exact-session authorization。
- recording consent 和 retention identity。
- tenant/interaction binding。
- command idempotency。
- bounded input、queue 和 artifact path。

控制面检查通过后，fork 组件仍要验证签名 token 和 epoch。只相信内网来源不构成安全边界。

## 15. 可观测性

每个 fork 至少输出：

- build/version/manifest identity。
- owner lease/epoch 和 drain state。
- active/reserved/safe capacity 各维度。
- admission accept/reject/timeout/retry。
- bounded queue depth、oldest age、drop/reject reason。
- packet/message/frame/byte rate。
- reconnect、rebuild、stale epoch reject。
- recording/spool/upload/reconciliation。
- component-specific quality SLI。

Prometheus label 不得包含 `interaction_id`、`room_id`、`call_id`、`topic_id`、`session_id` 或 `tenant_id`。这些高基数字段进入 trace/log/evidence，并通过采样和保留策略控制。

## 16. 组件源码改造蓝图

### 16.1 RustPBX/rsipstack

必须进入源码的能力：

- Cell reservation、owner epoch 和 stale command fencing。
- SIP transport/transaction/dialog/RTP 的 CapacityVector。
- new-call drain、现有 dialog 完成和有界强制结束。
- recording fork、local spool 和 manifest correlation。
- RTP allocation/copy、timer、lock、codec passthrough 和 socket profiling/优化。
- overload 时明确返回 SIP 状态，不以超时作为默认回压。

首先把现有 patch queue 变成可验证 custom image；随后 owner/recording/hot-path 进入 maintained fork。

### 16.2 LiveKit Server/Egress

必须进入 Server fork 的能力：

- Cell reservation 和 node CapacityVector。
- placement token、room owner epoch 和 stale action fencing。
- room/node drain 与 signed snapshot。
- node loss 后 room rebuild metadata。
- 针对 1:1 AV/screen profile 的 packet/track/scheduler 优化。

Egress 保持独立 worker pool。TrackEgress 为主，RoomComposite 不超过 profile 中 1% 的 room；adapter 无法提供原子 slot、spool、epoch 和 reconciliation 时修改 Egress 源码，不降低录制目标。

### 16.3 Tinode

必须进入 fork 的能力：

- topic owner epoch、Cell shard placement、drain 和 recover。
- Converact Fabric edit/delete 映射为原生 mutation。
- connection/topic/fanout/persistence 的 CapacityVector 和 backpressure。
- outbox、native client 和 Converact Fabric projection 的幂等一致性。
- 90k WebSocket、60k active topic、5k steady/20k burst message profile 下的 hot-path 优化。

Tinode 原生 wire compatibility保留为目标，但不能绕过 Converact Fabric tenant、授权、文件安全和审计边界。

### 16.4 RustDesk Server/Client

Server fork：

- rendezvous/relay Cell placement、bandwidth/session admission。
- owner epoch、new-session drain 和 relay load metrics。
- desktop/frame/file-transfer workload 的 buffer/copy/socket/backpressure 优化。

Client/companion fork：

- exact-session disconnect，不用重启服务影响同机其他会话。
- owner epoch 覆盖控制、剪贴板、文件传输、录屏和证据上传。
- 两台 Windows 下多屏、重连、授权撤销和录制闭环。
- native evidence 仍必须经过统一 MIME、病毒扫描、隔离和 OCR/ASR/AI 链路。

## 17. 风险与控制

| 风险 | 控制 |
| --- | --- |
| 与上游分叉扩大 | 内部协议隔离、月度 sync、change ID、差异预算和 maintained owner |
| 性能优化破坏正确性 | 固定 profile、correctness-first、G2-G5 分层门禁 |
| 多组件同时改造难定位 | component profile 先行，Cell 集成按版本矩阵逐个推进 |
| rolling upgrade 协议不兼容 | N/N-1、capability negotiation、fail-closed major |
| 构建无法复现 | exact commit、builder digest、lockfile、SBOM、provenance |
| fork 漏掉安全更新 | 月度同步、critical 1 日研判/7 日 release 目标 |
| 优化只减少服务器却耗尽故障余量 | safe capacity 独立于 hard limit，Zone failure reserve 不参与正常 admission |
| 内部 fork 泄漏为业务合同 | Converact Platform/LED 只使用 Converact Fabric public API/SDK/event/webhook |

## 18. 实施顺序

### Phase F0：治理工具

1. 实现 fork manifest validator。
2. 校验 patch path/hash、commit/tag/digest 和 production gate invariant。
3. evidence bundle 自动引用 manifest SHA-256。
4. CI 禁止容量测试使用未登记 artifact。

### Phase F1：现有改造闭环

1. RustPBX/rsipstack patch queue clean clone、apply、compile、unit 和 integration。
2. 生成 custom image digest、SBOM 和 provenance。
3. RustDesk 1.4.9 tag 解析 commit，Windows overlay apply/compile/package。
4. 不把真实双 Windows 尚未运行改写成 pass。

### Phase F2：Cell contract

1. 先实现 component-neutral placement/admission/owner protocol test kit。
2. RustPBX 接入，完成 voice Cell-10K。
3. Tinode 接入，完成 IM Cell-10K。
4. LiveKit 接入，完成 AV/screen Cell-10K。
5. RustDesk Server/Client 接入，完成 remote Cell profile。

### Phase F3：源码性能优化

每个组件按 profile 独立做：

```text
baseline -> profile -> one bottleneck -> one change -> correctness -> benchmark -> merge
```

不同时修改多个未知 dominant resource 后再猜测收益来源。

### Phase F4：平台合成

1. Cell-25K candidate。
2. MIX-100K 双 Zone steady/burst/soak。
3. node/Cell/Zone/quorum/object-storage/Provider 故障注入。
4. 服务器数量、headroom、功耗、网络和存储成本报告。

## 19. 验收标准

本 ADR 完成设计验收需满足：

- fork manifest Schema 和实例 JSON 可解析并通过 Schema 校验。
- 当前八个容量关键组件均有明确 source identity 和诚实 verification 状态。
- 所有现存 patch/overlay 的 path 与 SHA-256 可重算。
- RustPBX 默认 upstream runtime 与 custom candidate 的差异被明确记录。
- 每个 planned source change 有唯一 change ID、容量维度和证据要求。
- public API 与 fork internal protocol 边界无歧义。
- release、rolling upgrade、upstream sync、security、canary 和 rollback 均有可执行规则。

实现与生产验收则需后续 evidence 证明，本文不会把设计完成写成容量完成。

## 20. 结论

Converact Fabric 不把上游项目当前结构视为不可修改的边界。对 MIX-100K 来说，真正稳定的边界是 profile、CapacityVector、owner epoch、recording manifest 和 Converact Fabric public contract。

RustPBX、LiveKit、Tinode、RustDesk 可以被深度修改，甚至长期维护 fork；但每一次修改都必须回答四个问题：

1. 它解决了哪个可重复 profile 中的能力或性能瓶颈？
2. 它如何保持 interaction ownership、tenant isolation 和审计正确？
3. 它如何滚动升级、吸收上游和回滚？
4. 哪个 evidence bundle 证明它提高了 safe capacity，而不只是提高 crash limit？

只有这四项同时成立，源码改造才会真正让单节点更强、让 Cell 更少、并使单套平台能够可信地横向扩展到 100,000 并发通信。
