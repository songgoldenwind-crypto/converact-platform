# Converact Platform — 统一领域语言

Converact Platform 上下文定义跨业务 Profile 的 Engagement、通信、人工/AI 协作、证据和结果语言，
以及通信底座中的呼叫、信令与媒体语言。本文只定义统一语言；实现、商业包装与选型记录在
设计文档和 ADR 中。

## Language

**Engagement**:
围绕一个可描述业务目的、可以跨渠道、跨 Interaction 和跨天持续的持久容器。一个
Engagement 绑定一个版本化 Engagement Profile，并可包含多个 EngagementItem。
_Avoid_: Resolution（未说明 Profile）、Conversation、Call、Room、Ticket、Opportunity

**EngagementItem**:
Engagement 中能够独立资格化、执行、验证、重开和结果归因的最小业务结果单元。它不是路由
队列中的 WorkItem，也不是 Agent 的一个 turn。
_Avoid_: WorkItem、Task、ResolutionItem（未说明 `resolution` Profile）

**Engagement Profile**:
在不创建第二套平台 Authority 的前提下，为一种业务形态定义字段、状态、不变量、
VerificationPolicy、指标、UI 和 Connector 映射的版本化领域语义包。
_Avoid_: 独立平台、行业 Fork、Product Offer

**Product Offer**:
客户可购买的合同包装，明确 Profile、能力、范围、价格、区域、支持、验收与可销售状态。
_Avoid_: Engagement Profile、Deployment Option、功能列表

**Objective**:
Engagement 希望达到并可由 Profile 解释和验证的业务目的。
_Avoid_: Prompt、Task、模型目标

**Resolution**:
绑定 `resolution` Engagement Profile 的 Engagement，表达一个或多个需要独立验证的问题。
它是首个垂直领域模型，不是 Converact 平台的上位对象。
_Avoid_: Platform、Call、Ticket、Case

**ResolutionItem**:
`resolution` Profile 中、`item_type=problem` 的 EngagementItem，拥有独立 ProblemStatement、
fingerprint、基线、VerificationPolicy、OutcomeClaim 和复发窗口。
_Avoid_: 任意 EngagementItem、Task、Case line

**Interaction**:
参与者的一次连续参与窗口；可以在不中断参与关系的情况下同时或顺序使用电话、LiveKit、
IM、屏幕和未来 ViLTE。一个 Engagement 可以包含多个 Interaction。
_Avoid_: Engagement、SIP Call-ID、LiveKit Room、Provider Session、跨天 Conversation

**Communication Session**:
Interaction 在一个具体通信渠道上的运行实例，例如一通电话、一次 Room 使用或一个消息
窗口。Provider/runtime ID 只作为引用，不替代 InteractionId 或 EngagementId。
_Avoid_: Interaction、Engagement、bare Session

**Task**:
人工或 AI 为推进某个 EngagementItem 而需要完成的工作，生命周期由 Converact Agent Runtime
管理；Engagement Core 只保存稳定引用和结果关系。
_Avoid_: EngagementItem、WorkItem、AgentRun

**Evidence**:
带来源、时间、授权、完整性、保留策略和 lineage 的事实材料，可被 Profile 的
VerificationPolicy 引用。
_Avoid_: Agent summary、无来源模型输出、普通附件

**Action**:
对外部系统、设备或受控业务状态产生副作用的意图与执行生命周期，必须具备授权、幂等、
Receipt 和不确定结果 reconcile。
_Avoid_: Tool call、HTTP 2xx、LLM function proposal

**OutcomeClaim**:
针对一个 EngagementItem、按版本化 VerificationPolicy 和 Evidence 提出的可争议结果
声明；只有 Finalized claim 才能用于正式结果和相应计费。
_Avoid_: Call ended、Case closed、模型自评、客户沉默

**Call**:
一次具有业务身份、租户归属和生命周期的通信交互，可以包含一条或多条 Leg。
_Avoid_: Session、Conversation

