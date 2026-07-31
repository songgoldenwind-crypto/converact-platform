> **Revision 5 架构声明（2026-07-31）**：本文继续作为 AI-native 产品愿景、Task-first、
> Tool Action Reliability、Policy、Memory、Human approval 与 Evaluation 的战略参考。
> Channel Agent、HF Speech Runtime、LiveKit/Active Call 分工、ViLTE 和跨渠道唯一
> Authority 以
> [统一通信底座与 AI-native 架构 Revision 5](./design/unified-communication-foundation-r5.md)
> 及 [ADR-CCAAS-9](./adr/ccaas-9-channel-agent-and-speech-runtime.md) 为准；本文中的旧运行时
> 选型不再授权实现。
>
下面我默认说的是：**我们要做一个 AI native 的 CCaaS / Customer Interaction Platform**，覆盖客服、外呼、IM、视频、邮件、短信、工单等所有企业与客户之间的联络场景。

我的完整判断是：

> **不要做“传统 CCaaS + AI 插件”，而要做一个“AI 原生的客户联络与任务解决平台”。**
> 核心不是电话，不是坐席，不是客服机器人，而是：
> **AI 理解客户意图 → 编排渠道和任务 → 调用业务系统执行 → 必要时交给人 → 自动质检和复盘 → 反向优化知识、流程和运营。**

---

# 1. 平台定位：不是“AI 客服”，而是“AI 客户联络操作系统”

我们应该把这个平台定义为：

> **AI Native Customer Interaction OS**
> 一个云原生、多渠道、AI-first 的客户联络平台，用 AI 统一编排企业与客户之间的入站、出站、同步、异步、多媒体互动，并完成服务、销售、回访、通知、催收、预约、投诉、质检和运营优化。

这和传统 CCaaS 的边界一致，但我们要把它重构成 AI-first。传统 CCaaS 已经不是单纯电话系统，NICE 对 CCaaS 的定义就是在云平台中统一管理 voice、chat、email、SMS、social media 等客户互动；Amazon Connect 的官方文档也把 voice、Chat/SMS、web calling/video、tasks、email 都列为云联络中心渠道，并强调跨渠道保留交互历史，减少客户重复描述。([NiCE][1])

所以我们平台的边界应该是：

```text
入站客服：咨询、售后、投诉、技术支持
出站外呼：销售、回访、催收、通知、续费、预约确认
数字渠道：Web Chat、App IM、微信、WhatsApp、SMS、社交私信
视频渠道：视频客服、远程顾问、远程核验、远程诊断
异步渠道：Email、表单、工单、后台任务
AI 运营：机器人、Copilot、质检、知识、路由、分析、预测
```

一句话：
**只要是企业和客户之间的联络，并且进入统一的路由、坐席、AI、质检、工单和数据体系，就属于我们要做的平台范围。**

---

# 2. 最核心的产品理念：从“坐席中心”变成“任务解决中心”

传统 CCaaS 的核心对象是：

```text
通话
队列
坐席
工单
报表
```

AI native 平台的核心对象应该是：

```text
客户意图
服务任务
业务动作
客户上下文
风险等级
解决结果
```

比如客户说：

> “我上周买的东西还没到，而且地址可能填错了。”

传统系统会把它当成一次咨询，转到人工。
AI native 平台应该把它拆成一个任务链：

```text
识别客户身份
↓
识别订单
↓
判断物流状态
↓
判断能否改址
↓
调用 OMS / 物流系统
↓
如需赔付或例外授权，转人工
↓
生成摘要、标签、质检记录和后续任务
```

也就是说，我们要做的不是“回答客户问题”的 AI，而是 **完成客户任务的 AI**。

Gartner 预测，到 2029 年，agentic AI 将自主解决 80% 的常见客服问题，并带来 30% 的运营成本下降；这说明市场方向会从“AI 辅助回答”走向“AI 自主完成服务请求”。([Gartner][2]) 但同时 Gartner 2025 年的调研也显示，只有 20% 的客服领导者已经因为 AI 减少坐席人数，更多企业是在用 AI 提效、扩展服务能力，而不是简单裁人。([Gartner][3]) 所以我们的定位不应该是“替代客服”，而应该是：

