# iveKit RustPBX 与 RTPengine Goal 3 实施计划

> **执行约束：** 按任务顺序使用测试驱动开发。不要使用 `using-superpowers`。
> 所有运行时结论必须绑定 RustPBX、rsipstack、rustrtc、RTPengine、补丁集、镜像、
> 配置、主机内核和证据身份。未经机器证据不得把 `not_run` 写成 `passed`。

**目标：** 让 RustPBX 继续拥有 Call、Leg、Dialog、路由快照和逻辑媒体图，同时把普通
RTP/RTCP/SRTP 中继、wire SDP 和 transport runtime 可靠地委托给 Goal 2 RTPengine
执行面，形成可恢复、可解释、可横向扩展的双腿媒体编排闭环。

**架构：** RustPBX 在呼叫状态机内直接调用 cell-local media-control HTTP/mTLS API。
media-control agent 仍是 RTPengine 的唯一 iveKit 调用者，继续执行 reservation、owner
epoch、command sequence、idempotency、unknown outcome reconciliation 和本地 WAL。
RustPBX 只保存逻辑 offer/answer、每腿 dialog 状态、媒体 reservation 引用和最后一次已确认
命令，不复制 RTPengine 的端口、ICE、DTLS 或 SRTP 状态。已建立 RTP 不依赖 RustPBX、
PostgreSQL、NATS、对象存储或外部 Provider 存活。

**高可用边界：** 普通 voice profile 承诺 RustPBX 故障时 RTP 继续，并通过 re-INVITE、
重拨或人工接管恢复控制。只有 `VOICE-HA-T1` profile 在可见 18x/200、in-dialog 状态变化
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

---

## 2. 不可破坏的系统不变量

1. RustPBX 维护逻辑媒体图；RTPengine 维护 wire SDP、端口和 transport runtime；两者不得
   反向夺权。
2. 一个 SIP Call-ID 可包含多个 Leg/Dialog，但一个媒体 reservation 只能绑定一个
   `tenant + call + leg + owner epoch`。
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

---

## 3. 权威状态与命令模型

### 3.1 每腿媒体状态

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

### 3.2 双腿事务顺序

初始普通 B2BUA 呼叫：

1. route snapshot 和 component admission 返回 owner binding；
2. caller leg offer prepare，得到 caller-facing effective SDP；
3. callee leg offer prepare，得到 callee-facing effective SDP；
4. RustPBX 使用 callee effective SDP 发出 outbound INVITE；
5. 183+SDP 到达时提交 early answer/update，再向 caller 发有效 early SDP；
6. 200+SDP 到达时提交 final answer；
7. 两腿均 committed 后更新 logical media graph 和 CDR sequence；
8. 任一步确定失败时按逆序补偿；
9. 任一步 unknown 时冻结该 reservation mutation，先 reconcile；
10. SIP 终态通过后异步释放非媒体业务资源，但 media delete 仍需进入有界 cleanup
    deadline。

### 3.3 SIP 动作映射

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
  sha256(tenant_id, call_id, leg_id, owner_epoch, sequence, action, payload_hash)

idempotency_key =
  rustpbx/{cell_id}/{call_id}/{leg_id}/{owner_epoch}/{sequence}

media_reservation_id =
  admission_reservation_id + "/" + stable_leg_id
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

- [ ] 在上游精确源码上先写 Rust 单元测试，覆盖 canonical JSON/hash、命令 identity、
      mTLS 配置、响应上限、deadline 和 error projection。
- [ ] client 使用已有 reqwest/rustls、serde、sha2 和 Tokio，不引入第二套 HTTP runtime。
- [ ] 每个 call 使用独立 sequence allocator，不持有全局锁完成网络 I/O。
- [ ] 使用 bounded semaphore 限制 inflight；队列满时在发请求前确定拒绝。
- [ ] 发送完成后断线统一返回 unknown。
- [ ] production 模式要求 HTTPS、client identity、CA 和 server name。
- [ ] token 仅从 secret file 读取，不允许 CLI、日志、metrics 或 shadow payload 暴露。
- [ ] patch 应用两次时第二次必须识别 already applied，禁止 partial patchset。
- [ ] patchset 从 `ivekit.21` 升为 `ivekit.22`，镜像 label 绑定新 patch hash。
- [ ] cargo fmt、clippy、unit 和 exact-source `cargo check --locked` 通过。
- [ ] 提交：`feat(rustpbx): add media control client`。

