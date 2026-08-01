# Converact Architecture Foundation — 所有 Goal 的绑定执行规则

本文对 `goals/goal-*.md` 全部生效。单个 Goal 与本文冲突时，采用更严格的限制；如冲突
会改变 Authority、数据、计费、安全或用户体验，必须先修改 Goal 文件并重新审查。

## 1. 仓库与用户工作保护

完成品牌迁移后，唯一开发根为
`/Users/songjinfeng/Projects/converact-worktrees/platform`。以下目录只作为 Goal 00 的
只读迁移来源或生产证据边界：

- `/Users/songjinfeng/Desktop/opc`：包含既有 staged/dirty/untracked AI-native、
  Collaboration 和旧 G01–G07 工作的 legacy source；
- `/Users/songjinfeng/Projects/opc-worktrees/ivekit-v3`：通信 R4/R5 与历史开发 source；
- `/Users/songjinfeng/Projects/opc-worktrees/legacy-production-20260730`：冻结生产线，禁止修改。

Goal 00 必须验证 canonical root 的来源账本和完整性；不得重新选择旧目录为开发根，也不得
跨树批量复制、覆盖或清理代码。若 canonical root 不存在或品牌迁移未完成，Goal 00 直接阻断。

所有 Goal 必须：

- 禁止 reset、rebase、clean、discard、覆盖用户文件或改写已有提交；
- 禁止 `git add .`、`git add -A` 和无审计的全文件暂存；
- 只暂存本 Goal 的精确文件或 hunk；
- 不 push，除非用户明确授权；
- 不修改生产服务器、容器、Release、Feature Flag 或数据库，除非该 Goal 文件明确要求
  且用户另行授权；
- 不回显 `/private/tmp/opc-ivekit-runtime-access-2026-07-29.md` 中的任何凭据。

## 2. 不可变 Authority

- Kamailio：SIP Edge、ACL、限流、Registrar/Location 和边缘调度。
- Unified RustPBX：Native Call、Leg、业务 Dialog、路由、CDR、录音意图和 Media Plan。
- RTPengine：普通 RTP/RTCP/SRTP Fast Path 和默认性能底线。
- `voice-media-rs`：需要解码、转码、混音、播放、录音 tap 或 AI tap 的媒体外观。
- LiveKit：Room、Participant、Publication、WebRTC、ICE/DTLS/SRTP、SFU/TURN。
- Converact Engage：Engagement、EngagementItem、ProfileBinding、VerificationPolicy 与
  OutcomeClaim；Profile validator 不成为第二写者。
- Converact Fabric Coordination：一次连续参与窗口的 Interaction、CommunicationSession、
  BridgeIntent 与切换 generation。
- Converact Resolve Profile：把 `Engagement/EngagementItem` 严格特化为
  `Resolution/ResolutionItem`，只增加问题、复发、指标和验证语义。
- Converact Agent Runtime：跨渠道 AgentRun、Task、ContextRevision、Policy、Handoff 和
  Evaluation；只产生 ActionProposal。
- Converact Engage Action Authority：ActionIntent、Authorization、Attempt、Receipt、Verification、
  query/reconcile 和 Compensation；Agent/Framework 不得成为第二写者。
- 外部 PBX/CCaaS/CRM/FSM：Overlay 中继续拥有其 Call、Case、Opportunity、WorkOrder、SLA
  和正式关闭。

不得创建第二 PBX、第二 Call/Room/Engagement/Resolution/Agent/Recording/Billing Authority。
Adapter、Worker、Backend 和 Framework 都是可替换执行器。

## 2.1 Platform、Profile、Capability 与 Option Gate

- Platform Contract Gate 决定 Horizontal Platform 的术语、Authority、接口和证据纪律。
- Profile Market Gate 决定某个垂直 Profile/Offer 的 ICP、价值、范围和商业资格。
- Capability Gate 决定 Speech、Translation、Vision、Agent、Action、Recording 等能力是否可用。
- Deployment Option Gate 决定 Native、Dedicated、On-prem、OEM、ViLTE 等交付方式。

