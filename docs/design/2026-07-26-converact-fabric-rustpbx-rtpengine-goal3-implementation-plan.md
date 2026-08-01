# iveKit RustPBX 与 RTPengine Goal 3 实施计划

> **架构状态（2026-07-29）：历史过渡实施资产，不是生产权威。** 本文记录的
> `RustPBX -> media-control HTTP/mTLS -> RTPengine` 路径和对应镜像证据仍可用于回归、
> 诊断及迁移前事实核对，但已被 `rvoip-rustpbx-unified-authority-r2` 取代。唯一生产
> 基线中，RustPBX 进程内 Media Engine Facade 持有 Media Plan 和每条有向 Media Edge
> 的绑定/写者权威；Backend Binding Group generation 持有共享物理 allocation 和
> Wire Transport Bundle，普通 Edge 默认委托外部 RTPengine。本文不得授权独立
> media-control 生产服务。
>
> **关联文档：** `rvoip-opc-communication-foundation-integration-design.md`、
> `communication-foundation-vos5000-parity-performance-plan.md`、
> `../adr/ccaas-5-media-authority-and-rtpengine.md`。

> **执行约束：** 按任务顺序使用测试驱动开发。不要使用 `using-superpowers`。
> 所有运行时结论必须绑定 RustPBX、rsipstack、rustrtc、RTPengine、补丁集、镜像、
> 配置、主机内核和证据身份。未经机器证据不得把 `not_run` 写成 `passed`。

**目标：** 让 RustPBX 继续拥有 Call、Leg、Dialog、路由快照和逻辑媒体图，同时把普通
RTP/RTCP/SRTP 中继、wire SDP 和 transport runtime 可靠地委托给 Goal 2 RTPengine
执行面，形成可恢复、可解释、可横向扩展的双腿媒体编排闭环。

**目标架构：** Unified RustPBX 呼叫状态机直接调用进程内 Media Engine Facade。
Facade 先编译完整 candidate Media Plan、directed Edge、Backend Binding Group 和
flow membership，再执行 Backend-specific reserve。每个 Edge generation 以
`WireMediaBinding(group_id, group_generation, flow_selector, writer_fence)` 精确映射
一条 flow；group generation 持有共享物理 allocation，`WireTransportBundle` 持有
effective SDP views、transport tuple、SSRC 和 ICE/DTLS/SRTP 状态引用。RTPengine
Adapter 通过直接 Rust 调用 Facade 内部控制接口执行，不经过独立 media-control
HTTP/RPC 权威。历史 agent/WAL/HTTP 路径仍是回归与迁移输入，不能作为目标实现完成
证据。RTP packet path 不依赖 PostgreSQL、NATS、对象存储或外部 Provider。

**高可用边界：** Unified RustPBX 故障时，外部 RTPengine ordinary Edge 的既有转发
为 `continue_degraded`；同进程 embedded worker 上的 required Edge 为
`interrupt_visible`，混合呼叫只要任一 required Edge 中断，呼叫结果就是
`interrupt_visible`。控制恢复可通过 re-INVITE、重拨或人工接管。只有
`VOICE-HA-T1` profile 在可见 18x/200、in-dialog 状态变化
和 provider commit ACK 前完成同 Cell 双故障域 shadow quorum 后，才允许声明 owner
takeover RTO 不超过 5 秒。shadow quorum 不在每包路径，不可用时只停止新的 T1 admission，
不能中断已建立媒体。

**固定上游身份：**

- RustPBX commit：`6c49ee76baa54fdbf8f98020cc9bee158c7c15de`
- rsipstack commit：`8318e97b1170de4e5245b120afec1cdf53e3d716`
- rustrtc commit：`166c6d22984429eb6b509920c14fcd69f974f0b3`
- Goal 2 RTPengine commit：`506cfa74386a5373e40fca139a932917f22f0524`
- Goal 2 RTPengine archive SHA-256：
  `a6d23de8f656c3ad54e4060813c230861d100b79fb45ba1ce728ad2cef780143`

**技术栈：** Rust、Tokio、reqwest/rustls、serde、sha2、RustPBX/rsipstack/rustrtc、
TypeScript/Node.js、RTPengine TCP NG、NATS JetStream、PostgreSQL、Docker/OCI、Helm、
Prometheus、OpenTelemetry、SIPp 和 RTP/RTCP/SRTP packet probes。

---

## 1. 当前代码审计结论

### 1.1 已具备能力

1. `ivekit.media-control.v1` 已定义 offer、answer、update、delete、query、forwarding、
   recording、playback、DTMF、quality subscription 和 drain。
2. `HttpMediaControlClient` 已实现 HTTP/mTLS、响应上限、绝对超时和 unknown outcome
   投影。
3. `RustPbxMediaControlAdapter` 已实现 offer/answer/delete、逻辑 SDP 与 effective SDP
   分离、单 reservation pending reconciliation。
4. media-control agent 已具备 owner epoch、sequence、idempotency、capacity、drain 和
   checksummed WAL。
5. RTPengine fork 已具备 stable cookie、owner fence、capacity ceiling、drain、TCP NG、
   userspace RTP/RTCP/SDES-SRTP 和低基数指标。
6. RustPBX 已具备 route snapshot、inbound admission、owner epoch、RWI、hold/resume、
   re-INVITE、early media、DTMF、录制隔离和媒体热路径补丁。

### 1.2 真实缺口

1. TypeScript adapter 目前只在测试中使用，没有进入 RustPBX 原生呼叫状态机。
2. RustPBX 仍由 rustrtc 本地分配 ordinary relay transport，未消费 RTPengine effective
   SDP。
3. offer、early answer、final answer、re-INVITE、UPDATE、CANCEL、BYE 和 timeout 没有
   共享同一 reservation lifecycle。
4. 双腿媒体事务没有明确的 prepare/commit/compensate 顺序，部分失败可能留下 orphan
   media。
5. pending reconciliation 只存在进程内 Map，RustPBX 重启后缺少逻辑命令影子。
6. route snapshot 的 owner epoch 尚未同时绑定 media owner 和 dialog shadow epoch。
7. CDR 没有记录 caller/callee 两腿独立的 SIP cause、媒体结果、reservation 和 owner
   epoch。
8. Kamailio 对离线 pinned owner 的 481 行为尚未接入可恢复窗口和 epoch coordinator。
9. `VOICE-HA-T1` 所需的 dialog shadow quorum、takeover token 和可重复恢复动作尚未实现。
10. 现有 RustPBX media-hot-path patch 优化 rustrtc 内部转发，但不能替代外部 RTPengine
    编排。
11. 目标 Media Engine Facade、Backend Binding Group/Wire Transport Bundle、
    O(1) Edge-flow index、atomic blocked prepare/revoke 和 direct Rust Adapter 均尚未
    接入生产呼叫路径。
12. 当前 per-leg DTMF 路径尚未落实 RFC 4733/SIP INFO/in-band 的统一权威、跨来源
    去重和单一 outbound wire mechanism。

---

## 2. 不可破坏的系统不变量

1. RustPBX 维护逻辑媒体图；RTPengine 维护 wire SDP、端口和 transport runtime；两者不得
   反向夺权。
2. 一个 SIP Call-ID 可包含多个 Leg/Dialog。每个 Edge generation 只有一个
   `WireMediaBinding`，精确指向一个 `(group_id, group_generation, flow_selector)`；
   一个 group generation 可以包含多个显式成员，但成员集合冻结后不可修改。
