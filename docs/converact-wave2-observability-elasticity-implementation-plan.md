# Converact Fabric Wave 2 可观测性与弹性实施计划

> 状态：代码与受控服务器验收完成；真实环境门禁待执行
> 范围：OpenTelemetry、KEDA、VictoriaMetrics
> 验证纪律：本机仅编辑与静态检查；动态回归、Helm、容器、故障注入全部在 `64.225.122.227` 执行

## 1. 目标

在不增加 SIP、RTP、LiveKit SFU、Tinode 扇出和 RustDesk 中继热路径开销的前提下，完成：

1. 用 W3C TraceContext 串联 Converact Fabric HTTP、PostgreSQL、NATS、外部 Provider 和异步 worker 边界。
2. 提供 OpenTelemetry Collector gateway，所有 exporter 有界批量、可采样、失败时不阻塞业务。
3. 将通知、Webhook、OCR/ASR、AI 质检、翻译和文件证据处理拆成独立 worker 池。
4. 让 KEDA 根据队列深度与最老任务年龄扩缩离线 worker，而不是只按 CPU 扩缩。
5. 以 VictoriaMetrics single-node 作为少服务器优先的 Prometheus 长期存储；只有实测越过容量门槛才升级为 cluster。
6. 保持 Prometheus 指标为唯一指标权威，OpenTelemetry 不重复定义业务指标，VictoriaMetrics 不改变查询语义。
7. 证明 Collector、VictoriaMetrics 和 KEDA 控制面故障不会中断既有语音、视频、IM 或远控会话。

## 2. 不做事项

- 不对 RTP 包、音视频帧、SFU subscriber、Tinode 单个扇出接收人创建 span。
- 不让 trace export、metrics remote-write 或 autoscaler 查询进入同步通话/媒体决策路径。
- 不在应用 Chart 中安装 KEDA、Prometheus Operator 或 OpenTelemetry Operator 的 CRD/operator。
- 不把 VictoriaMetrics 变成事务、会话、审计或消息权威。
- 不因当前单机验证服务器存在就宣称双 Zone、目标 Kubernetes 或 MIX-100K 已通过。
- 不在本机启动 Docker、Helm 动态渲染、服务进程或集成回归。

## 3. 权威边界

| 领域 | 唯一权威 | 本计划组件的职责 |
| --- | --- | --- |
| 实时会话 | RustPBX、LiveKit、Tinode、RustDesk | 只传播低频控制面上下文；遥测故障不得反向影响会话 |
| 异步任务 | PostgreSQL 队列表、lease token、`FOR UPDATE SKIP LOCKED` | KEDA 只观察 backlog 并调整副本数，不领取或确认任务 |
| 业务指标 | Converact Fabric `prom-client` 与各通信组件原生 Prometheus 指标 | Collector 不复制业务指标模型 |
| 指标存储 | VictoriaMetrics（启用时） | Prometheus-compatible ingest/query，Grafana 与告警继续用 PromQL |
| 分布式追踪 | W3C TraceContext + OpenTelemetry SDK | Collector gateway 批量、过滤、采样并转发至外部 trace backend |
| 扩缩决策 | KEDA ScaledObject | 只管理明确允许的离线 Deployment/StatefulSet |

## 4. OpenTelemetry 方案

### 4.1 应用边界

Node 服务使用 OpenTelemetry Node SDK 的预加载入口，必须先于 HTTP、PostgreSQL 和 NATS 模块加载。默认规则：

- `CONVERACT_OTEL_ENABLED=0` 时零 exporter、零网络连接，并保留原启动命令。
- 开启后使用 OTLP/HTTP 向 Collector gateway 导出 traces。
- 只自动采集 HTTP client/server、PostgreSQL 和 DNS/TCP 等受控库边界；禁用文件系统等高噪声 instrumentation。
- NATS 与 Provider 调用在发布、消费、重试和外部请求边界建立手工 span，并传播 `traceparent`/`tracestate`。
- `BatchSpanProcessor` 队列、批次、导出超时和采样率全部有上下限；队列满时丢弃遥测，不阻塞业务。
- tenant、session、call、message、手机号、文件名和自由文本不得作为指标 label；trace attribute 仅记录经过 allowlist 的低敏标识或哈希。
- API 与 worker 使用不同 `service.name`，并携带 Region/Zone/Cell、版本和实例 ID resource 属性。

### 4.2 Collector gateway

新增 `infra/platform/observability/otel-collector/`：

- 两副本 Deployment、ClusterIP Service、PDB、跨 Zone/hostname topology spread、NetworkPolicy。
- OTLP gRPC/HTTP receiver；`memory_limiter`、低敏 attribute processor、tail/head sampling、batch processor。
- 默认只开启 debug/health/Prometheus 自监控，不内置 Jaeger/Tempo 权威；生产通过 Secret 注入外部 OTLP endpoint。
- exporter 使用有界 sending queue、重试上限和超时；Collector 不可用时应用 exporter fail-open。
- 镜像固定为服务器实际解析过的不可变 digest。

