# LiveKit Egress Cell-10K 生产化实施计划

> 状态：受控代码实施完成；真实 Egress、对象存储与物理容量验收 `not_run`
> 日期：2026-07-17
> 负载合同：[`cell-10k-v1.json`](profiles/cell-10k-v1.json)

## 1. 边界

本计划不重新实现 IM、音视频、通知或既有录制功能。现有 API、业务录制记录、保留策略、
对象导出和 Webhook 生命周期保持兼容，只补齐影响 Cell-10K 单机密度及 MIX-100K 横向
扩展效率的 Egress 执行层。

目标是：

1. 让直接轨道落盘、双轨合成和房间混流使用与真实成本一致的执行模式。
2. 将 LiveKit SFU 房间容量与 Egress 编码容量分开准入、扩容、故障隔离和观测。
3. 一个业务录制可绑定多个 provider job，不再把多个 Egress ID 拼进单字段。
4. 录制请求、provider job、对象产物和最终 manifest 可重放、可对账、可审计。
5. 保留旧调用默认 `room_composite`，新调用显式选择模式，避免 LED/OPC 现有集成回归。

## 2. 容量模型

Cell-10K 预算包含 860 个 TrackEgress job 和最多 10 个 RoomComposite job。两者不能用
一个并发数表示：TrackEgress 主要消耗解封装、落盘和对象存储吞吐，RoomComposite 还包含
Chrome、布局渲染和重新编码。

独立维度：

```text
livekit_egress_track_slots
livekit_egress_track_composite_slots
livekit_egress_room_composite_slots
livekit_egress_output_mbps
livekit_egress_spool_bytes
livekit_egress_upload_bytes_per_second
```

`safe_capacity` 必须来自相同镜像、codec、分辨率、对象存储和故障注入条件下的实测 profile。
代码不得把 Cell-10K 目标数写成已通过容量。

## 3. 数据模型

`call_recordings` 继续表示对外业务录制，并保留 `egress_id` 作为单 job/主 job 兼容字段。
新增 `livekit_egress_jobs` 表表示实际 provider 执行：

```text
call_recordings 1 --- N livekit_egress_jobs
```

每个 job 独立保存模式、track selector、对象地址、provider egress ID、状态、失败码、
准入 reservation 和时间戳。TrackEgress 的每条轨道产生一个 job；TrackComposite 和
RoomComposite 各产生一个 job。停止、Webhook 和对账按 job 幂等执行，父记录状态由所有
子 job 汇总，不允许单个成功覆盖其他失败。

## 4. API 兼容

新增可选输入：

```json
{
  "recording_mode": "track | track_composite | room_composite",
  "tracks": [
    { "track_id": "TR_x", "kind": "audio", "source": "microphone" }
  ],
  "audio_track_id": "TR_audio",
  "video_track_id": "TR_video"
}
```

规则：

- 未传 `recording_mode`：保持旧行为，使用 `room_composite`。
- `track`：必须提供非空、去重的 `tracks`；每条轨道直接落独立对象。
- `track_composite`：至少提供 audio/video 之一；同步合成单对象。
- `room_composite`：不得携带 track selector。
- 对外增加按 recording ID 查询 job 列表；旧字段不删除、不改变含义。

## 5. 运行与部署

以 LiveKit Egress v1.13.0 的 Redis worker discovery、CPU cost 和 Prometheus 能力为基线，
强制应用 `livekit-egress-capacity-v1` overlay。Kubernetes 将 Track 与 Composite 设为独立
StatefulSet、PDB、反亲和和扩缩容边界；各 pool 在上游 CPU/内存准入前通过源码级 allowlist
和并发槽硬拒绝不属于自身的 job。上游原始 `livekit/egress` 镜像不识别 iveKit 环境变量，
不得作为双池生产镜像。

生产模板必须具备：

- Track 与 Composite 独立副本、资源、node selector、toleration 和 topology spread。
- `prometheus_port`、健康探针、PDB、优雅终止和 session duration 上限。
- `backup_storage` 使用有容量上限和告警的持久 NVMe；不能使用容器临时层冒充 spool。
- HPA/KEDA 只根据真实 pending、CPU、内存、spool 和上传吞吐扩容，不以 Pod CPU 单指标
  代替 Egress job admission。
- 双 Zone 反亲和；一个 Zone 或一个 pool 失效不得拖垮 SFU 房间和另一 Egress pool。

## 6. 实施顺序

1. API 模式校验、job 领域模型与兼容读取。
2. PostgreSQL migration、租户隔离、唯一约束和父子状态汇总。
3. Track、TrackComposite、RoomComposite provider 调用及启动失败补偿。
4. 多 job 停止、Webhook 对账、超时恢复和 orphan reconciliation。
5. 独立 Egress admission reservation、指标与过载拒绝。
6. Kubernetes 双 pool、PDB、反亲和、spool、Prometheus 与扩缩容模板。
7. SDK、OpenAPI、部署、容量状态与交接文档。

