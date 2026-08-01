# Converact Fabric 备份与恢复运行手册

## 1. 目的与边界

本文定义 Converact Platform、LED 及其他业务共同使用的 Converact Fabric 通信底座的备份、校验、恢复和演练流程。命令面向平台运维人员，不向租户或普通业务服务开放。

一次 Converact Fabric 备份集可以包含：

| 数据 | 默认状态 | 说明 |
| --- | --- | --- |
| Converact Fabric PostgreSQL 主库 | 必选 | IM 映射、媒体、文件、远控、语音控制面、通知、审计、保留策略等 |
| Tinode PostgreSQL | 可选 | 设置 `CONVERACT_FABRIC_TINODE_ADMIN_DATABASE_URL` 后纳入同一清单 |
| RustPBX PostgreSQL | 可选 | 设置 `CONVERACT_FABRIC_RUSTPBX_ADMIN_DATABASE_URL` 后纳入同一清单 |
| S3/MinIO 或本地对象 | 必选 | 附件、录制、证据、转码和缩略图；逐对象复制与校验 |

以下内容不写入应用备份集：

- Kubernetes Secret、外部 Secret Manager、TLS 私钥、LiveKit API Secret、数据库密码。
- RustDesk `id_ed25519` 私钥、第三方 Provider 密钥等基础设施机密。
- 镜像和部署仓库；它们由 Git、镜像仓库和交付清单恢复。
- Redis 中的短期队列、房间在线态、租约、限时缓存；持久业务状态以 PostgreSQL 为准。

这些机密必须由平台的密钥备份策略单独保护。RustDesk 服务身份私钥丢失会导致客户端信任关系变化，因此密钥恢复是整个平台灾备演练的必检项，但不允许把私钥混入普通数据备份。

## 2. 备份集格式

每次备份创建一个全新目录，已有目录不会被覆盖：

```text
<backup-id>/
  .converact-backup
  database.dump
  database-tinode.dump          # 可选
  database-rustpbx.dump         # 可选
  objects.jsonl
  objects/<sha256-of-key>.bin
  manifest.json
  manifest.sha256
```

`database*.dump` 使用 PostgreSQL custom format。`objects.jsonl` 保存对象键、备份文件、SHA-256、字节数和 ETag。`manifest.json` 再绑定数据库转储、对象清单、依赖库清单、源提交和恢复所需迁移版本；`manifest.sha256` 绑定完整清单。

`.converact-backup` 在任务开始时是 `partial`，只有所有数据写入且完整性复验通过后才原子更新为 `complete`。失败目录保留用于诊断，但不能用于恢复。

清单 SHA-256 是防误损校验，不等同于防篡改签名。备份目录必须保存到启用访问控制、版本锁定和服务端加密的存储中；跨信任域传输时应再使用组织级 KMS 签名或不可变归档策略。

## 3. 安全约束

1. 数据库 URL 和密码只进入 `pg_dump`、`pg_restore`、`psql` 子进程环境，不进入命令参数、标准输出或清单。
2. 对象以流方式复制，复制过程中计算 SHA-256；不会把大文件整体读入内存。
3. 本地对象源拒绝符号链接、设备文件和 FIFO，并忽略未完成的 `.multipart` 临时目录。
4. 恢复默认只校验备份，不修改数据库或对象存储。
5. 真正恢复同时要求 `--execute`、精确确认串和空目标声明。
6. 程序还会查询每个目标 PostgreSQL 的 `public` 表数量；任一目标非空时，在第一个 `pg_restore` 前整体终止。
7. 对象恢复使用“不存在才写入”；本地采用排他复制，S3 使用 HEAD 检查加 `If-None-Match: *`。
8. 主库恢复后校验必需迁移和核心运维表；Tinode/RustPBX 恢复后至少必须存在业务表。

恢复保护变量不得长期放在服务 Deployment 或共享 Secret 中。只应在单次受控恢复任务里注入。

## 4. 配置

主库使用以下两种方式之一：