> **AI-first, human-assured：AI 优先处理，人类兜底判断。**

---

# 3. 产品总形态：六大核心模块

我建议产品结构拆成六层。

## 3.1 Omnichannel Interaction Hub：多渠道联络入口

这是所有客户互动的入口层。它要支持：

| 渠道                  | 是否纳入平台 | 核心能力                         |
| ------------------- | -----: | ---------------------------- |
| 入站电话                |      是 | IVR、语音 AI、排队、转人工、录音、转写       |
| 外呼电话                |      是 | Campaign、预测式/预览式外呼、合规时间窗、DNC |
| Web / App IM        |      是 | AI 接待、转人工、会话连续性              |
| 微信 / WhatsApp / SMS |      是 | 通知、双向沟通、客服、营销触达              |
| Email               |      是 | 异步服务、自动分类、自动草稿、SLA           |
| 视频                  |      是 | 视频客服、远程顾问、核验、屏幕共享            |
| 工单 / 任务             |      是 | 后台处理、跨部门流转、AI 跟进             |

Amazon Connect 的渠道配置文档已经把电话、in-app/web calling、video、chat、SMS、email，以及 Apple Messages for Business、WhatsApp Business messaging 等都纳入统一渠道设置，这说明未来 CCaaS 的边界天然是 omnichannel，而不是 voice-only。([AWS 文档][4])

我们的设计原则是：
**渠道可以不同，但底层会话对象、客户上下文、任务状态和质检体系必须统一。**

---

## 3.2 Agentic Orchestration Engine：AI 编排中枢

这是整个平台的心脏。

它负责决定：

```text
这个客户是谁？
他要解决什么问题？
这个问题应该由 AI 解决、人工解决，还是人机协作？
需要调用哪些业务系统？
哪些动作可以自动执行？
哪些动作必须人工审批？
会话结束后如何记录、质检、复盘？
```

这里不要做成简单 bot flow，而要做成 **多 Agent 编排系统**。OpenAI 的 Agents 文档里也把 agent 定义为包含模型、指令、工具、guardrails、MCP server、handoff 和结构化输出的工作流单元；Agents SDK 支持 tool loop、handoff、tracing、guardrails 和审批暂停，这类机制正好对应我们平台里的任务编排、专家转接和高风险动作审批。([OpenAI开发者][5])

我们至少需要这些 agent：

| Agent            | 职责                     |
| ---------------- | ---------------------- |
| Triage Agent     | 识别身份、意图、语言、情绪、优先级、风险   |
| Service Agent    | 处理查单、退款、改址、预约、账单、售后等任务 |
| Outbound Agent   | 做外呼、回访、线索筛选、续费提醒、催收提醒  |
| Copilot Agent    | 实时辅助人工坐席，推荐答案和下一步动作    |
| Knowledge Agent  | 检索知识、发现知识缺口、建议更新知识库    |
| Routing Agent    | 根据意图、客户价值、情绪和风险做动态路由   |
| QA Agent         | 自动质检、合规检查、评分、异常发现      |
| Supervisor Agent | 给主管生成运营洞察、异常预警和优化建议    |
| Compliance Agent | 负责隐私、话术、授权、风险动作和审计     |

重点不是“有很多机器人”，而是每个 agent 都要有清晰的：

```text
角色
权限
工具
数据范围
可执行动作
人工审批点
失败兜底
评估指标
审计日志
版本管理
```

---

## 3.3 Human Agent Workspace：人类坐席工作台

AI native 平台不是不要坐席，而是让坐席从“信息搬运工”变成“复杂问题解决者”。

坐席工作台应该提供：

```text
实时转写
实时摘要
客户画像
历史会话
订单 / CRM / 工单信息
AI 推荐话术
AI 推荐下一步动作
一键执行工具
风险提醒
自动填写工单
自动生成会后总结
自动质检反馈
```

坐席不应该再在十几个系统之间切换。
他应该看到的是一个统一任务面板：