## 7. 验收门槛

本机可完成：

- 模式/selector/幂等/补偿/父子状态的自动化测试。
- migration checksum、RLS、Helm 静态合同、TypeScript 和 Compose 检查。
- 上游 Egress patch 或 adapter 的固定版本、可重复 apply/build 合同。

真实环境保持 `not_run`，直到具备 LiveKit、Redis、Egress、TURN、生产对象存储及压测节点：

- Track 与 Composite pool 确实不串用。
- 单 worker `C_hard`、`C_safe` 与最少服务器数量。
- 860 Track + 10 RoomComposite 的 Cell-10K steady/burst/fault/endurance。
- 对象存储中断 30 分钟的 spool、恢复上传、校验和与 manifest 完整性。
- 1/2/4/8 节点扩展效率以及双 Zone 故障隔离。

任何本地 mock、模板渲染或目标预算都不能把上述项目标记为通过。

## 8. 当前实现状态

已完成的受控代码能力：

- `track`、`track_composite`、`room_composite` 输入校验及对应 provider API 调用。
- `call_recordings 1:N livekit_egress_jobs`，含 provider 状态、selector、对象状态和删除断点。
- 多 job 启动失败补偿、全部停止、Webhook 幂等汇总和父录制终态约束。
- 子 job 鉴权检查/导出 API 与 SDK；公开 DTO 不返回对象存储地址。
- 多对象 retention 删除，部分失败重试只处理未删除对象。
- Track/Composite 独立 StatefulSet、PDB、持久 spool、资源和拓扑配置。
- 固定 `livekit/egress` v1.13.0 提交的 iveKit overlay；worker 在上游 CPU/内存准入前
  按 `IVEKIT_EGRESS_ALLOWED_REQUEST_TYPES` 硬拒绝跨池请求。
- 每个 Egress child job 与 Cell admission reservation、owner epoch 持久绑定；启动后激活，
  终态 Webhook 或 reconciliation 只释放完全匹配的容量，过期 owner 不能误关新任务。
- 带租约的 starting/recording/stopping provider 对账；provider missing 需要两次独立观察才
  收敛为失败，多个实例不会同时处理同一 job。
- 独立控制面容量指标：按 pool 聚合 pending、active、stopping 和最老 pending age。
- fork 进程指标：active/max slots、drain、按原因拒绝、spool 使用/容量与非 loopback
  网络发送字节，不向媒体热路径增加数据库或控制面调用。
- Track/Composite 各自的 KEDA ScaledObject、CPU/内存 HPA fallback、ServiceMonitor 和
  pending 卡住、slot/spool 饱和、上传停滞、policy 拒绝告警模板。
- external LiveKit 场景强制显式提供与 LiveKit Server 相同的 Redis address/认证/TLS 参数；
  缺失时 Helm fail-closed，避免 Egress 启动后永远收不到录制任务。
- Egress Pod 只接受 `ivekit/livekit-egress@sha256:...` 路径的定制不可变镜像，并要求解析出的
  Registry 主机位于 `media.egress.image.allowedRegistries`；默认仅批准 `docker.io`，私有 Registry
  必须在发布 values 中显式列入审核后的 allowlist。缺 digest、任一全限定上游别名、任意其他路径
  或未批准 Registry 均 Helm fail-closed。build/Chart 契约统一为 `ivekit-egress-pool-v1`；overlay、
  Go policy、build script 和双池 Helm 文件已进入交付包。Registry/digest 门禁不替代集群镜像签名
  provenance 策略。
- 公开 Egress job DTO 删除 reservation、owner epoch、lease 和 provider 对账内部字段；
  failed webhook 不触发 recording completed hook。

受控代码层当前无已知 Egress Cell-10K 功能缺口。2026-07-17 使用 Helm `v3.18.4` 先后发现并
修复 Egress 错误依赖 bundled LiveKit 开关、external 模式仍指向本地错误 Redis、双池默认使用
不识别 iveKit 策略的上游镜像和交付包遗漏 overlay/Chart 的问题。独立复审继续发现 Docker Hub
上游仓库别名可绕过精确字符串检查，现已改为定制仓库路径与 Registry allowlist 双门禁并纳入
实际负向渲染。当前模板在缺 shared Redis、定制 image digest、使用任一上游别名/其他路径或
未批准 Registry 时分别拒绝渲染；提供批准 Registry、定制路径、digest 和共享 Redis 后，
`helm template` 生成 Track/Composite 两套
StatefulSet、Service、PDB、Secret、ServiceMonitor 和 PrometheusRule，且 Secret 与外部 LiveKit
共享同一 Redis、Pod 使用 digest-bound iveKit 镜像。目标 Kubernetes apply、双池运行与扩缩容
仍属于真实环境验收。

真实上游 overlay 应用/完整编译、自定义镜像、真实对象存储、双池隔离和 Cell-10K
录制负载仍为 `not_run`。
