# RustPBX 编码录音分段 Spool 实施计划

**状态：** 代码阶段完成；真实媒体、对象存储与容量验收 `not_run`  
**架构依据：** [`../adr/ccaas-3-recording-evidence.md`](../adr/ccaas-3-recording-evidence.md)  
**容量目标：** 单 Cell 10K 通信并发，多个 Cell 横向扩展到 MIX-100K  
**固定上游：** RustPBX `6c49ee76baa54fdbf8f98020cc9bee158c7c15de`

## 1. 目标

本计划保持既有语音、IM、视频、通知功能及其对外 API 不变，只优化 RustPBX
原有录音收口方式，使其满足 Cell-10K 的容量架构要求：

- 保留媒体转发线程中的有界、非阻塞录音分叉。
- 将整通话单文件改为有界本地 segment spool。
- segment 关闭后生成 SHA-256 和 durable manifest。
- 由独立 sidecar/worker 流式上传，RTP、编解码和混音线程不得访问
  PostgreSQL、NATS 或对象存储。
- 对象存储不可用时保留本地 segment 并退避重试；只有 spool admission
  耗尽时才拒绝新的必须录音呼叫。
- 所有 segment 最终归并到 iveKit `RecordingManifest`，或者进入可审计的
  durable terminal error，不能静默丢失。

## 1.1 代码阶段结果

截至 2026-07-17 已实现：

- 固定 RustPBX patch 在 recorder 消费端轮换分片，媒体路径不访问 API、
  PostgreSQL、NATS 或对象存储。
- iveKit Provider API 以 profile service key 鉴权，并将 tenant、call、
  reservation、owner epoch、Region、Zone、Cell 和 recorder node 做精确绑定。
- 独立 sidecar 使用稳定文件检查、整文件 SHA-256、确定性 lease、持久化
  multipart part 和指数退避实现跨重启续传。
- RustPBX 在录音通道 `try_send` 的 `Full` 分支以 `Relaxed` 原子计数，分段关闭时
  发布 `sample_dropped + dropped_samples`；`paused`/`resumed` 与丢样事件随
  segment 幂等写入统一时间线。服务端协议同时支持后续 mask/discontinuity 来源。
- RustPBX 在最后一个 segment 持久化后原子发布 `recording-completed.json`；sidecar
  持久化重试结束提交，PostgreSQL 只有在 `1..N` 连续分段全部为 `uploaded` 时才把
  总清单推进到 `uploaded_unverified`，缺段不会误封账。
- 通话恰好在 segment 轮换后结束时，finalize 冷路径丢弃尚未写入编码负载的空末段，
  completion 仍指向上一有效段；整通无媒体则明确失败，不伪造成功录音。
- Compose 与 Helm 提供共享 spool、独立 state、只读 Secret 文件、资源限制；
  多副本平台 Helm 使用 StatefulSet 和逐 Pod PVC，避免上传锁和本地证据互相争用。
- sidecar 原子发布磁盘容量和 backlog 指标；component-node 缓存读取，80% 标记
  非核心录音延后，90% 或指标过期时仅对新的必须录音 reservation fail closed。

这些结果只属于 controlled code evidence。Rust 二进制编译、真实 RTP 连续性、
真实对象存储故障、SIPp 并发和 Cell-10K/MIX-100K 物理容量均未据此宣称通过。

## 2. 实施前问题（已由本实现处理）

固定版本 RustPBX 原本已经通过 `try_send` 将录音样本非阻塞地分叉到录音通道，
但实施前的收口方式存在三个容量问题：

1. 一通电话只生成一个 WAV，长通话会形成大文件和长尾 finalize。
2. `RecordingUploadHook` 在通话结束后把整个文件读入 `Vec<u8>` 再上传，
   内存峰值随录音文件大小增长。
3. 上传失败只记录日志，没有 durable segment lease、幂等 complete 和
   跨重启 reconciliation。

## 3. 不变量

1. 媒体样本处理路径只允许有界内存操作和本地顺序写。
2. 录音分叉通道满时不得阻塞 RTP；必须增加 dropped-sample 指标和证据状态。
3. segment 默认按 60 秒或 64 MiB 先到者关闭。
4. segment 文件和 manifest 使用同目录临时文件加原子 rename 发布。
5. manifest 不保存手机号、姓名、邮箱或明文 SIP URI。
6. `recording_id + segment_id + sequence + owner_epoch` 是幂等身份。
7. 同一 segment 同一时间只允许一个有效上传 lease。
8. 上传 complete 必须校验字节数和 SHA-256；重放返回同一结果。
9. 80% spool 水位停止新的非核心录音，90% 水位停止新的必须录音 interaction。
10. 已接受的 segment 不因上传失败被覆盖或自动删除。
11. pause、resume、mask、丢包和时间线 discontinuity 必须作为 segment 事件保留。
12. 真实媒体质量、真实对象存储吞吐和物理容量在环境具备前保持 `not_run`。

## 4. 数据模型

新增迁移 `086_ivekit_recording_manifests.sql`：

- `ivekit_recording_manifests`
  - 统一保存 source、interaction、owner、consent、retention、媒体和处理状态。
  - `ivekit_voice_recordings` 保持兼容，并通过 `manifest_id` 关联。
- `ivekit_recording_segments`
  - 保存 sequence、track、codec、起止时间、大小、SHA-256、对象引用和状态。
- `ivekit_recording_segment_events`
  - 保存 pause/resume/mask/discontinuity/drop 等有序事件。
- `ivekit_recording_upload_leases`
  - 保存 worker、lease token、attempt、next attempt 和 terminal error。