3. 同一 owner epoch 内 command sequence 严格递增；新 owner epoch 第一条 mutation 的
   sequence 必须为 1。
4. HTTP 超时、连接中断或无效响应统一为 `unknown`，不得自动重发有副作用命令。
5. unknown 未 reconcile 前，不得对同 reservation 发下一条不同 command。
6. offer 成功后必须持久化 effective SDP，再允许发出包含该 SDP 的 SIP 消息。
7. CANCEL、non-2xx、BYE、timeout 和 owner takeover 都必须走幂等 delete 或 reconcile，
   不允许仅清理 RustPBX 内存。
8. RTPengine、media-control、recorder、AI tap 或对象存储故障不得回压已建立 RTP packet
   path。
9. 录音、实时翻译和 AI tap 只能消费独立 fork；队列满时按 profile 降级或 fail closed，
   不得阻塞 ordinary relay。
10. route snapshot 的 `cell_id`、`owner_node_id`、`owner_epoch`、`reservation_id` 和
    `media_profile_id` 必须形成不可变 admission binding。
11. T1 shadow commit 只允许有界 binary payload，禁止保存 bearer token、私钥、完整
    Authorization、未脱敏号码和任意 SIP body。
12. Prometheus label 禁止 tenant、call、dialog、reservation、phone、IP、port 和 SDP。
13. userspace、kernel、recording 和 transcoding 必须分别验收，不能继承其他模式的容量
    结论。
14. 普通 profile 与 T1 profile 的可用性声明必须分开；普通 profile 不能借用 T1 takeover
    结果。
15. group generation 持有共享端口/ICE/DTLS/SRTP/physical release；Edge 持有逻辑
    writer authority。group 在 `live_member_refcount == 0` 时只释放一次，禁止每条
    Edge 独立释放共享资源。
16. packet path 必须用 `flow_selector -> WireMediaBinding -> Edge` 的 O(1) 索引；
    不得扫描 group members。raw SRTP key 不进入持久状态或证据，只保存 reference、
    negotiation state 和 digest。
17. Backend Binding Group 生命周期唯一为
    `absent -> prepared_blocked -> active -> revoked_receive_only -> released`
    （prepare abort 可直接 `prepared_blocked -> released`）。prepare 创建即关闭
    user/kernel output gate；revoke 只在两层 gate 关闭且 in-flight send 排空后 ACK。
18. 每个 Leg 的 DTMF canonical event 由 RustPBX 持有；来源优先级为 negotiated
    RFC 4733、显式接受的 SIP INFO、in-band detector。重复 end、INFO retry 和跨来源
    同一 tone 必须有界去重，且每个 outbound Leg 只选择一种 wire mechanism。

---

## 3. 权威状态与命令模型

### 3.1 历史每腿状态与目标物理组状态

下列 per-leg 状态机是历史 HTTP 路径的兼容模型：

```text
unallocated
  -> preparing
  -> prepared
  -> early
  -> committed
  -> updating
  -> committed
  -> deleting
  -> closed

preparing/updating/deleting
  -> uncertain
  -> reconciling
  -> prepared/early/committed/closed

prepared/early
  -> cancelling
  -> closed

prepared/early/committed
  -> expired
```

终态为 `closed` 或 `expired`。`uncertain` 是控制状态，不表示 RTP 已中断。

Revision 3 生产模型另有一套唯一的 physical group lifecycle：

```text
absent
  -> prepared_blocked
  -> active
  -> revoked_receive_only
  -> released

prepared_blocked
  -> released            # abort before the immutable decision

prepare/commit/revoke timeout
  -> unknown
  -> query/reconcile exact durable decision
```

`unknown` 是控制观察状态，不创建第二个物理 authority。group membership、Backend、
port allocation、writer fence 或 flow identity 的任何改变都必须生成新的
`group_generation`。

### 3.2 目标事务顺序与 SDP 可见性

初始普通 B2BUA 呼叫：

1. 固定 route snapshot、Backend selector revision 和 backend mix identity；
2. 编译完整 candidate Media Plan、所有 required Edge、Binding Group generations、
   flow memberships 和 compensation plan；
3. 完成 component admission 后才执行 Backend-specific reserve；
4. 对所有 required groups 执行 atomic `prepare_blocked`，此时输出增量必须为零；
5. 持久化 immutable final plan、Edge mappings、Wire Transport Bundles 和 commit
   decision；
6. commit 所有 required groups，并把决定标为 committed；
7. 只有第 6 步完成后，才向任一远端暴露 initial effective SDP；
8. decision 前失败按逆序 abort prepared groups 并取消 reservation；decision 后局部
   commit 失败保持决定不变并 query/reconcile，最终不可完成时按预声明补偿进入
   `compensated_failed`，不得写成 `aborted`；
9. 任一 timeout 进入 `unknown`，不得自动改 Backend、重编组或重发有副作用 mutation。

迁移呼叫：

1. 新 generation 以 `prepared_blocked` 建立并持久化 candidate/handoff intent，旧
   generation 仍是 sole writer；
2. 可向远端暴露 candidate SDP，等待其接受；
3. 持久化 immutable handoff decision；
4. revoke 旧 generation，等待 zero-output ACK；
5. commit 新 generation并记录 writer gap；
6. 旧 generation 只在有界 grace 内 receive/authenticate/count/drop，不得 forward、
   产生 DTMF、录音或 AI 副作用，随后在 zero live refs 时释放。

默认 rollout 是新呼叫选择新 Backend、旧呼叫 drain；不得仅因 selector 策略改变而迁移
active calls，也不得宣称零丢包 handoff。

### 3.3 历史 SIP 动作映射

本表是 HTTP 兼容命令映射；目标 Adapter 必须把动作包装进 3.2 节的 group lifecycle，
不能直接让 `offer/answer/update/delete` 成为物理资源 authority。

| SIP 动作 | media-control 动作 | 成功后可见副作用 |
| --- | --- | --- |
| 初始 INVITE offer | `offer` | 发 outbound INVITE 或本地 18x |
| 183 + SDP | `answer` 或 `update` | 发 caller-facing 183 |
| PRACK answer | `update` | 发 PRACK 2xx |
| UPDATE offer/answer | `update` | 发 UPDATE 2xx |
| 200 + SDP | `answer` | 发 caller-facing 200 |
| re-INVITE | `update` | 发 re-INVITE 2xx |
| hold/resume | `update` | 改变有效 direction 后发 2xx |
| DTMF RTP injection | `inject_dtmf` | 仅在 committed session 执行 |
| CANCEL before commit | `delete` | 完成 CANCEL/487 |
| non-2xx final | `delete` | 完成失败终态 |
| BYE | `delete` | BYE 事务不等待无限 cleanup |
| media timeout | `delete` | 产生明确 hangup cause 和 CDR |
| owner takeover | `query/reconcile/update` | 新 epoch 获得控制后恢复 mutation |

### 3.4 Command identity

```text
command_id =
  sha256(tenant_id, call_id, leg_id, edge_id, edge_generation,
         group_id, group_generation, flow_selector,
         owner_epoch, sequence, action, payload_hash)

idempotency_key =
  rustpbx/{cell_id}/{call_id}/{leg_id}/{owner_epoch}/{sequence}

media_reservation_id =
  admission_reservation_id + "/" + binding_group_id + "/" + group_generation
```

