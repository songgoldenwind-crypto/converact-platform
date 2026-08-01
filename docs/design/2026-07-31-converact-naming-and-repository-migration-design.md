# Converact 命名与仓库迁移设计

> 状态：`approved_name / implementation_in_progress / production_unchanged`
>
> 日期：2026-07-31
>
> 决策：用 `Converact` 替代 `OPC` 作为平台总品牌；保留兼容标识并渐进迁移
>
> 生产约束：不得修改当前服务器容器、部署目录或冻结维护工作树

## 1. 目标与非目标

本设计将已经扩展为 AI-native 多模态通信与业务执行平台的产品，从旧的 `OPC`
内部代号迁移到统一的 `Converact` 命名体系，同时保持 Git 历史、生产维护分支、运行时配置、
数据库、API 和外部集成可追溯、可回滚。

本次迁移的目标是：

1. 建立一个覆盖通信、AI、业务执行和垂直产品的长期品牌；
2. 以现有私有仓库 `songgoldenwind-crypto/opc-platform` 为唯一未来主仓库，不创建第三个主仓库；
3. 保留现有 Git 历史、未推送提交、脏工作区和冻结生产维护线；
4. 把品牌、产品模块、Git 仓库和运行时技术标识分层迁移；
5. 防止全局字符串替换破坏环境变量、数据库、API、镜像、工作流或生产部署。

本次迁移不做：

- 不改服务器上的任何容器、镜像、配置、release symlink 或密钥；
- 不改 `maintenance/legacy-production-20260730` 的提交、分支名或工作目录；
- 不把 `/Users/songjinfeng/Desktop/opc` 的脏内容整包复制进主仓库；
- 不重写 Git 历史，不 reset、rebase 或删除旧分支；
- 不把所有 `OPC_*`、`opc_*`、表名和历史 Evidence 一次性机械替换；
- 不把尚未通过 Gate 的产品方向描述成已经可销售或 production eligible。

## 2. 名称决策

### 2.1 总品牌

正式英文品牌为：

```text
Converact
```

语义来自 `Converge / Conversation + Act`：把人、AI、设备、通信渠道和企业系统连接起来，
并把 Interaction 推进为受控、可验证的 Action 和 Outcome。

正式类别描述为：

```text
Converact — AI-native Multimodal Communications & Execution Platform
Converact — AI-native 多模态通信与业务执行平台
```

品牌主张为：

```text
From every interaction to verified action.
```

初步名称检查在 2026-07-31 未发现 GitHub、npm、crates.io 完全同名项目，且
`converact.com`、`converact.ai` 的 WHOIS 查询返回未注册。该检查不是商标法律意见；公开发布前
应完成 WIPO、目标国家/地区商标库和相似名称检索，并先锁定域名。内部私有仓库迁移不以法律
审查为工程阻塞条件。

### 2.2 产品与模块层级

| 当前称呼 | 目标称呼 | 目标职责 |
| --- | --- | --- |
| OPC / OPC Platform | **Converact / Converact Platform** | 平台总品牌与产品总称 |
| OPC/iveKit 通信底座 | **Converact Fabric** | SIP/PSTN、WebRTC、视频、媒体、消息和未来 ViLTE 的通信底座 |
| OPC Engagement Core | **Converact Engage** | Engagement、Interaction、Task、Evidence、Action、Outcome 连续性 |
| OPC AI-native Runtime | **Converact Agent Runtime** | 人工/AI 协作、模型、Speech、工具、Handoff 和治理 |
| OPC Resolve Assist | **Converact Resolve** | 首个 `resolution` Profile 与商业 Offer 系列 |
| OPC Console / frontend | **Converact Console** | 管理、坐席、工程师和运营界面 |

`Converact Fabric` 是一体化通信产品层名称，不改变其内部单一 Authority 设计：Unified
RustPBX 仍拥有 Call/业务通信权威，Kamailio 仍是 SIP Edge，RTPengine 仍是普通媒体性能
底线，LiveKit 仍拥有 Room/WebRTC/SFU 权威。

`iveKit` 降级为历史兼容称呼。旧文件名、接口、镜像和 Evidence 可以在兼容期继续保留，
但新文档、新模块和新对外接口不得再把 `iveKit` 用作总平台品牌。

### 2.3 状态表达

改名不改变任何能力状态。文档必须继续区分：

- `current`：当前源码或运行环境已经存在；
- `target`：设计决定但尚未实现；
- `production_eligible`：完成指定测试、容量、安全和运维 Gate；
- `not_run`：没有可核验 Evidence。

把 `OPC` 改成 `Converact` 不能把 `not_run` 提升为已完成或可销售。

## 3. Git 仓库与工作树拓扑

### 3.1 未来唯一主仓库

现有私有仓库原地重命名：

```text
songgoldenwind-crypto/opc-platform
    ↓
songgoldenwind-crypto/converact-platform
```

不创建空白仓库，不使用文件复制丢弃历史，也不强行把两套无共同根提交的 Git 历史拼接成
一条伪历史。

