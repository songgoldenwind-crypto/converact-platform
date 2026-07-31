# OPC/iveKit 旧生产长期维护线设计

日期：2026-07-31
状态：已批准并进入实施
适用期：当前旧生产 release 至新 OPC 完成生产切换并通过回滚观察窗口。

## 1. 目标与成功标准

为 64.225.122.227 上的旧 OPC/Cell/LiveKit 组合建立长期、独立、可审计、可回滚的
维护线。它允许必要的最小生产热修，但永不与 ivekit-v3 或 G00–G17 新架构开发线混用。

成功标准：

1. 可从非敏感 manifest 重建与当前部署对应的源码。
2. 每个修复均有基线、测试、窄提交、候选包、部署证据和回滚点。
3. 不用单一 Git HEAD 伪代表 OPC、Cell、LiveKit、Compose 与 override 的组合状态。
4. 新架构与旧生产在工作目录、分支、发布、数据库和授权上完全隔离。

## 2. 已证明的基线事实

- 旧生产源码对象属于 songgoldenwind-crypto/opc-platform.git，不属于
  /Users/songjinfeng/Desktop/opc 的 opc.git。
- 新开发 worktree /Users/songjinfeng/Projects/opc-worktrees/ivekit-v3
  含大量未提交工作，不能作为维护线起点。
- 主 OPC 运行 production-media-20260730-835137d340da，由 base image
  sha256:530e6e3345c0... 与 13-file hotfix payload 组成。
- base image tag 为 im-final8-3f1a7d3ab2f3；服务器保留完整源码快照
  source-im-final8-3f1a7d3ab2f3，但该快照没有 .git，3f1a7d3ab2f3 也不是
  当前本地仓库可解析的 commit。
- Cell admission 与 LiveKit component-node 另行运行
  production-media-control-recovery-c32e8f369583；它以另一 base image
  sha256:83296c08de7b... 为基础，包含 2-file control recovery patch。
- 当前 Compose override 来自服务器 release
  /secure/releases/production-media-20260730-d98663222dff。

结论：生产是多基线、多镜像、多 override 组合，不能从当前开发 HEAD 简单拉分支。

## 3. 方案选择

### A. opc-platform.git 内的独立维护分支和 worktree（选定）

复用现有权限、Git 对象、CI 和审计流程。通过独立 worktree、maintenance/legacy-*
命名、分支保护和审核控制误合并风险。

### B. 独立 opc-legacy-production 仓库

物理隔离最强，但增加仓库、权限、CI 和备份治理。仅在现有 remote 无法配置有效保护时采用。

### C. 从 ivekit-v3 当前 HEAD 创建分支（拒绝）

会把新架构合同、migration 和未提交工作带入旧生产，也无法证明与服务器镜像的关系。

## 4. Git 与 worktree 设计

- remote：现有 songgoldenwind-crypto/opc-platform.git
- 分支：maintenance/legacy-production-20260730
- worktree：/Users/songjinfeng/Projects/opc-worktrees/legacy-production-20260730
- ivekit-v3：保持不变，不从中复制未提交文件
- 服务器：不作为 Git working tree，不在服务器直接编码或提交

分支创建必须经过基线决策门：

1. 将服务器 base source snapshot 与 opc-platform.git 可达 commit 做全树比较。
2. 若找到全树一致 commit，从该 commit 建分支。
3. 若找不到，创建 orphan reconstruction 分支，将快照作为明确标注 reconstructed
   provenance 的基线提交，不伪造原始 Git 血缘。
4. 基线之后，将 13-file media hotfix 作为独立提交。
5. 2-file control recovery 按真实 base 单独重建；若基线不兼容，则使用专用
   component branch/tag，不强压成虚假的统一 HEAD。

## 5. 发布事实模型

Git commit 只表示源码；release manifest 表示真实部署组合。每个候选或已部署
release 必须记录：

- 源码 commit/tag 或明确的 reconstructed base
- 每个容器的 image tag 与 image ID/digest
- base payload、hotfix payload 和 patch checksum
- Compose base files、override 顺序和非敏感配置指纹
- migration 清单、顺序、checksum 与实际执行状态
- rollback 起点、restore point checksum 和 runbook
- 临时例外、到期时间、enforcement 与 alert 状态
- candidate、deployed、current、superseded 或 rolled_back 状态
- not_run、passed、failed 或 unknown 验收状态

