# Converact Fabric 依赖与上游更新策略

## 1. 目标

Renovate 负责发现依赖、容器 digest、GitHub Action SHA 和 Converact Fabric fork 上游版本变化，但不拥有生产准入权。任何自动 PR 都不能跳过 exact source、补丁重放、性能回归、真实链路和 OCI 供应链门禁。

配置入口：

- `renovate.json`：仓库级更新、分组、安全和审批策略；
- `.github/renovate-upstreams.env`：有 tag 的 Converact Fabric fork 上游发现索引；
- `docs/capacity/forks/ivekit-forks-v1.json`：源码 commit、补丁、构建和证据的唯一权威。

## 2. 自动化边界

Renovate 可以自动创建 PR，但仓库禁止 dependency automerge：

- npm 与 lockfile 更新必须通过 typecheck、测试和 audit；
- Docker tag 保留可读版本，同时以 `@sha256` 固定内容；
- GitHub Actions 必须固定完整 commit SHA；
- Converact Fabric upstream PR 只表示“发现新版本”，不表示 fork 已经升级；
- Major 更新先进入 Dependency Dashboard，显式批准后才创建 PR。

内部候选镜像、示例 registry 和全零 digest 不由 Renovate 查询或替换。

## 3. Fork 升级流程

收到 `converact-upstream` PR 后必须完成：

1. 阅读 release note、安全公告和协议兼容变化；
2. 将 tag 解析为 exact 40-character commit；
3. 在隔离 worktree 重放 Converact Fabric patch/overlay，处理冲突；
4. 更新 build script、镜像标签、环境示例、fork manifest 和交付包；
5. 运行上游单测、Converact Fabric 定向测试、协议回归和性能 A/B；
6. 构建 digest-only 镜像，生成 SBOM，执行 HIGH/CRITICAL 扫描、签名和 provenance；
7. 运行对应真实链路、故障注入、drain、回滚和容量门禁；
8. 只有证据达到定义状态后，才更新 `production_eligible`。

源版本 PR 不直接修改 fork manifest，避免出现“tag 已升级但 commit、补丁和证据仍属于旧版本”的伪完成状态。

## 4. 性能和热路径约束

所有通信核心升级都必须和旧版本在同硬件、同 workload 下 A/B。至少比较吞吐、P50/P95/P99、CPU、RSS、网络、错误率、重连、弱网恢复和横向扩展效率。依赖更新不得增加 RTP/SFU/Tinode fanout/RustDesk relay 对数据库、对象存储、AI、扫描器或遥测后端的同步依赖。

## 5. 运行状态

仓库配置与静态测试已实现。Renovate App 的首次仓库运行、实际 PR、Registry digest 更新和 fork rebase 仍是 `not_run`；在 GitHub 产生对应证据前不能写成已通过。