```text
客户：张三，VIP，近 30 天第 3 次咨询
当前意图：物流延迟 + 地址修改 + 潜在投诉
AI 已完成：查询订单、判断物流状态、尝试改址
推荐动作：提供补偿券，并升级物流异常工单
风险：客户情绪偏负面，避免承诺具体送达时间
```

---

## 3.4 Agent Studio / Journey Studio：AI Agent 与流程配置台

传统 CCaaS 的后台是配置队列、IVR、技能组、路由规则。
AI native 后台应该变成自然语言 + 可视化流程混合配置。

运营人员可以这样配置：

> “所有退款金额超过 500 元的请求，AI 可以先判断资格，但必须转人工审批后才能执行退款。VIP 客户等待超过 30 秒时优先转高级坐席。”

系统自动生成：

```text
意图识别规则
agent policy
工具调用权限
审批流
测试样例
风险提示
上线前仿真
灰度发布方案
```

这里至少要有五个 Studio：

| Studio            | 用途                    |
| ----------------- | --------------------- |
| Agent Studio      | 创建、测试、发布 AI agent     |
| Journey Studio    | 配置跨渠道客户旅程             |
| Knowledge Studio  | 管理知识、政策、话术和 FAQ       |
| Guardrail Studio  | 管理权限、合规、审批和风险边界       |
| Evaluation Studio | 评估 AI 准确率、解决率、升级率、幻觉率 |

---

## 3.5 Knowledge & Memory Hub：知识与记忆底座

AI native CCaaS 的壁垒不是模型本身，而是企业自己的 **客户记忆、服务记忆、流程记忆**。

要沉淀三类数据。

**客户记忆：**

```text
客户身份
购买记录
偏好渠道
历史问题
最近承诺
客户价值
流失风险
敏感标签
```

**服务记忆：**

```text
每次互动的意图
处理路径
调用过的工具
是否解决
是否重复来访
是否转人工
是否产生投诉
```

**组织记忆：**

```text
哪些知识有效
哪些知识过期
哪些流程卡住
哪些政策导致投诉
哪些产品问题制造了大量客服量
哪些坐席话术效果更好
```

这会让平台从“处理请求”进化成“优化业务”。
每一次客户互动都变成训练样本、质检样本、流程优化样本和产品反馈样本。

---

## 3.6 Governance / Evaluation / Analytics：治理、评估和运营洞察

AI native 平台必须从第一天就内置治理能力。原因很简单：这个平台会接触客户隐私，会调用企业系统，会影响退款、改址、催收、销售和投诉处理，一旦失控，风险很高。

NIST 的 AI Risk Management Framework 是为了帮助组织管理 AI 对个人、组织和社会带来的风险，并把可信 AI 考量纳入设计、开发、使用和评估中。([NIST][6]) OWASP 的 LLM Top 10 也明确列出 prompt injection、insecure output handling、sensitive information disclosure、excessive agency 等 LLM 应用风险，其中“给 LLM 无限制行动能力”会带来可靠性、隐私和信任问题。([OWASP][7])

所以我们的平台必须内置：

```text
权限控制
工具调用审批
PII 脱敏
客户授权记录
AI 身份披露
高风险动作人工确认
全链路审计日志
模型输出留痕
prompt / agent 版本管理
离线评估集
线上灰度实验
红队测试
回滚机制
```

---

# 4. 参考技术架构

我建议整体架构这样设计：

```text
Channel Layer
电话 / 外呼 / Web Chat / App IM / 微信 / WhatsApp / SMS / Email / Video
        ↓
Conversation Gateway
会话统一接入、身份识别、渠道适配、上下文保持
        ↓
Realtime Understanding Layer
ASR / TTS / 实时转写 / 意图识别 / 情绪识别 / 实体抽取 / 风险识别
        ↓
Agentic Orchestration Layer
Triage Agent / Service Agent / Outbound Agent / Copilot / QA / Supervisor
        ↓
Policy & Guardrail Layer
权限、审批、合规、隐私、风险控制、人工兜底
        ↓
Tool & Action Layer
CRM / OMS / ERP / 工单 / 支付 / 物流 / 账单 / 营销 / 身份核验
        ↓
Memory & Knowledge Layer
客户记忆、会话记忆、任务状态、知识库、政策库、向量库、知识图谱
        ↓
Human Workspace
坐席工作台、主管控制台、运营台、知识运营台
        ↓
Analytics & Evaluation Layer
质检、解决率、CSAT、AHT、转人工率、幻觉率、工具成功率、ROI
```

