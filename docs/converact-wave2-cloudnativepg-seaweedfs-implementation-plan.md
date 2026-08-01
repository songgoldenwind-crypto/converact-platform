# Converact Fabric Wave 2 CloudNativePG 与 SeaweedFS 实施计划

> 状态：已批准的 Wave 2 总目标之执行细化。本文不扩大产品范围，不改变 PostgreSQL 与对象存储的既有权威边界。

## 1. 目标

在不侵入 SIP、RTP、LiveKit SFU、Tinode 消息扇出和 RustDesk 中继热路径的前提下，完成以下能力：

1. 将应用 Chart 中的单副本 PostgreSQL 明确定义为仅供开发使用的回滚路径；生产环境通过 Secret 消费外部 PostgreSQL 18 HA 服务。
2. 提供 CloudNativePG `v1.30.0` 三实例、跨 Zone、同步复制、PgBouncer、WAL 归档、定时备份和 PITR 恢复平台配置。
3. 保留统一 S3 provider 边界，新增 SeaweedFS `4.40` 自建对象存储兼容配置，不让 Converact Platform、LED 或 LiveKit 依赖 SeaweedFS 私有 API。
4. 证明对象存储不可用只会令上传、录制落盘或异步处理失败，不会结束正在进行的语音、视频、IM 或远控会话。
5. 所有 Docker、Helm、Kubernetes、故障注入和集成回归仅在 `64.225.122.227` 执行；本机只做编辑和静态检查。

## 2. 权威边界

| 领域 | 唯一权威 | CloudNativePG/SeaweedFS 的角色 |
| --- | --- | --- |
| 事务数据 | PostgreSQL | CloudNativePG 只负责 PostgreSQL 生命周期、复制、故障切换与备份，不成为第二数据库 |
| 数据库连接 | PostgreSQL rw Service 或 PgBouncer rw Service | PgBouncer 仅复用连接，不缓存事务权威数据 |
| 对象数据 | S3 provider 契约 | SeaweedFS 是可选的 S3 实现，不向业务暴露 filer、volume 或 master API |
| 实时会话 | RustPBX、LiveKit、Tinode、RustDesk | 数据库和对象存储故障不得同步终止实时会话 |
| 备份 | Barman Cloud CNPG-I Plugin + 独立备份桶 | 备份对象与媒体对象分桶、分凭据、分保留策略 |

## 3. 已选方案及取舍

### 3.1 CloudNativePG

采用“外部平台 profile”，不把 operator 安装清单塞进 Converact Platform 或 Converact Fabric 应用 Chart。

- CloudNativePG 固定为 `v1.30.0`，生产 Cluster 使用 PostgreSQL 18 标准镜像与不可变 digest。
- 三实例按 `topology.kubernetes.io/zone` 和 `kubernetes.io/hostname` 分散，Pod 反亲和为 required；资源不足时宁可 Pending，不伪装成 HA。
- 同步复制使用 `method: any`、`number: 1`、`dataDurability: required`。正常状态 RPO 为 0；失去全部同步副本时写入暂停，实时媒体转发不受影响。
- 应用连接 PgBouncer `transaction` 池，数据库迁移、LISTEN/NOTIFY、会话级锁等不兼容事务池的操作直连 rw Service。
- 备份只使用 Barman Cloud CNPG-I Plugin，不新增已弃用的内置 `barmanObjectStore` 配置。
- 备份从 standby 执行，避免全量备份 I/O 直接压主库；恢复总是创建新 Cluster，验证后再切换 Service/Secret。

未选择：

- 不在应用 Chart 内安装 operator，避免 CRD 生命周期和应用发布耦合。
- 不做双写数据库，避免一致性和回滚复杂度。
- 不把单副本 StatefulSet 宣称为生产 HA。

### 3.2 SeaweedFS

采用“外部 S3 优先，SeaweedFS 自建 profile”的路线。

- 固定 SeaweedFS `4.40` 不可变镜像；先做隔离的 S3 兼容验收，再决定生产启用。
- Converact Platform/LED 使用 `S3_*`/`AWS_*` 通用配置；`MINIO_*` 仅保留为有截止日期的兼容输入。
- LiveKit Egress 使用同一 S3 endpoint/bucket/credentials 契约，但独立 bucket 前缀和最小权限凭据。
- SeaweedFS master、volume、filer、S3 gateway 的部署属于平台层；应用 Chart 只消费 endpoint Secret。
- 对象锁、版本控制、跨 Zone 恢复只有在真实运行通过后才标记完成，不依据“API 看起来兼容”推断。