## 5. KEDA 与 worker 池方案

### 5.1 可扩缩池

| 池 | 开启的 worker | backlog 来源 | 是否允许 scale-to-zero |
| --- | --- | --- | --- |
| `notification` | 通知投递与回执收敛 | 通知 delivery 状态 | 否，默认至少 1，避免回执延迟 |
| `event-webhook` | tenant event Webhook | subscription cursor 落后量 | 是 |
| `attachment` | OCR/ASR 附件处理 | attachment processing jobs | 是 |
| `quality` | AI 质检 | quality review jobs | 是 |
| `translation` | 文本/语音翻译后处理 | translation jobs | 是 |
| `file-security` | 病毒扫描、转码、缩略图、清理 | secure file 与 derivative 状态 | 否，默认至少 1 |

每个池使用固定 allowlist 生成环境变量，禁止 values 注入任意 worker 开关。API Pod 对上述开关保持 `0`，避免同一 release 中出现未纳管的第二组消费者。

### 5.2 动态扩缩安全性

现有 notification StatefulSet 依赖“副本数等于分区数”，KEDA 改变副本数会遗漏或重复分片，必须先修复：

- notification 改为无固定分区的 Deployment。
- 所有副本观察全部 1024 逻辑 shard，任务领取仍由 PostgreSQL `FOR UPDATE SKIP LOCKED`、lease token 和完成 fencing 保证。
- 下线时停止新 batch，等待当前 batch 在 `terminationGracePeriodSeconds` 内结束；超时任务由 lease 到期重领。
- 缩容不改变数据分区，不做重新分片，不依赖 Pod ordinal。

### 5.3 backlog 指标

新增一个 `SECURITY DEFINER`、固定 `search_path` 的只读数据库函数，统一返回：

- `pool`
- `depth`
- `oldest_age_seconds`

函数只暴露聚合量，不暴露 tenant、消息正文或凭据；仅授予 `opc_runtime` 执行权限。API 中的低频 backlog observer 定时刷新低基数 Prometheus gauge：

- `opc_ivekit_worker_backlog_depth{pool}`
- `opc_ivekit_worker_backlog_oldest_age_seconds{pool}`
- `opc_ivekit_worker_backlog_observer_up`

KEDA 使用 Prometheus scaler，同时以 depth 和 oldest-age 触发扩容。每个 ScaledObject 必须具备：

- 有界 `minReplicaCount`/`maxReplicaCount`
- `fallback` 副本数
- 快扩慢缩、缩容稳定窗口和 cooldown
- backlog age 告警、max replicas 饱和告警、lease-lost 告警
- 不把 CPU 作为唯一扩缩信号

SIP、RTP、Kamailio、RustPBX、LiveKit Server、TURN、Tinode 和 RustDesk 不使用 backlog KEDA。

## 6. VictoriaMetrics 方案

新增 `infra/platform/observability/victoria-metrics/`，先部署 `vmsingle`：

- 单副本 StatefulSet、RWO PVC、PDB、固定 retention、资源和磁盘预算。
- 仅开放集群内 `8428`，通过 NetworkPolicy 只接受 Prometheus/agent remote-write 与 Grafana/query 客户端。
- 不安装 VictoriaMetrics Operator；现有 ServiceMonitor、PrometheusRule 和 Grafana dashboard 保持有效。
- 推荐现有 Prometheus 负责发现、规则与告警，并 remote-write 到 vmsingle；小型部署也可使用独立 vmagent，但两者不可同时抓取同一目标。
- 备份使用 `vmbackup` 对 storage snapshot 上传到通用 S3；恢复到新 PVC 后再切换 Service。
- remote-write outage 使用 Prometheus 本地 WAL 缓冲；缓冲耗尽时允许丢失历史指标，不得阻塞实时通信。

从 single-node 升级 cluster 的门槛必须来自实测，至少包含：

- 单节点持续 ingest、active series、查询 P99、磁盘增长或恢复时间越过预算；
- 已证明垂直扩容和 retention/cardinality 治理仍不能满足目标；
- cluster 增加的 vmstorage/vminsert/vmselect 节点成本小于容量收益。

## 7. 工作包

### A. backlog 合约与 worker 安全扩缩

- 新增 migration 与数据库合约测试。
- 新增 backlog observer、Prometheus 指标和 worker 生命周期测试。
- notification 从固定 ordinal 分片改为竞争消费者 Deployment。
- 新增固定的六类 worker pool 模板及 values 校验。

### B. KEDA

- 为六类离线 worker 渲染 ScaledObject。
- 复用现有 Prometheus 地址，禁止空地址或无监控时启用。
- 增加 fail-closed Helm 校验、PDB、拓扑、资源和告警。
- 保留 LiveKit Egress 已有的独立 KEDA；不合并媒体 worker 和业务 worker。

### C. OpenTelemetry

