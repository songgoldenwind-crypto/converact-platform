# Converact Fabric Voice CDR 跨 Zone 耐久性运行手册

## 1. 范围与权威

本手册管理 `ivekit_voice_cdr_durability_contracts`。该表不是数据库集群的自动发现结果，
而是运维人员在验证 Region 内跨 Zone 同步提交后登记的放行合同。

以下不变量不可放宽：

1. `committed` 只表示 CDR 已进入同一 Region、至少两个不同 Zone 的同步 quorum。
2. RustPBX 本地 fsync spool 只能保存 `pending_unacknowledged`，不构成计费提交。
3. `CONVERACT_FABRIC_CDR_REGION_ID` 必须等于当前 API 实例所在 Region。未配置时严格保持
   `pending_unacknowledged`。
4. 新 sequence 只使用当前 Region 的 active contract；历史 sequence 的精确重放继续返回
   原 contract 和原 receipt。
5. `ivekit_voice_cdr_submissions` 和 `ivekit_voice_cdr_receipts` 是 append-only journal。
   运行角色只有 `SELECT, INSERT`，不允许更新或删除历史 payload hash 或 receipt。
6. PostgreSQL、CDR API 或 receipt journal 故障不得进入 SIP/RTP packet path，也不得中断
   已建立媒体。
7. `VOICE-HA-T1` 的未 journal 化提交必须匹配当前 Cell、RustPBX node 和
   `owner_epoch`，且不得存在 pending takeover 或 terminal ownership。接管前已写入
   append-only submission journal 的精确 sequence/hash 可以继续取得或完成 receipt，
   但旧 owner 不能提交任何新 payload。
8. caller/callee 的 SIP code、hangup cause、时间与 media result 必须独立产生，禁止
   用一条腿的终态填充另一条腿。
9. RustPBX CDR spool 必须位于节点持久卷。当前和旧版 Helm 入口都拒绝关闭
   `voice.persistence.enabled`，不得使用 Pod 临时文件系统承载未确认 CDR。
10. `VOICE-HA-T1` 清理必须先提交双腿 `terminating` shadow。该状态只能执行终态收敛，
    禁止恢复 SIP dialog、RTPengine session 或媒体控制器。Region receipt 必须严格匹配
    RustPBX 配置的 `CONVERACT_FABRIC_RUSTPBX_CDR_REGION_ID`。

### 1.1 非空事件表的迁移预检

迁移 103 需要 `(tenant_id, id)` 复合唯一约束来保证计费事件的租户级外键。非空的
`ivekit_tenant_events` 不允许在事务迁移中同步构建该索引。标准迁移 runner 会在
迁移事务之外检查索引的唯一性、有效/ready 状态、谓词、表达式、键数量和精确键顺序：

- 索引不存在时执行 `CREATE UNIQUE INDEX CONCURRENTLY`；
- 同名索引元数据不符合合同时，先 `DROP INDEX CONCURRENTLY` 再重建；
- 已挂载同名唯一约束时不做任何修改；
- 数据重复、索引被其他约束占用或并发构建失败时 fail closed，不进入迁移事务。

需要人工预建时可执行：

```sql
CREATE UNIQUE INDEX CONCURRENTLY uq_ivekit_tenant_events_tenant_id
  ON public.ivekit_tenant_events(tenant_id, id);
```

迁移 SQL 会再次验证精确索引元数据，然后只把该索引挂载为同名唯一约束。不要绕过
标准 runner、删除二次校验或改为事务内同步创建索引。

### 1.2 部署身份与传输

启用 voice 的 API 必须显式配置 `CONVERACT_FABRIC_CDR_REGION_ID`。这个身份独立于 placement
home Region，不能从 placement 开关或故障转移配置隐式推导。Compose 中 RustPBX 默认
`RUSTPBX_ENV=production`，并要求部署者提供无凭据的 HTTPS
`RUSTPBX_CDR_ENDPOINT`；该 Region 同时注入 RustPBX 的
`CONVERACT_FABRIC_RUSTPBX_CDR_REGION_ID`，服务密钥只通过
`RUSTPBX_CDR_SERVICE_KEY_FILE` 挂载。
非回环 HTTP 仅限明确的开发测试，不能作为生产 Compose 的默认路径。

