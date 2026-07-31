# Kamailio 与 HOMER 11 HEPv3 接入

## 1. 目标与边界

iveKit 使用 Kamailio `siptrace` 把 SIP 信令副本发送给 HOMER 11 或兼容的 HEPv3 collector，用于按 Call-ID 还原事务、对话、失败分支和节点路径。

这条链路是纯观测旁路：

- 不参与路由、鉴权、容量准入或健康就绪；
- 不在 Kamailio worker 内写 trace 数据库；
- collector 不可用时允许追踪丢失，不能影响呼叫；
- 默认关闭；即使已完成受控同硬件 A/B，也必须按 Cell 容量预算显式开启；
- 当前仅支持私有可信网络内的 HEPv3/UDP，不允许跨公网直连。

HOMER 固定在 `11.0.297`、commit `ac4e1ae7f63660a655a5ef42e6607ab4cefc1c6b`。iveKit overlay 为 DuckLake 增加 PostgreSQL catalog，并生成非 root、自带离线 DuckDB 扩展的镜像。部署时必须使用验证过的自定义镜像 digest，不能使用上游浮动 tag，也不能把未包含 overlay 的上游镜像当作等价制品。

## 2. 已实现的发送端

启用后，生成的 Kamailio 配置具有以下固定语义：

- `hep_mode_on=1`、`hep_version=3`；
- `trace_init_mode=1`、`trace_mode=1`，使用 core callback 镜像；
- `trace_to_database=0`，不配置 `db_url`；
- `data_mode=1`，优先记录 advertised address；
- 默认不采集 OPTIONS，始终不采集内部 KDMQ；
- route-agent 通过 loopback authenticated JSON-RPC 动态写入 HEP mode、采样 bucket 和 revision；
- `full` 记录全部合格 Call-ID，`sampled` 按确定性 Call-ID hash 记录完整会话，`off` 不发送 HEP；
- 状态下降立即生效，恢复按连续健康样本逐级执行 `off -> sampled -> full`；
- collector 不进入 Pod readiness、liveness 或 route-agent admission。

HEPv3/UDP 发送链路没有应用层认证和 TLS；确定性采样只能控制负载，不能提供传输安全。生产部署
必须把 collector 放在同一受控 Cell/Zone 网络，并使用 NetworkPolicy 精确限制 namespace、Pod
标签或外部目标 CIDR。需要跨不可信网络时，应先在 Cell 内落一个可信 HEP relay，再由 relay
通过加密链路转发。

## 3. HOMER PostgreSQL 部署

HOMER 使用独立 Chart `infra/ivekit/homer/helm/ivekit-homer`，不进入 iveKit API Chart 的 readiness，也不和 Kamailio/RustPBX 共用进程。固定约束如下：

- `homer.catalogType` 只能是 `postgres`，Chart 不接受 SQLite；
- `replicaCount=1`、`homer.storage.shardCount=1`，一个 Cell 对应一个 release、一个 writer、一个 PostgreSQL catalog 和一组 Parquet 数据；
- 横向扩展通过增加独立 Cell collector，不让两个 writer 共享 catalog；
- PostgreSQL DSN、node token、JWT secret 和管理员密码哈希只从既有 Secret 注入；
- HEP Service 是私有 `ClusterIP`，HTTP、Flight 和 metrics 只在集群内暴露；
- 当前数据文件落在 Cell 本地持久卷，HOMER 对象存储分层尚未验收，不得把它写成已完成能力。

生产 values 示例：

```yaml
image:
  repository: registry.example.com/ivekit/homer
  digest: sha256:<64-hex-digest>

secrets:
  existingSecret: homer-cell-a

networkPolicy:
  enabled: true
  kamailioNamespaceSelector:
    matchLabels:
      kubernetes.io/metadata.name: communication-cell-a
  kamailioPodSelector:
    matchLabels:
      app.kubernetes.io/component: kamailio
  postgresEgressCidrs:
    - 10.42.30.15/32
```

Secret 至少包含 `homer-ducklake-postgres-dsn`、`homer-node-token`、`homer-jwt-secret` 和 `homer-admin-password-hash`。PostgreSQL DSN 不得出现在 values、命令行参数、日志或证据包中。启用 NetworkPolicy 时，PostgreSQL CIDR 必须是最窄地址范围，`0.0.0.0/0` 与 `::/0` 会被 Chart 拒绝。

## 4. Kamailio Helm 配置

```yaml
voice:
  kamailio:
    sipTrace:
      enabled: true
      collectorHost: cell-a-homer-hep.observability.svc.cluster.local
      collectorPort: 9060
      metricsPort: 9090
      captureId: 101
      includeOptions: false
      highWater:
        enabled: true
        pollIntervalMs: 1000
        metricsTimeoutMs: 1000
        samplePercent: 10
        queueRecoverRatio: 0.2
        queueSampleRatio: 0.5
        queueOffRatio: 0.8
        cpuRecoverCores: 0.3
        cpuSampleCores: 0.7
        cpuOffCores: 1.5
        packetsRecoverPerSecond: 2000
        packetsSamplePerSecond: 5000
        packetsOffPerSecond: 10000
        processingGapRecoverPerSecond: 25
        processingGapSamplePerSecond: 250
        processingGapOffPerSecond: 1000
        failureSamplesToOff: 3
        recoverySamples: 5
    networkPolicy:
      enabled: true
      hepCollectorNamespaceSelector:
        kubernetes.io/metadata.name: observability
      hepCollectorPodSelector:
        app.kubernetes.io/component: homer
      hepCollectorCidrs: []
```