**Leg**:
Call 中面向一个端点或上游网络的单条信令关系。
_Avoid_: Channel、Participant

**Business Dialog**:
受 owner fencing 保护、可持久恢复并归属于某条 Leg 的业务对话事实。
_Avoid_: bare Dialog、Protocol Dialog

**Protocol Dialog**:
由 SIP Call-ID、local tag、remote tag、route set 和 CSeq 等协议事实标识的 RFC 3261 对话。
_Avoid_: Business Dialog、Call

**Protocol Transaction**:
一次 SIP 请求及其响应、重传、计时器和终止状态组成的协议交换。
_Avoid_: Call、Business Transaction

**Protocol Session**:
协议运行时中把 Transport、Protocol Transaction 和 Protocol Dialog 组合起来的临时执行上下文，不是业务权威。
_Avoid_: bare Session、Call

**Logical Media Graph**:
描述 Call 各端点与处理阶段应如何连接的业务意图，不包含 Backend 选择、最终线上端口、
SSRC 或加密状态。
_Avoid_: Media Plan、Wire SDP、RTP Session

**Media Plan**:
由 Media Engine Facade 根据 Logical Media Graph、codec/security/recording policy、
capacity admission 和当前 Backend eligibility 编译出的有版本执行计划。它把业务意图
展开为一组有向 Media Edge 及其 Backend assignment，但不把尚未 commit 的端口、SSRC
或密钥误写成业务事实。
_Avoid_: Logical Media Graph、Wire Media Binding、Deployment Profile

**Candidate Media Plan**:
已完成结构校验、Backend 选择和 Backend Binding Group 编组，但尚未形成 durable
commit decision 的候选执行计划。它可以持有有 TTL 的 capacity reservation 和
`prepared_blocked` Wire Transport Bundle；失败后必须按 attempt/revision 明确 abort，
不能静默重编译或冒充已 commit Media Plan。
_Avoid_: committed Media Plan、Logical Media Graph、mutable final plan

**Media Endpoint**:
有向 Media Edge 的源或目的端，可以是 Call Leg、RTPengine endpoint、embedded
processing stage、recorder、AI tap 或 mixer port。
_Avoid_: Call、Leg、Backend

**Media Edge**:
Media Plan 中从一个 Media Endpoint 指向另一个 Media Endpoint 的单向媒体执行单元，
具有稳定 `MediaEdgeId`、mode、Backend identity、plan/binding revision 和 writer
fence。双向通话必须表示为两条 Edge；fork、tap、chain 和 mix input/output 必须表示为
不同 Edge，不能把两个可写 Backend 塞进同一 Edge。
_Avoid_: bidirectional RTP Session、whole Call media backend

**Directed Media Edge**:
`Media Edge` 的规范性全称，用于强调它只能有一个 source、一个 destination，并且每个
Edge generation 只有一个 active writer。语音与 LiveKit 之间的双向音频必须由两条
方向相反的 Directed Media Edge 表示，不能用一个“双向 bridge”隐藏双写。
_Avoid_: bidirectional writer、implicit reverse path

**Voice-LiveKit Handoff**:
在保持同一 `interaction_id`、业务 Call、路由/计费/录音决策 Authority 的前提下，把
一条或多条 Directed Media Edge 从 SIP/PSTN 端切换到 LiveKit Room，或从 LiveKit
Room 切回 SIP/PSTN 端的持久、owner-fenced 状态机。它改变媒体执行绑定，不把 Call
Authority 转移给 LiveKit，也不把 Room/WebRTC Authority 转移给 RustPBX。
_Avoid_: Call transfer of authority、PBX replacement、unproved seamless switch

**Voice-LiveKit Bridge**:
RustPBX Media Engine Facade 对 `RustPBX ↔ livekit-sip ↔ LiveKit` 执行路径的绑定与
receipt。它记录 bridge ID/generation、方向、关联 Call/Room/participant、owner epoch、
command sequence、writer fence、handoff decision、provider receipt 与 terminal cleanup
receipt；不是第二个 Call、CDR、Room、RecordingManifest 或 billing Authority。
_Avoid_: second Call、LiveKit-owned CDR、recording authority