语音侧尤其要重视实时性。OpenAI 的 voice agents 文档把实时语音 agent 设计为通过 WebRTC 或 WebSocket 建立 live audio session，并在会话内处理 audio turns、tools、interruptions 和 handoffs；文档也指出，对于审批重、需要持久转写和确定性逻辑的支持流程，chained voice workflow 往往更合适。([OpenAI开发者][8])

所以我们的语音架构建议分两种：

```text
低风险、低复杂度场景：
speech-to-speech realtime voice agent

高风险、强合规、强审批场景：
ASR → text agent workflow → tool/action approval → TTS
```

---

# 5. 我们应该先做什么：不要一上来做“大而全 CCaaS”

最容易犯的错是：一上来就做完整云呼叫中心、完整外呼系统、完整 IM、完整视频、完整工单、完整 CRM、完整 AI 平台。

这会把团队拖死。

正确路线应该是：

> **先用 AI native 的方式切一个高频任务闭环，再逐步扩成平台。**

我建议 MVP 从这条线切入：

## MVP 定位

> **面向中大型企业的 AI 客户联络与任务解决平台，先覆盖 IM + 电话 + 外呼的高频服务/销售任务。**

第一版不要主打“替代整个 CCaaS”，而是主打：

```text
AI 接待
AI Copilot
自动总结
知识推荐
自动质检
有限场景 AI Agent
外呼/回访任务自动化
```

这样最容易落地，也最容易证明价值。

---

# 6. MVP 具体范围

## 6.1 第一批渠道

建议先做：

```text
Web / App IM
电话接入或对接现有电话系统
短信 / WhatsApp / 微信类消息
基础外呼 Campaign
Email 可作为第二优先级
视频暂缓到第二阶段
```

视频当然属于平台范围，但视频的技术复杂度、合规、录制、质检和带宽要求更高。第一阶段可以设计好架构边界，但不一定先做。

---

## 6.2 第一批场景

优先选规则明确、数据可查、风险可控、量大的任务：

| 场景       | 适合 AI 自动化程度 |
| -------- | ----------: |
| 订单查询     |           高 |
| 物流状态查询   |           高 |
| 预约 / 改约  |           高 |
| 地址修改资格判断 |          中高 |
| 退换货资格判断  |           中 |
| 售后进度查询   |           高 |
| 账单解释     |           中 |
| 线索初筛     |           高 |
| 回访满意度    |           高 |
| 续费提醒     |          中高 |
| 投诉安抚     | 低到中，必须容易转人工 |
| 高额退款     |    低，必须人工审批 |

第一版最好选择一个行业，比如：

```text
电商 / 零售售后
本地生活预约
教育咨询转化
汽车售后服务
B2B SaaS 客户成功
```

不建议一开始就打金融、医疗、政务的深水区，因为合规重、采购慢、集成复杂。可以后续做行业版。

---

## 6.3 第一版必须有的产品能力

第一版应该交付这 10 个能力：

```text
1. 多渠道会话接入
2. 客户身份识别
3. 意图识别和情绪识别
4. AI 接待和有限场景自动解决
5. 无损转人工
6. 坐席 Copilot
7. 知识库 RAG
8. 自动摘要和工单字段填写
9. 自动质检和主管报表
10. 工具调用和人工审批机制
```

“无损转人工”非常关键。
客户最讨厌的是 AI 问一遍，人工又问一遍。我们的交接必须做到：

```text
客户说了什么
AI 判断了什么
AI 查了什么
AI 做了什么
哪里失败了
为什么转人工
建议人工怎么处理
```

---

# 7. 平台里的 AI Agent 应该如何分工

我建议先设计成“一个总控 + 多个专职 agent”。