Kubernetes 内置 HOMER 应使用 namespace 与 Pod selector，不依赖动态 Pod IP。`hepCollectorCidrs`
仅用于外部 collector，必须是最窄 Pod/节点地址范围，禁止 `0.0.0.0/0` 或 `::/0`。SIP trace
开启且 NetworkPolicy 打开时，Chart 要求至少配置完整 selector 或窄 CIDR，并同时只允许
collector 的 HEP UDP 端口和 metrics TCP 端口。

三组阈值均强制满足 `recover < sample < off`。queue 使用 `0..1` 比例，CPU 使用进程占用的
CPU core 数，packet rate 使用 HEP receive rate，processing gap 使用 receive rate 与 processed
rate 的正差。任一维度到达更严重阈值立即降级；只有所有维度连续健康达到 `recoverySamples`
才逐级恢复。HOMER metrics 连续抓取失败时先进入 sampled，达到 `failureSamplesToOff` 后进入
off；控制器自身故障不改变 route-agent readiness。

## 5. Compose 配置

```dotenv
OPC_IVEKIT_KAMAILIO_SIP_TRACE_ENABLED=true
OPC_IVEKIT_KAMAILIO_HEP_COLLECTOR_HOST=homer-capture
OPC_IVEKIT_KAMAILIO_HEP_COLLECTOR_PORT=9060
OPC_IVEKIT_KAMAILIO_HEP_CAPTURE_ID=101
OPC_IVEKIT_KAMAILIO_HEP_INCLUDE_OPTIONS=false
OPC_IVEKIT_KAMAILIO_HEP_HIGH_WATER_ENABLED=true
OPC_IVEKIT_KAMAILIO_HOMER_METRICS_ENDPOINT=http://homer-capture:9090/metrics
OPC_IVEKIT_KAMAILIO_HEP_HIGH_WATER_SAMPLE_PERCENT=10
```

Compose 只用于单 Cell 发送端集成验证，不是当前 HOMER PostgreSQL 生产部署面。生产 HOMER 使用独立 Chart、持久卷、保留策略、备份、访问控制和容量预算。

## 6. 数据治理

SIP 报文可能包含电话号码、显示名、URI、设备地址、Authorization 元数据和自定义业务头。启用前必须确定：

1. 哪些租户允许采集以及合法依据；
2. 原始信令和导出文件的保留时间；
3. HOMER UI/API 的最小权限和审计；
4. 号码、身份和 IP 的展示脱敏规则；
5. PCAP/Call Flow 导出的审批、加密和到期删除；
6. 对象存储、目录和备份中的同等删除策略。

不要把 HOMER 当作业务主库或长期审计主库。它是可丢失、有限保留的诊断数据面。

## 7. 上线门槛

### 7.1 已完成的受控服务器证据

2026-07-24 的隔离 Linux 服务器验证已完成：

1. 精确上游 tag/commit 接受 overlay，PostgreSQL catalog Go 测试和 Go 1.26.5 编译通过；
2. Linux amd64 候选镜像身份、非 root、只读根和 `/tmp` PID 合同通过；
3. PostgreSQL DuckLake catalog attach 通过，运行镜像不含 SQLite CLI、`sqlite_scanner`、Node 或 npm；
4. 受控 Kamailio 镜像成功加载 `siptrace.so` 并向 HEPv3/UDP collector 发送记录；
5. 完整 INVITE、100、180、200、ACK、BYE、200 流程在 HOMER 中按 Call-ID 还原；
6. `include_options=false` 时，OPTIONS 与 KDMQ 的检索结果均为零；
7. HOMER 停止期间 5/5 PCMU 通话成功，PostgreSQL 停止期间 3/3 成功；
8. PostgreSQL 恢复后无需重启 HOMER，新呼叫成功写入并检索。

机器证据和边界见
`docs/evidence/wave1-homer-postgres-hep-server-validation-2026-07-24.json` 与
`docs/evidence/wave1-homer-postgres-hep-server-validation-2026-07-24.md`。

### 7.2 仍阻断生产放行的门槛

以下项目保持 `not_run`：

1. 自定义镜像的多架构 Registry manifest、不可变 digest、最终漏洞结果、SBOM、Cosign 和 provenance；
2. 生产数据量的长期磁盘增长、retention/compaction 吞吐和导出审计；
3. collector/HEP 主动丢包、持续限速和多小时过载恢复；
4. 目标 Kubernetes install/upgrade/rollback、NetworkPolicy 运行态、双 Zone、节点丢失和 PostgreSQL 主备；
5. 独立 generator/SUT、长稳、Cell-10K 和 MIX-100K。

发布门禁定义见 `docs/deployment/oci-image-release-gate.md`。当前候选镜像仍为
`production_eligible=false`；目标集群默认值应继续保持 `sipTrace.enabled=false`，只有完成容量
预算和数据治理审批的 Cell 才能显式打开。

受控同机 HEP A/B、retention/compaction 和动态 high-water 证据分别见：

- `docs/evidence/wave1-homer-hep-ab-server-validation-2026-07-25.md`；
- `docs/evidence/wave1-homer-retention-compaction-server-validation-2026-07-25.md`；
- `docs/evidence/wave1-homer-hep-high-water-server-validation-2026-07-25.md`。
