# Converact Fabric V6 生产闭环尾项设计

> 日期：2026-07-16  
> 状态：已批准实施  
> 范围：Tinode Kubernetes、Tinode 原生消息 mutation、RustDesk Windows 精准断开、RustDesk 原生证据安全入库、真实环境验收

## 1. 目标与边界

本轮只关闭 Converact Fabric/LED 共享通信底座的已知技术尾项，不实现 LED/Converact Platform 的订单、支付、人员、价格、评价、投诉或业务后台，也不开发移动端。Converact Fabric 继续通过 `tenant_id + business_ref` 提供产品无关能力。

统一完成口径：

1. 已知代码和部署配置缺口全部关闭；
2. 自动化、受控 PostgreSQL、Compose/Helm 静态合同、standalone source graph 与交付包验证全部通过；
3. 可用真实环境形成 source-bound 证据；
4. 缺少账号、设备、域名、线路或集群的真实环境项保持 `not_run`，并提供直接可执行的验收步骤；
5. mock、受控 Provider、模板和静态配置不得升级为真实环境通过证据。

## 2. 总体架构

Converact Fabric 仍是会话、消息状态、授权、审计、证据与业务引用的权威控制面。Tinode、RustDesk、LiveKit、RustPBX 和内容 Provider 是可替换执行面：执行面故障不能回滚已经成立的 Converact Fabric 权威状态，而是进入 durable retry、dead letter 或明确的 degraded 状态。

所有新增异步链路统一采用：

`权威事务 -> durable outbox/command -> lease claim -> 外部执行 -> 条件完成 -> 事件/指标 -> retry/dead letter`

多实例 worker 使用 PostgreSQL `FOR UPDATE SKIP LOCKED`、claim token 和 lease fencing；不得依赖进程内队列或本地内存去重。

## 3. Tinode Kubernetes

standalone Chart 新增可选 `tinode.enabled` 模式：

- 默认关闭，兼容外部/托管 Tinode；
- 启用时使用 digest-pinned Tinode 镜像；
- Secret 只通过 `secretKeyRef` 注入 PostgreSQL DSN、token key 和 UID encryption key；
- ConfigMap/环境变量固定 `STORE_USE_ADAPTER=postgres`、`RESET_DB=false`、`WEBRTC_ENABLED=false`；
- 使用独立 PostgreSQL 数据库，禁止与 Converact Fabric runtime 角色混用；
- 提供 HTTP Service、startup/readiness/liveness probe、资源限制、Pod 安全上下文、PDB、拓扑分散和 NetworkPolicy 开关；
- Converact Fabric API 在 bundled 模式自动使用集群内 Tinode URL，浏览器仍使用显式公网 WSS URL；
- bundled `compact` 模式严格限制为单副本，使用 PVC 持久化 `/botdata` 和本地附件；
- bundled `cluster` 模式严格限制为三个 StatefulSet 副本，使用稳定 ordinal/DNS、headless ring Service、`minAvailable: 2` PDB、跨 Zone/主机分散以及共享 S3-compatible 附件存储；
- cluster Pod 设置 `NO_DB_INIT=true`，数据库建库/建表和升级只由阻塞式 `pre-install,pre-upgrade` Job 执行，避免三个节点并发初始化；
- Chart、README、values、交付包、监控和部署合同测试必须同时覆盖 external、compact 与 cluster 三种模式。

Helm 不负责部署生产 PostgreSQL，也不把数据库密码写入 values。数据库角色和 Secret 由平台运维预先提供；目标数据库不存在时 bootstrap 角色需要 `CREATEDB`，预建空库则不需要重建。升级始终保持 `RESET_DB=false`。

## 4. Tinode 原生消息 mutation

### 4.1 权威与协议

Converact Fabric 的 `collaboration_messages` 与 `collaboration_message_mutations` 继续是权威。针对已绑定 Tinode 且已有 provider sequence 的消息：

- edit 使用 Tinode publish replacement 语义，引用原消息 sequence；
- delete 使用 Tinode message delete 语义，只删除目标 sequence；
- provider payload 携带稳定的 Converact Fabric mutation ID，用于审计和入站回环识别；
- mutation API 成功表示 Converact Fabric 权威状态已提交，不表示 Tinode 已完成；返回值和事件暴露 provider sync 状态。

### 4.2 Durable outbox

新增 mutation outbox 表，每个本地 mutation 一行，唯一键为 `(tenant_id, mutation_id, provider)`。状态机：

`pending -> processing -> delivered | retry_wait -> processing | dead_letter`

outbox 与本地 edit/delete 必须在同一 PostgreSQL 事务创建。worker 只在原消息已取得 Tinode topic 与 sequence 后发送；原消息仍待投递时保持 pending，不制造无目标 mutation。

同一消息 mutation 按 version 串行发送：版本 N 未完成时不得 claim N+1。重试使用稳定幂等标识；超时视为不确定结果时，先通过入站投影/状态对账确认，不盲目重复产生语义不同的操作。

### 4.3 入站回环与多客户端一致性

Tinode inbound projector 识别 replacement/delete：

- 与已有 mutation ID 或相同目标状态匹配时标为 loop-suppressed/confirmed；
- 结果未知后到达且通过绑定/payload 校验的迟到 echo 在事务内纠正为 delivered，并在同一事务以稳定幂等键写 durable tenant event；提交后广播失败可由 replay/Webhook 恢复；
- 外部 Tinode 客户端发起的合法 mutation 继续投影为新的 Converact Fabric mutation；
- 旧版本、重复包和乱序包不得覆盖更新版本；
- 回写完成、重试和 dead letter 进入标准租户事件、审计与低基数指标。