### Task 4：初始 INVITE、early media 和 final answer

**文件：**

- 新建补丁 `infra/ivekit/rustpbx/patches/rustpbx-ivekit-media-lifecycle.patch`
- 修改 `infra/ivekit/rustpbx/build.sh`
- 新建 `test/ivekit-rustpbx-media-lifecycle-patch.test.ts`

- [ ] `SipSession` 增加 bounded per-leg media state，不保存 secret。
- [ ] route snapshot admission binding 在创建 session 时固化。
- [ ] `prepare_callee_media_offer` 在 ordinary relay profile 调用 media offer 并使用
      effective SDP。
- [ ] 183+SDP 先完成 early media mutation，再向 caller 发送 183。
- [ ] final 200+SDP 先完成 answer mutation，再向 caller 发送 200。
- [ ] 无 SDP、offerless INVITE、late offer 和 ACK answer 走独立测试向量。
- [ ] 多 early dialog 只允许获胜分支 commit，失败分支幂等 delete。
- [ ] local IVR、conference、transcoding、WebRTC bridge 和显式 bypass 继续走 RustPBX
      media graph，不被错误送入 ordinary relay。
- [ ] RTPengine 不可用时按 route profile fail closed 或显式 fallback，禁止静默绕过。
- [ ] 提交：`feat(rustpbx): orchestrate RTPengine call setup`。

### Task 5：re-INVITE、UPDATE、hold/resume 和 DTMF

**文件：**

- 修改 Goal 3 media lifecycle patch
- 修改 `src/agent-runtime/ivekit/voice/media-lifecycle.ts`
- 新建 `test/ivekit-rustpbx-media-mid-dialog-patch.test.ts`

- [ ] caller/callee 发起 re-INVITE 均以原 reservation 的下一 sequence 执行 update。
- [ ] UPDATE offer/answer 和 session refresh 无 SDP 时不产生无意义 media mutation。
- [ ] direction 覆盖 `sendrecv`、`sendonly`、`recvonly`、`inactive`。
- [ ] codec、ptime、connection address、RTCP mux 和 ICE restart 变化进入 payload hash。
- [ ] offer glare 返回 491，并使用有界随机退避；失败重试复用同 logical operation 但使用
      新 sequence。
- [ ] hold/resume 只在 media update committed 后改变 RustPBX LegState。
- [ ] RTP DTMF 走 RTPengine inject；SIP INFO DTMF 仍按端点策略透传。
- [ ] RTPengine unsolicited DTMF 进入 RustPBX event channel，不得满足 command promise。
- [ ] update unknown 时保持既有 RTP，冻结后续 mutation 并启动 reconcile。
- [ ] 提交：`feat(rustpbx): orchestrate mid-dialog media`。

### Task 6：终止、timeout、补偿和 orphan 回收

**文件：**

- 修改 Goal 3 media lifecycle patch
- 修改 `src/agent-runtime/ivekit/media-control/agent.ts`
- 新建 `test/ivekit-rustpbx-media-cleanup-patch.test.ts`
- 新建 `test/ivekit-media-orphan-reconciler.test.ts`

- [ ] CANCEL before offer、after offer、after 183 和 200 race 分别验收。
- [ ] non-2xx ACK 不创建新 reservation。
- [ ] BYE 双向并发时只执行一次逻辑 close，重复 delete 必须 replay。
- [ ] SIP cleanup 使用有界 deadline；media delete timeout 进入 durable reconciliation，
      不延迟 BYE 超过合同上限。
- [ ] media timeout 产生稳定 cause、终止 interaction 并删除 reservation。
- [ ] orphan reconciler 仅回收 lease 已过期且 owner/session 都不存在的媒体。
- [ ] recorder、AI tap 和对象存储 cleanup 失败只影响 evidence 状态。
- [ ] 进程 Drop safety-net 不执行未带 identity 的裸 delete。
- [ ] 提交：`feat(media): reconcile RustPBX media cleanup`。