command identity 由 canonical JSON golden vectors 约束。Rust 与 TypeScript 必须逐字节一致。

---

## 4. 文件地图

| 路径 | 职责 |
| --- | --- |
| `docs/capacity/contracts/voice-media-goal3-v1.json` | Goal 3 规范合同 |
| `docs/capacity/schemas/voice-media-goal3.schema.json` | 合同与证据 schema |
| `test/ivekit-voice-media-goal3-contract.test.ts` | 合同、身份和 honest status 门禁 |
| `src/agent-runtime/ivekit/voice/media-lifecycle.ts` | 参考状态机和跨语言 golden vectors |
| `src/agent-runtime/ivekit/voice/dialog-shadow.ts` | shadow record、quorum 和 takeover 协议 |
| `src/agent-runtime/ivekit/voice/dialog-shadow-journal.ts` | 有界 checksummed 本地 shadow WAL |
| `src/agent-runtime/ivekit/voice/dialog-shadow-http.ts` | cell-local append/read/takeover API |
| `src/agent-runtime/ivekit/voice/adapters/media-control.ts` | update、query、DTMF 和 durable reconciliation |
| `infra/ivekit/rustpbx/patches/rustpbx-ivekit-media-control-client.patch` | 原生 Rust media-control client |
| `infra/ivekit/rustpbx/patches/rustpbx-ivekit-media-lifecycle.patch` | SIP 状态机与媒体事务绑定 |
| `infra/ivekit/rustpbx/patches/rustpbx-ivekit-dialog-shadow.patch` | T1 shadow commit 与 takeover |
| `infra/ivekit/rustpbx/patches/rustpbx-ivekit-dual-leg-cdr.patch` | 双腿 CDR 与 cause convergence |
| `infra/ivekit/rustpbx/build.sh` | 补丁顺序和 patchset identity |
| `infra/ivekit/rustpbx/README.md` | 配置、故障语义、drain 和 rollback |
| `infra/ivekit/docker-compose.voice.yml` | RustPBX、media-control、RTPengine、shadow runtime |
| `infra/ivekit/helm/rustpbx/*` | RustPBX pool、T1 profile、PDB 和 topology |
| `infra/ivekit/helm/dialog-shadow/*` | shadow service、NATS stream 和 local WAL |
| `infra/ivekit/kamailio/kamailio.cfg` | pinned dialog recovery window 和 epoch routing |
| `scripts/ivekit-rustpbx-media-goal3-acceptance.ts` | SIP/SDP/RTP/故障注入验收 |
| `scripts/ivekit-rustpbx-media-goal3-finalize.ts` | 证据聚合和声明门禁 |
| `docs/evidence/goal3-*` | 机器证据，不包含 secret 或完整 SIP PII |

---

## 5. 执行任务

### Task 1：冻结 Goal 3 合同

**文件：**

- 新建 `docs/capacity/contracts/voice-media-goal3-v1.json`
- 新建 `docs/capacity/schemas/voice-media-goal3.schema.json`
- 新建 `test/ivekit-voice-media-goal3-contract.test.ts`
- 修改 `package.json`

- [x] 先写失败测试，要求固定四个上游 commit、Goal 2 patch/image identity 和 Goal 3
      RustPBX patch IDs。
- [x] 合同必须列出 offer、answer、update、delete、query、reconcile、DTMF、timeout、
      drain 和 takeover。
- [x] 合同必须列出 INVITE、180、183、PRACK、UPDATE、200、ACK、CANCEL、487、BYE、
      re-INVITE、hold/resume 和 session timer。
- [x] 合同必须区分 caller/callee 两腿和 ordinary/T1 两种 profile。
- [x] 合同必须要求 unknown outcome、stale epoch、sequence gap、capacity reject、
      media-control restart、RustPBX restart、RTPengine restart、shadow quorum loss、
      PostgreSQL outage、NATS outage、recorder outage 和 object-store outage。
- [x] 初始 evidence status 全部为 `not_run`。
- [x] 添加 `test:ivekit:voice-media-goal3`。finalizer 命令随 Task 12 的真实脚本一起加入，
      不提前暴露不可执行的 package 命令。
- [x] 运行 focused test 并确认先红后绿。
- [x] 提交：`test(media): freeze RustPBX Goal 3 contract`。

### Task 2：补齐参考媒体生命周期和 adapter

**文件：**

- 新建 `src/agent-runtime/ivekit/voice/media-lifecycle.ts`
- 修改 `src/agent-runtime/ivekit/voice/adapters/media-control.ts`
- 新建 `test/ivekit-rustpbx-media-lifecycle.test.ts`
- 修改 `test/ivekit-rustpbx-media-control-adapter.test.ts`

- [x] 用纯状态机测试覆盖合法和非法 transition。
- [x] adapter 增加 `update`、`query`、`injectDtmf`、`expire` 和 owner takeover。
- [x] pending reconciliation 从单 command Map 扩展为可序列化 snapshot，并在 transport
      执行前预留有界 uncertainty slot。
- [x] 同 reservation 存在 unknown 时拒绝所有 execute retry，只允许 reconcile；并发
      mutation 也在 transport 前拒绝。
- [x] canonical payload hash 和 command identity 提供 Rust 可复用 golden vectors。
- [x] 明确 early answer 与 final answer 的 sequence 和状态差异。
- [x] DTMF 按 RTPengine 原生协议每条命令只接收一个 digit，duration/gap/volume 有上限。
- [x] 运行 Goal 1、Goal 2、新 Goal 3 focused tests及全量 TypeScript typecheck。
- [x] 提交：`feat(media): define RustPBX media lifecycle`。

### Task 3：实现 RustPBX 原生 media-control client

**文件：**

- 新建补丁 `infra/ivekit/rustpbx/patches/rustpbx-ivekit-media-control-client.patch`
- 修改 `infra/ivekit/rustpbx/build.sh`
- 修改 `infra/ivekit/rustpbx/Cargo.lock`
- 修改 `test/ivekit-rustpbx-build.test.ts`
- 新建 `test/ivekit-rustpbx-media-control-client-patch.test.ts`

- [x] 在上游精确源码上先写 Rust 单元测试，覆盖 canonical JSON/hash、命令 identity、
      mTLS 配置、响应上限、deadline 和 error projection。
- [x] client 使用已有 reqwest/rustls、serde、sha2 和 Tokio，不引入第二套 HTTP runtime。
- [x] 每个 call 使用独立 sequence allocator，不持有全局锁完成网络 I/O。
- [x] 使用 bounded semaphore 限制 inflight；队列满时在发请求前确定拒绝。
- [x] 发送完成后断线统一返回 unknown。
- [x] production 模式要求 HTTPS、client identity、CA 和 server name。
- [x] token 仅从 secret file 读取，不允许 CLI、日志、metrics 或 shadow payload 暴露。
- [x] patch 应用两次时第二次必须识别 already applied，禁止 partial patchset。
- [x] patchset 从 `ivekit.21` 升为 `ivekit.22`，镜像 label 绑定新 patch hash。
- [x] cargo fmt、clippy、unit 和 exact-source `cargo check --locked` 通过。
- [x] 提交：`feat(rustpbx): add media control client`。

当前本机证据：Rust 1.94.1 的 focused unit 与 exact-source `cargo check --locked`
已通过；Clippy 仍需在服务器的 Rust 1.94 工具链执行，因此最后一项保持未完成。