## 2. 激活前证据

激活 contract 前必须保存以下同一次变更窗口证据：

- Region、Zone、PostgreSQL/CloudNativePG 集群和实例身份；
- 主库 `synchronous_commit`、`synchronous_standby_names`；
- 至少两个不同 Zone 的同步副本处于 `sync` 或设计批准的 quorum 状态；
- 主备 timeline、LSN 和复制延迟；
- 故障切换演练或本次配置对应的既有有效演练；
- 配置、拓扑和证据清单的 canonical SHA-256。

PostgreSQL 检查：

```sql
SHOW synchronous_commit;
SHOW synchronous_standby_names;

SELECT application_name,
       client_addr,
       state,
       sync_state,
       write_lsn,
       flush_lsn,
       replay_lsn
FROM pg_stat_replication
ORDER BY application_name;
```

CloudNativePG 还必须归档目标 Cluster、instances、synchronous replicas、Pod Zone 和
`kubectl cnpg status --verbose` 输出。只有 Pod 数量而没有同步复制状态不构成证据。

## 3. 激活 Region Contract

`contract_id` 必须是不可复用的发布身份；`fault_domains_csv` 中 Zone 必须去重。配置 hash
必须来自已归档的 canonical evidence，不得手工填写占位值。

```bash
psql "$ADMIN_DATABASE_URL" \
  -v contract_id="cdr-region-a-20260727-01" \
  -v region_id="region-a" \
  -v store_kind="cloudnativepg" \
  -v fault_domains_csv="zone-a,zone-b,zone-c" \
  -v quorum_size="2" \
  -v config_hash="<64-lowercase-hex>" <<'SQL'
BEGIN;
SELECT pg_advisory_xact_lock(
  hashtextextended('converact:voice-cdr-durability:' || :'region_id', 0)
);

UPDATE ivekit_voice_cdr_durability_contracts
SET status = 'disabled',
    updated_at = CURRENT_TIMESTAMP
WHERE region_id = :'region_id'
  AND status = 'active';

INSERT INTO ivekit_voice_cdr_durability_contracts
  (id, region_id, store_kind, fault_domains, quorum_size, status,
   config_hash, verified_at, updated_at)
VALUES
  (:'contract_id',
   :'region_id',
   :'store_kind',
   string_to_array(:'fault_domains_csv', ','),
   :'quorum_size'::smallint,
   'active',
   :'config_hash',
   CURRENT_TIMESTAMP,
   CURRENT_TIMESTAMP);
COMMIT;
SQL
```

事务失败时旧 active contract 保持不变。禁止用 `ON CONFLICT DO UPDATE` 改写历史 contract。

激活后核对：

```sql
SELECT id, region_id, store_kind, fault_domains, quorum_size, status,
       config_hash, verified_at
FROM ivekit_voice_cdr_durability_contracts
WHERE region_id = 'region-a'
ORDER BY verified_at DESC;
```

## 4. Quorum 丢失

检测到同步 quorum 不再覆盖至少两个 Zone 时，立即将 contract 标记为
`unavailable`：

```sql
BEGIN;
SELECT pg_advisory_xact_lock(
  hashtextextended('converact:voice-cdr-durability:region-a', 0)
);
UPDATE ivekit_voice_cdr_durability_contracts
SET status = 'unavailable',
    updated_at = CURRENT_TIMESTAMP
WHERE region_id = 'region-a'
  AND status = 'active';
COMMIT;
```

预期行为：

- 新 CDR 返回 HTTP `202` 和 `pending_unacknowledged`；
- RustPBX 保留本地 spool 文件并继续有界重试；
- 已建立 SIP/RTP 不等待 PostgreSQL、对象存储或 CDR API；
- 不生成新的 durable receipt，不重复生成 billing event；
- 精确重放既有 committed sequence 仍返回原 receipt。