### Task 7：Dialog shadow journal 和 T1 quorum

**文件：**

- 新建 `src/agent-runtime/ivekit/voice/dialog-shadow.ts`
- 新建 `src/agent-runtime/ivekit/voice/dialog-shadow-journal.ts`
- 新建 `src/agent-runtime/ivekit/voice/dialog-shadow-http.ts`
- 新建 `test/ivekit-dialog-shadow-journal.test.ts`
- 新建 `test/ivekit-dialog-shadow-quorum.test.ts`
- 新建补丁 `infra/ivekit/rustpbx/patches/rustpbx-ivekit-dialog-shadow.patch`

- [ ] 定义 versioned bounded binary record，包含 local/remote tag、route set、CSeq、
      branch/final response hash、auth context ref、logical offer/answer hash、media
      reservation、provider session ref 和 CDR sequence。
- [ ] record 禁止 token、私钥、完整认证头、原始号码和不受限 body。
- [ ] local WAL 使用 length、version、CRC/checksum、fsync、atomic compaction 和硬上限。
- [ ] T1 append 只有在同 Cell 至少两个 RustPBX 故障域 ACK 后才成功。
- [ ] NATS JetStream 作为复制总线，stream replicas 和 placement 必须证明跨故障域。
- [ ] shadow 不可用时停止新的 T1 admission；普通 profile 不受影响。
- [ ] 可见 18x/200 和状态改变 in-dialog 2xx 前执行 shadow commit。
- [ ] 旧 epoch append、sequence gap、payload mismatch 和 replay 有确定语义。
- [ ] 提交：`feat(voice): add dialog shadow quorum`。

### Task 8：Owner takeover 与 Kamailio epoch routing

**文件：**

- 修改 Goal 3 dialog shadow patch
- 修改 `infra/ivekit/kamailio/kamailio.cfg`
- 修改 `infra/ivekit/kamailio/scripts/render-dispatcher-snapshot.ts`
- 新建 `test/ivekit-rustpbx-owner-takeover-patch.test.ts`
- 新建 `test/ivekit-kamailio-dialog-recovery-routing.test.ts`

- [ ] 新 owner 通过 CAS 获得更高 owner epoch 和一次性 takeover token。
- [ ] 只有 shadow complete 且未终结的 T1 dialog 可自动 takeover。
- [ ] 恢复 local/remote tag、route set、CSeq、media reservation 和 CDR sequence。
- [ ] 新 epoch 第一条 RTPengine mutation sequence 为 1。
- [ ] Kamailio 在 recovery window 内将离线 pinned owner 路由到 epoch coordinator；
      只有确认 dialog 不存在或已终结才返回 481。
- [ ] stale owner 的 in-dialog mutation 必须被 RustPBX 和 RTPengine 双重拒绝。
- [ ] takeover 失败不停止既有 RTP；端点可支持时走 re-INVITE recovery。
- [ ] 自动验收 RTO、重复副作用、CSeq 单调性和最终 BYE。
- [ ] 提交：`feat(voice): recover T1 dialog ownership`。

### Task 9：双腿 CDR 和 durable convergence

**文件：**

- 新建补丁 `infra/ivekit/rustpbx/patches/rustpbx-ivekit-dual-leg-cdr.patch`
- 修改 `src/agent-runtime/ivekit/integration-event-*`
- 新建 `test/ivekit-rustpbx-dual-leg-cdr-patch.test.ts`
- 新建 `test/ivekit-voice-cdr-convergence.test.ts`

- [ ] 每腿记录 dialog ID hash、direction、SIP final code、hangup cause、answer time、
      end time、media result、reservation ref、owner epoch 和 route snapshot revision。
- [ ] call-level CDR 记录 winning branch、early media、transfer chain 和 media timeout。
- [ ] CDR sequence 在 owner takeover 后单调递增。
- [ ] Cell local spool 只标记 `pending_unacknowledged`。
- [ ] 只有 Region 跨 Zone quorum-backed durable store ACK 后标记 `committed`。
- [ ] 重放不重复计费，不覆盖更高 sequence，不丢 caller/callee 任一腿。
- [ ] CDR/store outage 不进入 RTP packet path。
- [ ] 提交：`feat(voice): converge dual-leg CDR`。

