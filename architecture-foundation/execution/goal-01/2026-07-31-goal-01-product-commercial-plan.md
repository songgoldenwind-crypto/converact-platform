# Goal 01 平台、Profile 与首发商业合同执行计划

> Goal：G01
> 绑定 Goal SHA-256：`736225a0d4c0d8abe2d951b95bf502e81f4dfbbcefce8a8defb81e330b7c5af1`
> 入口基线：G00 提交 `c10a3a2c636fa0f62f8108a113a729138e367929`
> 执行根：`/Users/songjinfeng/Projects/converact-worktrees/platform`
> 计划状态：离线合同已验证，G01 因真实市场 Evidence 阻塞为 `blocked_external`；任何未证明项保持 `not_run`

## 1. 目的与边界

本计划只执行 G01。它先冻结 Horizontal Platform，再冻结首个 Resolve Profile 和一个固定
范围 Pilot，最后建立真实市场验证协议。它不开发产品功能，不修改服务器、容器、数据库、
Feature Flag、旧工作树或冻结生产线，也不启动 G02 或后续 Goal。

G01 的三个 Gate 独立：

1. Platform Contract Gate：可以用可复查文档、机器合同和测试证明；
2. Resolve Profile Contract Gate：可以用可复查的产品、Pilot、ROI 与 Stop Gate 合同证明；
3. Resolve Market Gate：只能用真实买家访谈、书面付费承诺和合同证明。

前两个 Gate 通过不等于第三个 Gate 通过，也不构成产品市场匹配、生产资格或竞品领先声明。

## 2. Current-state audit

| 检查项 | 观察 | G01 处置 |
| --- | --- | --- |
| G00 | 提交 `c10a3a2` 已完成，工作树在 G01 开始时干净 | 固定为入口证据，不改写 |
| G00→G01 trace | 32 条：10 条 Platform R2、2 条 Resolve R1、1 条程序合同、19 条旧树隔离责任 | 全部进入 G01 trace；隔离责任只评估、不迁移 |
| Platform R2 | 已把 Converact 定义为水平平台并规定四层产品结构 | 本 Goal 机器化其边界 |
| Resolve R1 | 已给出首个 ICP、旅程、Pilot、ROI 和商业 Gate 候选 | 只作为 Profile 输入，不反向收窄平台 |
| 根 `CONTEXT.md` | 已使用 Engagement/Profile 语言 | 作为当前文档事实，不等于运行时代码已迁移 |
| 根 `CLAUDE.md` | 仍包含旧一代 AI communication framing | 记录为后续治理差异；G01 不越界修改根规范 |
| 旧工作树 | 存在旧 G01/领域实现、迁移、OpenAPI 和测试草稿 | 只引用 G00 哈希与处置；不得复制、执行或宣称已采用 |
| 真实市场 Evidence | 当前仓库没有合格的访谈、签约 Pilot 或时限付费承诺 | 保持 `not_run`；所有离线工作结束后记录精确外部阻塞 |

## 3. 已选择的设计

选择“水平 Platform 合同先行 + Resolve 严格 Profile + Offer/Option 分离 + 真实 Evidence
单独 Gate”。

- `Engagement`/`EngagementItem` 是上位业务执行对象；
- `Resolution`/`ResolutionItem` 只是 Resolve Profile 的严格特化；
- Call、Room、Ticket、Case、Opportunity、WorkOrder 都不能冒充平台根对象；
- Native 与 Overlay 使用同一平台合同，但正式外部 Case/WorkOrder 等 Authority 不被接管；
- Profile 只能扩展 schema、policy、metrics、UI projection 和 adapter requirement，不能创建
  第二套平台状态或写者；
- Offer 是可采购合同，Option 是需单独资格化的交付/能力选择；
- 首发 Resolve Pilot 固定为 A+B1，不把未来 B2/B3、ViLTE、Native PBX、远程控制或自主
  高风险动作偷偷包装进首发范围。

拒绝的方案：

- 把 Resolve 硬编码成整个平台根模型；
- 同时开发多个 Profile 或首发行业；
- 用功能数量或供应商 benchmark 代替买家价值；
- 让 Profile validator、Agent framework、通信组件或外部系统成为第二 Authority；
- 因 Market Gate 缺失而降低门槛或伪造 Evidence。

## 4. 公开事实与判断纪律

竞争结论使用三种互斥 claim 类型：

- `public_fact`：可由厂商官方页面或官方源码仓库复查；
- `converact_inference`：基于公开事实作出的产品假设，必须写出推理和待证条件；
- `converact_test_requirement`：未来需要同源 workload、硬件、配置和原始输出的实测要求。

厂商宣传的百分比、客户案例和“低延迟/规模化”措辞只作为其公开主张，不作为 Converact
性能、市场或 ROI Evidence。源页面在 `competitive-source-register-v1.json` 中记录 URL、抓取
日期、层级和使用限制。

## 5. 精确产物与责任

所有写入限制在 `architecture-foundation/execution/goal-01/`。

### 5.1 设计合同