## 5. RustDesk Windows 精准断开

Windows companion 新增 native session bridge，命令只接受已注册设备上的 `external_id + native_session_id`，不得执行任意命令行。bridge 的优先级：

1. 从 ACL 保护的 registry 解析 `external_id + target_id + rustdesk_id` 对应的唯一 native connection ID；
2. placement-enabled package v6 通过固定 `ivekit-rustdesk-native-control-v2` named pipe 传入 interaction、reservation、owner epoch、command ID 和 native ID；companion 持久化最大 epoch 后调用 RustDesk 1.4.9 overlay 的 `ui_cm_interface::close(native_id)`；
3. 映射缺失、连接漂移或原生接口不可用时返回 `precise_disconnect_unavailable`，不执行任意 hook。

service restart 不再是普通自动 fallback。只有管理员显式提交 emergency fallback、确认 `collateral_sessions_may_disconnect=true` 并提供原因后才允许执行；操作必须产生单独审计事件。普通用户或自动 worker不得触发。

companion 回传 command ID、native session ID 哈希、执行方式、退出码、时间和结构化错误，不上传窗口标题、屏幕内容、剪贴板或按键。

## 6. RustDesk 原生证据安全入库

Windows companion 观察 RustDesk 已完成的文件传输和本地录屏事件。仅在会话授权策略明确允许、文件路径位于配置的 allowlisted roots、文件句柄稳定且大小不再变化后创建 evidence upload 任务。

定制 RustDesk 内置 allowlist scanner：从 ACL 保护的 roots manifest 读取文件/录屏根，基线后只对连续稳定的新文件写候选。companion 通过 device-token evidence context 将候选与唯一 controller、operation、预期文件名和时间窗关联，再原子、幂等生成 `rustdesk-native-evidence-v1` 事件。`Publish-IveKitRustDeskEvidence.ps1` 仅是固定故障恢复工具。Windows 包只接受同时声明 native control 和 native evidence 协议的自定义 RustDesk 1.4.9 制品；真实扫描器、关联和双机行为必须在物理 Windows 验收。

会话结束后只保留 15 分钟录屏 finalization window。uploader 死信 payload 与可追踪状态不得分离压缩，按本地保留期或数量上限成对删除。远端成功后的本地清理也是可恢复状态：先持久化 `uploaded + manifest`，删除失败跨重启重试且不重复上传，删除完成后才能移除 manifest 和压缩终态。ready evidence 补偿对确定 `unsupported|ignored` 写终态标记，临时不就绪/失败仍可重试，避免旧文件占满有界候选批次。

处理链路：

`native observation -> consent/policy gate -> local spool -> resumable evidence uploader -> secure_file -> MIME + ClamAV -> quarantine/release -> derivative -> OCR/ASR/AI -> status event/audit`

约束：

- 原生直传但未经过 uploader 的文件继续标为 `native_unscanned`；
- 仅本地存在的录像继续标为 `local_only`，不能声称已扫描；
- 自动上传必须绑定 tenant、remote session、operation、business_ref、evidence type、SHA-256 和授权 ID；
- 支持断点分片、崩溃恢复、重复事件去重、源文件变化检测和安全删除本地 spool metadata；
- 文件内容、录屏字节只进入 secure-file 上传接口；观察/审计事件不得包含文件内容；
- 剪贴板正文、按键日志、未授权屏幕捕获永不进入自动上传。
- secure-file 收敛回调负责低延迟入队；derivative worker 每轮结束通过 migration 076 的最小权限 `SECURITY DEFINER` 候选函数查询“ready + clean + RustDesk source 且尚无 processing attachment/终态 skip 标记”的 ID，再按租户读取并幂等补偿，关闭状态已落库但进程在回调期间退出的窗口；函数不返回文件内容/路径，多实例竞态由消息幂等键和 PostgreSQL 唯一约束收敛。
- `POST/PUT/GET/DELETE /api/ivekit/rustdesk/devices/{device_id}/evidence...` 只接受设备绑定的 `X-RustDesk-Edge-Token`，LED 浏览器和业务服务不得持有该 token；owner/admin emergency fallback 使用普通 Bearer JWT，二者在 OpenAPI 中是不同 security scheme。

## 7. 真实环境验收

验收矩阵分为 Provider、Tinode、LiveKit/TURN/Egress、RustDesk 双 Windows、Voice/PSTN、通知、对象存储和 Kubernetes 八组。每组报告绑定：

- 完整 deployed commit 和 artifact digest；
- run ID、environment ID、开始/结束时间；
- 每个 check 独立 observation 文件及 SHA-256；
- operator 与不同身份 QA approver；
- secret scan 和脱敏确认；
- `passed | failed | not_run`，其中 `not_run` 必须有机器可读 reason code。

没有真实资源时只生成模板、preflight、采证器和 runbook，不改变真实环境状态。

## 8. 验证标准

- Tinode Helm external/bundled/invalid HA 三类静态渲染合同；
- mutation 单元、HTTP、worker、入站回环、顺序、幂等、dead-letter、PostgreSQL/RLS 测试；
- Windows PowerShell/parser/package/command/evidence spool 自动化合同；
- secure-file 单文件/分片/扫描/隔离/OCR-ASR 调度状态测试；
- missed-callback 补偿、OpenAPI edge security、交付包独立编译和 V6 模板 hash/tamper 测试；
- 根 typecheck、全量测试、SDK build/pack、standalone source graph、Compose config、Helm 合同、迁移 fresh/upgrade/RLS、交付包和 secret scan；
- 独立代码复审无未关闭 finding。