**LiveKit SIP Audio Bridge**:
`Voice-LiveKit Bridge` 的音频执行器精确名称。它使用 LiveKit SIP 把 SIP/RTP 音频映射
成 Room participant/audio track；不表示 Video over SIP，也不能继承 ViLTE 视频资格。
_Avoid_: LiveKit video bridge、AV Gateway

**AV Participant Gateway**:
把 RTPengine-facing ViLTE 音视频映射成同一个 LiveKit participant/PeerConnection 的
audio/video tracks，并把订阅的 Room tracks 反向发送给 carrier 的双向执行器。carrier、
内部和 LiveKit 三段 crypto context 分离。它遵守 Media Plan、Bridge Generation 和
writer fence，不拥有 Call、Room、billing、RecordingManifest 或 Agent 业务状态。
_Avoid_: PBX、SFU、LiveKit SIP Audio Bridge、RTPengine

**Bridge Generation**:
Voice-LiveKit Bridge 一次不可变的执行尝试。改变方向、participant、Room、Backend、
transport 或 writer 必须产生新 generation，并通过
`prepare/commit/abort/query/reconcile` 与旧 generation 的 revoke/cleanup 收敛。每个
generation 的双向媒体仍分别对应两条 Directed Media Edge。
_Avoid_: mutable bridge in place、generation-less retry

**Media Backend**:
执行一条或多条 Media Edge 的实现，例如 RTPengine ordinary fast path、进程内
`voice-media-rs` processing Backend，或通过资格门禁后的 Rust-native fast-path
Backend。Backend 不是 Authority；其行为受 Media Plan、writer fence 和 Wire Media
Binding 约束。
_Avoid_: Media Engine Facade、Deployment Profile、media authority

**Backend Binding Group**:
把一条或多条逻辑 Media Edge 映射到同一个 Backend 原生会话/传输分配的物理生命周期
单元。它具有稳定 group ID、generation/revision、Backend instance/native session key、
不可变成员集合及其 digest、admission receipt、output gate、prepared lease 和引用计数；
每个成员记录 Edge ID/generation、binding revision、`flow_selector` 和 writer fence。
RTPengine 的 call/tag/media-section 以及共享的双向端口、ICE、DTLS 和 SDP 必须由该
对象管理。一个 generation 内成员不可变；改变 Backend、端口、成员或 writer 必须新建
generation。Edge 仍是 writer Authority 粒度，Binding Group 只是物理资源粒度。
_Avoid_: Media Edge、whole Call authority、independent per-edge port allocation

**Wire Transport Bundle**:
Backend Binding Group generation 返回并实际使用的共享网络事实，包括 bundle
revision/digest、一个或多个 effective SDP view、按 `flow_selector` 索引的
local/remote tuple 与 m-line/mid、端口、ICE/DTLS/SRTP state、SSRC state、
key reference、Backend reservation identity、live member refcount 和 TX counter
watermark。raw SRTP key 不持久化。它由成员 Edge 的 Wire Media Binding 引用，不复制
为多份可独立释放的物理事实。
_Avoid_: Logical Media Graph、per-edge duplicated effective SDP

**Wire Media Binding**:
某条已 commit Media Edge 对 Backend Binding Group/Wire Transport Bundle 的逻辑映射，
包含 edge generation/binding revision、writer fence、group ID/generation、
`flow_selector` 和生命周期。每个 Edge generation binding 必须恰好映射一个
group/flow；packet path 通过预编译 `flow_selector -> edge binding` 做 `O(1)` 查找，
不得扫描 group members。Edge release 先解除成员关系；只有 group live member
refcount 归零时，才释放共享端口、SDP、ICE/DTLS、SSRC/key reference 和 Backend
reservation。整个 group 的替换必须生成新的 group generation，旧 generation 仍须
等到 zero live refs 才能释放。
_Avoid_: Logical Media Graph、Media Plan、duplicated physical transport ownership