```text
Triage Agent
        ↓
Service Agent / Sales Agent / Outbound Agent / Complaint Agent
        ↓
Tool Agent / Knowledge Agent / Compliance Agent
        ↓
Human Agent / Supervisor Agent
```

## Triage Agent

负责所有入口的第一判断：

```text
识别客户身份
识别意图
识别语言
识别情绪
识别紧急程度
判断是否高风险
决定自助、转人工或进入任务 agent
```

## Service Task Agent

每个任务一个窄 agent，不要一个 agent 包打天下。

```text
Order Agent：查订单、查物流、解释状态
Refund Agent：判断退款资格、生成退款建议
Appointment Agent：预约、改约、取消
Billing Agent：解释账单、开票、缴费提醒
Tech Support Agent：收集故障信息、初步排障
```

OpenAI 的 orchestration 文档也建议在需要不同指令、工具或策略时，把任务拆给不同 specialist，并通过 handoff 或 agents-as-tools 组织编排。([OpenAI开发者][9])

## Outbound Agent

负责主动触达：

```text
线索清洗
销售跟进
预约确认
满意度回访
续费提醒
活动通知
催收提醒
异常通知
```

但外呼必须有强合规：

```text
客户授权
免打扰时间
DNC 名单
频次控制
话术审批
录音留痕
人工接管
```

## Copilot Agent

坐席旁边的副驾：

```text
实时推荐答案
实时提示风险
实时生成下一步动作
自动查知识
自动查系统
自动生成总结
自动填工单
```

## QA Agent

做全量质检，不再只抽样：

```text
是否核验身份
是否按政策承诺
是否违规营销
是否辱骂/冷漠
是否遗漏关键信息
是否应该升级但没有升级
是否 AI 幻觉
是否工具调用错误
```

## Supervisor Agent

给主管看的不是“报表”，而是行动建议：

```text
今天退款类转人工率上升 18%
主要原因：新版退款政策知识缺失
建议更新 3 条知识，调整 Refund Agent 策略
预计减少 800 次人工介入
是否进入灰度测试？
```

---

# 8. 数据模型：一定要从第一天设计好

这个平台的数据模型非常重要。建议核心对象有 8 个。

| 对象            | 说明               |
| ------------- | ---------------- |
| Customer      | 客户身份、画像、偏好、价值、风险 |
| Contact       | 一次电话、聊天、邮件、视频、外呼 |
| Conversation  | 跨渠道连续会话          |
| Intent        | 客户意图，可多意图并存      |
| Task          | 要完成的业务任务         |
| Action        | AI 或人工执行的动作      |
| Case / Ticket | 需要跟进的服务事项        |
| Evaluation    | 对 AI、人工、流程结果的评估  |

尤其要把 **Contact** 和 **Task** 分开。
一次会话里可能有多个任务：

```text
客户来电：
1. 查询物流
2. 修改地址
3. 申请补偿
4. 投诉上次客服
```

如果只按“通话”建模，AI 就很难真正完成任务。
如果按“任务”建模，平台就能知道每个任务是否解决、卡在哪里、谁处理的、调用了什么工具、是否产生风险。

---

# 9. 技术上最关键的不是模型，而是 Tool Action Reliability

很多团队会以为 AI native 平台的核心是“大模型能力”。
我认为真正核心是：

> **AI 安全、可靠、可审计地调用企业系统完成动作。**

也就是：

```text
查订单
改地址
创建工单
发短信
退优惠券
改预约
更新 CRM
触发外呼
生成报价
发邮件
关闭 case
升级主管
```

每个工具都要有：

```text
输入 schema
输出 schema
权限要求
幂等设计
失败重试
审计日志
dry-run 模式
人工审批点
回滚方案
```

高风险动作不能让 LLM 直接执行。
应该是：

```text
LLM 生成动作意图
↓
Policy Engine 判断权限
↓
Tool Broker 校验参数
↓
必要时人工审批
↓
Action Service 执行
↓
Action Ledger 记录结果
```

这就是平台的护城河。

---

# 10. 安全与合规：必须做成产品能力，不是后台补丁

