# 审查结论

这份 Revision 3 的**战略方向正确，治理意识也很强**：单一 Authority、拒绝双 PBX、普通媒体与解码媒体分流、迁移后删除重复实现、生产声明必须绑定证据，这些都是正确的。

但按文档自己的退出条件——“无 Critical/Important 才能进入实现”——**当前不能通过 D0 审查**。我建议状态改成：

> **Accepted with Blocking Corrections**
> 架构方向已接受，但在阻断项关闭前不得作为可执行生产基线。

本次审查发现：

| 级别                      | 数量 |
| ----------------------- | -: |
| Critical，阻断实现或生产语义不成立   |  6 |
| Important，容易导致后期返工或生产缺口 | 12 |
| 一般性补充                   |  8 |

审查依据是你上传的 Revision 3 文档；其中涉及本地仓库、五个 RTPengine 补丁、`voice-media-rs` 当前代码质量等陈述，我没有实际读取对应本地源码，因此本次是**架构审查，不是代码审计**。

---

# 一、做得正确的部分

## 1. Authority划分清楚

以下边界值得保留：

* RustPBX拥有Call、Leg、Business Dialog、路由、CDR和Logical Media Graph；
* rvoip只竞争SIP底层实现，不引入高层Orchestrator；
* RTPengine拥有普通Wire Media Binding；
* `voice-media-rs`拥有需要解码的Processing Session；
* 同一Media Edge只有一个active writer。

这有效避免了两个SIP状态机、两个媒体状态机和两个业务Call模型同时成为权威。

## 2. 不把rvoip成熟度夸大