```bash
export CONVERACT_FABRIC_ADMIN_DATABASE_URL='postgresql://admin:***@db/opc?sslmode=require'
```

或标准 `PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER`、`PGPASSWORD`、`PGSSLMODE`。可选依赖库只接受独立 URL：

```bash
export CONVERACT_FABRIC_TINODE_ADMIN_DATABASE_URL='postgresql://admin:***@db/tinode?sslmode=require'
export CONVERACT_FABRIC_RUSTPBX_ADMIN_DATABASE_URL='postgresql://admin:***@db/rustpbx?sslmode=require'
```

对象存储沿用业务运行时变量：

```bash
export MINIO_ENDPOINT='https://storage.example.com'
export MINIO_BUCKET='converact-production'
export MINIO_ACCESS_KEY='***'
export MINIO_SECRET_KEY='***'
```

也支持 `S3_BUCKET`、`S3_REGION`、`S3_ENDPOINT`、`AWS_ACCESS_KEY_ID` 和 `AWS_SECRET_ACCESS_KEY`。`CONVERACT_FABRIC_BACKUP_OBJECT_PREFIX` 可限制到 Converact Fabric 专属前缀；未设置时备份整个配置桶。

没有 S3/MinIO 桶时，命令读取 `CONVERACT_UPLOAD_DIR`，默认是当前目录下的 `data/uploads`。生产环境必须明确挂载持久目录，源目录不存在会让备份失败，不会静默当作空目录。

## 5. 创建备份

源码工作区：

```bash
CONVERACT_FABRIC_BACKUP_ROOT=/secure/converact-backups npm run converact:backup
```

指定确切目录和可追踪 ID：

```bash
npm run converact:backup -- \
  --output /secure/converact-backups/converact-20260715-a \
  --backup-id converact-20260715-a
```

独立 Compose：

```bash
mkdir -p ./backups
chown 1000:1000 ./backups
docker compose --profile operations run --rm backup
```

Compose 的 `backup` 服务默认不随应用启动，只能通过 `operations` profile 显式执行。其输出目录由 `CONVERACT_FABRIC_BACKUP_HOST_DIR` 挂载到容器 `/backups`。

Helm：

```yaml
backup:
  enabled: true
  schedule: "0 2 * * *"
  persistence:
    existingClaim: converact-backups
```

启用后 Chart 创建 `concurrencyPolicy: Forbid` 的 CronJob。同一时刻不会并行创建两份备份，任务有截止时间、失败重试和历史保留上限。S3 凭据从 `secrets.runtimeEnvironmentSecret` 注入；主库管理员 URL 从 Converact Fabric Secret 的 `admin-database-url` 键注入。

如果生产使用本地对象存储，还必须配置只读对象 PVC：

```yaml
backup:
  localObjectStorage:
    existingClaim: converact-objects
    mountPath: /objects
```

## 6. 只读校验

每份备份完成后和恢复演练前都运行：

```bash
npm run converact:restore -- --backup /secure/converact-backups/<backup-id>
```

正常结果的 `status` 是 `validated`，且 `database_restored=false`、`objects_restored=0`。校验会读取全部对象文件并重新计算哈希，因此耗时与备份集总容量有关。

Compose：

```bash
docker compose --profile operations run --rm \
  --entrypoint node backup \
  dist/converact-restore.js --backup /backups/<backup-id>
```

校验失败时不得手工修改清单“修复”。应重新生成备份或从不可变存储恢复原始字节。

## 7. 恢复到新环境

恢复只允许写入全新、空的数据库和空对象前缀。推荐流程：

1. 创建隔离网络、全新 PostgreSQL 数据库和空对象桶/前缀。
2. 恢复组织密钥管理系统中的 Secret，但先不要启动 Converact Fabric、Tinode、RustPBX 或任何 worker。
3. 给恢复任务注入新目标的主库、Tinode、RustPBX URL 和对象存储凭据。
4. 先运行只读校验。
5. 设置精确确认串并执行恢复。
6. 检查恢复结果的数据库和对象数量。
7. 运行 `/readyz`、迁移核对、IM/媒体/远控/语音受控验收，再开放入口。