我们要把治理做成平台内建能力，而不是客户问起来才补。

最低限度要有：

```text
AI 身份披露：让用户知道何时在和 AI 互动
PII 脱敏：手机号、身份证、地址、银行卡等
权限隔离：不同 agent 只能访问必要数据
工具权限：不同 agent 可调用不同工具
高风险审批：退款、赔付、改敏感资料必须人工确认
提示词注入防护：外部内容不能覆盖系统指令
输出校验：AI 输出不能直接进入 SQL、代码、付款等系统
审计追踪：每次模型调用、工具调用、handoff、审批都留痕
评估集：上线前后持续测准确率、幻觉率、违规率
回滚：agent、prompt、知识、策略都能快速回滚
```

如果客户面向欧盟市场，还要考虑 EU AI Act 这类风险分级和可信 AI 监管框架；欧盟官方说明中把 AI Act 称为全球首个全面 AI 法律框架，并强调基于风险的规则。([数字战略欧盟][10])

---

# 11. 评估指标：不要只看“AI 接待率”

很多 AI 客服项目失败，是因为只看 containment rate，也就是“AI 拦住了多少人”。
这很危险，因为 AI 可能只是把客户困住了。

我们应该分四层指标。

## 客户体验指标

```text
首次解决率 FCR
客户满意度 CSAT
客户努力度 CES
重复来访率
转人工后是否需要重复描述
投诉率
负面情绪变化
```

## 运营效率指标

```text
平均处理时长 AHT
会后处理时长 ACW
坐席并发能力
SLA 达成率
排队时长
人工转接率
工单积压量
```

## AI 质量指标

```text
意图识别准确率
知识命中准确率
工具调用成功率
幻觉率
违规话术率
高风险升级准确率
人工接管时机准确率
p95 延迟
每次解决成本
```

## 外呼 / 增长指标

```text
接通率
有效沟通率
转化率
预约成功率
续费率
回款率
退订率
投诉率
触达成本
```

最重要的是：
**AI 自动解决率必须和客户满意度、重复来访率、投诉率一起看。**

---

# 12. 商业模式：从 seat-based 走向 outcome-based

传统 CCaaS 常见收费是：

```text
坐席 seat
通话分钟
号码费用
渠道模块
录音存储
高级报表
```

AI native 平台可以设计成混合模式：

```text
平台基础费
人工坐席 seat
渠道通信费
AI 使用量：语音分钟、消息量、模型调用量
AI Agent 数量
自动解决任务数
外呼 Campaign 量
质检 / 分析 / 治理高级包
行业模板包
私有化 / 专属模型 / 合规审计包
```

更长期可以走 outcome-based：

```text
每个成功自动解决任务收费
每个有效销售线索收费
每个成功预约收费
每个成功续费 / 回款 / 留存动作收费
```

但第一阶段不建议完全 outcome-based，因为客户的数据、流程、知识质量会严重影响结果。
更合理的是：

```text
基础 SaaS 费 + AI 使用费 + 高价值场景结果费
```

---

# 13. 差异化：我们不能只做“又一个 CCaaS”

现在市场上大厂已经在往 AI orchestration 方向走。Genesys 2025 年发布的 agentic AI 能力中，已经提到 agentic Copilot、Virtual Agent、更高自主性、A2A 和 MCP 互操作，用于大规模负责任的 AI 编排。([Genesys][11]) Genesys 也把自己的方向描述为 AI-Powered Experience Orchestration，强调 omnichannel engagement、intelligent routing、workforce engagement、journey management 等能力。([Genesys][12])

所以我们不能只拼“我也有语音、我也有在线客服、我也有质检”。
我们的差异化应该是这几个：

## 13.1 任务级 AI，而不是会话级 AI

别人管理 conversation，我们管理 task resolution。

## 13.2 行业流程模板

每个行业预置：

```text
任务意图库
业务流程
知识模板
合规话术
外呼策略
质检表
工具连接器
评估样本
```

比如电商版、教育版、本地生活版、汽车售后版、B2B SaaS 版。

## 13.3 Tool Action Layer

