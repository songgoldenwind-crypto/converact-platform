# Wave 2 Tinode 三节点集群受控验证证据

> 日期：2026-07-23
> 证据等级：controlled server
> 容量结论：none
> 目标服务器：`64.225.122.227`，Linux amd64
> 源码：Tinode `v0.25.3@22a7c18e9cd695e9a061bf1b8c84175196ef5a15`

## 1. 验证目标

本轮验证 standalone Chart 新增的 Tinode 两种运行模式及其共同镜像合同：

- `compact`：恰好一个副本，PVC 持久化 `/botdata`，本地附件位于 `/botdata/uploads`；
- `cluster`：恰好三个 StatefulSet 副本，稳定 ordinal/DNS、独立 client/headless Service、共享 S3-compatible 附件存储；
- 三个集群 Pod 不执行数据库初始化，由唯一阻塞式 Helm hook Job 建库、建表或升级；
- 容器使用非 root 用户和 read-only root filesystem，运行时可写目录显式挂载；
- 配置不完整、可变镜像、错误副本数和缺失 S3 配置必须 fail closed。

这是单台隔离服务器上的受控功能验证，不是目标 Kubernetes、跨主机高可用、容量或生产放行证据。

## 2. 不可变输入与输出

| 项目 | 值 |
| --- | --- |
| Tinode source | `v0.25.3@22a7c18e9cd695e9a061bf1b8c84175196ef5a15` |
| Builder | `docker.io/library/golang:1.26-alpine@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2` |
| Runtime | `docker.io/library/bash:5.3-alpine3.23@sha256:0d2a1b7230ba3cae17a0fd5b29445b1729be49a8a34cb28cfd9ab0710cb98743` |
| Candidate | `ivekit/tinode:v0.25.3-ivekit.3-22a7c18e-amd64` |
| Image ID | `sha256:6c83d13fc244b000b5bd0b2489a918b3fd4ac90bbab46039fea6656fa41b6650` |
| Image size | `46,880,001` bytes |
| Architecture | `amd64` |
| Runtime user | `tinode`, UID/GID `10001:10001` |
| Build network | dependency vendoring 后最终构建 `--network=none` |

最终镜像标签包含 iveKit release、精确上游 revision 和 build version。运行时 smoke 检查确认可执行文件、非 root 用户、架构、标签、owner hook、集群配置、S3 path-style 和数据库初始化标记均存在。

## 3. 补丁身份

| 文件 | SHA-256 |
| --- | --- |
| `infra/ivekit/tinode/apply-overlay.mjs` | `b29e401be7025d7962c9e3b8a3cd16dc8d2f815340579416ee7eda2391760df1` |
| `infra/ivekit/tinode/build.sh` | `603b1b2734e9dc7d0784914a3092ba885631cd1e3a0bb611300e7fe0e4ef91a2` |
| `infra/ivekit/tinode/patches/tinode-ivekit-session-fanout-hot-path.patch` | `01f39f3ad8386844486c512110d4f0daaee8da99f6ddbd616885a575d120e977` |
| `infra/ivekit/tinode/patches/tinode-ivekit-postgres-bootstrap.patch` | `3574014ebbbb08082002b5e8439d2aedfe784c4e85acd4535fe014c23b900fd2` |

在一份干净的精确上游源码上连续执行 overlay 两次。第一次结果为两个补丁均 `applied`，第二次均为 `already_applied`，证明补丁应用幂等且不接受未知源码漂移。

## 4. 编译与自动化验证

Go 1.26 验证覆盖：

```text
go test ./server ./server/db/postgres
go test -C ivekit/component-hook-go ./...
go test -C ivekit/tinode-owner ./...
```

数据库适配器新增测试使用 PostgreSQL SQLSTATE `3D000` 判断数据库不存在，避免依赖错误字符串。源码构建、组件 owner hook、数据库适配器和最终镜像 smoke 均通过。

Helm 受控验证覆盖：