- 新增 Node SDK 预加载入口与配置解析测试。
- API/worker Chart 命令在开启时增加 `--import dist/telemetry.js`。
- 新增 Collector gateway 平台清单、配置校验与 outage-isolation acceptance。
- 更新环境变量示例、日志/trace 字段和隐私约束。

### D. VictoriaMetrics

- 新增 vmsingle 平台清单、remote-write Secret 契约、备份/恢复示例。
- 新增 PromQL/remote-write/server-runtime acceptance。
- 固定服务器实际拉取并解析的镜像 digest；纠正未验证版本号。

### E. 治理与证据

- 更新技术基线、组件权威矩阵、Chart README 和部署手册。
- 服务器执行 Node、Helm、Collector、VictoriaMetrics、KEDA 静态 CRD 合约与故障隔离测试。
- 证据严格区分 `passed_controlled_server`、`not_run_target_kubernetes`、`not_run_cross_zone` 和 `not_run_capacity`。

## 8. 服务器验收

所有动态命令通过：

```bash
ssh -i /Users/songjinfeng/.ssh/led_rsa_songjinfeng \
  -o IdentitiesOnly=yes root@64.225.122.227
```

服务器源码目录为 `/opt/converact-wave123-validation-20260722/source`，Node 为 `/opt/converact-wave123-validation-20260722/cache/toolchain/bin/node`，Helm 使用缓存镜像 `alpine/helm:3.18.4` 并显式覆盖 entrypoint。

验收矩阵：

1. migration、backlog observer、worker 竞争领取、停止与 lease 恢复测试。
2. Helm 默认不渲染可选组件；开启时资源、Secret、地址或 CRD 前置缺失必须 fail-closed。
3. 六类 worker 的 KEDA target、query、min/max/fallback、cooldown 与 PDB 合约。
4. Collector 接收 W3C trace、批量导出、敏感属性过滤、队列上限和进程停止恢复。
5. 停止 Collector 时 API/worker 探针继续成功，恢复后新 trace 可导出。
6. VictoriaMetrics remote-write、PromQL 查询、retention 配置、快照/恢复脚手架。
7. 停止 VictoriaMetrics 时实时探针继续成功，Prometheus/WAL 路径产生明确可观测告警。
8. 每轮前后 LED 运行容器必须仍恰好为约定的七个容器，并清理所有测试资源。

## 9. 完成定义

代码完成要求：

- 所有新增合约与受影响回归在服务器通过，TypeScript 编译通过。
- OTel exporter 和 Collector 故障不会使业务启动失败或同步请求失败。
- notification 动态扩缩不再依赖固定 ordinal 分片。
- KEDA 只管理离线 worker，且 backlog age 与 depth 均可观测。
- VictoriaMetrics 使用已验证版本和不可变镜像，Prometheus 仍是指标定义与告警规则入口。
- 文档不把单机受控验证写成 Kubernetes、双 Zone、吞吐或 MIX-100K 证据。

生产完成仍需要目标 Kubernetes 的 operator/CRD 版本验证、双 Zone 调度、真实 worker backlog、Collector/metrics 节点故障、长期 retention、备份恢复、吞吐与成本测试；这些项目在真实环境执行前保持 `not_run`。

## 10. 实施结果（2026-07-23）

| 工作包 | 结果 | 受控服务器证据 | 仍为 `not_run` |
| --- | --- | --- | --- |
| Backlog 与 worker 池 | `implemented` | migration 096、六类低基数 backlog depth/age、notification 竞争消费者 Deployment、六类独立 worker Deployment/PDB | 真实生产 backlog、毒消息、长稳与目标集群 drain |
| KEDA | `implemented_not_deployed` | 六类 ScaledObject 的 depth/age 双触发、min/max/fallback、快扩慢缩、Profile 与地址 fail-closed；Helm v3.18.4 渲染及负向门禁通过 | 目标 KEDA 2.20.1、CRD/operator、真实扩缩与节点故障 |
| OpenTelemetry | `passed_controlled_server` | Node trace-only SDK、HTTP/PG/Undici、NATS TraceContext、Collector 0.153.0；正常投递、Collector outage fail-open 和恢复投递通过，见 `docs/evidence/wave2-opentelemetry-runtime-2026-07-22.json` | 真实 trace backend、目标 Kubernetes、双 Zone、真实通信会话故障注入与 trace 容量 |
| VictoriaMetrics | `passed_controlled_server` | v1.148.0 vmsingle、Prometheus v3.12.0 remote-write/WAL、停库补发、社区版 vmbackup/vmrestore 清盘恢复、非 root/只读根文件系统通过，见 `docs/evidence/wave2-victoria-metrics-runtime-2026-07-22.json` | 生产 S3、目标 StorageClass/Kubernetes、双 Zone、长期 retention、容量和成本曲线 |

Prometheus 继续是唯一指标定义、抓取、规则和告警权威；VictoriaMetrics 不依赖 OpenTelemetry。两项运行时验收前后 LED 服务始终恰好为约定的七个容器，验收资源已全部清理。以上结果不产生 Cell-10K 或 MIX-100K 容量结论。