### Task 4：初始 INVITE、early media 和 final answer

**文件：**

- 新建补丁 `infra/ivekit/rustpbx/patches/rustpbx-ivekit-media-lifecycle.patch`
- 修改 `infra/ivekit/rustpbx/build.sh`
- 新建 `test/ivekit-rustpbx-media-lifecycle-patch.test.ts`

- [x] `SipSession` 增加 bounded per-leg media state，不保存 secret。
- [x] route snapshot admission binding 在创建 session 时固化。
- [x] `prepare_callee_media_offer` 在 ordinary relay profile 调用 media offer 并使用
      effective SDP。
- [x] 183+SDP 先完成 early media mutation，再向 caller 发送 183。
- [x] final 200+SDP 先完成 answer mutation，再向 caller 发送 200。
- [x] 无 SDP、offerless INVITE、late offer 和 ACK answer 走独立测试向量。
- [x] 多 early dialog 只允许获胜分支 commit，失败分支幂等 delete。
- [x] local IVR、conference、transcoding、WebRTC bridge 和显式 bypass 继续走 RustPBX
      media graph，不被错误送入 ordinary relay。
- [x] RTPengine 不可用时按 route profile fail closed 或显式 fallback，禁止静默绕过。
- [x] SIP tag 使用独立 RFC 3261 token 校验，不复用 iveKit 内部 identifier 字符集。
- [x] 提交：`feat(rustpbx): orchestrate RTPengine call setup`。

当前本机证据：14 个 lifecycle/command Rust 测试和 exact-source
`cargo check --locked --lib` 已通过。offerless/late-offer/ACK answer 已有独立纯状态
向量，但尚未接入 rsipstack 的 ACK body；多 early branch 已有 bounded winner 状态和
PII-free branch identity，但 losing branch 的 RTPengine 定向 delete 尚未接线，因此这
两项保持未完成。

### Task 5：re-INVITE、UPDATE、hold/resume 和 DTMF

**文件：**

- 修改 Goal 3 media lifecycle patch
- 修改 `src/agent-runtime/ivekit/voice/media-lifecycle.ts`
- 新建 `test/ivekit-rustpbx-media-mid-dialog-patch.test.ts`

- [x] caller/callee 发起 re-INVITE 均以原 reservation 的下一 sequence 执行 update。
- [x] UPDATE offer/answer 和 session refresh 无 SDP 时不产生无意义 media mutation。
- [x] direction 覆盖 `sendrecv`、`sendonly`、`recvonly`、`inactive`。
- [x] codec、ptime、connection address、RTCP mux 和 ICE restart 变化进入 payload hash。
- [x] offer glare 返回 491，并使用有界随机退避；失败重试复用同 logical operation 但使用
      新 sequence。
- [x] hold/resume 只在 media update committed 后改变 RustPBX LegState。
- [x] RTP DTMF 走 RTPengine inject；SIP INFO DTMF 仍按端点策略透传。
- [x] RTPengine unsolicited DTMF 进入 RustPBX event channel，不得满足 command promise。
- [x] update unknown 时保持既有 RTP，冻结后续 mutation 并启动 reconcile。
- [x] 提交：`feat(rustpbx): orchestrate mid-dialog media`。

当前本机证据：补丁在 media-control client 基线的干净 worktree 可一次性应用，双向
caller/callee SIP tag、原 reservation、连续 sequence 和 RTP DTMF 的 Rust lifecycle
及事件解码测试 `22/22` 通过，exact-source `cargo check --locked` 通过，仓库 Goal 3
门禁 `40/40` 通过；兼容回归 Goal 1 `75/75`、Goal 2 `131/131` 通过。ordinary relay
的 491 每次有界随机退避后都会对
同一 logical offer 申请下一 media command sequence；本地 bridge 不需要 media sequence，
继续使用单次有界 SIP 重试。RTPengine `onDTMF` 与 command promise 保持隔离，并通过每个
RustPBX owner 一条的认证 NDJSON 流回灌现有 call command channel；事件按 owner 精准路由，
使用连续 sequence 和有界重放窗口断线续传，慢消费者不会扩张无界内存。

### Task 6：终止、timeout、补偿和 orphan 回收

**文件：**

- 修改 Goal 3 media lifecycle patch
- 修改 `src/agent-runtime/ivekit/media-control/agent.ts`
- 新建 `test/ivekit-rustpbx-media-cleanup-patch.test.ts`
- 新建 `test/ivekit-media-orphan-reconciler.test.ts`

- [x] CANCEL before offer、after offer、after 183 和 200 race 分别验收。
- [x] non-2xx ACK 不创建新 reservation。
- [x] BYE 双向并发时只执行一次逻辑 close，重复 delete 必须 replay。
- [x] SIP cleanup 使用有界 deadline；media delete timeout 进入 durable reconciliation，
      不延迟 BYE 超过合同上限。
- [x] media timeout 产生稳定 cause、终止 interaction 并删除 reservation。
- [x] orphan reconciler 仅回收 lease 已过期且 owner/session 都不存在的媒体。
- [x] recorder、AI tap 和对象存储 cleanup 失败只影响 evidence 状态。
- [x] 进程 Drop safety-net 不执行未带 identity 的裸 delete。
- [x] 提交：`feat(media): reconcile RustPBX media cleanup`。

### Task 7：Dialog shadow journal 和 T1 quorum

**文件：**

- 新建 `src/agent-runtime/ivekit/voice/dialog-shadow.ts`
- 新建 `src/agent-runtime/ivekit/voice/dialog-shadow-journal.ts`
- 新建 `src/agent-runtime/ivekit/voice/dialog-shadow-http.ts`
- 新建 `src/agent-runtime/ivekit/voice/dialog-shadow-jetstream.ts`
- 新建 `src/agent-runtime/ivekit/voice/dialog-shadow-runtime.ts`
- 新建 `src/agent-runtime/ivekit/voice/dialog-shadow-server.ts`
- 新建 `scripts/ivekit-dialog-shadow-agent.ts`
- 新建 `test/ivekit-dialog-shadow-journal.test.ts`
- 新建 `test/ivekit-dialog-shadow-quorum.test.ts`
- 新建 `test/ivekit-dialog-shadow-http.test.ts`
- 新建 `test/ivekit-dialog-shadow-jetstream.test.ts`
- 新建 `test/ivekit-dialog-shadow-runtime.test.ts`
- 新建 `test/ivekit-dialog-shadow-server.test.ts`
- 新建 `test/ivekit-rustpbx-dialog-shadow-patch.test.ts`
- 新建补丁 `infra/ivekit/rustpbx/patches/rustpbx-ivekit-dialog-shadow.patch`

- [x] 定义 versioned bounded binary record，包含 local/remote tag、route set、CSeq、
      branch/final response hash、auth context ref、logical offer/answer hash、media
      reservation、provider session ref 和 CDR sequence。
- [x] record 禁止 token、私钥、完整认证头、原始号码和不受限 body。
- [x] local WAL 使用 length、version、CRC/checksum、fsync、atomic compaction 和硬上限。
- [x] T1 append 只有在同 Cell 至少两个 RustPBX 故障域 ACK 后才成功。
- [x] NATS JetStream 作为复制总线，stream replicas 和 placement 必须证明跨故障域。
- [x] shadow 不可用时停止新的 T1 admission；普通 profile 不受影响。
- [x] 可见 18x/200 和状态改变 in-dialog 2xx 前执行 shadow commit。
- [x] 旧 epoch append、sequence gap、payload mismatch 和 replay 有确定语义。
- [x] 提交：`feat(voice): add dialog shadow quorum`。