不得仅凭 tag、目录存在、Git HEAD 或本地候选包声称已部署。

## 6. 维护工作流

### 日常观察

1. 只读获取 Compose ConfigFiles、镜像 ID、容器健康与 restart count。
2. 只读统计 Media Call、livekit_av placement/reservation 和非终态 Room。
3. 只收集脱敏日志；不记录凭据、原始幂等键或参与者 token。
4. 临时例外低于 24 小时进入 warning，约低于 2 小时进入 critical。

### 故障修复

1. 只读复现并固定当前 release/image/config 事实。
2. 在维护 worktree 先添加回归测试，再做最小修复。
3. 禁止从新架构随意 cherry-pick。若必须借用逻辑，应人工重写最小差异，并审核
   合同、schema 与运行时假设。
4. 生成 candidate release，验证校验和及 base-only rollback。
5. push、构建生产镜像、migration、配置变更、restart 和 deploy 分别需要对应授权。
6. 发布后冻结观察；异常先取证，再回滚或修复。

## 7. 测试与验收

每个热修至少覆盖：

- 对故障的确定性回归测试
- media payload 与 control payload 的边界回归
- migration checksum、顺序及重复执行防护
- image label、payload manifest 与镜像内提取文件的一致性
- Compose 渲染差异，证明未触碰 LED 或新架构资源
- livez、readyz、placement/admission 和非终态 Room 观察
- 必要时的 LED 双浏览器/Profile 建会、Join、双向 track、重连、挂断验收
- 失败后的 base-only rollback 演练或可重放证据

真实生产写入型验收不由“只读监控”默认授权。

## 8. LED 与新架构边界

- 本维护线不修改 LED 代码；LED 问题形成 Markdown 适配清单。
- LED 继续保持 durable Call、同幂等键安全重试、刷新后 create intent、legacy ref
  自愈、LiveKit Web UI 和诚实失败态。
- OPC 合同稳定后，LED 才进行双参与者音视频终验及 Remote 授权 UI/安全边界实现。
- ivekit-v3、architecture-foundation 和 G00–G17 不是旧生产部署源。

## 9. 安全与权限

- 仓库只保存非敏感指纹和路径，不保存密码、SSH key、API key、token、Cookie、
  认证头或原始幂等键。
- 服务器 secret 仅在服务器内受控使用，不复制回 worktree。
- 分支 push 授权不等于 deploy 授权。
- 容器、release symlink、Compose、环境变量、数据库、migration、网络、证书、
  restart 或 deploy 均需用户在当次任务明确授权。

## 10. 分支保护与提交规则

- 禁止 force-push、rebase 已部署提交或删除 deployed tag。
- 一个提交只处理一个生产问题，不做无关重构、格式化或依赖升级。
- 提交必须引用脱敏故障证据、回归测试和 rollback impact。
- candidate tag 与 deployed tag 分离；只在服务器事实复核后标记 deployed。
- 不将维护分支 merge 回新架构分支；新架构若需同类修复，须单独建模和验收。

## 11. 退役

仅当新 OPC 完成生产切换、观察窗口结束、旧线不再承载流量，且新线回滚不再依赖旧线时：

1. 将维护分支设为 read-only/frozen。
2. 保留最终 source tag、release manifest、image digest、migration 与 rollback 证据。
3. 撤销临时例外和运行凭据。
4. 按保留要求停止服务，但不删除审计记录。

## 12. 实施顺序

1. 冻结并校验服务器 base source snapshot、media patch 和 control recovery payload。
2. 判定是否存在全树一致的可达 Git commit。
3. 创建独立 worktree 和维护分支，不触碰 ivekit-v3 工作区。
4. 建立 reconstructed base、media hotfix 与 control recovery 的可追溯 commit/tag。
5. 生成并验证当前 deployed release manifest。
6. 配置远端维护分支及保护规则；分支 push 不触发部署。
7. 执行纯本地重建、测试及 manifest 一致性验证。
8. 保持服务器冻结；任何后续部署另行授权。