**Processing Session**:
需要解码、转码、播放、收号、混音或 AI 音频处理的有界媒体执行上下文。
_Avoid_: Protocol Session、Call

**Channel Agent Runtime**:
面向一个通信渠道、拥有当前连接/turn/buffer/playback 和短期 framework state 的 Agent
执行上下文。Telephony Channel Agent 可吸收 Active Call 的电话能力；Room Channel
Agent 可使用 LiveKit Agents。它不拥有跨渠道 Task、Memory、Policy、Approval 或 Tool
side effect。
_Avoid_: AI-native Orchestrator、Call Authority、Speech Runtime

**Speech Runtime**:
通过 Converact-owned normalized contract 执行 VAD/STT/LLM/TTS、streaming event、cancel、
usage 和 session lifecycle 的可替换运行时。Hugging Face `speech-to-speech` 是目标主
实现，channel-native pipeline 是迁移/A-B baseline。Speech Runtime 不拥有 Task、
Tool、Memory、Call 或 Room。
_Avoid_: Agent framework、AI-native Orchestrator、Provider-specific domain model

**AI-native Orchestrator**:
跨渠道 AgentRun、Task DAG、Context Revision、Memory Proposal、Policy、Handoff 和
Evaluation 的唯一业务 Authority。它通过 Channel Agent Runtime 与 Speech Runtime 执行，
只能向独立 Action Authority 提交 Action Proposal，不拥有 Action Ledger，也不管理 RTP、
Room 或 SIP Protocol Dialog。
_Avoid_: Speech Runtime、LiveKit Agents、Active Call、LLM

**Context Revision**:
由 AI-native Orchestrator 单写的 canonical conversation/task context 版本，绑定
Interaction、AgentRun、memory/policy/tool catalog revisions 与内容 digest。Channel
framework、Speech Runtime 和 Provider 的 chat/history 只是可丢弃 projection；每次
response 创建和 tool-result 回注必须匹配当前 Context Revision。
_Avoid_: framework-local chat authority、Provider session history

**Response Lease**:
由 Converact Interaction Lease Store 通过 durable CAS 唯一签发，绑定 Interaction、AgentRun、
Channel Binding、lease/response generation、owner epoch、fence 和 expiry 的独占响应
许可。只有当前 lease holder 可以提交 turn、播放/发布 Agent 输出、取消响应或提交本
generation 的 tool proposal；audio/publisher/tool/transcript output gate 必须拒绝旧
fence。lease 丢失只停止 Agent 输出与动作，不停止主通信媒体。
_Avoid_: channel presence、best-effort active flag

**Speech Control Fence**:
由 Speech session coordinator 签发，保护 prepare、resource ownership 和 lifecycle
mutation 的 session/generation owner fence。它允许在新 Response Lease 签发前做无外部
输出的 blocked prepare，但不能授权 turn、TTS、tool 或电话动作。
_Avoid_: Response Fence、unfenced prepare

**Response Fence**:
从当前 Response Lease 派生，保护 turn、response、tool-result、cancel 以及所有可听、
可见或有副作用输出。output-affecting Speech mutation 同时验证 Speech Control Fence
和 Response Fence。
_Avoid_: Speech Control Fence、framework-local active flag

**Output Permit**:
由当前 Response Lease receipt 编译到 audio injector、LiveKit publisher、RustPBX
communication-action executor、Tool Broker 和 transcript sink 的本地只读 gate，使用
Interaction、lease/response generation 和 fence 做 `O(1)` 判定。它避免逐帧访问
durable store；到期或撤销时 fail closed。
_Avoid_: unguarded output、database lookup per audio frame

**Qualification Profile**:
在证据运行前固定 source/model/binary/config/hardware/workload/clock、绝对 SLO 与相对
门禁的签名测试身份。运行后补阈值、跨 profile 借证据或用 upstream claim 填 passed 均
不合法。
_Avoid_: benchmark description without thresholds、post-hoc gate