- `ivekit_recording_segment_uploads` / `ivekit_recording_upload_parts`
  - 保存可跨进程恢复的 multipart identity 和已经确认的分片，不保存媒体二进制。

所有表启用 tenant RLS。Claim 使用 `FOR UPDATE SKIP LOCKED`，状态转换使用
期望状态和 owner epoch CAS。

## 5. RustPBX 补丁

新增固定补丁 `rustpbx-ivekit-recording-spool.patch`：

1. 扩展录音配置，显式启用 iveKit segment spool。
2. 在现有 recorder channel 消费端按时长或大小轮换文件。
3. 每个关闭 segment 计算 SHA-256，写 manifest 临时文件并原子 rename。
4. CDR 附带 recording、interaction、reservation、owner epoch 和 segment 摘要。
5. pause/resume 和 channel overflow 追加 durable 事件；正常 RTP 包不增加锁，只有
   channel `Full` 分支执行一次原子累加。
6. 禁用原有整文件 HTTP/S3 upload hook；本地 legacy 模式保持兼容。
7. 最后一个 segment 关闭后原子发布 owner-fenced completion marker。
8. 由 sidecar 提供 spool 指标文件供本地容量探针读取。

补丁只能修改 recorder、media engine、call record/config 和必要接线，不在 RTP
socket、codec、路由或公开 RWI payload 中增加网络调用。

## 6. Sidecar/Worker

新增 RustPBX 录音 spool worker：

- 扫描已原子发布且稳定的 manifest。
- 拒绝越界路径、符号链接、大小或 checksum 不匹配的 segment。
- 先向 iveKit 注册/重放 manifest 和 segment。
- 使用现有 secure-file/object intake 分片协议流式上传。
- complete 后回写对象引用，进入 MIME、病毒扫描、ASR 和质检队列。
- completion marker 仅在本地 segment 均已确认清理后提交；服务端锁定 manifest，
  校验 owner/topology、连续 sequence、总数和全部上传状态后幂等封账。
- 本地删除失败保存 `uploaded_cleanup_pending`，重启后只重试清理。
- 总清单提交失败保存独立 finalization 状态并指数退避；服务端确认前不删除 marker。
- 网络或对象存储失败使用有界指数退避和抖动，不改变 segment 身份。

## 7. Admission 和容量探针

- 必须录音呼叫的 `required_capacity` 同时包含：
  - `voice.recording_slots`
  - `data.local_spool_bytes`
  - `workers.evidence_upload_bytes_per_second`
- RustPBX 节点探针上报：
  - spool 总量、已用量和水位。
  - active/terminal segment 数、backlog 字节和最老 segment 年龄。
  - recording finalization backlog、terminal 数和最老 finalization 年龄。
  - 最近成功上传时间。
- recorder channel overflow 以逐 segment 的 `sample_dropped + dropped_samples` 精确证据
  持久化；真实负载下的 drop rate 聚合与告警阈值必须由部署监控验收，不由代码测试冒充。
- capacity projector 只采用带过期时间的节点观测，不使用目标容量冒充观测。

## 8. 测试顺序

1. 迁移合同：表、约束、索引、RLS、租约和 standalone migration bundle。
2. 领域状态机：合法转换、owner epoch fencing、幂等重放和 terminal error。
3. PostgreSQL store：claim、lease expiry、CAS complete、并发 worker 隔离。
4. spool worker：路径安全、稳定文件、checksum、断点续传、退避和重启恢复。
5. RustPBX patch：固定提交 apply、补丁范围、无热路径网络调用和配置合同。
6. 部署：Compose/Helm sidecar、共享 spool volume、只读 secret 和资源限制。
7. 容量：水位 admission、探针 freshness、backlog 指标和故障降级。
8. 回归：voice、delivery、capacity、SDK、typecheck 和 patch manifest hash。

## 9. 完成证据

代码阶段可以声明完成的证据：

- 固定补丁可对精确 RustPBX commit 和既有补丁队列连续 apply。
- TypeScript 单元测试、Rust patch 内嵌测试源码和静态合同测试通过；Rust 内嵌测试
  只有在固定依赖可用并真实编译后才算执行通过。
- 两套 Compose 配置渲染通过；2026-07-17 使用 Helm `v3.18.4` 实际 `helm template`，生成
  固定 digest RustPBX StatefulSet、route snapshot/recording spool sidecar、三类 Service、PDB
  和配置 Secret。目标 Kubernetes apply 与真实录音链路仍保持 `not_run`。
- 上传中断、进程重启和 lease 过期的自动化测试证明幂等恢复。
- fork manifest 记录补丁 SHA-256、源码身份、验证命令和真实环境状态。

当前自动化证据入口：

- `test/ivekit-rustpbx-recording-spool-patch.test.ts`
- `test/ivekit-rustpbx-recording-spool-worker.test.ts`
- `test/ivekit-rustpbx-recording-spool-capacity.test.ts`
- `test/ivekit-recording-spool-intake.test.ts`
- `test/ivekit-recording-segment-upload.test.ts`
- `test/ivekit-recording-manifest-postgres.test.ts`
- `test/ivekit-voice-deployment.test.ts`

以下项目必须保持 `not_run`：

- RustPBX 真实双向 RTP 音频连续性和录音听检。
- 固定 RustPBX patch 的联网/完整依赖 Rust 编译及其中的 overflow 单元测试执行。
- 真实录音通道过载下的 dropped-sample 数量、音频缺口和事件一致性。
- 12,500 路并发录音与 200 MB/s 峰值 ingest。
- 真实生产对象存储 multipart 吞吐和故障恢复。
- 双 Zone 节点故障、spool 水位拒绝和跨 Cell 长稳。
- 真实 ASR、AI 质检和 retention 删除闭环。