恢复后必须重新采集证据并创建新的 contract ID。不得直接把旧 contract 从
`unavailable` 改回 `active`。

## 5. 监控与排障

每个 Region 至少监控：

```sql
SELECT region_id, count(*) AS active_contracts
FROM ivekit_voice_cdr_durability_contracts
WHERE status = 'active'
GROUP BY region_id;

SELECT tenant_id,
       count(*) AS pending_count,
       EXTRACT(EPOCH FROM CURRENT_TIMESTAMP - min(updated_at)) AS oldest_pending_seconds
FROM ivekit_voice_cdr_calls
WHERE state = 'pending_unacknowledged'
GROUP BY tenant_id
ORDER BY oldest_pending_seconds DESC;

SELECT tenant_id, call_id, acknowledged_sequence, committed_sequence,
       receipt_id, durability_contract_id, region_id, committed_at
FROM ivekit_voice_cdr_receipts
WHERE call_id = '<call-id>'
ORDER BY acknowledged_sequence;

SELECT tenant_id, cell_id, call_session_ref, owner_node_id, owner_epoch,
       terminal_cdr_sequence, terminal_cdr_payload_hash, updated_at
FROM ivekit_voice_dialog_ownership
WHERE terminal_shadow_pending = TRUE
ORDER BY updated_at;
```

必须告警：

- 生产 Region active contract 数量不是 1；
- `oldest_pending_seconds` 超过恢复目标；
- RustPBX CDR spool 文件数、字节数或最老文件年龄持续增长；
- receipt INSERT、CDR webhook 鉴权或 PostgreSQL事务失败；
- API CDR Region 缺失、没有唯一 active contract，或 receipt 返回了其他 Region。
- `result="quarantined"` 增长或 `quarantine/` 存在未处置记录。
- `terminal_shadow_pending` 超过终态 shadow 修复目标。

禁止在日志、告警或证据中保存号码、SDP、Authorization header、service key 或数据库
凭据。

## 6. Spool 与隔离记录处置

RustPBX 的专用落盘线程使用 4096 条硬上限队列；只有在文件 fsync、原子 rename 和目录
fsync 完成后才确认终态写入。进程启动时必须先初始化并验证 writer，才允许 readiness
放行。队列饱和时只把 admission 标记为 unhealthy，使后续新呼叫 fail closed；它不把
已经可用的 spool 错报为故障，也不取消既有通话的终态写入。当前终态等待同一个 Tokio
MPSC writer 的有界容量和 oneshot durability ACK；等待发生在 Future 上，不占用
OS/Tokio worker 线程，也不生成无上限的并发同步 fsync。writer 对失败批次不发送成功
ACK、不丢弃请求，而是保留原 canonical 请求并以最长 1 秒的有界退避持续重试；writer
通道断开时才进入全局异步互斥、单 blocking task 的 emergency writer，同样保留请求
直到完成原子落盘。writer 再次确认耐久后恢复 admission；已建立媒体和 RTP 转发不受
影响。

T1 cleanup 的强制顺序是：

1. 先把两腿 `confirmed/updating` shadow 以同一 quorum 提交为 `terminating`；
2. 把精确 sequence/hash 写入节点持久卷，完成文件和目录 fsync；
3. 在固定 64 个 Region commit slot 内取得配置 Region 的跨 Zone `committed` receipt；
4. 同一 PostgreSQL 事务将 owner 标记为 `terminal`，写入
   `terminal_cdr_sequence`、`terminal_cdr_payload_hash` 并设置
   `terminal_shadow_pending=TRUE`；
5. 提交双腿 `terminated` shadow；服务端观察到该 terminal pair 后清除 pending repair。

Region 未提交时 shadow 保持 `terminating`，更高 epoch owner 只能进入 `finalize`：
提交新 owner 的 `terminating` pair、消费 takeover、以更高 epoch 收敛 CDR 和 terminal
shadow，不恢复 SIP dialog、RTPengine session 或媒体控制器。Region 已提交但 terminal
shadow 暂时失败时，数据库终态围栏立即拒绝任何 takeover；pending repair 保留为可监控
证据。恢复 finalizer 以有界退避重试 receipt 和 terminal shadow，成功后关闭本地 owner。

