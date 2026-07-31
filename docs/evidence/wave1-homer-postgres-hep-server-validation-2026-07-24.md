# Wave 1 HOMER PostgreSQL/HEPv3 受控服务器验证

日期：2026-07-24
状态：`passed_controlled_server`
范围：HOMER 精确源码构建、PostgreSQL DuckLake catalog、Kamailio HEPv3、故障隔离与恢复
容量声明：`capacity_claim=none`

机器证据见
`docs/evidence/wave1-homer-postgres-hep-server-validation-2026-07-24.json`。

## 1. 结论

HOMER `11.0.297@ac4e1ae7f63660a655a5ef42e6607ab4cefc1c6b` 已在隔离 Linux
服务器上从精确源码构建。候选镜像以 PostgreSQL 作为 DuckLake catalog，不包含 SQLite CLI、
`sqlite_scanner`、Node.js、npm 或前端源码产物。运行时使用 UID/GID `10001:10001`、只读根文件
系统和 `/tmp/homer-core.pid`，没有发生 OOM 或进程重启。

受控拓扑成功完成以下闭环：

1. Kamailio 通过 HEPv3/UDP 把完整 SIP 呼叫副本送入 HOMER。
2. HOMER 使用 PostgreSQL catalog 写入并按 Call-ID 检索 INVITE、临时响应、最终响应、ACK 和 BYE。
3. `include_options=false` 时，OPTIONS 和 KDMQ 均不进入诊断库。
4. HOMER collector 停止时，电话和 RTP 主链继续成功。
5. PostgreSQL 停止时，HOMER 保持运行，电话和 RTP 主链继续成功。
6. PostgreSQL 恢复后，无需重启 HOMER，新呼叫成功写入并检索。

本结果证明受控服务器上的功能和故障隔离，不证明生产容量、长稳、双 Zone 或十万并发。

## 2. 精确源码和镜像

| 项目 | 结果 |
| --- | --- |
| 上游版本 | `11.0.297` |
| 上游 commit | `ac4e1ae7f63660a655a5ef42e6607ab4cefc1c6b` |
| Overlay SHA-256 | `76806d5aba1fa460d3490c338ffd169268be5ed5f63e2be2c6ea93294e76d66e` |
| Go | `go1.26.5 linux/amd64` |
| 候选镜像 | `ivekit/homer:11.0.297-ivekit.1-ac4e1ae7` |
| 镜像 ID | `sha256:fe0d45edc33c23b5047258690ca7ecf95bed93a164d7cfdb9ab499cbc83c893d` |
| Inspect size | `121,407,366` bytes |
| 二进制 commit | `ac4e1ae7f63660a655a5ef42e6607ab4cefc1c6b` |
| 运行用户 | `10001:10001` |
| 最终镜像 Node/npm | 均不存在 |
| Registry 制品 | 尚未发布 |

构建输入固定为以下不可变基础镜像：

- Go：`golang@sha256:1ecb7edf62a0408027bd5729dfd6b1b8766e578e8df93995b225dfd0944eb651`
- Node：`node@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3`
- Runtime：`debian@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818`

Overlay 在精确源码中执行 Go 格式化、Go module 下载与校验、前端 `npm ci`、PostgreSQL catalog
专项 Go 测试和 HOMER 编译。build script 显式向 `make` 注入精确 commit，并在构建后执行二进制
revision 门禁；前端构建完成后在同层删除 `node_modules` 和 npm cache，避免 legacy builder 长期
保留无用依赖。最终镜像离线启动所需的 DuckLake、`postgres_scanner`、HTTPFS 和 AWS 扩展随
镜像交付；SQL 中使用的 catalog 类型名仍为 `postgres`。

## 3. PostgreSQL Catalog

HOMER 成功 attach PostgreSQL DuckLake catalog。PostgreSQL 中观察到 28 张 DuckLake catalog
metadata 表，事件数据由 HOMER writer 写入并由 node 查询。部署合同保持一 Cell 一个 writer、
一个 catalog 和一组数据文件，不允许多个 writer 共享 catalog。

本证据没有输出 DSN、数据库密码、管理员密码、JWT 或 node token。HOMER 的本地 settings
DuckDB 仅保存协调器设置，不是 SQLite，也不是业务权威数据库。

## 4. HEP 呼叫还原