- compact 和 cluster 分别执行 lint/template；
- cluster 渲染三个 StatefulSet 副本、client/headless Service、bootstrap Job、PDB 和 NetworkPolicy；
- 三个节点使用稳定 ordinal 地址，PDB 为 `minAvailable: 2`；
- invalid mode、cluster 副本数不等于 3、非 iveKit maintained image、缺失 S3 配置均被拒绝；
- MinIO/SeaweedFS 可显式设置 `forcePathStyle=true`，AWS S3 默认保持 `false`。

最终定向回归在验证服务器通过 `44/44`。Helm `v3.18.4` 对 compact 和 cluster 均得到 `1 chart(s) linted, 0 failed`，两种 template 均成功渲染。四个真实 Helm 反例分别拒绝了非法 mode、两副本 cluster、非 maintained image repository 和缺失 S3 配置。`rhysd/actionlint:1.7.12` 同时通过 Tinode 镜像工作流。机器可读结果记录于 `docs/capacity/phase2-code-status.json`；本机不运行 Docker、Helm 或动态测试。

## 5. PostgreSQL 初始化验证

### 5.1 目标数据库不存在

初始 PostgreSQL 只有维护数据库，目标 `tinode` 数据库不存在。初始化器收到 SQLSTATE `3D000` 后：

1. 连接 `postgres` 维护数据库；
2. 使用安全引用的数据库标识创建目标数据库；
3. 连接目标数据库并初始化 Tinode schema；
4. 最终 schema version 为 `116`。

这关闭了上游空 database 参数被 pgx 解释为数据库用户名、导致自动建库失败的问题。

### 5.2 目标数据库已预建但为空

另一组 PostgreSQL 容器通过 `POSTGRES_DB=tinode` 预建空数据库。初始化器查询 `pg_database` 确认数据库存在，不再执行 `CREATE DATABASE`，随后创建 schema。相同 initializer 第二次运行仍成功，schema version 保持 `116`。

这关闭了预建空数据库被误判为缺失、执行重复 `CREATE DATABASE` 的问题。

目标数据库不存在时，bootstrap 角色需要 `CREATEDB`；目标数据库由运维预建时不需要重建权限。安装和升级均禁止 `RESET_DB`。

## 6. S3 与三节点运行时验证

隔离网络内启动一次性 PostgreSQL、MinIO 和三个 Tinode 容器：

- MinIO bucket 预先创建并保持私有；
- Tinode S3 handler 使用 `force_path_style=true` 完成 `HeadBucket`；
- 三个节点均使用 `--read-only`；
- 三个 `/health` 均返回 server `0.25`、build `v0.25.3-ivekit.3`；
- cluster 日志出现 `Cluster of 3 nodes initialized`，并连接另外两个节点后启动选举；
- 受控运行标记为 `missing-db-bootstrap-s3-and-three-node-runtime-ok`。

S3 endpoint 不可达时，Tinode 在启动阶段 fail closed，而不是启动一个附件状态不一致的集群节点。这不会影响已经由其他健康节点承载的会话，但新节点不会被错误加入 Service。

## 7. 清理与共存检查

验证结束后已删除本轮临时容器、网络和卷。服务器原有 LED 服务未参与验证；清理后 LED 容器集合仍为以下 7 个：

```text
led-platform-edge-1
system-tasks
admin
web
api
postgres
minio
```

## 8. 尚未执行

以下项目继续保持 `not_run`，不得由本证据推导为通过：

- GHCR 发布、不可变 registry digest、SBOM、签名与 provenance；
- arm64 最终镜像执行；
- 目标 Kubernetes install/upgrade/rollback；
- 真实 PVC、生产 S3-compatible 对象存储和凭据轮换；
- Pod、节点、Zone、PostgreSQL 和对象存储故障注入；
- 多节点断线重连、sequence recovery、drain 和所有权接管；
- iveKit SDK 与第三方 Tinode 原生客户端的 mutation/历史/presence 收敛；
- 单节点 frontier、三节点扩展效率、长稳、P95/P99 延迟和 Cell/MIX 容量。

## 9. 结论

Tinode standalone 交付不再只有单副本模板。compact 单节点和 cluster 三节点的源码、镜像、Helm 合同、数据库 bootstrap、共享 S3 配置以及受控三节点组环均已实现并在服务器验证。生产放行仍取决于第 8 节真实环境证据，当前不声明高可用或容量达标。