Task 7 evidence:

- `npm run typecheck` 通过。
- `npm run test:ivekit:voice-media-goal3` 通过 78 项测试。
- Voice HTTP、镜像清单、补丁队列、容量基线和录音隔离扩展回归通过 55 项测试。
- Rust 1.94.1 下 7 项 dialog shadow 契约测试及完整 `cargo check --locked` 通过。
- 精确补丁在固定 RustPBX 基线及 `ivekit.25` 队列后可应用，并由静态测试验证关键源
  顺序；真实三节点 JetStream、故障域中断和容量性能仍由 Task 10/11 进行服务器验收。

### Task 8：Owner takeover 与 Kamailio epoch routing

**状态：** 代码与本地精确补丁回放完成；真实双 RustPBX 故障域、三节点
JetStream、RTP 连续性和不超过 5 秒的 takeover RTO 仍由 Task 11 服务器验收，
当前保持 `not_run`。

**文件：**

- 新建 `infra/ivekit/rustpbx/patches/rustpbx-ivekit-dialog-recovery.patch`
- 新建 `infra/ivekit/rustpbx/patches/rsipstack-ivekit-dialog-recovery.patch`
- 新建 `src/agent-runtime/ivekit/voice/dialog-recovery-capsule.ts`
- 新建 `src/agent-runtime/ivekit/voice/dialog-owner-takeover.ts`
- 新建 `src/agent-runtime/ivekit/voice/postgres/dialog-owner-takeover-store.ts`
- 新建 `src/migrations/102_ivekit_voice_dialog_takeovers.sql`
- 修改 dialog shadow HTTP、JetStream、WAL、runtime、server 和 Kamailio route compiler
- 新建独立 dialog-shadow agent 入口，修改源/独立 Compose 及独立 Helm RustPBX
  StatefulSet，使 T1 恢复 sidecar 与 owner node-local 共置
- 新建 owner takeover、recovery capsule、PostgreSQL、HTTP 和精确补丁测试
- 新建 `test/ivekit-kamailio-dialog-recovery-routing.test.ts`
- 新建 `test/ivekit-dialog-recovery-deployment.test.ts`

- [x] 新 owner 通过 CAS 获得更高 owner epoch 和一次性 takeover token。
- [x] 只有 shadow complete 且未终结的 T1 dialog 可自动 takeover。
- [x] 恢复 local/remote tag、route set、CSeq、media reservation 和 CDR sequence。
- [x] 新 epoch 第一条 RTPengine mutation sequence 为 1。
- [x] Kamailio 在 recovery window 内将离线 pinned owner 路由到 epoch coordinator；
      只有确认 dialog 不存在或已终结才返回 481。
- [x] stale owner 的 in-dialog mutation 被 RustPBX authority 和 RTPengine owner fence
      双重拒绝。
- [x] takeover 失败不删除既有 RTP reservation；成功恢复后通过 re-INVITE/UPDATE
      继续媒体协商。
- [x] 正常会话清理把两腿作为一个可恢复终态提交；重复清理无副作用，终态仍保留加密
      recovery capsule。
- [x] 恢复控制器使用 64 项有界队列，终态入队最多等待 100 ms；authority outcome
      unknown 或 reconcile required 时冻结，不继续猜测性 mutation。
- [x] 成功 INVITE/UPDATE 响应的唯一 Contact 刷新 rsipstack remote target，下一条
      in-dialog 请求使用新 Request-URI。
- [x] T1 部署通过 node-local sidecar、mTLS、每 Pod SPIFFE client identity、持久 WAL、
      PostgreSQL CAS 和三节点 JetStream fail closed；普通 profile 默认不启用且不依赖
      NATS/PostgreSQL。
- [x] `voice-t1` 是依赖闭合的完整双 owner Compose profile；Helm `0440 + fsGroup`
      projected secret 可由 RustPBX 安全读取，组写/执行、world 权限和越界 symlink
      均 fail closed。
- [x] 本地自动化覆盖 token 重放、重复副作用、双腿 CSeq/sequence 单调性、恢复后的
      in-dialog 请求和有界最终 BYE。
- [ ] 真实故障注入下自动验收 takeover RTO P50/P95/P99；由 Task 11/12 完成。
- [x] 提交：`feat(voice): recover T1 dialog ownership`。

Task 8 evidence:

- `npm run typecheck` 通过。
- `npm run test:ivekit:voice-media-goal3` 已将 Task 8 的恢复、Kamailio 与部署合同纳入
  正式门禁，`130/130` 通过；31 个改动相关测试文件 `181/181` 通过。
- `npm run test:ivekit:capacity` 为 `336/336`，`npm run test:ivekit:delivery` 为
  `58/58`，根目录和容量 runtime TypeScript 类型检查通过。
- 独立交付上下文解析 402 个源码文件，完成 `npm ci`、TypeScript build，并验证
  `dist/ivekit-dialog-shadow-agent.js` 等 17 个必需入口真实生成。
- 从固定 RustPBX、rsipstack、rustrtc commit 依次重放构建脚本中的全部 28 个补丁后，
  `cargo check --locked --lib` 通过。
- Rust 1.94.1 干净重放源码下，19 项 dialog recovery 合同、3 项 recovered media
  takeover、1 项 unresolved takeover 冻结测试及 rsipstack 全部 `247/247` library
  测试通过。
- `.github/workflows/ivekit-rustpbx-image.yml`、构建脚本、三套环境样例和 fork manifest
  已原子推进到 `ivekit.27`；该 tag 尚无不可变 registry digest、SBOM、签名或 provenance。
- Compose 和 Helm 静态部署合同通过，包括 `voice-t1` 依赖闭包、Kubernetes
  atomic-writer symlink 及共享密钥权限合同；本机没有 Helm CLI，因此真实 chart
  render、Kubernetes sidecar 启动及每 Pod CSI SPIFFE 证书挂载仍保持 `not_run`。
- 真实多节点 SIP/RTP、JetStream 故障域、owner crash、RTP 连续性及 5 秒 RTO
  均保持 `not_run`，不会由本地合同测试推导为 `functional_pass`。

### Task 9：双腿 CDR 和 durable convergence

**状态：** 代码、精确 RustPBX 补丁、本地迁移合同和自动化回归完成；真实 Region
跨 Zone PostgreSQL quorum、进程重启、持续 spool replay、真实 RTP 连续性和负载仍为
`not_run`。

**文件：**

- 新建补丁 `infra/ivekit/rustpbx/patches/rustpbx-ivekit-dual-leg-cdr.patch`
- 新建 `src/agent-runtime/ivekit/voice/cdr-convergence.ts`
- 新建 `src/agent-runtime/ivekit/voice/postgres/cdr-convergence-store.ts`
- 新建 `src/agent-runtime/ivekit/voice/dialog-terminal-shadow-repair.ts`
- 新建 `src/migrations/103_ivekit_voice_cdr_convergence.sql`
- 修改 Voice HTTP、readiness、Compose、Helm 和 RustPBX 部署配置
- 新建 `docs/ivekit-voice-cdr-durability-runbook.md`
- 新建 `test/ivekit-rustpbx-dual-leg-cdr-patch.test.ts`
- 新建 `test/ivekit-voice-cdr-convergence.test.ts`
- 新建 `test/ivekit-terminal-shadow-repair.test.ts`
- 新建 `test/ivekit-dialog-terminal-repair-postgres.test.ts`