GitHub 会为普通仓库 Web、clone、fetch 和 push 提供旧地址重定向，但官方仍建议更新每个
clone 的 remote URL。GitHub 不会重定向以旧仓库地址引用的 GitHub Action，因此迁移前必须
扫描 workflow、submodule、package、container、badge、webhook 和部署脚本中的完整仓库引用。

### 3.2 旧仓库

`songgoldenwind-crypto/opc` 与 `opc-platform` 没有共同的可见根提交，继续作为独立迁移来源。
在 G00 逐文件迁移和验收完成前保持名称与内容不变。完成后：

```text
songgoldenwind-crypto/opc
    ↓
songgoldenwind-crypto/opc-legacy
```

`opc-legacy` 设为只读归档；不得用归档仓库继续开发新能力，也不得复用 `opc-platform` 旧名称
创建另一个仓库，以免破坏 GitHub 重定向。

### 3.3 分支与工作树保护

以下对象原样保留：

| 对象 | 规则 |
| --- | --- |
| `maintenance/legacy-production-20260730` | 冻结；只接受用户单独授权的生产热修 |
| `/Users/songjinfeng/Projects/opc-worktrees/legacy-production-20260730` | 路径不改；不参加品牌代码替换 |
| `/Users/songjinfeng/Projects/opc-worktrees/ivekit-v3` | 保留全部未推送提交和 44 项既有脏变更 |
| `/Users/songjinfeng/Desktop/opc` | 保留全部 staged/unstaged/untracked 用户工作；只作为迁移来源 |
| `.worktrees/ivekit-v2`、旧 `ivekit-v3`、`livekit-acceptance` | 只读对照；验证吸收前不删除 |
| `.runtime/nanobot-*`、`.tmp-r4-shadow-*` | 临时/上游候选；必须经 G00 证据确认后才能归档或清理 |

本次改名工作在隔离分支和工作树完成：

```text
branch: codex/converact-platform-rename
path:   /Users/songjinfeng/Projects/converact-worktrees/platform-renaming
```

目标稳定开发根为：

```text
/Users/songjinfeng/Projects/converact-worktrees/platform
```

只有当仓库改名、remote 校验、基线测试和迁移清单完成后，才能把该路径登记为
`canonical_execution_root`。

## 4. 技术命名兼容合同

### 4.1 环境变量

新代码和新部署只新增 `CONVERACT_*`，旧 `OPC_*` 进入兼容期。配置解析遵守：

1. 只存在 `CONVERACT_*`：使用新值；
2. 只存在 `OPC_*`：继续使用并发出可观测的 deprecation 事件；
3. 两者都存在且值相同：使用新值并记录旧别名仍在使用；
4. 两者都存在且值不同：启动失败，禁止无声选择造成不同节点配置漂移；
5. 任何日志、指标和错误不得输出 secret 内容；
6. 删除旧别名前，必须证明所有部署、CI、SDK、客户集成和回滚路径的旧变量使用量为零。

不得在 300 余个变量读取点手工复制兼容判断。实施阶段先建立一个有测试覆盖的配置别名解析
边界，再按域迁移直接读取点。

### 4.2 包、服务、镜像与资源

目标命名如下：

| 类型 | 目标 |
| --- | --- |
| 根 npm package | `converact-platform` |
| 前端 package | `converact-console` |
| 核心服务 | `converact-core` |
| Agent Runtime | `converact-agent-runtime` |
| 通信产品层 | `converact-fabric` |
| 新容器镜像 | `converact-*` |
| 新 Kubernetes release/resource 前缀 | `converact-*` |

当前生产环境继续使用原名称，直到生产维护线解除冻结且单独完成滚动升级计划。新旧资源不能在
同一集群中因名字不同而同时成为同一事实域的 Authority。

### 4.3 API、Schema 与持久化标识

- 新外部 HTTP API 使用品牌无关的版本路径，例如 `/api/v1/...`；不把 `converact` 写进
  每个业务 URL；
- 已发布 `/api/...` 路径不因品牌变化而删除或修改语义；
- 数据库表、列、migration ID、event type、idempotency key、metric name 和 Evidence 文件名
  默认不改；它们是兼容标识，不是营销文案；
- 只有存在明确业务收益、滚动 schema、双读/双写或 adapter、回滚与 active-zero 证据时，
  才迁移持久化标识；
- 历史 Evidence 中的 `OPC`、`iveKit` 保留原文，禁止改写过去的测试事实；
- 新 Evidence 使用 `Converact`，并在 provenance 中记录被测源码、commit、旧兼容标识和环境。

### 4.4 文档语言

新 canonical 文档使用 `Converact`。旧设计中的产品性 `OPC` 逐文档迁移；以下内容保留：

- 历史标题、commit message、Evidence、服务器 release 名和外部引用；
- `OPC_*` 兼容变量的精确拼写；
- `opc-platform`、`opc` 作为旧仓库来源说明；
- 尚未迁移的旧 API、表、镜像和部署资源。