- `product-domain-contract.md`：平台上位模型、单一 Authority、Native/Overlay、AI/人工边界；
- `platform-profile-offer-option-contract.md`：四层产品合同、销售状态与 Option Gate；
- `authority-and-user-journey.md`：唯一 ICP/JTBD/角色和 Resolve 主旅程；
- `pilot-scope-and-acceptance-contract.md`：12 周 Pilot A+B1 与客观验收；
- `market-evidence-protocol.md`：访谈、承诺、隐私、版本和争议协议；
- `roi-unit-economics-model.md`：价值、成本、毛利、CAC、Credit/Reversal 公式；
- `platform-market-and-competitive-map.md`：平台预算层与 Resolve 替代方案分离；
- `competitive-and-build-buy-partner-review.md`：Build/Absorb/Buy/Partner 与 Win/No-bid；
- `commercial-stop-gates.md`：Profile-scoped Stop/No-bid/Partner Gate；
- `independent-review.md`：基于原始合同的第二遍规则审查，不冒充外部或人工审计。

### 5.2 机器合同

- `ubiquitous-language-v1.json` 与 schema；
- `engagement-profile-contract-v1.json` 与 schema；
- `interview-and-demand-evidence-register.json` 与 schema；
- `competitive-source-register-v1.json` 与 schema；
- `traceability-v1.json` 与 schema。

### 5.3 可执行验证

- `evaluate-roi.mjs`：纯函数、fail-closed 的 ROI/单位经济计算；
- `fixtures/*.synthetic.json`：明确标注为非市场 Evidence 的公式 fixture；
- `fixtures/invalid-*.json`：每个 schema 的故意非法输入；
- `goal-01-contract.test.mjs`：schema、边界、Authority、Pilot、ROI、来源、trace、链接、隐私和
  Git 边界测试；
- `generate-goal-01.mjs`：确定性生成机器合同和静态合同文档，不生成客户 Evidence。

## 6. TDD 顺序与预期 RED

1. 先写本计划、平台设计、Authority/旅程及 threat/failure 设计；
2. 写 schema 预期、故意非法 fixtures 与测试；
3. 在机器合同和其余产物不存在时运行测试，保留命令与失败原因作为 RED 证据；
4. 写最小 generator、schema、ROI evaluator 和其余合同；
5. 运行 generator；
6. 运行 focused tests，修到 GREEN；
7. 独立第二遍审查时从 Goal/PROGRAM-RULES/G00 trace 重新抽样，不使用生成器的结论；
8. 核对 Markdown 链接、SHA、公开源、敏感信息、Git 变更范围及旧树未变；
9. 只暂存 G01 精确文件并作窄提交；不 push。

预期 RED 必须至少证明：

- 缺失 JSON/schema/Markdown 会失败；
- 非法 Profile 第二 Authority 会被拒绝；
- 把 `Resolution` 设为平台根会被拒绝；
- 缺少 Evidence provenance、含直接 PII 或把 synthetic 当 market Evidence 会被拒绝；
- Pilot 价格、周期、范围或 A+B1 被放宽会失败；
- ROI 除零、负成本、重复价值池或未包含 Credit/Reversal 会 fail closed；
- 公开事实没有官方源、推断伪装成事实或 benchmark 被借用会失败；
- trace 中任何 G00→G01 或 G01 outcome 没有 disposition 会失败。

## 7. 公式验证矩阵

| Fixture | 预期 | 证明范围 |
| --- | --- | --- |
| `roi-qualifying.synthetic.json` | 年价值/首年成本 ≥ 3，且其他经济阈值满足 | 公式工具能识别“候选可售”，不是市场证明 |
| `roi-no-bid.synthetic.json` | 比值 < 3，返回 no-bid | 低价值不被乐观解释 |
| `roi-credit-reversal.synthetic.json` | Credit/Reversal 进入净收入和毛利 | 结果计费不能隐藏退款风险 |
| `roi-zero-denominator.synthetic.json` | 明确拒绝 | 除零与缺失基线 fail closed |

## 8. Gate 与状态更新

| Gate | 可在 G01 离线证明 | 当前初始状态 | 完成条件 |
| --- | --- | --- | --- |
| Platform Contract | 是 | `verified_contract` | 边界、schema、trace、链接、审查全部通过 |
| Resolve Profile Contract | 是 | `verified_contract` | 唯一 ICP/JTBD、Pilot A+B1、ROI、Stop Gate 可客观验收 |
| Resolve Market | 否 | `not_run` | ≥20 合格访谈；1 份签署 USD 20k Pilot；另 2 份有期限付费承诺 |
| Production eligibility | 否 | `not_run` | 后续 Goal 的真实功能、容量、安全与客户转化 Evidence |

当离线合同完成而真实 Market Evidence 仍为空时：记录零计数、缺失类别、允许的下一步和禁止
解锁项。G01 不得标记 `completed`；也不得自动启动 G02/G09/G11/G16。

## 9. 提交边界

优先形成可独立审查的窄提交：

1. `docs(platform): freeze engagement and profile boundaries`；
2. `docs(product): freeze resolve assist domain and pilot contract`；
3. `docs(commercial): freeze resolve qualification and stop gates`。

若测试与 generator 跨越这些文件，最终提交必须仍只包含 G01 文件，且每个提交消息不得暗示
真实市场 Gate 已完成。未经用户明确授权不 push。