**Unified RustPBX Process**:
包含 RustPBX 产品层、Call Core、进程内 rvoip `SipFoundation` Adapter，以及首期
进程内嵌入的 `voice-media-rs` library/worker shards 的单一可执行进程；这些 Rust
模块只通过 Rust Interface、bounded queue 和内存对象调用，不使用 HTTP/gRPC/RPC。
RTPengine 仍是外部专用 ordinary media data plane。Revision 5 明确：该术语固定产品、
Call 和 Media Plan Authority，不要求 native/unsafe codec、recording upload、AI、
GPU 或 AV Gateway 永远位于同一 OS 地址空间；风险执行器可以进入受监管 worker fault
domain，而不成为第二 Authority。
_Avoid_: rvoip node、voice-media service、all-media-in-one-thread

**Media Engine Facade**:
RustPBX 面向 Logical Media Graph 的唯一媒体 Interface；它负责编译、校验、提交和
reconcile Media Plan，并以 owner-fenced
prepare/commit/abort/update/revoke/delete/query/reconcile 管理每条 Media Edge 及其 Backend
Binding Group。一个 Facade 不等于一个物理媒体进程，同一 Edge 同一时刻只能有一个
active writer。
_Avoid_: multiple media authorities、single physical executor

**Deployment Profile**:
固定生产 Authority、进程边界、故障域和媒体执行拓扑的可签署身份。
`CARRIER-CELL-V1` 是唯一生产基线：Unified RustPBX Process 内嵌
`voice-media-rs`，外接 RTPengine ordinary fast path。
`UNIFIED-STANDALONE-V1` 只表示开发、诊断、互通和 benchmark 拓扑，不是生产基线；
旧名 `RUST-NATIVE-CARRIER-V1` 不再表示第二套生产 Profile，只作为历史 capability
identity 保留，其工作归入 `RUST-NATIVE-FAST-PATH-CANDIDATE` Backend 资格轨道。
Helm 中历史命名为 `deploymentProfiles.core/ai/observability/benchmark` 的开关只是
Component Bundle Overlay，不属于本领域的 Deployment Profile，也不能改变 Authority。
_Avoid_: environment-only toggle、untracked topology

**Component Bundle Overlay**:
在同一个 `CARRIER-CELL-V1` 上增减 AI、observability 或 benchmark 组件的部署包选择。
Production-eligible 只表示该组件包可附加到生产基线，不表示新增了一套语音生产架构。
_Avoid_: Deployment Profile、Media Backend、Authority

**Carrier Fast Path**:
承载 ordinary RTP/RTCP/SRTP、端口和有效 Wire SDP 的高性能数据面。默认实现可为
RTPengine；Rust-native 实现只有通过同硬件证据门禁后，才可在同一个
`CARRIER-CELL-V1` 下成为 eligible Media Edge Backend。该术语不暗示 RTPengine 是
临时件，也不允许两个 Backend 对同一 Edge 双写。
_Avoid_: mandatory Rust rewrite、dual media authority

**Authority**:
对某类事实拥有唯一最终解释权，并负责其 fencing、持久化和冲突处理的角色。
_Avoid_: Owner（未说明所拥有事实时）、Primary

**Capability Absorption**:
在不转移 Authority 的前提下，采用另一项目的源码、算法、测试方法或接口语义。
_Avoid_: Runtime Replacement、whole-stack integration

**Runtime Replacement**:
把某类线上 Authority 及其运行职责从现有实现转移到另一实现。
_Avoid_: Capability Absorption、library upgrade

**Exact Source Slice**:
由仓库、commit、tree、归档哈希以及逐文件路径、大小和哈希共同固定的最小源码集合。
_Avoid_: latest source、floating dependency

**Production Eligibility**:
功能、互通、性能、安全、供应链和适用合规门禁均有同一源码身份的可验证证据后，才允许进入生产的状态。
_Avoid_: implemented、compiled、tests passed
