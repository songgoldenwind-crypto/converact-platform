# Resolve Authority and User Journey Contract

> Scope：首个 `resolution` Profile，不是 Converact 永久行业边界
> Market qualification：`not_run`
> Runtime implementation：`not_run`

## 1. 唯一 ICP 与购买角色

首发 ICP 固定为：**向美国/英语市场销售 LED 显示系统、由中国专家支持美国现场首次安装调试
的中国出口企业；其现有电话与 CRM/FSM 仍需保留，且安装调试失败会引发可计量的派工、停机、
返工或专家等待成本。**

冻结身份：

| 字段 | 唯一值 |
| --- | --- |
| `product_family_id` | `led-display-system-v1` |
| Product family | LED 显示系统，包括显示模组、接收/发送/控制设备及完成该系统安装所需的配置软件 |
| `flow_id` | `remote-installation-commissioning-v1` |
| `flow_version` | `1.0.0` |
| Flow start | 美国现场首次安装/调试期间，通过现有电话报告“无法完成 agreed commissioning acceptance” |
| Flow terminal | human verifier 按冻结验收步骤确认显示系统通过，或明确转派工/blocked/disputed |

已投入运行后的故障维修、例行维护、纯软件 IT 支持以及其他设备产品族均不属于该 flow；它们只
能作为未来独立 flow/Profile Evidence，不能混入本轮 20 次访谈或三个付费席位。

| 角色 | 定义 | Pilot 责任 |
| --- | --- | --- |
| Budget Owner | 对售后/服务运营成本和 Pilot 预算负责的服务 VP、售后负责人或业务负责人 | 提供价值池、批准 USD 20k、签署范围/Outcome |
| Champion | 能推动电话、CRM/FSM、工程师和现场团队协作的服务运营/数字化负责人 | 组织流程、数据、用户和周复盘 |
| Economic/Procurement approver | 合法合同、付款和供应商准入责任人 | 付款条款、信息安全/采购审批 |
| Customer/installer/field technician | 在英语现场遇到安装、设备或软件问题的人 | 授权通信/Evidence，执行被验证步骤 |
| Support engineer | 远程诊断和指导的中文/双语工程师 | 对技术建议和人工验证负责 |
| Service manager | 队列、升级、质量和例外责任人 | 样本 eligibility、争议和人工升级 |
| Data/IT owner | PBX、CRM/FSM、身份、保留和数据可得性责任人 | Overlay 连接与 Authority 边界 |

如果没有可接触的 Budget Owner/Champion、没有同意的价值/数据基线或客户只想采购低价视频，
则 no-bid/partner，而不是改变 ICP。

## 2. 单一 JTBD

> 当美国现场安装人员通过现有电话报告 LED 显示系统首次安装/调试无法通过 agreed acceptance
> 时，帮助中国服务团队在不要求安装 App、不替换现有 PBX/CRM/FSM 的前提下升级到可视中英
> 协作，收集可审计 Evidence、指导并人工验证调试步骤，确认可复查 Outcome，从而减少可避免
> 派工、停机、返工和专家等待。

JTBD 不包含已投产售后维修、例行维护、纯软件 IT 支持、其他设备族、通用销售、营销、咨询、
低价 Bot、全量 CCaaS 替换、完整 FSM、ViLTE 或高风险自主维修。

## 3. 领域映射

| Resolve 术语 | 平台对象 | 正式 Authority |
| --- | --- | --- |
| Resolution | `Engagement(profile_type="resolution")` | Converact Engage |
| ResolutionItem | `EngagementItem(item_type="problem")` | Converact Engage |
| 客户电话 | `CommunicationSession` + RustPBX Call reference | Fabric + Unified RustPBX |
| 视频升级 | 同一 Interaction 下的新 CommunicationSession/Bridge generation | Fabric；Room 由 LiveKit |
| 外部工单 | external object reference | 客户 CRM/FSM（Overlay） |
| 诊断/指导步骤 | Task；需要动作时 ActionIntent | Agent Runtime / Action Authority |
| 截图、照片、注释、转写 | Evidence candidate + provenance | Converact Engage；媒体源保持来源 Authority |
| 已解决声明 | OutcomeClaim | Converact Engage；由 VerificationPolicy + human verifier Finalize |

## 4. Happy-path 旅程