生产式 `include_options=false` 配置下，真实 PCMU 媒体呼叫在 HOMER 中检索到 14 条记录。时间范围
为 `2026-07-24T15:10:57.599346Z` 至 `2026-07-24T15:11:02.643146Z`，包含：

```text
INVITE -> 100 -> 180 -> 200 -> ACK -> BYE -> 200
```

双层受控 Kamailio trace 点会产生预期重复记录，因此记录数不等于 SIP 方法种类数。验证使用
Call-ID SHA-256 绑定证据，机器文件不暴露内部地址。

最终候选镜像 `sha256:fe0d45ed...c893d` 接管原有 PostgreSQL catalog 后，又发起一条唯一
INVITE，收到 `100` 和 `486`，并检索到 8 条新记录。它证明最终镜像身份、默认 PID 参数、
catalog attach 和 HEP 新写入属于同一构建产物。

排除规则结果：

| 类型 | SIP 结果 | HOMER 记录 |
| --- | ---: | ---: |
| OPTIONS | `200` | `0` |
| KDMQ | `403` | `0` |

## 5. Collector 故障隔离

HOMER collector 完全停止时，通过 HEP edge 发起 5 路真实 PCMU 通话：

| 指标 | 结果 |
| --- | ---: |
| UAC / UAS 成功 | `5/5` / `5/5` |
| 失败 / SIP 重传 | `0` / `0` |
| RTP packet coverage | `99.36%` |
| durable loss | `0` |
| sequence gap / duplicate / reorder | `0 / 0 / 0` |

Collector 恢复后健康，Kamailio、RustPBX、Router 和 PostgreSQL 基线均未重启。这验证了 HEP 是
不可反压呼叫事务的旁路副本。

## 6. PostgreSQL 故障隔离和恢复

HOMER PostgreSQL catalog 停止时，HOMER 进程保持运行。故障窗口内完成 3 路 PCMU 通话：

| 指标 | 结果 |
| --- | ---: |
| UAC / UAS 成功 | `3/3` / `3/3` |
| 失败 / SIP 重传 | `0` / `0` |
| RTP packet coverage | `99.20%` |
| durable loss | `0` |
| sequence gap / duplicate / reorder | `0 / 0 / 0` |

PostgreSQL 恢复后，HOMER 无需重启。随后新发起一条唯一 INVITE，收到 `100` 和 `486`，HOMER
检索到 8 条新记录，时间范围为 `2026-07-24T15:26:07.032899Z` 至
`2026-07-24T15:26:07.040914Z`。这证明恢复后的新写入和读取链路可用。

故障期间 HEP 允许有界丢失。该旁路不能为了保证诊断数据完整而阻塞、无限排队或终止主媒体。

## 7. 安全和供应链边界

上游前端 lockfile 的 `npm audit` 报告 8 项构建期依赖告警：`3 high`、`4 moderate`、`1 low`、
`0 critical`。这些包只参与前端构建，最终运行镜像中没有 Node、npm、`package.json`、
`package-lock.json` 或 `node_modules`。这降低运行时暴露面，但不等于供应链告警已关闭。

共享 OCI release gate 尚未真实执行，因此当前镜像只是服务器本地候选制品。以下项目仍未完成：

- GHCR amd64/arm64 manifest 与不可变 Registry digest；
- 最终 OCI 漏洞扫描和 SPDX SBOM；
- Cosign 签名与 GitHub provenance/SBOM attestations；
- 目标 Kubernetes admission 和 rollout。

因此 `production_eligible=false`。

## 8. 未运行项目

以下项目保持 `not_run`：

- 同硬件 HEP enabled/disabled CPS、CPU、内存、网络、HEP loss 和 P95/P99 A/B；
- HEP 丢包、限速、高水位、动态关闭 trace 和过载恢复；
- retention、compaction、导出审计、删除作业和长期磁盘增长；
- 目标 Kubernetes install/upgrade/rollback、NetworkPolicy 运行态和生产 Secret 轮换；
- 双 Zone、节点丢失、生产 PostgreSQL 主备和目标存储故障；
- 独立 generator/SUT、长稳、Cell-10K 和 MIX-100K。

本证据不能用于宣传 HOMER、Kamailio 或 RustPBX 的生产容量，也不能把服务器本地镜像作为已签名
生产镜像。