文档不得用全局替换把 `OPC` 出现在兼容合同中的位置删除。

## 5. 迁移阶段

### Phase N0：冻结命名合同

- 提交本设计；
- 记录名称初筛、仓库可见性、remote、分支、worktree 和脏状态；
- 建立逐项 rename inventory；
- 确认域名已由用户控制后，才对外公开新品牌。

退出条件：设计通过审阅；改名清单覆盖 GitHub、源码、配置、数据库、CI/CD、镜像、文档、SDK、
部署、可观测性和外部集成。

### Phase N1：GitHub 主仓库改名

- 预扫描完整仓库 URL、reusable Action、webhook、deploy key、package 和 container 引用；
- 将私有仓库改名为 `converact-platform`；
- 更新所有本地 clone 的 `origin`；
- 验证 clone/fetch、branch protection、Actions、webhook、package 和 image release；
- 不改旧生产工作树内容，只更新它的 Git remote 元数据并验证只读 fetch。

退出条件：新 URL 可访问，所有已知 clone 指向新 URL，旧 URL 重定向验证通过，CI 没有使用
无法重定向的旧 Action 地址。

### Phase N2：产品文档和新开发表面

- 更新 canonical 产品与架构入口；
- 增加 Converact 产品层级和旧名称映射；
- 新文件、package、service、image 和部署模板只使用新名称；
- 历史 Evidence 和冻结生产配置保持不变。

退出条件：canonical 文档不再把 `OPC` 或 `iveKit` 当作当前总品牌；旧名称只出现在明确标注的
历史或兼容上下文。

### Phase N3：运行时兼容迁移

- TDD 实现统一环境变量 alias resolver；
- 按配置域迁移 `OPC_*` 读取点；
- 逐组件迁移 package/service/image/resource 名；
- 对升级、混合版本、回滚和冲突值执行 fail-closed 测试；
- 不在旧服务器版本验证期内部署这些变化。

退出条件：新测试环境只用 `CONVERACT_*` 可以运行；旧变量仍可兼容；冲突值必定失败；不存在
静默配置漂移。

### Phase N4：旧仓库归档与旧别名删除

- G00 完成两仓库逐文件迁移、hash 和来源审计；
- `opc` 改名为 `opc-legacy` 并归档；
- 各运行环境、客户集成和回滚路径对旧别名达到 active-zero；
- 通过单独 breaking-change 版本删除旧别名。

退出条件：没有未映射代码、文档、测试、schema、Evidence 或外部依赖；删除动作具有恢复副本和
审计记录。

## 6. 验证与回滚

### 6.1 每阶段验证

每个阶段至少验证：

- `git status` 只包含本阶段文件；
- 所有已知 clone 的 remote、branch 和 HEAD；
- 文档链接、JSON/Schema、OpenAPI 和 package metadata；
- typecheck、相关测试和改名 contract test；
- GitHub Actions、webhook、package/container 引用；
- 新旧环境变量的单值、同值、冲突值和 secret redaction；
- 老生产工作树 HEAD 与工作区状态没有变化。

未执行的检查记为 `not_run`，不得写成通过。

### 6.2 回滚

仓库级回滚不重写历史：

1. 在 GitHub 把仓库名恢复为 `opc-platform`；
2. 把本地 remote 恢复为旧 URL；
3. 恢复 CI/CD 中不能依赖 GitHub 重定向的引用；
4. 保留已提交的迁移 commit，通过正常 revert 还原代码命名；
5. 旧生产分支始终可独立构建，不依赖新命名资源。

运行时回滚依赖兼容别名，不依赖数据库 destructive rename。任何删除旧别名、旧镜像或旧资源的
动作都必须在 active-zero 后单独授权。

## 7. 验收标准

命名迁移完成必须同时满足：

1. GitHub 主仓库为 `songgoldenwind-crypto/converact-platform`，历史、分支和 tag 完整；
2. `maintenance/legacy-production-20260730` HEAD、文件内容和服务器容器未被本迁移改变；
3. canonical 产品入口只使用 Converact 产品体系；
4. 历史事实、旧 API、数据库和 Evidence 没有因品牌替换被篡改；
5. 新配置使用 `CONVERACT_*`，旧 `OPC_*` 有受测兼容和可观测弃用路径；
6. 所有仓库、worktree 和临时目录都有唯一用途及处置状态；
7. `/Users/songjinfeng/Projects/converact-worktrees/platform` 被验证为唯一新开发根；
8. 旧 `opc` 仓库只有在迁移审计完成后才改名归档；
9. 任何未跑的测试、容量或生产验证继续标记 `not_run`；
10. 改名没有创造第二通信、Agent、Engagement、Billing、Evidence 或媒体 Authority。

## 8. 参考

- [GitHub：Renaming a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository)
- [GitHub：Managing remote repositories](https://docs.github.com/en/get-started/git-basics/managing-remote-repositories)
- [WIPO Global Brand Database](https://www.wipo.int/en/web/global-brand-database)
- [USPTO Trademark Search](https://www.uspto.gov/trademarks/search)