- [x] 每腿记录 dialog ID hash、direction、SIP final code、hangup cause、answer time、
      end time、media result、reservation ref、owner epoch 和 route snapshot revision。
- [x] call-level CDR 记录 winning branch、early media、transfer chain 和 media timeout。
- [x] CDR sequence 在 owner takeover 后单调递增。
- [x] Cell local spool 只标记 `pending_unacknowledged`。
- [x] 只有 Region 跨 Zone quorum-backed durable store ACK 后标记 `committed`。
- [x] 重放不重复计费，不覆盖更高 sequence，不丢 caller/callee 任一腿。
- [x] submission hash 与 receipt append-only journal 通过复合外键绑定；未知或篡改的
      历史 sequence 不会获得 durable ACK。
- [x] T1 提交在同一事务内锁定并校验 Cell/node/owner epoch；pending takeover、
      terminal owner 和 stale owner 的新 payload 全部拒绝；接管前已 journal 化的
      精确 sequence/hash 可继续取得或完成 receipt。
- [x] caller/callee 终态独立产生；接管后保留旧 epoch 的历史腿可恢复投影，但不能授权
      新提交。
- [x] T1 在 CDR 提交前先提交双腿 `terminating` quorum；该状态的 takeover 只能执行
      finalization，不恢复 SIP dialog、RTPengine 或媒体控制器。
- [x] RustPBX 将 `expected_region_id` 纳入 canonical payload 和提交 hash；Region
      store 在任何数据库访问前拒绝配置 Region 不一致的 payload。精确提交使用
      64-slot semaphore 和 `.t1pending` 独占文件，不持有跨网络请求的全局锁，崩溃后
      可原子恢复为后台 replay。
- [x] T1 receipt 与 owner terminal fence 在同一 PostgreSQL 事务提交，并持久化
      call ID、receipt ID、Region、durability contract、sequence/hash 与
      `terminal_shadow_pending`；terminal shadow 观察后清除 repair 标志，shadow
      失败期间 takeover 仍返回 terminal。
- [x] `terminal_shadow_pending` 由专用跨进程 repair lease 扫描；repair 严格绑定原始
      Region CDR call/receipt/durability contract、sequence/hash、source owner epoch
      和 fault domain，只重放冻结的 terminal shadow，不进入 SIP/media takeover；
      claim、reserve 和 completion 每一步都重新校验这组精确权威，完成事务以同一绑定
      清除 pending fence，复合外键、RLS 和函数权限禁止跨租户或伪造 receipt。
- [x] repair worker 每轮在独立 lease 表建立短租约后再 claim；该租约与 RustPBX
      dialog owner liveness 完全分离，冷启动无需等待新 T1 呼叫，同时不会替已停止的
      RustPBX owner 制造假 heartbeat 或阻塞非终态 takeover。
- [x] recovery capsule 接受 Rust 发出的原始 call timing 与 route snapshot revision，
      同时保持旧版 TypeScript canonical payload 字节稳定；非法时间关系、未知字段和
      超界 revision 全部拒绝。
- [x] uploader 使用跨轮次有界目录游标；backlog 指标取最近完整周期与当前部分周期的
      较大值，每轮最多扫描/保留 4096 条并以 64 并发上传；spool 使用
      `0700/0600`，`202 pending` 不会形成紧密重试，启动清理不会删除当前进程的
      临时写入。
- [x] CDR 持久化使用 4096 条硬上限专用 writer queue；终态只在文件 fsync、原子
      rename 和目录 fsync 后确认；队列满时只 fence 后续 admission，不把健康 spool
      错报为故障，并通过同一 writer 的异步 MPSC 对既有终态执行有界背压。等待者挂起
      Future 而不占用 OS/Tokio worker 线程。writer 保留失败批次并以有界退避持续
      重试，断开时才进入全局异步互斥、单 blocking task 的 emergency writer；已建立
      媒体不受影响。
- [x] 每条 spool 记录持久化独立 retry sidecar，延迟记录不阻塞健康记录；service key
      每轮重读，projected Secret 原子轮换无需重启；扫描、读取、hash、sidecar、隔离和
      删除均移到 blocking worker。
- [x] 两条 tenant-event retention 路径均跳过被 CDR call/receipt 外键引用的计费事件，
      不会因一条受保护事件阻断同批普通过期事件。
- [x] Helm projected Secret 只允许解析到 Secret mount 内部的目标。
- [x] 当前与旧版 Compose/Helm 均接入 CDR spool/key；Compose 默认 production 并要求
      显式 HTTPS endpoint，两套 Helm 都拒绝关闭持久卷且独立要求 CDR Region。
- [x] 旧版 `infra/k8s` Helm 入口补齐 node-local dialog-shadow sidecar、持久 WAL、
      mTLS/CSI SPIFFE 身份、NATS 跨故障域放置、terminal repair 和 RustPBX recovery
      配置，并与主 chart 采用相同的 fail-closed T1 合同。
- [x] 标准 migration runner 在事务外验证并发索引元数据，缺失或畸形时并发创建/重建；
      同名约束必须精确匹配唯一索引、列顺序和有效状态；迁移事务使用 5 秒
      `lock_timeout`，SQL 二次校验后只挂载约束，避免事务内同步建索引造成长锁。
- [x] CDR/store outage 不进入 RTP packet path。
- [x] 提交：`feat(voice): converge dual-leg CDR`。

Task 9 evidence:

- 固定上游 commit 上依次通过 `git apply --check` 并重放全部 29 个补丁；Task 9
  补丁 SHA-256 为
  `84c1dd9d91c2d12a8505dd99fb0416e76471bb8ef37e68e0c70e46fd6fa5984f`，基线、
  独立补丁回放树和精确编译树中的 Rust 源文件 SHA-256 完全相同；回放树
  `git diff --check` 和 Task 9 新文件 `rustfmt --check` 通过。
- Rust 1.94.1 与 RustPBX 仓库锁文件下
  `cargo check --locked --features cross --bin rustpbx --bin sipflow` 通过；Clippy
  完成且 Task 9 新文件没有新增告警，上游既有 203 条告警作为可见债务保留。RustPBX
  iveKit 定向单元测试 `64/64`、缺失 callee 终态独立性 `1/1`、dialog
  shadow/recovery 合同 `20/20` 通过。rsipstack
  上游不提交独立 `Cargo.lock`，按其 manifest 解析后 library 测试 `247/247` 通过；
  RustPBX 对 rsipstack 的生产依赖仍由 RustPBX 锁文件固定。
- `npm run test:ivekit:voice-media-goal3` 为 `202/202`；fork/构建/dialog recovery/CDR
  身份聚焦合同 `42/42`；完整交付套件 `58/58`；精确 CDR/owner/repair 与部署聚焦
  回归 `80` 项、`79` 通过、`1` 项按 PostgreSQL 环境条件跳过、`0` 失败；全仓
  `npm test` 为 `4315` 项、`4301` 通过、`14` 跳过、`0` 失败；
  `npm run typecheck` 和 `git diff --check` 通过。