未选择：

- 不直接调用 SeaweedFS filer API、TUS API 或 volume API。
- 不在当前阶段引入 Ceph，避免为尚未证明的容量需求付出过高资源和运维成本。
- 不立即删除 MinIO 回滚配置；先完成对象核对、双读验证和端点切换，再按治理截止日期删除。

## 4. 工作包与文件

### 工作包 A：CloudNativePG 平台 profile

新增：

- `infra/platform/cloudnative-pg/README.md`：安装前置、Secret 契约、切换、回滚、备份与恢复操作。
- `infra/platform/cloudnative-pg/kustomization.yaml`：只组合应用拥有的 CNPG 资源，不安装 operator/CRD。
- `infra/platform/cloudnative-pg/cluster.yaml`：三实例 PG18、同步复制、跨 Zone、资源、存储和监控。
- `infra/platform/cloudnative-pg/pooler-rw.yaml`：三副本 transaction PgBouncer 与显式连接预算。
- `infra/platform/cloudnative-pg/object-store.yaml`：Barman Cloud Plugin `ObjectStore`，只引用外部 Secret。
- `infra/platform/cloudnative-pg/scheduled-backup.yaml`：插件式 standby 定时备份。
- `infra/platform/cloudnative-pg/recovery-example.yaml`：从独立 ObjectStore 恢复到新 Cluster 的 PITR 示例。
- `test/cloudnative-pg-platform-profile.test.ts`：静态合约与禁用弃用字段测试。

修改：

- `infra/k8s/values.yaml`：数据库模式从布尔值升级为 `bundled-dev`/`external`。
- `infra/k8s/templates/postgres-statefulset.yaml`：仅在 `bundled-dev` 渲染。
- `infra/k8s/templates/secrets.yaml`：external 模式只引用已有 Secret，不把数据库密码复制进 release Secret。
- `infra/k8s/templates/converact-deployment.yaml`：通过统一 helper 引用 database URL Secret。
- `infra/k8s/templates/_helpers.tpl`：模式校验、external Secret 校验和数据库 env helper。
- `test/postgres-deployment-contract.test.ts`：生产 fail-closed、开发回滚和 Secret 引用测试。

验收：

1. `external` 模式不渲染 PostgreSQL StatefulSet，也不生成明文连接串。
2. 缺少 external Secret name/key 时 Helm 渲染失败。
3. `bundled-dev` 模式保留原单节点回滚行为并带非生产标签/注释。
4. Cluster 固定三实例、跨 Zone、同步一副本、PDB/监控/资源预算完整。
5. 配置中不存在 `.spec.backup.barmanObjectStore`。
6. 目标 Kubernetes 上的 node loss、WAL archive、backup、PITR、PgBouncer 连接预算保留为真实环境 gate，未执行前不得写成完成。

### 工作包 B：品牌无关 S3 契约

新增或修改：

- `infra/k8s/templates/_helpers.tpl`：统一 S3 endpoint、bucket 与 Secret 引用校验。
- `infra/k8s/templates/converact-deployment.yaml`：优先注入 `S3_*`/`AWS_*`，保留 `MINIO_*` 兼容期输入。
- `infra/k8s/templates/livekit-egress-deployment.yaml`：从统一 S3 helper 渲染 Egress 配置。
- `infra/k8s/templates/secrets.yaml`：支持外部 S3 Secret，生产模式禁止默认凭据。
- `infra/k8s/values.yaml`：新增 `media.objectStorage`，`media.minio` 标记 legacy rollback。
- `.env.example`、`infra/env.example`、`services/converact-service/env.example`：说明通用 S3 配置优先级与兼容截止。
- `test/object-storage-brand-neutral-contract.test.ts`：通用变量优先、legacy 兼容和 fail-closed 测试。

验收：

1. `S3_*` 配置优先于 `MINIO_*`，应用代码不出现 SeaweedFS 私有 API。
2. 生产 external 模式缺少 endpoint、bucket 或 Secret 时 Helm 失败。
3. AWS S3 可关闭 path-style，自建 SeaweedFS 可显式启用 path-style。
4. Converact Platform 附件、录音对象、备份 runner 与 LiveKit Egress 使用同一协议契约但可以使用不同 bucket/凭据。

### 工作包 C：SeaweedFS 4.40 服务器验收

新增：

