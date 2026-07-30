## 结论

**我同意把这条路线锁定为后续开发的生产基线，但要修改一句话：**

> 不是“唯一且永远不变的实现”，而是“唯一权威架构 + 唯一生产基线 + 可替换的底层 Backend”。

推荐正式定案为：

```text
Kamailio
    │
    ▼
Unified RustPBX
    ├── 唯一 Call Core
    ├── 唯一 Call Registry
    ├── 唯一 SIP 状态 Authority
    ├── 唯一 Media Plan Authority
    ├── rvoip 选择性同进程吸收
    └── Media Engine Facade
           ├── RTPengine：普通 RTP/SRTP 快路径
           └── voice-media-rs：需要解码的媒体路径
```

这比以下两条路线都合理：

```text
完整 RustPBX + 完整 rvoip 直接混合
```

```text
RustPBX 服务 ↔ RPC ↔ rvoip 服务
```

但还需要补上几个关键约束，否则后面仍可能出现双状态、双媒体控制和职责重叠。

---

# 1. 锁定的是 Authority，不是某个库

必须冻结以下权威边界：

| 状态领域                         | 唯一 Authority          |
| ---------------------------- | --------------------- |
| 业务呼叫、Leg、Bridge              | `Call Core`           |
| SIP Transaction、Dialog、Timer | 当前生效的 `SipFoundation` |
| 路由、租户、限额、计费策略                | 业务核心                  |
| Codec策略、媒体拓扑、Backend选择       | `Media Plan`          |
| RTP端口、SSRC、Sequence、媒体运行态    | 当前媒体Backend           |
| CDR业务时间线                     | `Call Core`产生的标准事件    |
| RTP质量数据                      | 媒体Backend上报           |

因此不是简单地说：

```text
RustPBX负责业务
rvoip负责SIP
RTPengine负责媒体
```

还要明确数据所有权。

例如，SDP解析可以由rvoip完成，但最终选择：

* 使用哪个Codec；
* 是否允许转码；
* 是否锚定媒体；
* 是否走RTPengine；
* 是否进入`voice-media-rs`；
* 是否录音或媒体分叉；

应由统一的`Media Plan`决定。

---

# 2. rvoip只吸收底层，不引入高层Orchestrator