### Task 10：部署、容量隔离和可观测性

**文件：**

- 修改 `infra/ivekit/docker-compose.voice.yml`
- 新建或修改 `infra/ivekit/helm/rustpbx/*`
- 新建 `infra/ivekit/helm/dialog-shadow/*`
- 修改 `infra/ivekit/rustpbx/README.md`
- 新建 `test/ivekit-rustpbx-media-deployment.test.ts`

- [ ] ordinary relay、T1、IVR/transcoding、recording 和 AI tap 使用独立 admission profile。
- [ ] RustPBX 与 media-control 使用 loopback/Unix 或 cell-local mTLS，不暴露公网端口。
- [ ] service token、client cert 和 CA 只通过 secret volume。
- [ ] readiness 同时反映 route snapshot freshness、media-control availability 和 profile
      capacity；liveness 不因外部 Provider 故障失败。
- [ ] drain 先将 Kamailio weight 归零，再拒绝新 admission，最后等待 dialogs。
- [ ] PDB、anti-affinity、topology spread 和 T1 shadow fault-domain label 有模板门禁。
- [ ] 指标只使用固定 label：action、result、leg、profile、runtime_mode、failure_stage。
- [ ] tracing 传播 trace ID，但日志和 span attribute 不含 SDP、号码或 secret。
- [ ] 录制/AI tap queue 和 ordinary relay 使用独立 semaphore、内存预算和告警。
- [ ] rollback 保留 Goal 2 media sessions，禁止为回滚重启整 Cell RTPengine。
- [ ] 提交：`feat(deploy): add RustPBX media orchestration`。

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
| recorder crash | SIP 不受影响 | RTP 继续 | evidence degraded | partial/failed |
| PostgreSQL outage | 已建立继续 | RTP 继续 | 新 durable admission fail closed | local pending |
| NATS outage | ordinary 继续 | RTP 继续 | 新 T1 fail closed | pending |

---

## 7. 性能门槛

Goal 3 不是最终 100K 容量签署，但实现必须满足以下结构性门槛：

1. ordinary relay 建立过程中 RustPBX 到 media-control 的每个 command 只有一次同步
   request；unknown 后不自动重发。
2. 每 call/leg 状态为 O(1)，无全局 call map 锁内网络 I/O。
3. canonical hash、state transition 和 CDR projection 不分配无界集合。
4. RustPBX command inflight、shadow append、reconcile 和 cleanup 都有独立硬上限。
5. ordinary profile 不同步等待 NATS、PostgreSQL、recorder、对象存储、ASR、OCR、翻译或
   LLM。
6. T1 shadow append 延迟单独记录 P50/P95/P99，并计入 T1 CPS 容量。
7. RTP packet path 在 RustPBX、media-control、NATS 和 PostgreSQL故障注入期间保持独立。
8. server acceptance 只产生功能结论；单机 CPS、active calls、PPS 和 Cell 横向效率留给
   Goal 7 容量 campaign。

---

## 8. 完成定义

Goal 3 只有同时满足以下条件才可标记 `functional_pass`：

1. Task 1 至 Task 12 的代码、配置、文档和自动化测试全部完成。
2. 精确 RustPBX/rsipstack/rustrtc/RTPengine 身份可证明。
3. 基础呼叫、early media、PRACK、UPDATE、re-INVITE、hold/resume、DTMF、CANCEL、
   BYE、timeout 和 reconciliation 在服务器通过。
4. RustPBX owner 故障时已建立 RTP 继续。
5. 普通和 T1 profile 的声明边界清晰；T1 未通过时不得阻塞 ordinary profile 的诚实完成。
6. 双腿 CDR 最终一致，不重复计费，不丢失终态。
7. 录制和 AI tap 故障不回压主媒体。
8. 所有未执行的 kernel、recording、transcoding、capacity 或跨 Zone 场景保持
   `not_run`，并列出 blocker。

`production_pass` 还要求真实双 Zone、生产 mTLS、三节点 NATS、生产 PostgreSQL、真实
对象存储和完整故障矩阵。`capacity_pass` 还要求 Goal 7 的独立发生器、同配置重复、资源
遥测和安全容量计算。功能完成不得替代生产或容量结论。