任一 Profile、能力或 Option 的失败只停止其自身路线，不能静默改写其他 Authority 或状态；
也不能以“平台更广”为理由无限开发。新 Profile 必须先有自己的市场与领域合同。首个 Resolve
Profile 的 Pilot、价格、B1 和转化 Gate 不得冒充整个平台的市场证明。

## 3. 性能与复杂度

性能第一，但不能用功能缺失换取数字。所有热路径必须：

- bounded queue、bounded retry、bounded fan-out；
- 禁止全局热锁、按包数据库/HTTP、线性全局扫描、每包 Tokio task 和无界分配；
- 使用 generation、owner epoch、fence 和 O(1) fast-path 判定；
- ordinary media 不经过 AI、录音上传、数据库或通用事件总线；
- AI、GPU、录音、对象存储或 Provider 故障不得拖垮已建立 Human Communication；
- 任何性能改善必须与相同功能、硬件、网络、Source、配置和 workload 的基线比较。

容量不能线性外推。普通语音、解码媒体、Bridge、翻译、Agent、录音、AV 和 mixed-cell
证据相互独立，不能借用。

## 4. 证据与状态

- 当前、target 和 `production_eligible` 必须分开。
- 未运行或没有原始 Evidence 的项目保持 `not_run`。
- Upstream benchmark、Mock、loopback 和 microbenchmark 不能成为生产证据。
- 每份 Evidence 固定 commit、source、binary/image、config、model、hardware、clock、
  workload、seed、时间和原始输出。
- `EffectReceipt` 必须区分 accepted、completed、state-observed；网络不承诺 Exactly Once。
- 所有外部副作用经过 idempotency、query/reconcile；`unknown` 不得盲目重试。
- 任何失败、deferred、rejected 或不适用要求都必须留在 traceability 中，不能删除。

## 5. TDD 与提交

每个 Goal 的执行顺序固定为：

```text
Current-state audit
→ Design/ADR
→ Machine Contract/Schema/Trace
→ Threat/Failure review
→ Detailed TDD plan with exact files
→ failing tests
→ minimal implementation
→ focused tests
→ controlled evidence
→ real dependency/long-run/capacity/recovery evidence
→ independent review
→ narrow commit
```

测试必须先证明预期失败，再实现最小通过版本。每次提交保持单一意图；文档合同、测试、
实现、证据可按可审查边界分开提交。

## 6. 安全、隐私与法律

- Tenant、Identity、Consent、Retention、Audit 和 Key lifecycle 是前置能力，不是上线收尾。
- Edge-to-Core 必须 mTLS 或等价强身份；禁止长期非 mTLS 例外。
- 密钥不进入日志、Prompt、Evidence 或 Core Dump；原生/unsafe/FFI slice 需独立 Gate。
- G.729 工程强制完成；法律/供应链 Gate 只限制分发与 enablement，不能删除工程任务。
- Video、录音、转写、翻译、AI 和工具动作分别记录授权。
- E2EE strict、trusted processing edge 和 server-processing 是不同 profile，不能混称。

## 7. 外部条件与停止

缺少账号、真实 Carrier/IMS、证书、号码、客户合同、GPU/Provider 配额或合法分发决定时：

1. 继续完成所有可离线合同、测试、Harness、仿真和故障注入；
2. 把外部项精确记录为 `not_run` 或 `blocked_external`；
3. 不伪造凭据、测试结果、客户访谈、合同或性能；
4. 不因一个外部阻塞停止其他独立离线工作。

Stop Gate 触发时必须停止相应路线，不得为了完成 Goal 而降低门槛。

## 8. create_goal 约定

每个 Goal 文件末尾包含不超过 `create_goal` 长度限制的 summary。调用时必须把文件绝对
路径和 `manifest.json` 中的 SHA-256 写入 objective，并声明：

> Execute every clause of the binding full objective file. The summary exists only because
> create_goal has a length limit. Anything unproved remains not_run.

`create_goal` 只启动当前 Goal，不自动授权下一 Goal。
