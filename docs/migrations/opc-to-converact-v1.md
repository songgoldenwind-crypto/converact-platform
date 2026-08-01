# OPC / iveKit → Converact v1 迁移指南

> 状态：`migration_in_progress / production_unchanged`
>
> 适用范围：新开发分支、SDK 使用方、CI、测试环境与后续新部署
>
> 不适用范围：冻结生产版本、当前服务器容器、历史 Evidence 与不可变发布清单

这次迁移只改变产品身份、新构建产物和开发入口，不借品牌迁移修改通信语义或持久化事实。
Converact 是平台品牌；Converact Fabric 是 SIP/PSTN、WebRTC、视频、媒体、消息和未来 ViLTE
的通信底座。冻结生产环境继续运行原版本，直到另行批准滚动升级。

## 1. 产品与仓库名称

| 旧名称 | 当前名称 |
| --- | --- |
| OPC / OPC Platform | Converact / Converact Platform |
| OPC/iveKit communication foundation | Converact Fabric |
| OPC Engagement Core | Converact Engage |
| OPC AI-native Runtime | Converact Agent Runtime |
| OPC Resolve Assist | Converact Resolve |
| OPC Console | Converact Console |
| `songgoldenwind-crypto/opc-platform` | `songgoldenwind-crypto/converact-platform` |

普通 GitHub Web、clone 和 fetch 请求可以经过旧仓库重定向，但本地 remote、CI、webhook、
OCI source label 与不能重定向的 GitHub Actions 引用必须改为新仓库。旧独立仓库
`songgoldenwind-crypto/opc` 在完整迁移账本关闭前仍是只读来源；之后才会改名为
`opc-legacy` 并归档。

## 2. 包、目录与导入

| 旧入口 | 当前入口 |
| --- | --- |
| `opc-growth-platform` | `converact-platform` |
| `opc-frontend` | `converact-console` |
| `@opc/ivekit-reference-client` | `@converact/reference-client` |
| `@opc/ivekit-sdk` | `@converact/sdk` |
| `@opc/ivekit-service` | `@converact/service` |
| `@opc/ivekit-capacity-runtime` | `@converact/capacity-runtime` |
| `@opc/sdk` | `@converact/javascript-sdk` |
| `opc-agent-panel` | `converact-agent-panel` |
| `@opc/ivekit-rustdesk-edge-agent` | `@converact/rustdesk-edge-agent` |
| `clients/ivekit-reference` | `clients/converact-reference` |
| `sdk/ivekit` | `sdk/converact` |
| `services/ivekit-service` | `services/converact-service` |
| `infra/ivekit` | `infra/converact` |
| `src/agent-runtime/ivekit` | `src/agent-runtime/converact` |

新 TypeScript 代码使用 `createConveractFabricClient`、`createConveractFabricHttpSdk` 和
`ConveractFabric*` 类型。`@converact/sdk` 仍导出原 `createIveKitClient`、
`createIveKitHttpSdk` 与 `IveKit*` 名称作为 deprecated alias；这些别名直接指向同一个
Converact 实现，不存在第二套客户端状态机。`@converact/javascript-sdk` 同理保留
`OPCClient`/`OPCClientConfig` 到 `ConveractClient` 的兼容别名。Python 的旧 `opc_client`
模块仅作为 `converact_client` 的兼容 shim。

包发布到公共 registry 尚未执行，状态为 `not_run`；在 `@converact` scope 的所有权和发布
Gate 完成前，不得把本地 build 或 dry-run pack 描述成已发布。

## 3. 环境变量

新配置使用：

```text
CONVERACT_<SUFFIX>
CONVERACT_FABRIC_<SUFFIX>
```

兼容映射为：

```text
OPC_<SUFFIX>         -> CONVERACT_<SUFFIX>
OPC_IVEKIT_<SUFFIX>  -> CONVERACT_FABRIC_<SUFFIX>
```

解析规则是强合同：

1. 只有新键时使用新键；
2. 只有旧键时使用旧值，并发出不含值的结构化弃用事件；
3. 新旧键同时存在且值相同，则使用新键；
4. 新旧键同时存在且值不同，启动或读取立即失败；
5. 空字符串是显式值，不能被当成未设置；
6. 错误和日志可以记录键名，绝不记录 secret 值。