| Step | 用户可见行为 | 权威状态变化 | Evidence/指标 |
| --- | --- | --- | --- |
| 1. Intake | 客户拨打原号码；工程师接听 | PBX/Carrier 保持电话 Authority；创建/关联 Engagement | eligible screen、call reference、baseline time |
| 2. Profile bind | Champion 约定的 flow 将该 item 绑定 Resolve v1 | Engage 写 ProfileBinding/Objective/ResolutionItem | rule version、eligible/excluded reason |
| 3. Escalate to video | 工程师发送 no-app 邀请，电话不中断 | Fabric prepare 新 bridge generation；LiveKit 创建 Room/Participant | invite/consent/prepare receipt、switch gap 待后续实测 |
| 4. Join/commit | 现场用户浏览器加入；媒体就绪后原子 commit | Fabric commit directed media edges；各通信 Authority 保持独立 | participant/media receipt、generation、failure reason |
| 5. B1 assist | 双方看到中英 captions/text translation；不注入 translated TTS | Speech executor 仅写可追溯候选；人工仍负责含义 | source transcript、language/model/revision、correction |
| 6. Diagnose/guide | 工程师看现场、标注、指导步骤；AI 可建议 | Task/ActionProposal；高风险动作需显式 Authorization | photos/annotations/steps/provenance/consent |
| 7. Verify | 现场执行验证，工程师/指定责任人确认 | OutcomeClaim proposed→verified→finalized 或 disputed | test result、human verifier、external case state reference |
| 8. Return/close | 可返回普通语音；视频参与者清理；外部 CRM/FSM 按自身流程关闭 | Fabric 新 generation 返回 fast path；外部系统保持关闭 Authority | cleanup/reconcile、recording continuity、Outcome revision |
| 9. Review | 周/最终复盘比较 agreed baseline | 只聚合 eligible verified facts | avoided event、downtime/rework/expert-wait、CSAT/safety |

每一步都必须保留同一 `EngagementId` 和稳定 Interaction 关联；CallId、RoomId、external CaseId 是
各自 Authority 的引用。失败重试不能创建第二 Engagement 或重复计费。

## 5. Eligibility 与排除

只有双方在 Pilot 前定义、可从来源系统审计并落在一个 agreed flow 的 item 才进入分母。

至少排除：

- 不属于选定团队/产品族/流程；
- 在 Pilot 前已解决或没有可观察基线；
- 仅咨询、销售、保修争议、缺件物流等非目标流程；
- 现场网络/设备完全不支持约定路径且未列入网络场景；
- 未取得视频、录音、转写、翻译或 Evidence 所需授权；
- 安全政策要求立即派工或禁止远程指导；
- 重复 item（保留 canonical item，其他只作关联）；
- 超过 300 agreed eligible items 的范围。

排除必须在看见 Outcome 前按规则完成。事后为了提高成功率删除失败样本被禁止。

## 6. Failure journeys

### 6.1 视频加入失败

电话保持；Fabric abort 未提交 generation，清理 participant/room，记录原因并继续语音或按人工
流程升级。失败不能被计为“视频解决”，也不能关闭 Resolution。

### 6.2 翻译不可用或低置信

停止/标红翻译输出，保留 source language；工程师与客户使用原始音频、人工文本或人工翻译。
不得让 translation worker 故障结束通话，不得把未经确认译文作为 Outcome Evidence。

### 6.3 CRM/FSM 不可用

外部对象仍是 Authority。Action 进入 `deferred/unknown`，用 idempotency key 查询/对账；禁止创建
第二正式工单、盲重试关闭或把本地成功当外部完成。

### 6.4 录音/Evidence 存储不可用

依据 Offer/consent 决定继续无录音的人类通信或停止需要 Evidence 的步骤，明确 UI/审计状态；
不得无界缓存、伪造 Evidence 或把录音故障当通话故障。

录音权威分三段且不能合并：RustPBX 写 Native Call 的 recording intent；`voice-media-rs` 或
LiveKit Egress 只执行带 fence 的 capture/segment；Converact Region Recording Plane 是唯一
root `RecordingManifest`/coverage/gap/terminal writer。对象存储上传成功只是 Receipt，不等于
完整录音。任何一段失败均不得终止已建立的人类通信。

### 6.5 争议或复发

OutcomeClaim 进入 `disputed` 或新增 immutable Reversal；保留原 claim、验证者、时间和影响。复发
关联原 Resolution，但不能覆盖历史或重复认领 avoided event。

## 7. Outcome 与责任

Pilot 的业务 Outcome 不是“模型返回正确”“成功建房”或“通话时长”。候选 Outcome 必须：

- 对应 agreed eligible item 和预定义验证规则；
- 有原始 Evidence 与来源/同意/保留元数据；
- 由指定 human accountable owner 或合法外部系统观察确认；
- 对派工、停机、返工、专家等待等价值池执行去重；
- 可被 dispute/reversal/credit，不覆盖原事实；
- 不因 translated caption、AI suggestion 或模型 confidence 自动 Finalize。

## 8. Profile 边界声明

该 ICP、JTBD、角色、产品族、语言对、Pilot 和指标只属于 Resolve v1。平台仍可服务销售、
咨询、运营、Agent service、OEM 等未来 Profile，但每一个必须先有独立领域/市场合同。Resolve
成功不证明这些方向；Resolve Stop Gate 也不自动否定 Horizontal Platform。