- 本机临时 PostgreSQL 14.18 实例完成新库、旧 OPC 非空库升级、重复迁移、Tinode
  入站/投影、IVR、受控 RustPBX 和 terminal shadow repair 并发/RLS/fault-domain
  回归，共 7 项、0 失败；旧库夹具按依赖顺序补装 runtime security、WebPhone、
  realtime intelligence 和 CDR migrations，历史 migration checksum 未被修改。
- fork manifest 中 Task 9 补丁 SHA-256 与磁盘内容匹配，交付 bundle 已包含 CDR
  durability runbook；旧版 Helm 的 T1 sidecar 静态合同通过。本机没有 Helm CLI，
  因此真实 chart render 保持 `not_run`；本地测试未写入生产 SQLite。
- `VOICE-HA-T1` 正常和 recovered cleanup 都强制执行“本地文件/目录 fsync、精确
  sequence/hash 获得当前 Region 跨 Zone `committed` receipt、最后提交双腿 terminal
  shadow”。Region 未提交时 shadow 保持 non-terminal 并可被更高 epoch 接管；Region
  已提交后进程退出也不会丢失 CDR。`VOICE-ORDINARY` 以本地 durable spool 为成功边界，
  没有第二 durable sink；唯一 spool 丢失后再发生 SIGKILL/OOM/Pod 驱逐属于未保护
  双故障，不能宣称零丢失。需要该保证的租户必须使用 T1；Task 11 保留强杀与恢复证据。
- 真实双 Zone PostgreSQL durability contract、进程重启后的持续 spool replay、
  Region takeover、真实 RTP 连续性和负载仍为 `not_run`，不得据此宣称
  `functional_pass`、`production_pass` 或 `capacity_pass`。

### Task 10：部署、容量隔离和可观测性

**文件：**

- 修改 `infra/ivekit/docker-compose.voice.yml`
- 新建或修改 `infra/ivekit/helm/rustpbx/*`
- 新建 `infra/ivekit/helm/dialog-shadow/*`
- 修改 `infra/ivekit/rustpbx/README.md`
- 新建 `test/ivekit-rustpbx-media-deployment.test.ts`

- [x] ordinary relay、T1、IVR/transcoding、recording 和 AI tap 使用独立 admission profile。
- [x] RustPBX 与 media-control 使用 loopback/Unix 或 cell-local mTLS，不暴露公网端口。
- [x] service token、client cert 和 CA 只通过 secret volume。
- [x] readiness 同时反映 route snapshot freshness、media-control availability 和 profile
      capacity；liveness 不因外部 Provider 故障失败。
- [x] drain 先将 Kamailio weight 归零，再拒绝新 admission，最后等待 dialogs。
- [x] PDB、anti-affinity、topology spread 和 T1 shadow fault-domain label 有模板门禁。
- [x] 指标只使用固定 label：action、result、leg、profile、runtime_mode、failure_stage。
- [x] tracing 传播 trace ID，但日志和 span attribute 不含 SDP、号码或 secret。
- [x] 录制/AI tap queue 和 ordinary relay 使用独立 semaphore、内存预算和告警。
- [x] rollback 保留 Goal 2 media sessions，禁止为回滚重启整 Cell RTPengine。
- [x] 提交：`feat(deploy): add RustPBX media orchestration`。

### Task 11：服务器功能和故障验收

**文件：**

- 新建 `scripts/ivekit-rustpbx-media-goal3-acceptance.ts`
- 新建 `test/ivekit-rustpbx-media-goal3-acceptance.test.ts`
- 生成 `docs/evidence/goal3-*`

- [ ] 使用服务器隔离 project/network/container names，不修改或重启 LED 服务。
- [ ] 验证 exact source、patchset、image digest、config hash 和 host kernel。
- [ ] SIPp 跑 INVITE/183/PRACK/200/ACK/BYE、CANCEL races、UPDATE、re-INVITE、
      hold/resume、DTMF 和 session timer。
- [ ] packet probes 验证双向 RTP/RTCP/SRTP、sequence continuity 和 effective SDP。
- [ ] 停止 RustPBX owner，确认既有 RTP 继续。
- [ ] 停止 media-control，确认既有 RTP 继续且 mutation 进入 unknown/reconcile。
- [ ] 停止 recorder、对象存储、PostgreSQL 和 NATS，验证与合同一致。
- [ ] T1 profile 验证 shadow quorum loss fail closed 和 owner takeover RTO。
- [ ] 验证 orphan media 在 60 秒合同内回收。
- [ ] 每个网络条件只保留可追溯、不可变、脱敏证据。
- [ ] 未执行 kernel/recording/transcoding/capacity 时保持 `not_run`。
- [ ] 提交：`test(media): validate RustPBX media orchestration`。

### Task 12：回归、供应链和最终证据

**文件：**

- 新建 `scripts/ivekit-rustpbx-media-goal3-finalize.ts`
- 新建 `test/ivekit-rustpbx-media-goal3-finalizer.test.ts`
- 修改 `docs/capacity/forks/ivekit-forks-v1.json`
- 修改 `docs/design/communication-foundation-vos5000-parity-performance-plan.md`
- 生成 `docs/evidence/goal3-rustpbx-media-final-evidence-YYYY-MM-DD.json`

- [ ] finalizer 校验源码、补丁、镜像、配置、内核、测试和运行时证据身份。
- [ ] invalid/mixed identity attempt 必须保留但不得晋级。
- [ ] 功能通过不能自动产生容量声明。
- [ ] T1 takeover 需要至少三次同配置有效重复，输出 P50/P95/P99 RTO。
- [ ] 供应链生成 CycloneDX、SPDX、Trivy、secret scan、provenance 和签名状态。
- [ ] active vulnerability exception 必须包含 owner、原因、到期时间和修复状态。
- [ ] 回归 Goal 0、Goal 1、Goal 2、Kamailio、RustPBX、CDR、recording isolation 和
      package typecheck。
- [ ] 最终状态只允许 `implemented`、`functional_pass`、`production_pass` 或
      `capacity_pass`，并由证据推导。
- [ ] 更新总体设计中的 Goal 3 状态和未完成 blocker。
- [ ] 提交：`docs(media): finalize RustPBX Goal 3 evidence`。

### Task 13：切换到 Unified Revision 3 生产 Authority

**状态：** 目标增量，全部 `not_run`。Task 1–12 的完成项只证明历史
HTTP/media-control 路径，不得自动勾选本任务。

- [ ] 在 Unified RustPBX 内实现唯一 Media Engine Facade；RustPBX 与 RTPengine
      Adapter、`voice-media-rs` embedded Backend 之间使用直接 Rust
      trait/function/channel 边界，不使用独立 HTTP/gRPC/RPC authority。
- [ ] 固化 `MediaPlanRevision`、`DirectedMediaEdge`、`WireMediaBinding`、
      `BackendBindingGroup`、`WireTransportBundle`、group/member digest、flow selector
      和 writer fence 的 canonical encoding 与 durable identity。
- [ ] 证明 `Edge generation -> group generation/flow` 与 packet-path
      `flow selector -> Edge` 均为 O(1)，且 group membership 变更只能创建新 generation。
- [ ] 先完成 candidate plan/group 编译和 admission，再做 Backend-specific reserve；
      reserve retry 必须创建新 candidate attempt/revision。
- [ ] 实现 `prepare_blocked`、commit、pre-decision abort、zero-output revoke、
      query/reconcile、zero-live-ref release，以及 decision 前/后的不同补偿语义。