固定的rvoip源码确实是0.3.2，SIP属于限定范围内的Beta，其WebRTC、跨传输和多项高级媒体能力仍是Developer Preview；其生产加固路线也明确还有P2/P3工作未完成。把它作为逐模块候选，而不是整体生产核心，是正确判断。([[GitHub](https://github.com/eisenzopf/rvoip/blob/4ced02b7f6e73041c848f1765dc2bcf7588796f0/docs/PRODUCTION_HARDENING_ROADMAP.md)][1])

## 3. RTPengine作为普通媒体长期基线是合理的

RTPengine已经具备内核态转发、用户态回退、SDP重写、ICE、SRTP桥接、转码、录音、DTMF和媒体分叉等能力。把普通媒体留给它，而不是强迫普通G.711通话进入Rust解码路径，是正确的性能策略。([[GitHub](https://github.com/sipwise/rtpengine?utm_source=chatgpt.com)][2])

---

# 二、Critical：必须修正的矛盾

## C1. `commit_send/query_effect`不能提供文档暗示的“可确认发送”语义

文档把SIP输出设计为：

```text
prepare_effect
→ durable commit
→ commit_send
→ query/reconcile unknown outcome
```

这个方向可以实现**业务副作用的幂等性**，但不能证明：

* 报文一定离开了网卡；
* 报文到达了Kamailio或对端；
* 对端只处理了一次；
* 进程崩溃后能够查询出对端是否收到。

`send()`成功最多表示数据被本机传输层接受。UDP可能丢包；TCP写成功也不代表对端SIP事务已处理。SIP本身通过Transaction重传和协议响应解决这种不确定性。RFC 3261还明确区分了非2xx ACK与2xx ACK：2xx ACK由UAC Core生成，2xx响应重传也不属于普通Transaction层。([[RFC 编辑器](https://www.rfc-editor.org/rfc/rfc3261.html)][3])

### 必须修改

把`ProtocolEffectReceipt`拆成不同层级：

```text
PreparedDurable
WireBound
SendAttempted
TransportAccepted
ProtocolObserved
PeerAcknowledged
Failed
Unknown
```

其中：

* `TransportAccepted`不能命名为`Sent`；
* `query_effect`只能查询本地持久事实；
* 对端是否收到必须通过SIP响应、ACK或后续Dialog事件判断；
* unknown outcome必须重放**同一个SIP Transaction identity和相同wire bytes**，而不是试图实现网络层Exactly Once。

文档应明确：

> 系统保证业务命令幂等和SIP协议级重传安全，不保证网络报文Exactly Once，也不把本地socket写入成功等同于对端接收。

---

## C2. `prepare_effect`在Transport绑定前冻结“完整规范化bytes”不一定可行

文档要求`prepare_effect`在无可见副作用的情况下生成完整SIP bytes和hash，然后持久化，再发送。

但请求的最终wire representation可能依赖：

* RFC 3263 DNS解析结果；
* UDP/TCP/TLS选择；
* TCP连接复用结果；
* 本地source IP/port；
* `Via sent-by`；
* Route与下一跳；
* TLS SNI；
* 401/407之后的新CSeq、branch和Authorization；
* 连接失败后的下一DNS候选。

RFC 3261明确把连接选择和实际传输放在Transport层，Via的`sent-by`也与实际传输绑定。([[RFC 编辑器](https://www.rfc-editor.org/rfc/rfc3261.html)][3])

### 必须改为三段或四段

```text
1. SemanticPrepare
   生成业务意图、Dialog delta、SDP和稳定effect ID

2. ResolveAndBind
   DNS、目标地址、Transport、连接、本地地址绑定

3. FreezeWireEffect
   固定Via、branch、Route、Authorization、完整bytes和hash

4. DurableDecision → Transmit
```

连接建立、DNS查询可以被定义为“准备性外部动作”，但必须声明其可取消、可超时且不构成SIP业务副作用。

---

## C3. `CARRIER-CELL-V1`依赖一个当前不存在的RTPengine原子生命周期

文档要求RTPengine实现：

```text
prepare_blocked
commit
abort
revoke
query
reconcile
group generation
zero-output ACK
```

同时文档又明确承认：

* 当前五补丁没有packet output gate；
* 新补丁`rtpengine-ivekit-atomic-binding-lifecycle-v1`尚不存在；
* 运行验证为`not_run`；
* 当前索引仍主要基于SIP Call-ID，无法表达完整Binding Group identity。

这意味着**唯一生产基线依赖一个尚未实现的核心组件**。

上游RTPengine NG协议目前公开的是`offer/answer/delete/query/block media/unblock media`等命令；它支持按参与者或flow阻断媒体，但没有文档中定义的完整事务型`prepare/commit/revoke`协议。([[GitHub](https://github.com/sipwise/rtpengine/blob/master/docs/ng_control_protocol.md)][4])

### 两种解决办法只能选一种

**方案A：降低V1承诺，推荐。**

第一版生产基线仅允许：

* 新Call选择Backend；
* 老Call自然drain；
* 不主动迁移active ordinary Edge；
* 不声明RTPengine原子handoff；
* `offer/answer/delete/query`按传统方式使用。

原子迁移放到后续资格阶段。

**方案B：保留当前强语义。**

则必须先完成RTPengine fork、kernel/userspace双路径gate、WAL、query/reconcile和故障测试，再把`CARRIER-CELL-V1`称为可执行生产基线。

当前文档同时声称“唯一生产基线已冻结”和“基础原子patch尚不存在”，这是最明显的内部矛盾。

---

## C4. per-Edge writer fence与RTPengine物理粒度可能不一致

文档同时规定：

* 每条有向Edge有独立writer fence；
* 多条Edge可以共享一个Backend Binding Group；
* RTPengine物理资源可能按Call、tag、media section和共享端口管理；
* group mutation是原子的。

问题是：如果Backend只能在group、participant或media-flow粒度执行block/revoke，而不能按你的`MediaEdgeId`验证owner epoch，那么“独立Edge fence”只是控制面的逻辑声明，数据面并不能强制执行。

RTPengine确实支持方向性和单flow媒体阻断，但其原生选择键是Call-ID、tag、label、地址和flow，而不是OPC的Edge generation与owner fence。([[GitHub](https://github.com/sipwise/rtpengine/blob/master/docs/ng_control_protocol.md)][4])

### 必须新增Backend Capability Contract

```text
BackendCapabilities {
  allocation_scope
  commit_scope
  revoke_scope
  fence_scope
  query_scope
  migration_scope
  supports_blocked_prepare
  supports_member_flow_fence
}
```

编译规则必须是：

> 当Backend的fence/revoke粒度粗于Edge独立生命周期时，相关Edge不得共享Binding Group。

否则会出现：

* 释放一个Edge误伤另一个Edge；
* revoke一方向时关闭整个媒体组；
* Edge fence已变化，但Backend仍按旧group运行；
* 文档说单writer，数据面实际无法验证。

---

## C5. Protocol Dialog可恢复，不等于活动Transaction和Transport连接可恢复

文档设计了：

```text
snapshot Protocol Dialog
restore
owner takeover
```

但没有清楚区分：

* Dialog状态；
* 正在进行的INVITE/non-INVITE Transaction；
* 2xx重传状态；
* PRACK状态；
* TCP/TLS连接；
* DNS候选尝试；
* 尚未发送或发送结果未知的Effect。

SIP Transaction由本地Timer、重传状态和Transport目标共同组成。RFC 3261明确将Transaction定义为状态机，并且2xx/ACK还有独立于普通Transaction的Core语义。([[RFC 编辑器](https://www.rfc-editor.org/rfc/rfc3261.html)][3])

### 必须增加恢复边界

建议写死：

| 状态                        | 故障后策略                   |
| ------------------------- | ----------------------- |
| Confirmed Protocol Dialog | 可通过snapshot重建           |
| Early Dialog              | 条件恢复，必须按fork branch逐项定义 |
| 活动UDP Transaction         | 不承诺无损迁移；按相同effect重放或超时  |
| 活动TCP/TLS Transaction     | 原连接不可恢复；按协议规则重新发起或失败    |
| 2xx响应等待ACK                | 必须有独立UAS Core恢复策略       |
| PRACK/100rel状态            | 必须有RSeq/RAck恢复模型        |
| DNS/连接尝试                  | 不持久化连接本身，只持久化候选与决策      |

还需补充Kamailio侧：

* Record-Route策略；
* mid-dialog owner路由；
* owner epoch变化后的route token；
* TCP/TLS flow失效后的重路由；
* 新owner如何接收同一Dialog的请求。

---

## C6. “同进程嵌入媒体”与“媒体故障不影响SIP”不能同时作为强保证

文档要求：

* `voice-media-rs`与SIP/Call Core在一个进程中；
* 媒体故障不终止无关SIP；
* OOM、allocator pressure、worker panic、process abort都纳入生产门禁。

线程和Shard能够隔离CPU预算、队列和普通panic，但无法隔离：

* 进程级OOM；
* `abort`；
* allocator损坏；
* native codec FFI中的UB；
* stack overflow；
* 全局内存碎片；
* Rust运行时或共享依赖的致命错误。

文档自己的故障矩阵也承认Unified RustPBX进程被kill后，所有embedded Edge都会中断。

### 必须二选一

**坚持单进程：**

将目标表述改成：

> 对可恢复panic、队列过载和局部worker失败提供逻辑隔离；不承诺进程级故障隔离。

并且：

* 禁止未审计native codec进入主进程；
* `panic=unwind`与`catch_unwind`边界明确；
* 设置进程级内存保留和SIP headroom；
* 任何codec OOM只能通过预分配和admission尽量避免，不能声称完全隔离。

**坚持进程级故障隔离：**

允许同一Pod或同一部署单元中的本地supervised media worker进程。它不是“两个独立业务节点”，但能提供真实地址空间隔离。

---

# 三、Important：需要补齐的设计

## I1. Durable Store已经进入建呼关键路径，但没有SLO和降级模型

初始INVITE流程包含多次：

* reservation；
* candidate持久化；
* final plan durable transaction；
* media commit ACK；
* Business Dialog持久化；
* SIP发送。

需要补充：

* 使用什么一致性存储；
* 单次事务P99预算；
* 写超时后返回什么SIP码；
* 数据库故障时是否拒绝新Call；
* durable store可用性低于Kamailio/RTPengine时如何避免雪崩；
* 100/180响应是否允许在完整durable commit之前发送；
* `100 Trying`的延迟上限。

否则信令瓶颈很可能不是rvoip，而是同步持久化链路。

---

## I2. Kamailio与Rust SIP parser的差异是安全边界，不只是兼容性测试

同一报文会被Kamailio解析一次，再被rvoip或rsipstack解析一次。对于：

* 重复Content-Length；
* 冲突Via；
* 折行；
* 非法URI转义；
* 多个Contact；
* multipart边界；
* 重复Authorization；

如果两层解释不同，可能产生类似请求走私的安全问题。

建议新增：

> Edge-to-Core Canonicalization Contract

Kamailio应只转发双方都认可的规范子集，并传递可信的：

* 原始source identity；
* TLS验证状态；
* ingress transport；
* 规范化长度；
* parser policy版本。

---

## I3. Media Plan缺少“Backend能力约束求解”

当前编译器只强调`O(E)`，但没有定义：

* 哪些Edge组合能映射到一个RTPengine session；
* 哪些组合必须增加中间端点；
* 哪些Backend支持SRTP终止；
* 哪些Backend支持只读tap；
* 哪些Backend支持双向AI；
* 哪些Backend能保留SSRC；
* 哪些组合会形成媒体环路。

需要一个显式的Capability Algebra和编译失败原因，例如：

```text
UnsupportedGraph
FenceGranularityMismatch
SecurityTerminationMismatch
CodecChainUnavailable
NoAtomicMigration
LoopDetected
CapacityClassUnavailable
```

---

## I4. 切换流程遗漏RTCP、SRTP和ICE状态连续性

文档详细处理了RTP writer，却没有同等定义：

* RTCP sender/receiver report；
* CNAME；
* packet loss统计连续性；
* SRTP ROC与replay window；
* SSRC碰撞；
* DTLS role与fingerprint；
* ICE ufrag/pwd；
* consent freshness；
* ICE restart；
* RTCP mux；
* BUNDLE/MID。

Active migration不能只切UDP tuple。尤其SRTP replay window和ROC处理错误会造成切换后持续丢包。

---

## I5. DTMF Authority定义正确，但事件获取链路没闭合

文档说普通Edge透明DTMF由RTPengine转发，业务DTMF由RustPBX统一去重。

缺口是：

> 普通RTPengine Edge上的RFC 4733事件如何可靠、低延迟地上报给`DtmfEventAuthority`？

必须确定一种唯一方式：

* RTPengine事件通知；
* 独立只读fork Edge；
* SIP INFO；
* 进入embedded processing。

如果为了检测DTMF把所有普通通话都引入解码路径，会破坏快路径设计。

---

## I6. G729A/G729AB应是内部能力身份，不应表现为两个外部RTP Codec

文档已经正确规定wire encoding为`G729/8000`，并用`annexb=yes/no`协商。RFC 7261也规定参数缺失默认`yes`，任一方明确`no`时最终不得使用Annex B。([[RFC 编辑器](https://www.rfc-editor.org/rfc/rfc7261.html)][5])

建议把术语改为：

```text
Wire Codec Identity: G729/8000
Processing Capability:
  G729_SPEECH_ONLY
  G729_ANNEX_B
```

而不是把G729A和G729AB描述成两个对外Codec identity。否则可能导致：

* SDP出现两个相同`G729/8000`条目；
* Payload Type映射冲突；
* LCR/计费将同一wire codec错误视为两个codec；
* 与运营商互通时策略过于严格。

rvoip固定版本中的G.729路径本身也仍是Developer Preview，适合作为源码候选，不适合把上游声明直接提升为生产能力。([[GitHub](https://github.com/eisenzopf/rvoip/blob/4ced02b7f6e73041c848f1765dc2bcf7588796f0/README.md)][6])

---

## I7. 缺少持久化Schema与Snapshot版本兼容策略

你已经引入大量持久对象：

* Business Dialog；
* Protocol Dialog snapshot；
* Media Plan；
* Edge；
* Binding Group；
* Wire Bundle；
* Effect Receipt；
* Recovery Capsule。

必须补充：

* schema version；
* forward/backward compatibility；
* binary version与snapshot version矩阵；
* rolling upgrade时新旧节点谁能接管谁；
* 不兼容snapshot的drain策略；
* unknown字段保留；
* 数据迁移回滚方式。

否则“保留旧Call直到自然结束”和“owner takeover”会在升级时冲突。

---

## I8. 固定rvoip commit之后，缺少安全补丁和升级治理

固定源码有利于可复现，但还需要：

* 上游安全公告监控；
* CVE backport SLA；
* 哪些修改直接cherry-pick；
* 哪些修改触发完整重新资格化；
* Source Slice是否允许本地修改；
* 维护fork的生命周期；
* 当上游API变化时如何减少永久分叉。

这很重要，因为固定版本的rvoip自己也明确还有P2/P3安全与工程加固事项。([[GitHub](https://github.com/eisenzopf/rvoip/blob/4ced02b7f6e73041c848f1765dc2bcf7588796f0/docs/PRODUCTION_HARDENING_ROADMAP.md)][1])

---

## I9. Rust-native Fast Path在运营上仍然是一种Deployment Capability Profile

文档说它不是第二个Deployment Profile，但它可能需要完全不同的：

* kernel模块；
* eBPF/XDP；
* AF_XDP；
* NIC驱动；
* hugepage；
* CPU/NUMA布局；
* RSS/RPS/XPS；
* 容器权限；
* 运维Runbook。

它可以不是第二套**业务Authority架构**，但必然是不同的**运行能力配置档案**。

建议区分：

```text
Architecture Profile: CARRIER-CELL-V1
Runtime Capability Profile:
  RTPENGINE_KERNEL_V1
  RTPENGINE_USERSPACE_V1
  RUST_AF_XDP_V1
```

否则会把真实的运维差异藏在“同一Profile”名义下。

---

## I10. 缺少明确的容量准入公式

文档要求Backend-specific reservation，但未定义需求向量。

至少需要：

```text
MediaDemand {
  rtp_streams
  rtcp_streams
  packets_per_second
  ingress_bps
  egress_bps
  decode_units
  encode_units
  resample_units
  mixer_inputs
  recorder_tracks
  ai_streams
  ports
  srtp_contexts
}
```

G.729、Opus、录音、AI和Conference不能只用“并发路数”准入。

---

## I11. 缺少时钟与时间语义

需要明确：

* durable事件使用UTC wall clock；
  -Timer、RTP调度和deadline使用monotonic clock；
* NTP跳变不能影响SIP Timer；
* 不同节点CDR时间如何校准；
* RTP timestamp和系统时钟漂移；
* 音频resampler如何处理长期clock skew。

---

## I12. Drain策略缺少最长生命周期

“旧Call自然drain”可能被以下场景无限阻塞：

* 数小时会议；
* 永不挂机的监控通话；
* SIP Session Timer失效；
* 异常half-open Dialog；
* RTP仍有包但SIP状态丢失。

需要定义：

* `max_drain_duration`；
* 强制BYE策略；
* 超时后保留旧binary还是终止；
* emergency security rollout是否允许强制中断；
* active count为零的可信判断。

---

# 四、尚未形成直接矛盾，但建议补充

## 1. WebRTC边界

文档把浏览器WebRTC交给LiveKit/Coturn，但没有解释：

* LiveKit与SIP/RustPBX之间通过什么网关；
* Opus/G.711在哪里转换；
* WebRTC录音和AI tap由谁负责；
* DTMF和Call状态如何映射。

## 2. 密钥生命周期

除了“不持久化raw SRTP key”，还应规定：

* 内存zeroize；
* 禁止core dump；
* crash dump脱敏；
* KMS/HSM引用；
* key rotation；
* fork/clone时不复制密钥；
  -日志和metrics不泄漏key reference关联信息。

## 3. Conference资源模型

N方会议需要单独定义：

* N-1 mixing；
* active speaker；
* 最大输入；
* mixer复杂度；
* 每参与者独立编码；
* 抖动缓冲策略；
* 会议录音轨道；
* 大会场是否转SFU或层级Mixer。

## 4. 音质门禁

除了P99和sessions/core，还需要：

* POLQA/PESQ或等价客观指标；
* 多次串联转码退化；
* clipping；
* level normalization；
* PLC质量；
* DTX/CNG切换；
* 长期采样时钟漂移。

## 5. 正式状态机验证

当前prepare/commit/reconcile、owner epoch和handoff状态机很复杂，建议使用：

* TLA+或PlusCal验证状态转换；
* Rust Loom验证并发原语；
* property-based test验证命令乱序、重复、unknown outcome；
* fault injection覆盖WAL写入与网络响应任意切点。

## 6. Native依赖策略

如果Opus、AMR或其他Codec通过C/C++ FFI进入统一进程，需要单独审计：

* panic/abort边界；
* allocator归属；
* thread safety；
* SIMD CPU feature；
* ASan/UBSan；
* ABI锁定；
* 是否需要进程隔离。

---

# 五、建议直接修改文档的八处内容

## 修改1：文档状态

从：

```text
Accepted，唯一权威架构与生产基线
```

改为：

```text
Accepted with Blocking Corrections
唯一权威目标架构；生产可执行性尚未通过
```

## 修改2：增加“SIP Effect语义边界”

明确：

* 不保证网络Exactly Once；
* receipt分层；
* 本地send不等于peer receive；
* 相同Transaction identity重传；
* 2xx/ACK属于Core特殊语义。

## 修改3：拆分`prepare_effect`

改成：

```text
semantic_prepare
resolve_and_bind
freeze_wire_effect
durable_commit
transmit
```

## 修改4：将RTPengine Active Migration从V1基线移出

V1固定：

```text
new-call selection
old-call drain
no active ordinary-edge migration
```

等原子补丁通过后，再发布`CARRIER-CELL-V1.x`能力升级。

## 修改5：增加Backend Capability Contract

明确Backend支持的：

* allocation；
* fence；
* revoke；
* query；
* flow粒度；
* security终止；
* migration；
* tap；
* codec。

## 修改6：增加“不可恢复状态矩阵”

明确Dialog、Transaction、Transport Connection、2xx/ACK、PRACK分别如何恢复。

## 修改7：修正同进程故障保证

将“故障隔离”拆成：

* task/shard-level isolation；
* process-level isolation；
* node-level isolation。

不要把三者混称。

## 修改8：增加持久化和升级合同

包含：

* Schema version；
* Effect WAL；
* snapshot compatibility；
* rolling upgrade；
* GC与retention；
* security backport。

---

# 六、建议后的实施顺序

```text
D0-A  修正文档中的6个Critical
D0-B  定义SIP Effect和Recovery合同
D0-C  定义Backend Capability与Graph Compiler规则
D0-D  决定RTPengine V1不迁移，或先完成原子patch
D0-E  定义同进程故障保证的真实边界
D0-F  建立Schema/版本/升级合同

D1    G.729源码提取与离线测试
D2    Parser离线差异测试
D3    Parser主路径灰度
D4    Transaction/Dialog/Transport替换
D5    voice-media-rs同进程处理路径
D6    完整共驻容量测试
D7    原子媒体迁移与Rust fast path资格化
```

# 最终裁决

**架构主线不需要推倒重来。**

应保留：

```text
RustPBX业务Authority
+ rvoip低层选择性吸收
+ RTPengine普通媒体
+ voice-media-rs解码媒体
+ 单一Media Plan
+ 单writer原则
```

但现在还不能称为“生产基线已冻结”，因为两个最关键的保证尚未成立：

1. SIP Effect的发送、重放和恢复语义还没有达到可实现的精度；
2. RTPengine的原子Binding lifecycle目前只是设计目标，不是已有能力。

我的审查结果是：

> **架构方向：通过。**
> **D0文档门禁：不通过。**
> **开始Parser/G.729离线工作：可以。**
> **开始替换生产SIP主路径：暂不可以。**
> **宣称`CARRIER-CELL-V1`可执行生产基线：暂不可以。**

修正上述Critical后，这套架构有资格进入实现阶段，而且不需要改变“RustPBX产品主干 + rvoip底层吸收 + RTPengine快路径”的核心决策。

[1]: https://github.com/eisenzopf/rvoip/blob/4ced02b7f6e73041c848f1765dc2bcf7588796f0/docs/PRODUCTION_HARDENING_ROADMAP.md "rvoip/docs/PRODUCTION_HARDENING_ROADMAP.md at 4ced02b7f6e73041c848f1765dc2bcf7588796f0 · eisenzopf/rvoip · GitHub"
[2]: https://github.com/sipwise/rtpengine?utm_source=chatgpt.com "sipwise/rtpengine: The Sipwise media proxy for Kamailio"
[3]: https://www.rfc-editor.org/rfc/rfc3261.html "www.rfc-editor.org"
[4]: https://github.com/sipwise/rtpengine/blob/master/docs/ng_control_protocol.md "rtpengine/docs/ng_control_protocol.md at master · sipwise/rtpengine · GitHub"
[5]: https://www.rfc-editor.org/rfc/rfc7261.html "www.rfc-editor.org"
[6]: https://github.com/eisenzopf/rvoip/blob/4ced02b7f6e73041c848f1765dc2bcf7588796f0/README.md "rvoip/README.md at 4ced02b7f6e73041c848f1765dc2bcf7588796f0 · eisenzopf/rvoip · GitHub"