执行命令：

```bash
export CONVERACT_FABRIC_RESTORE_CONFIRM='RESTORE:<backup-id>'
export CONVERACT_FABRIC_RESTORE_TARGET_EMPTY=1
npm run converact:restore -- \
  --backup /secure/converact-backups/<backup-id> \
  --execute
```

`CONVERACT_FABRIC_RESTORE_TARGET_EMPTY=1` 只是操作员声明，不能跳过程序对所有目标库的实际空库查询。对象目标中只要有同名键，恢复就会停止，不覆盖现有数据。

恢复过程不是跨 PostgreSQL 和对象存储的分布式事务。若恢复中途失败，应销毁本次新建的隔离目标，修复原因后从空目标重新执行，不要在部分恢复环境上继续重试。

## 8. 恢复后验收

最低自动检查：

- 主库 `schema_migrations` 包含通知、审计、限流、保留、心跳和运行时安全迁移。
- 通知、审计、限流、保留策略、法律保留和心跳核心表存在。
- 依赖数据库恢复后包含业务表。
- 每个恢复对象的备份源字节已在恢复前通过 SHA-256 校验。

人工/环境验收还应包括：

- 用测试租户登录 Tinode，同步历史消息、附件和已读状态。
- 建立 LiveKit 房间并验证录制对象可读取。
- 使用受控 RustDesk 设备验证服务身份密钥、授权和审计链。
- 使用 SIPp 验证 RustPBX 注册、呼叫、IVR、挂断和 CDR 回传。
- 验证审计哈希链和保留 checkpoint；法律保留数据不得缺失。
- 验证通知 Provider 仍引用恢复后的 Secret，测试消息不发往真实客户。

真实 OCR/ASR/翻译供应商效果、双 Windows 物理机和公网媒体质量仍按项目总验收标准标记为 `not_run`，不能用备份恢复演练替代。

## 9. RPO、RTO 与保留建议

- 基线 RPO：每日全量备份不高于 24 小时；生产 IM/呼叫量较大时改为每 6 小时，并结合托管 PostgreSQL PITR 和对象存储版本控制。
- 基线 RTO：由最近一次完整恢复演练测量，不在文档里虚报固定时长。
- 至少保留 7 份日备、4 份周备和 12 份月备；实际值服从数据保留和监管要求。
- 每天自动运行清单校验，每月至少恢复到隔离环境一次，每季度执行包括 Secret、RustDesk 身份和外部依赖的完整演练。
- 备份删除必须由存储生命周期策略执行；应用命令没有批量删除或覆盖功能。

## 10. 常见失败码

| 代码 | 含义 | 处理 |
| --- | --- | --- |
| `database_configuration_invalid` | 主库连接配置缺失或 URL 非 PostgreSQL | 修正管理员连接配置 |
| `local_object_root_missing` | 本地对象卷未挂载 | 恢复挂载后重新备份 |
| `artifact_checksum_mismatch` | 数据库或对象清单损坏 | 从不可变副本恢复或重做备份 |
| `object_checksum_mismatch` | 某个对象内容损坏 | 定位对象源和归档介质，禁止恢复 |
| `restore_confirmation_required` | 精确确认串不匹配 | 核对清单中的 `backup_id` |
| `restore_target_not_empty` | 任一 PostgreSQL 目标已有表 | 换用全新空库，不要强制覆盖 |
| `restore_object_exists` | 对象目标已有同名键 | 换用空桶/空前缀 |
| `restore_dependent_database_configuration_missing` | 清单有 Tinode/RustPBX，但未提供对应恢复 URL | 注入该依赖库的新目标 URL |
| `restore_database_validation_failed` | 主库迁移或核心表不完整 | 销毁目标并检查转储/版本 |

任何恢复失败都应保留任务日志和备份 ID，但日志不得记录数据库 URL、密码或 Provider Secret。