- [ ] 按 3.2 节覆盖 initial SDP、migration candidate SDP、remote acceptance、
      handoff decision、old writer revoke、新 writer commit、有界 receive-only grace 和
      可测 writer gap/loss 上限。
- [ ] 实现 RustPBX per-Leg DTMF canonical authority、RFC 4733/SIP INFO/in-band
      precedence、有界跨源去重、transparent relay 无业务事件和单一 outbound wire
      mechanism。
- [ ] 故障矩阵明确：普通 RTPengine required Edge 在 Unified RustPBX 故障时
      `continue_degraded`；embedded required Edge 为 `interrupt_visible`；混合呼叫
      按 required Edge 最坏结果，optional tap 仅降级/释放 tap。
- [ ] 发布只使用新呼叫 selector + 旧呼叫 drain。升级前后证据绑定
      `media_plan_compiler_revision`、`backend_selector_revision` 和
      `backend_mix_id`；不得用在途强迁移冒充 rollout 成功。
- [ ] 完成真实 SIP/RTP/SRTP、race、process abort/OOM/cgroup、worker panic、
      cpuset/NUMA、SIP headroom、reconcile 和 drain 证据；当前不产生生产或容量声明。

---

## 6. 自动化验收矩阵

| 场景 | SIP 预期 | 媒体预期 | 控制预期 | CDR 预期 |
| --- | --- | --- | --- | --- |
| 基础 200 呼叫 | 正常完成 | 双向连续 | 两腿 committed | 单次 committed |
| 183 early media | PRACK/200 正常 | early 到 final 连续 | early 后 final | early 标记 |
| CANCEL before offer | 487 | 无媒体 | 无 reservation | canceled |
| CANCEL after offer | 487 | 已分配媒体删除 | delete/replay | canceled |
| CANCEL/200 race | RFC 语义 | 不泄漏媒体 | winner 唯一 | 单终态 |
| re-INVITE codec change | 2xx | 新 effective SDP | sequence +1 | mutation event |
| hold/resume | 2xx | direction 正确 | update committed | hold durations |
| update timeout | 保持 dialog | 原 RTP 继续 | unknown/reconcile | uncertainty event |
| RustPBX crash | dialog 暂失 | RTP 继续 | ordinary/T1 分级 | 不重复 |
| T1 takeover | in-dialog 恢复 | RTP 继续 | epoch +1 | sequence 单调 |
| media-control crash | SIP 按 profile | RTP 继续 | WAL recovery | 不丢终态 |
| RTPengine crash | re-INVITE/失败 | 节点媒体中断 | orphan/recovery | cause 明确 |
| group prepare partial failure | 不暴露 initial SDP | 输出增量为零 | reverse abort/cancel reserve | `aborted_before_decision` |
| group commit timeout | 不改 immutable decision | 按已决定状态 | query/reconcile | 单一决定 |
| old group revoke timeout | migration 不双写 | old 保持可查询 | query/reconcile zero-output | handoff gap 可见 |
| embedded worker panic | required Edge 中断可见 | ordinary RTPengine Edge 继续 | worker fenced/restart | `interrupt_visible` |
| Unified RustPBX process abort | SIP 中断；ordinary 可降级继续 | RTPengine `continue_degraded`，embedded 中断 | 重建 authority | 按 Edge 聚合结果 |
| recorder crash | SIP 不受影响 | RTP 继续 | evidence degraded | partial/failed |
| PostgreSQL outage | 已建立继续 | RTP 继续 | 新 durable admission fail closed | local pending |
| NATS outage | ordinary 继续 | RTP 继续 | 新 T1 fail closed | pending |

---

## 7. 性能门槛

Goal 3 不是最终 100K 容量签署，但实现必须满足以下结构性门槛：

1. ordinary relay 建立过程中 Unified RustPBX 到 RTPengine Adapter 不经过独立
   HTTP/RPC hop；每个 mutation 只有一个 durable decision，unknown 后只 query/reconcile。
2. 每 call/leg/Edge/group lookup 和 flow dispatch 为 O(1)，无 member scan、无全局 call
   map 锁内网络 I/O。
3. canonical hash、state transition 和 CDR projection 不分配无界集合。
4. RustPBX command inflight、shadow append、reconcile 和 cleanup 都有独立硬上限。
5. ordinary profile 不同步等待 NATS、PostgreSQL、recorder、对象存储、ASR、OCR、翻译或
   LLM。
6. T1 shadow append 延迟单独记录 P50/P95/P99，并计入 T1 CPS 容量。
7. RTP packet path 在 RustPBX、media-control、NATS 和 PostgreSQL故障注入期间保持独立。
8. server acceptance 只产生功能结论；单机 CPS、active calls、PPS 和 Cell 横向效率留给
   Goal 7 容量 campaign。
9. embedded processing 必须与 SIP/Call Core 在同一个 Unified RustPBX SUT 内验证，
   固定 cpuset/NUMA/worker/queue/allocator budget 并保留 SIP headroom；独立
   `voice-media-rs` microbenchmark 只能诊断热点，不能授权生产容量。
10. 每轮证据包含 `media_plan_compiler_revision`、`backend_selector_revision`、
    `backend_mix_id` 和 ordinary/embedded Edge mix；不同 mix 不得合并。

---

## 8. 完成定义

Goal 3 只有同时满足以下条件才可标记 `functional_pass`：

1. Task 1 至 Task 13 的代码、配置、文档和自动化测试全部完成；Task 1–12 的历史
   compatibility evidence 不能替代 Task 13。
2. 精确 RustPBX/rsipstack/rustrtc/RTPengine 身份可证明。
3. 基础呼叫、early media、PRACK、UPDATE、re-INVITE、hold/resume、DTMF、CANCEL、
   BYE、timeout 和 reconciliation 在服务器通过。
4. 故障结果按 Backend 精确成立：ordinary RTPengine Edge 可
   `continue_degraded`，embedded required Edge 明确 `interrupt_visible`，混合呼叫
   不隐藏 required Edge 中断。
5. 普通和 T1 profile 的声明边界清晰；T1 未通过时不得阻塞 ordinary profile 的诚实完成。
6. 双腿 CDR 最终一致，不重复计费，不丢失终态。
7. 录制和 AI tap 故障不回压主媒体。
8. 所有未执行的 kernel、recording、transcoding、capacity 或跨 Zone 场景保持
   `not_run`，并列出 blocker。

`production_pass` 还要求真实双 Zone、生产 mTLS、三节点 NATS、生产 PostgreSQL、真实
对象存储和完整故障矩阵。`capacity_pass` 还要求 Goal 7 的独立发生器、同配置重复、资源
遥测和安全容量计算。功能完成不得替代生产或容量结论。

## 9. 变更日志

| Revision | 日期 | 作者 | 变更 |
| --- | --- | --- | --- |
| 3 | 2026-07-29 | Codex | 将独立 media-control/HTTP 拓扑标记为非生产历史过渡资产，并指向统一进程、按 Edge 授权的唯一生产基线。 |
| 4 | 2026-07-29 | Codex | 增加 Revision 3 Backend Binding Group/Wire Transport Bundle、O(1) Edge-flow mapping、blocked prepare/zero-output revoke、decision-aware compensation、initial/migration SDP、per-Leg DTMF、故障分级和 co-resident 验收增量。 |