- `services/converact-service/acceptance/seaweedfs-s3/docker-compose.yml`：隔离 master、volume、filer、S3 gateway，不暴露公网端口。
- `services/converact-service/acceptance/seaweedfs-s3/probe.ts`：复用生产 `ObjectStorage` provider 执行 S3 矩阵。
- `services/converact-service/acceptance/seaweedfs-s3/accept.sh`：服务器约束、随机凭据、健康门、故障注入、清理和证据输出。
- `test/seaweedfs-s3-acceptance.test.ts`：验收脚手架静态测试。
- `docs/evidence/wave2-seaweedfs-s3-validation-YYYY-MM-DD.md`：不夸大结论的验收记录。
- `docs/evidence/wave2-seaweedfs-s3-runtime-YYYY-MM-DD.json`：机器可读证据。

运行矩阵：

1. bucket create/list/head/delete。
2. 小对象、至少 256 MiB 大对象、metadata、content type、range read。
3. multipart create、part upload、complete、abort；中断后基于持久 upload id 恢复。
4. versioning 和 object-lock 分别探测，只有成功才标记 supported。
5. 暂停一个非唯一 volume/filer 实例时验证可用性；单机 Compose 不宣称跨 Zone 容灾。
6. 关闭 S3 gateway 时，预先建立的 LiveKit/语音会话模拟探针持续成功，上传明确失败且队列有界；gateway 恢复后新上传成功。
7. 验收前后 LED 七个容器集合完全一致，临时容器、网络、卷全部清理。

## 5. 测试纪律

本机允许：

```bash
git diff --check
jq empty <json-file>
node --check <javascript-file>
sh -n <shell-file>
```

服务器执行：

```bash
ssh -i /Users/songjinfeng/.ssh/led_rsa_songjinfeng \
  -o IdentitiesOnly=yes root@64.225.122.227
```

服务器源码目录固定为 `/opt/converact-wave123-validation-20260722/source`。Node 测试使用 `/opt/converact-wave123-validation-20260722/cache/toolchain/bin/node`。Helm 通过缓存镜像 `alpine/helm:3.18.4` 执行并显式设置 `--entrypoint /bin/sh`。

每个动态验收必须：

1. 开始前记录源文件 SHA-256、Git commit（如存在）和 LED 容器集合。
2. 使用随机生成且不进入日志的凭据。
3. 失败时输出脱敏诊断。
4. 使用 trap 清理临时容器、网络、卷。
5. 结束后再次验证 LED 七容器不变量。
6. 将未执行项写成 `not_run`，不得写成 `passed` 或“已支持”。

## 6. 实施顺序

1. 先写失败的 CloudNativePG profile 与 external database Helm 契约测试。
2. 实现 CloudNativePG 平台清单和应用 Chart 外部数据库模式，在服务器运行 Helm/Node 回归。
3. 写失败的品牌无关 S3 配置测试，完成 `media.objectStorage` 与 legacy 兼容层。
4. 写失败的 SeaweedFS 验收脚手架测试，再实现服务器 Compose/probe/acceptance。
5. 在服务器执行 SeaweedFS 真实 S3 矩阵与存储中断隔离测试。
6. 更新技术基线、组件权威矩阵、Wave 2 状态、迁移文档和证据索引。
7. 在服务器运行受影响的全量回归与 TypeScript 编译；Kubernetes 双 Zone、PITR 和真实 LiveKit Egress 未具备环境时明确保留 `not_run`。

## 7. 完成定义

以下条件全部满足才可将本计划标记为代码完成：

- CloudNativePG 和 SeaweedFS 所有新增静态合约测试通过。
- 应用 Chart external 数据库和 external S3 模式 fail-closed，开发回滚模式可渲染。
- SeaweedFS 真实 S3 兼容矩阵在指定服务器通过，且清理和 LED 不变量通过。
- 版本基线更新为 CloudNativePG `v1.30.0`、Barman Cloud Plugin 当前固定版本、SeaweedFS `4.40`，均记录不可变来源。
- 文档准确区分 `passed_controlled_server`、`not_run_target_kubernetes` 和 `not_run_cross_zone`。
- 没有任何新增同步数据库、对象存储、分析或 AI 调用进入实时通信热路径。

生产完成还需要目标 Kubernetes 的三节点/双 Zone、真实对象存储持久盘、WAL/PITR、真实 LiveKit Egress 和跨 Zone 故障演练；这些不由单机服务器 Compose 证据替代。