rvoip当前的SIP端点、Dialog控制、B2BUA构建能力、RTP/RTCP与G.711核心已经进入其Beta范围；但G.729、Opus、G.722、会议混音、WebRTC等仍有不同程度的Developer Preview属性。([[GitHub](https://github.com/eisenzopf/rvoip)][1])

因此建议只引入：

```text
SIP Parser
Transport
Transaction
Dialog
SDP
必要的 RTP/RTCP 基础类型
```

暂时不要引入：

```text
rvoip Orchestrator
rvoip Call/Conversation高层模型
rvoip Registrar/Proxy业务模型
rvoip Workforce/Identity扩展
全量WebRTC/UCTP/MoQ体系
```

原因是rvoip自己的接口设计也把Queue、技能、坐席状态等Workforce语义留给上层消费者；它自身定位更接近通信基础设施和跨协议编排库，而不是你的运营软交换业务核心。([[GitHub](https://github.com/eisenzopf/rvoip/blob/main/docs/INTERFACE_DESIGN.md)][2])

推荐接口：

```rust
pub trait SipFoundation {
    type DialogHandle;
    type TransactionHandle;

    async fn receive(
        &self,
        packet: SipPacket,
    ) -> Result<Vec<SipEvent>, SipError>;

    async fn send_request(
        &self,
        request: OutboundRequest,
    ) -> Result<Self::TransactionHandle, SipError>;

    async fn send_response(
        &self,
        response: OutboundResponse,
    ) -> Result<(), SipError>;
}
```

业务层不得直接使用rvoip或rsipstack的公开类型。

---

# 3. RTPengine长期保留是对的，但应定义为“一级生产Backend”

RTPengine明确支持：

* 内核态包转发；
* 内核不可用时自动回退用户态；
* IPv4/IPv6桥接；
* RTP与SRTP互通；
* 录音；
* 转码和重打包；
* DTMF转换与注入；
* 媒体分叉；
* T.38与PCM转换。([[GitHub](https://github.com/sipwise/rtpengine)][3])

因此，将它作为普通媒体快路径是目前更稳妥的选择：

```text
G.711 ↔ G.711
RTP ↔ RTP
RTP ↔ SRTP
IPv4 ↔ IPv6
NAT锚定
无需业务解码的录音或媒体分叉
```

但是建议把“永久不替换”改成：

> RTPengine是长期支持的一级生产Backend，也是任何纯Rust快路径必须达到的性能和可靠性下限。

未来即使纯Rust快路径成熟，也可以保留：

```text
media.backend = rtpengine
media.backend = rust_fast_path
```

而不是做一次高风险的全局替换。

---

# 4. `voice-media-rs`应优先做成同进程crate

你之前明确不希望出现两个Rust节点。因此建议：

```text
Unified RustPBX进程
└── voice-media-rs library
```

不要第一阶段部署成：

```text
Unified RustPBX
     │ RPC
voice-media-rs服务
```

它可以同时保留二进制入口，用于：

* 独立压测；
* Codec测试；
* 诊断；
* 将来超大规模时拆出Media Worker。

但第一阶段生产调用应是：

```rust
MediaEngine::create_session(...)
MediaEngine::push_frame(...)
MediaEngine::inject_audio(...)
```

而不是HTTP或gRPC。

你给出的本地仓库状态、104项测试、线程分片、Datagram Pool等内容，我无法从公开互联网独立验证，因为路径属于你的本地工程；现阶段可以把它们视为你的代码审计结果，但不能把这些结果直接等同于生产认证。

---

# 5. Backend不应简单按“整个Call”选择

“建呼时确定Backend，通话中不迁移”原则正确，但粒度最好是：

> **每个Media Leg或Media Graph边，在创建时确定Backend。**

因为一个电话可能同时包含：

```text
用户A ── RTPengine ── 用户B
                  │
                  └── 单向分叉 ── voice-media-rs录音/AI分析
```

也可能是：

```text
电话用户
   │
RTPengine边缘锚定
   │
voice-media-rs
   ├── G.711解码
   ├── AI语音
   └── G.711编码
```

推荐抽象：

```rust
pub struct MediaPlan {
    pub edges: Vec<MediaEdge>,
}

pub struct MediaEdge {
    pub source: MediaEndpoint,
    pub destination: MediaEndpoint,
    pub backend: MediaBackend,
    pub mode: MediaMode,
}
```

其中：

```rust
pub enum MediaMode {
    Relay,
    Transcode,
    Mix,
    RecordTap,
    AiBidirectional,
}
```

规则是：

* 同一条媒体边只有一个Writer；
* 媒体分叉的接收者可以是只读Observer；
* 通话中不得无状态迁移Backend；
* 需要迁移时，必须作为显式re-INVITE/新Media Session处理；
* 每条边独立释放端口、SSRC和缓冲区。

---

# 6. 普通快路径和解码路径要彻底分开

## 普通路径

```text
RTP Packet
    │
RTPengine
    │
RTP Packet
```

禁止经过：

* Call Actor；
* Rust通用事件总线；
* 数据库；
* HTTP；
* PCM转换；
* `voice-media-rs`；
* 每包日志。

## 解码路径

```text
RTP
 ↓
Jitter Buffer
 ↓
Decoder
 ↓
PCM Pipeline
 ├── Transcode
 ├── IVR
 ├── Mixer
 ├── Recorder
 └── AI
 ↓
Encoder
 ↓
RTP
```

`voice-media-rs`承担这一条路径。

这样才不会因为增加AI、录音或G.729能力，降低全部普通通话的容量。

---

# 7. 必须限制RTPengine与voice-media-rs的能力重叠

RTPengine本身也有转码、录音、DTMF处理和媒体分叉能力。([[GitHub](https://github.com/sipwise/rtpengine)][3])

如果不制定能力矩阵，后面会出现：

* 两边都能录音，不知道使用哪一个；
* 两边都能转码，质量和计费不可预测；
* DTMF在两边重复转换；
* 两层Jitter Buffer；
* 同一流被重复重采样；
* RTPengine和Rust同时改写SDP。

建议第一版固定：

| 能力               | 默认Backend      |
| ---------------- | -------------- |
| RTP/SRTP relay   | RTPengine      |
| NAT、ICE、地址族桥接    | RTPengine      |
| 普通媒体锚定           | RTPengine      |
| 不解码媒体录制          | RTPengine可选    |
| G.711 ↔ G.729    | voice-media-rs |
| G.711 ↔ Opus     | voice-media-rs |
| IVR动态生成          | voice-media-rs |
| 双轨录音与PCM质检       | voice-media-rs |
| AI双向媒体           | voice-media-rs |
| Conference/Mixer | voice-media-rs |
| DTMF透传           | RTPengine      |
| 业务DTMF识别与生成      | voice-media-rs |

后续任何能力迁移，都需要ADR和基准测试，不允许通过配置随意切换两套实现。

---

# 8. RustPBX主干仍可保留，但要逐步“去底座化”

RustPBX当前已经直接依赖：

* `rsipstack 0.5.22`；
* `audio-codec 0.3.40`；
* `rustrtc 0.3.110`。([[GitHub](https://github.com/restsend/rustpbx/blob/main/Cargo.toml)][4])

而且它当前本身已经提供完整SIP、RTP、Queue、录音、控制台和RWI能力，并公布了G.711 RTP代理的并发基准。([[GitHub](https://github.com/restsend/rustpbx)][5])

因此融合路线应当是：

```text
RustPBX产品主干
   │
   ├── 保留产品模块
   │   ├── Console
   │   ├── Storage
   │   ├── Tenant
   │   ├── Routing
   │   ├── Queue
   │   ├── CDR
   │   └── Observability
   │
   └── 逐步替换基础设施
       ├── rsipstack → SipFoundation候选
       ├── rustrtc → RTPengine/Media Facade
       └── audio-codec → 统一Codec Registry
```

不是把RustPBX全部保留，也不是重新从零写产品层。

---

# 9. 建议正式冻结的架构决议

可以把以下内容写成`ADR-001`：

```text
1. RustPBX作为产品与业务主干。
2. rvoip仅通过SipFoundation和必要媒体接口选择性吸收。
3. 任意时刻只有一个SIP实现可以写Transaction和Dialog状态。
4. 不采用RustPBX与rvoip两个Rust服务之间的RPC架构。
5. RTPengine是普通RTP/SRTP的一级生产Backend和性能基线。
6. voice-media-rs负责必须解码的媒体能力，第一阶段同进程链接。
7. 每条Media Edge只能有一个Writer。
8. Media Backend在Media Edge创建时固定。
9. RTP热路径不得经过业务Actor、数据库、HTTP或通用事件总线。
10. 不引入rvoip高层Orchestrator与RustPBX Call Core竞争。
11. 不允许两套SDP、Codec、Dialog或Media Session同时成为权威。
12. 所有底层替换必须通过同机、同流量、同参数的Gate。
```

# 最终判断

**同意锁定这条路线。**

但准确名称应该是：

> **RustPBX产品主干 + 单一Authority + rvoip选择性同进程吸收 + RTPengine一级快路径 + voice-media-rs同进程解码路径。**

它不是“两项目融合”，而是：

```text
保留RustPBX的产品价值
+
建立统一领域核心
+
用接口逐项筛选rvoip实现
+
用RTPengine守住普通媒体性能下限
+
用voice-media-rs建设差异化媒体能力
```

这是当前信息下风险、上线速度、性能和长期可控性最平衡的基线。真正需要长期保持不变的是**Authority边界和接口契约**，而不是承诺某个底层库永远不会被替换。

[1]: https://github.com/eisenzopf/rvoip "GitHub - eisenzopf/rvoip · GitHub"
[2]: https://github.com/eisenzopf/rvoip/blob/main/docs/INTERFACE_DESIGN.md "rvoip/docs/INTERFACE_DESIGN.md at main · eisenzopf/rvoip · GitHub"
[3]: https://github.com/sipwise/rtpengine "GitHub - sipwise/rtpengine: The Sipwise media proxy for Kamailio · GitHub"
[4]: https://github.com/restsend/rustpbx/blob/main/Cargo.toml "rustpbx/Cargo.toml at main · restsend/rustpbx · GitHub"
[5]: https://github.com/restsend/rustpbx "GitHub - restsend/rustpbx: A PBX written by rust · GitHub"