因此混合版本升级不能靠“新键优先”掩盖冲突。先令新旧键同值，再滚动迁移读取方，最后依据
弃用指标证明旧键 active-zero。

## 4. 镜像、服务与 Helm

新构建镜像使用：

```text
ghcr.io/songgoldenwind-crypto/converact-<component>:<immutable-version>
```

Helm chart 与新资源使用 `converact-platform`、`converact-service`、
`converact-rtpengine` 等 Converact 名称。旧 `opc-*`、`ivekit-*` 镜像不会被删除、覆盖或
重新打 tag；冻结生产发布仍按原 digest 拉取。禁止在同一事实域同时启动新旧名字的两个
Authority。迁移遵守“新交互进入新节点、旧交互排空、三方 active-zero、回滚窗口到期后再删除”。

## 5. 明确保持不变的兼容标识

以下标识已经被客户端、数据库、事件消费者或历史证据引用，本次保持不变：

- 已发布 HTTP 路径，包括 `/api/ivekit/` 下的 Voice、IVR、Media、Chat、Events、
  Notifications、Contact Center 与 RustDesk API；
- OpenAPI `operationId`、`IveKit*` schema/component 名和 `x-ivekit-*` webhook header；
- 数据库表名、列名、migration 文件名与 migration ID；
- event type、metric name、idempotency key、CDR/recording identity 与持久化 schema ID；
- 历史 Evidence、验收报告、patch 文件名、objective 来源路径、release 名与旧镜像 digest；
- R4/R5 中明确冻结的兼容字段，例如旧来源分支、来源仓库和历史 Authority ID。

这些字符串表示兼容协议或来源事实，不表示当前产品仍叫 OPC/iveKit。若未来迁移其中任一项，
必须建立独立版本化合同、双读/适配、回滚与 active-zero 证据，不能通过文本替换完成。

## 6. 兼容窗口与删除条件

兼容窗口不按日历日期强制截止。SDK deprecated export 计划在相应 Converact SDK `1.0.0`
删除，但只有同时满足以下条件才可进入 breaking-change：

- 所有受控仓库、CI、部署、SDK 使用方和客户集成已迁到新名称；
- 旧环境键、旧 import 与旧脚本入口的可观测使用量持续为零；
- 混合版本升级和回滚演练通过；
- 冻结生产线已有单独批准的新版本替换方案；
- 删除清单、恢复方式、owner 和 Evidence 已审阅。

任一条件未满足，旧 alias 继续保留；不得仅为让命名扫描通过而删除兼容面。

## 7. 推荐迁移顺序

1. 更新 Git remote 和不可重定向的 CI/Action/webhook 引用；
2. 把依赖和 import 改为 `@converact/*` 与 `ConveractFabric*`；
3. 新增与旧值相同的 `CONVERACT_*` / `CONVERACT_FABRIC_*`；
4. 在测试环境验证同值、新键单独运行和冲突失败；
5. 更新镜像、Helm release 与资源引用，但不部署到冻结生产服务器；
6. 观察 deprecated alias 使用量并完成客户集成迁移；
7. 仅在 active-zero 与单独授权后删除旧键、旧 export 或旧资源。

## 8. 回滚

改名回滚不重写 Git 历史，也不修改数据库：

1. revert 对应的窄迁移 commit；
2. 将依赖/import 暂时切回 deprecated alias；
3. 保持新旧环境键同值，旧版本继续读取 `OPC_*` / `OPC_IVEKIT_*`；
4. 将 Git remote、CI 与 webhook 恢复到仍可用的旧地址；
5. 新环境重新选择旧镜像 digest/Helm values，先排空新节点再切换；
6. 冻结生产线直接继续使用原 release，不参与本开发分支回滚。

如果新旧环境键冲突，回滚前必须先修正为同值；不能关闭 fail-closed 检查。任何回滚均保持
一个 Authority、一个 writer 与现有 API/数据库语义。

## 9. 验证边界

完成改名需要分别验证 package tarball、SDK build/test、OpenAPI、环境别名、Helm/Compose
静态渲染、命名审计、Git remote 和冻结生产工作树。未执行项继续记录为 `not_run`。本指南
本身不是发布、部署、容量或生产可用性证据。