不是只回答，而是安全执行。
谁能把 AI 和企业业务系统稳定接起来，谁才有护城河。

## 13.4 Evaluation-first

每个 agent 上线前都必须经过：

```text
离线测试
仿真对话
红队测试
灰度发布
线上监控
自动回滚
```

## 13.5 Human-assured

把人工兜底做得非常顺。
这点比“AI 多聪明”还重要。

---

# 14. 推荐落地路线

## 阶段一：AI Copilot + 自动质检切入

先不要挑战客户核心生产流程，先帮坐席提效。

做：

```text
实时转写
自动摘要
知识推荐
话术推荐
工单自动填写
全量质检
主管报表
```

价值：

```text
风险低
集成简单
客户容易接受
可以快速积累真实对话数据
能训练后续 AI Agent
```

## 阶段二：有限场景 AI Agent

选择 3 到 5 个高频、低风险、规则明确的任务，让 AI 自动解决。

比如：

```text
查订单
查物流
预约 / 改约
售后进度查询
线索初筛
满意度回访
```

这阶段重点不是追求全自动，而是建立：

```text
意图识别
工具调用
人工审批
失败转人工
质检评估
```

## 阶段三：加入外呼和主动触达

把平台从“客户来找我”扩展成“我主动联系客户”。

做：

```text
外呼 Campaign
AI 线索筛选
自动回访
预约确认
续费提醒
异常通知
短信 / IM 联动
外呼质检
```

这会把平台从客服成本中心推向收入和运营中心。

## 阶段四：多 Agent 编排平台

当数据、工具、权限、评估体系成熟后，再做真正的平台化：

```text
Agent Studio
Journey Studio
Guardrail Studio
Evaluation Studio
Marketplace
行业模板
开放 API
MCP / connector 生态
```

---

# 15. 组织上需要哪些团队

要做成这个平台，团队不能只有算法和后端。

最小核心团队应该包括：

| 团队                     | 职责                       |
| ---------------------- | ------------------------ |
| Product                | 定义场景、流程、指标、行业模板          |
| AI Engineering         | Agent、RAG、评估、prompt、模型路由 |
| Backend Platform       | 会话、任务、权限、工具调用、审计         |
| Realtime Communication | 语音、转写、TTS、外呼、视频          |
| Frontend               | 坐席台、主管台、Studio、运营台       |
| Data                   | 事件流、报表、质检、评估集、数据治理       |
| Security / Compliance  | 隐私、权限、审计、合规、风险           |
| Solution / CX Ops      | 客户落地、流程梳理、知识建设、ROI 证明    |

尤其需要 **CX Ops / Solution**。
AI native CCaaS 不是纯技术产品，它非常依赖行业流程理解。

---

# 16. 我建议我们第一版的产品包长这样

可以命名为：

> **AI Contact OS**

第一版包含四个产品包：

## 16.1 AI Agent Desk

给坐席用。

```text
统一会话收件箱
客户上下文
实时转写
AI 推荐答案
AI 下一步动作
自动摘要
自动填工单
一键转接
```

## 16.2 AI Self-Service Agent

给客户自助用。

```text
IM AI 接待
语音 AI 接待
FAQ + RAG
任务型工具调用
失败转人工
会话留痕
```

## 16.3 AI Outbound Agent

给外呼和主动触达用。

```text
外呼任务列表
AI 线索初筛
预约确认
回访
续费提醒
短信 / IM 补充触达
外呼质检
合规频控
```

## 16.4 AI Supervisor

给主管和运营用。

```text
全量质检
异常会话发现
知识缺口
坐席辅导
AI agent 表现
转人工原因分析
流程瓶颈
运营建议
```

---

# 17. 什么不要做

这部分很重要。

不要一上来做：

```text
完整替代 Genesys / NICE / Amazon Connect
完整自研底层电话网络
一开始覆盖所有行业
一开始覆盖所有渠道
只卖“减少坐席”
只做 RAG 问答机器人
让 LLM 直接操作核心系统
没有评估体系就上线客户现场
没有人工兜底就宣传全自动
```

更好的策略是：