普通 profile 不依赖 shadow，也不等待 Region receipt；其成功边界是本地 durable spool。
因此“唯一 spool 丢失 + 进程被强杀/OOM/驱逐”仍是未保护双故障，不能将进程内 retry
解释成跨重启持久化。要求该组合下零丢失时必须使用 `VOICE-HA-T1`。Task 11 未完成真实
强杀恢复前，相关状态保持 `not_run`。Drop 中的后台上报只是不设置成功标志的尽力兜底，
不属于 T1 或普通 profile 的耐久提交证据。

上传器使用跨轮次持久的有界目录游标，每轮最多扫描并保留 4096 个目录项，并发上传最多
64 条。T1 精确提交也使用独立的 64-slot semaphore，不持有跨网络请求的全局锁；slot
耗尽只拒绝新的 T1 admission，不影响 ordinary profile 或既有 RTP。T1 记录先以
`.t1pending` 独占文件落盘，精确提交失败或进程重启时原子释放为 `.json` 供后台重放，
因此精确提交与后台扫描不会竞争同一文件。backlog gauge 表示最近完整扫描周期的计数与当前部分周期计数的较大值，不是每轮
重新全目录枚举得到的瞬时精确值；持续多个扫描周期观察增长趋势。service key 读取、
目录扫描、记录读取/哈希、sidecar 更新、隔离和删除都通过 blocking worker 执行，不占用
异步上传 executor。
每条记录的重试次数和下一次时间保存在独立 sidecar 中，进程重启后仍保持独立退避。
`202 pending`、`401`、`403`、`404`、`408`、`425`、`429` 和 `5xx` 保留原文件并执行
最长 60 秒的指数退避加抖动；其他永久 HTTP 协议错误进入同一文件系统的
`quarantine/`。单条延迟或隔离记录不得阻塞其余 CDR。上传器每轮重新读取 service key，
Kubernetes projected Secret 可原子轮换而无需重启 RustPBX。

处置步骤：

1. 根据 sequence、payload hash、HTTP status 和 RustPBX node 定位记录，禁止把 service
   key 或完整请求正文复制到工单。
2. 区分服务端 schema 回归、已修复的临时兼容问题与不可恢复的 payload 冲突。`409`
   payload hash 冲突不得通过修改文件或数据库强行重放。
3. 只有确认原 canonical 文件仍然有效且接收端缺陷已经修复后，才可在同一节点维护窗口
   将原文件移回 spool 根目录，并保持目录 `0700`、文件 `0600`。
4. 移回后必须确认 exact sequence/hash 获得原 receipt 或新的合法 receipt，billing event
   没有重复，然后关闭告警。
5. 禁止编辑 quarantined JSON、重算 hash、删除 submission/receipt journal，或把隔离文件
   复制到另一 owner node 冒充提交。

## 7. 验收与回滚

变更完成必须验证：

1. 双腿 CDR 获得 `200 committed`，receipt Region 和 contract ID 精确匹配。
2. 同一 payload 重放返回原 receipt，billing event 数不增加。
3. 更高 sequence 生成新 receipt，旧 receipt 行仍存在。
4. 禁用 contract 后新 CDR 返回 `202 pending_unacknowledged`。
5. 恢复新 contract 后 pending spool 重放为 committed。
6. CDR API/PostgreSQL 故障期间真实 RTP sequence continuity 不受影响。
7. owner takeover 后旧腿可以参与投影恢复，已 journal 化的精确旧 payload 可以取得
   receipt，旧 owner 的新提交返回 `409`。
8. 永久失败记录进入 `quarantine/`，后续健康记录仍可提交；重启不会删除当前进程正在
   写入的临时文件。

回滚只能禁用新 contract 并在重新验证后创建另一个 contract。禁止删除 contract、
`ivekit_voice_cdr_receipts` 或已提交 billing event。