```text
先做 AI 原生层
对接已有电话 / IM / CRM / 工单系统
拿下一个高频行业场景
证明 AI 解决任务能力
再逐步向完整 CCaaS 扩展
```

---

# 18. 最终愿景

最终这个平台应该像这样工作：

```text
客户从任何渠道进来
        ↓
AI 识别客户、意图、情绪、风险
        ↓
AI 判断自助、人工、外呼、后台任务
        ↓
AI 调用业务系统完成动作
        ↓
高风险动作自动请求人工审批
        ↓
客户跨电话、IM、视频、邮件都不用重复描述
        ↓
坐席获得实时 Copilot
        ↓
主管获得全量质检和运营建议
        ↓
知识库和流程自动被反馈优化
```

最终界面不是传统报表，而是这样的运营控制台：

```text
今天 AI 自动解决了 42,380 个客户任务
自动解决率：61%
重复来访率下降：18%
退款类转人工率异常上升：12%
原因：新版退款政策缺少知识条目
建议：
1. 更新 Refund Policy v3
2. 调整 Refund Agent 审批阈值
3. 对 37 条异常会话做人工复核
预计影响：
减少 1,200 次人工介入
提升 CSAT 2.8 分
是否创建灰度变更？
```

这才是 AI native。

---

# 19. 最终结论

我们要做的不是：

```text
AI 客服机器人
云呼叫中心
在线客服插件
外呼系统
质检系统
```

而是：

> **一个 AI-first 的客户联络与任务解决平台。**

它的核心公式是：

```text
多渠道联络
+ AI 意图理解
+ 多 Agent 编排
+ 工具调用执行
+ 人工兜底
+ 全量质检
+ 知识和流程自优化
= AI Native CCaaS Platform
```

我的建议路线是：

> **第一阶段用 Copilot + 自动质检 + 有限任务 Agent 切入；第二阶段扩到外呼和主动触达；第三阶段做 Agent Studio 和多渠道编排；最终成为企业客户联络的 AI 操作系统。**

[1]: https://www.nice.com/glossary/what-is-ccaas-contact-center-as-a-service "What is CCaaS (Contact Center as a Service) | NiCE"
[2]: https://www.gartner.com/en/newsroom/press-releases/2025-03-05-gartner-predicts-agentic-ai-will-autonomously-resolve-80-percent-of-common-customer-service-issues-without-human-intervention-by-20290 "Gartner Predicts Agentic AI Will Autonomously Resolve 80% of Common Customer Service Issues Without Human Intervention by 2029"
[3]: https://www.gartner.com/en/newsroom/press-releases/2025-12-02-gartner-survey-finds-only-20-percent-of-customer-service-leaders-report-ai-driven-headcount-reduction "Gartner Survey Finds Only 20% of Customer Service Leaders Report AI-Driven Headcount Reduction"
[4]: https://docs.aws.amazon.com/connect/latest/adminguide/set-channels.html "Set up your channels - Amazon Connect Customer"
[5]: https://developers.openai.com/api/docs/guides/agents/define-agents "Agent definitions | OpenAI API"
[6]: https://www.nist.gov/itl/ai-risk-management-framework "AI Risk Management Framework | NIST"
[7]: https://owasp.org/www-project-top-10-for-large-language-model-applications/ "OWASP Top 10 for Large Language Model Applications | OWASP Foundation"
[8]: https://developers.openai.com/api/docs/guides/voice-agents "Voice agents | OpenAI API"
[9]: https://developers.openai.com/api/docs/guides/agents/orchestration "Orchestration and handoffs | OpenAI API"
[10]: https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai "AI Act | Shaping Europe’s digital future"
[11]: https://www.genesys.com/company/newsroom/announcements/genesys-launches-ai-agents-with-greater-autonomy-to-drive-enterprise-wide-customer-experience-orchestration "Genesys Launches AI Agents with Greater Autonomy to Drive Enterprise-Wide   Customer Experience Orchestration | Genesys"
[12]: https://www.genesys.com/genesys-cloud "Genesys Cloud CX - AI-Powered Experience Orchestration Platform  | Genesys"
