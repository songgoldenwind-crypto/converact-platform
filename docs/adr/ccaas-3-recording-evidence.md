# ADR-CCAAS-3：录制、证据与媒体后处理数据面

**Status:** Proposed（2026-07-16）
**Decision owner:** Converact Fabric shared communication foundation
**Related:** [`ccaas-1-cell-placement.md`](ccaas-1-cell-placement.md)、[`ccaas-2-dual-zone-quorum.md`](ccaas-2-dual-zone-quorum.md)、[`../capacity/profiles/mix-100k-v1.json`](../capacity/profiles/mix-100k-v1.json)、[`../new-feature-application-checklist.md`](../new-feature-application-checklist.md)

## 1. 背景

`mix-100k-v1` 同时包含：

- 25,000 个 SIP voice call，50% 录音。
- 10,000 个 LiveKit A/V room，20% TrackEgress。
- 最多 1% A/V room 使用 RoomComposite。
- 3,000 个 screen room，20% screen track recording。
- 2,000 个 RustDesk session，10% 本地录屏/证据上传。
- 录音后的 ASR、视频帧 OCR、附件 OCR、AI 质检和防绕单。

如果把所有录制都做在线混音、转码或 RoomComposite，录制 CPU 会超过 SFU/PBX 主负载。LiveKit 官方说明 RoomComposite 通常需要 2 至 6 CPU，因此录制必须独立调度，原始/已编码 track 优先，合成和 AI 后处理异步。

## 2. 决策摘要

1. 统一 `RecordingManifest` 和状态机，对外 API 不暴露底层 recorder 差异。
2. SIP voice 使用 RustPBX encoded fork/分片 spool，避免在 API 或 PostgreSQL 中传媒体。
3. LiveKit 合规证据主要使用 TrackEgress；RoomComposite 基线不超过 A/V interaction 的 1%。
4. screen 使用 screen track recording，离线合成。
5. RustDesk 使用终端/edge local recording 和证据 uploader。
6. 所有对象先进入 intake/quarantine namespace，再完成 MIME、checksum、病毒扫描和策略处理。
7. OCR/ASR/AI、转码、缩略图和合成全部使用 durable queue 与独立 worker/GPU pool。
8. recording slots、spool bytes、upload bandwidth、Egress jobs 和 object storage throughput 都进入 CapacityVector admission。
9. `consent_id`、`recording_mode`、`retention_until` 是所有受管录制必填合同。

## 3. 录制类型

| 类型 | 热路径 | 主要用途 | 是否核心 admission |
| --- | --- | --- | --- |
| SIP encoded fork | RustPBX fork -> local spool -> multipart upload | 语音合规、ASR、质检 | 是 |
| LiveKit TrackEgress | 独立 Egress pool -> object storage | 原始 A/V track 证据 | 是 |
| LiveKit RoomComposite | 独立高 CPU Egress pool | 少量所见即所得合成画面 | 否，Zone 故障可暂停新任务 |
| Screen TrackEgress | 独立 Egress pool | 屏幕证据、帧 OCR | 是 |
| RustDesk local recording | Windows/edge -> encrypted spool -> uploader | 远控录屏、审计 | 否，失败必须显式标记 |
| Attachment evidence | direct upload -> intake | IM 图片/文件防绕单 | 依消息策略 |

“核心 admission”表示 interaction 建立前必须确认有对应 slot。非核心录制不得导致基础通信 interaction 被拒绝，但必须产生降级事件。

## 4. RecordingManifest

```typescript
type RecordingSource =
  | 'sip_voice'
  | 'livekit_audio_track'
  | 'livekit_video_track'
  | 'livekit_screen_track'
  | 'livekit_room_composite'
  | 'rustdesk_local'
  | 'im_attachment';

type RecordingState =
  | 'requested'
  | 'reserved'
  | 'recording'
  | 'finalizing'
  | 'uploading'
  | 'uploaded_unverified'
  | 'scanning'
  | 'available'
  | 'quarantined'
  | 'failed'
  | 'deleting'
  | 'deleted';

interface RecordingManifest {
  recording_id: string;
  tenant_id: string;
  interaction_id: string;
  interaction_kind: string;
  owner_epoch: string;
  source: RecordingSource;
  state: RecordingState;
  consent_id: string;
  recording_mode: 'always' | 'policy' | 'on_demand' | 'evidence_only';
  retention_until: string;
  legal_hold: boolean;
  region_id: string;
  zone_id: string;
  cell_id: string;
  recorder_node_id: string;
  started_at: string;
  ended_at: string | null;
  media: {
    container: string;
    codecs: string[];
    channels: number | null;
    sample_rate_hz: number | null;
    width: number | null;
    height: number | null;
    fps: number | null;
  };
  object: {
    bucket_class: 'intake' | 'quarantine' | 'evidence';
    key: string;
    version_id: string | null;
    size_bytes: number | null;
    sha256: string | null;
    encryption_key_ref: string;
  };
  segments: Array<{
    segment_id: string;
    sequence: number;
    started_at: string;
    ended_at: string | null;
    size_bytes: number | null;
    sha256: string | null;
  }>;
  processing: {
    mime_status: 'pending' | 'passed' | 'failed';
    malware_status: 'pending' | 'passed' | 'infected' | 'failed';
    asr_status: 'not_requested' | 'pending' | 'running' | 'passed' | 'failed';
    ocr_status: 'not_requested' | 'pending' | 'running' | 'passed' | 'failed';
    quality_status: 'not_requested' | 'pending' | 'running' | 'passed' | 'failed';
  };
  failure_code: string | null;
  created_at: string;
  updated_at: string;
}
```

Manifest 是录制治理 authority；媒体二进制只在 spool/object storage。任何 Provider callback 必须使用 `recording_id + owner_epoch + job_id` 幂等关联。

## 5. 状态机

```text
requested
  -> reserved
  -> recording
  -> finalizing
  -> uploading
  -> uploaded_unverified
  -> scanning
  -> available

uploaded_unverified -> quarantined
scanning -> quarantined
any non-terminal -> failed
available/quarantined/failed -> deleting -> deleted
```

规则：

- `available` 只表示对象 checksum、MIME 和 malware policy 通过，不代表 ASR/OCR/AI 一定完成。
- `quarantined` 对业务下载不可见，只允许安全管理员和扫描 worker 使用受审计权限访问。
- `failed` 不得删除已存在 segment；reconciliation 可以从可验证 segment 恢复。
- `deleted` 必须保留 tombstone、删除原因、retention/legal hold 证据，不保留媒体内容。
- legal hold 时禁止自动进入 deleting。

## 6. SIP voice recording

### 6.1 热路径

```text
RTP/SRTP owner
  -> RustPBX encoded fork
  -> bounded local segment spool
  -> multipart uploader
  -> object intake
  -> checksum/MIME/malware
  -> evidence namespace
  -> ASR/quality jobs
```

RustPBX Converact Fabric fork 必须：

- 在 call admission 时预留 recording slot 和 spool/upload budget。
- 以固定时长或大小切 segment，默认 60 秒或 64 MiB 先到者。
- segment close 时计算 SHA-256，并追加本地 durable manifest。
- 上传失败时保留本地 segment 并指数退避。
- spool 达到 high watermark 时拒绝新的需要录音 call，而不是覆盖旧录音。
- 支持 pause/resume/mask segment，并记录策略来源和操作者。
- CDR/webhook 携带 recording ID、interaction ID 和 owner epoch。

### 6.2 格式

第一版允许：

- 双向独立 G.711 track，便于说话人分离和重处理。
- 可选实时 mono mix，但不能替代原 track，除非租户策略明确只保留混音。
- 会后转码为 Opus/AAC 等归档格式，由独立 worker 完成。

禁止为了减少存储在 RTP 热线程中执行高成本全量转码。

### 6.3 语音数据包络

`mix-100k-v1` 12,500 个并发录音，双向各 64 kbps，约：

```text
1.6 Gbps recording payload
200 MB/s before container/protocol overhead
720 GB/hour
17.28 TB/day at full-day steady load
```

生产存储预算必须按真实 ACD、工作时段、压缩、保留期和复制系数重算，不能用峰值日数据直接当月均值，也不能忽略峰值 ingest。

## 7. LiveKit recording

### 7.1 TrackEgress 为默认

TrackEgress 用于：

- participant audio track。
- participant camera track。
- screen share track。
- 后续独立 ASR/OCR/合成。

优势：

- 不启动浏览器渲染完整房间布局。
- 可以保留独立参与人/轨道证据。
- 合成策略可以重跑，不影响原始证据。
- 容量按 track job、ingress/egress 和对象写入单独调度。

### 7.2 RoomComposite 限制

- `mix-100k-v1` 基线最多 1% A/V rooms，即最多 100 个并发 RoomComposite。
- 每个任务使用独立 Egress admission，按官方 2-6 CPU 范围实测。
- RoomComposite pool 不与 SFU、TURN、TrackEgress 共用 CPU node。
- Zone failure 时可以暂停新 RoomComposite；已运行任务按 policy 完成或显式失败。
- 需要超过 1% 时必须创建新 profile 并重新计算服务器数。

### 7.3 Room/track 映射

Manifest 记录：

- LiveKit room SID/name。
- participant identity/SID。
- track SID/source/codec。
- interaction ID/owner epoch。
- Egress job ID 和 Egress worker identity。
- start/end timestamp 和 reconnect discontinuity。

客户端重建 room 后产生新的底层 room/track binding，但逻辑 interaction ID 保持；manifest 通过 segment 和 discontinuity 记录多段证据。

## 8. RustDesk recording/evidence

RustDesk 远控证据可能产生于 Windows 客户端、companion 或 edge agent，不假设 hbbr 能看到 P2P 媒体。

要求：

- 录屏、文件传输证据和操作日志带 interaction/session/operation ID。
- 本地 spool 加密，使用设备级 key wrapping 和 tenant evidence key ref。
- watcher 只上传稳定、不再增长且 checksum 已固定的文件。
- 分片上传支持断点续传和幂等 complete。
- 上传成功后本地删除失败要保持 `uploaded + cleanup_pending`，重启后只重试删除。
- 精确断开、录制开始/停止和证据关联由 RustDesk fork/companion 原生 hook 提供。
- 未上传或未扫描的内容保持 `local_only/native_unscanned`，不能由审计日志推导为已安全入库。

## 9. 对象命名与隔离

对象 key 不包含手机号、姓名、邮箱或明文设备 ID：

```text
v1/{tenant_hash}/{yyyy}/{mm}/{dd}/{interaction_hash}/{recording_id}/{segment_sequence}
```

Bucket class：

| class | 访问 |
| --- | --- |
| intake | uploader 写、scanner 读；业务不可下载 |
| quarantine | 安全 worker/管理员受审计访问 |
| evidence | 通过 policy 后按 tenant/role/purpose 读取 |

所有对象：

- server-side encryption，key ref 绑定 tenant/purpose。
- TLS 上传。
- SHA-256 与 size 校验。
- 不可变 version ID。
- retention/legal hold policy。
- object access log。

预签名 URL TTL 默认 <=5 分钟，限制 method、object key、content length 和 checksum。

## 10. 安全处理流水线

```text
intake object
  -> true MIME detection
  -> archive/decompression policy
  -> malware scan
  -> metadata validation
  -> evidence promotion or quarantine
  -> derivative jobs
  -> OCR/ASR/AI quality
```

规则：

- 不信任扩展名和客户端 Content-Type。
- 压缩包限制解压层数、文件数和总膨胀比。
- scanner/provider 失败默认不 promotion。
- 原始证据不可由转码产物覆盖。
- derivative 保存 parent recording/object ID 和 processor version。
- OCR/ASR/AI 输出是派生证据，保留 Provider/model/prompt/version/confidence。
- 检测到恶意内容时不向 Tinode/LED/Converact Platform 返回可下载 URL。

## 11. OCR、ASR 与 AI

### 11.1 实时 ASR

`mix-100k-v1` 中 20% voice，即 5,000 个实时 ASR stream。它们使用独立 stream slots：

- media owner fork audio，不等待 Provider 返回。
- Provider quota 不足时按策略降级为 post-call ASR。
- 降级产生 `recording.asr.deferred` 事件。
- 不允许 ASR backpressure 阻塞 RTP。

### 11.2 Post-call ASR

- 其余 voice recording 进入 durable queue。
- 用 `audio_seconds_per_second` 和 real-time factor 扩容。
- 同一个 recording/processor version 幂等。
- partial/final transcript 有版本和时间戳。

### 11.3 OCR

- IM 图片在 safe-file pipeline 通过后 OCR。
- screen/video 按策略抽帧，不逐帧默认 OCR。
- 抽帧 interval、scene-change threshold 和最大 frames/minute 进入 profile。
- OCR 检测手机号等防绕单命中时保存位置、frame timestamp、置信度和 rule/model version。

### 11.4 AI 质检

- AI 读取 transcript/OCR/metadata，不读取未经授权的全量对象 URL。
- 结果包含 evidence references，不只存结论文本。
- Provider/模型失败不改变原始录制 available 状态。
- 质检 backlog 不影响实时 interaction admission。

## 12. CapacityVector

录制相关维度至少包含：

```text
voice.recording_slots
voice.realtime_asr_streams
livekit.track_egress_jobs
livekit.room_composite_jobs
data.object_write_bytes_per_second
remote.recording_uploads
workers.audio_seconds_per_second
workers.images_per_second
```

本地 spool 额外监控：

```text
recording_spool_bytes
recording_spool_utilization_ratio
recording_oldest_unuploaded_seconds
recording_upload_bytes_per_second
recording_segment_finalize_p99_ms
recording_checksum_failures_total
```

Admission：

- 核心 recording slot 不足时，在 interaction 建立前按租户策略拒绝或明确降级。
- spool >=80% 停止接纳新的非核心录制。
- spool >=90% 停止接纳新的必须录制 interaction，并返回结构化原因。
- 已有 segment 不删除、不覆盖。

## 13. Dual Zone

- 每个 Data Zone 的 voice TrackEgress 核心 capacity 覆盖完整 Region target。
- RoomComposite 不要求双倍 full target，Zone failure 时可以暂停新任务。
- 本地 spool 只承受短时对象存储故障，不作为永久 authority。
- 对象存储跨故障域 durable 后才确认 uploaded。
- Zone 丢失时，未上传本地 segment 可能丢失；要声明 RPO=0 必须使用同步远端 segment replication 或足够频繁的流式上传并实测。
- recording manifest 存在跨 Zone synchronous durable store。

第一版产品承诺应区分：

```text
manifest RPO = 0 after ACK
uploaded object RPO = 0 after checksum ACK
active local segment RPO = segment/upload interval，待实测
```

禁止把 manifest RPO=0 写成录制中最后一毫秒媒体也绝不丢失。

## 14. API 与事件

Converact Fabric 统一事件：

```text
recording.requested
recording.started
recording.segment.finalized
recording.upload.started
recording.upload.completed
recording.scan.passed
recording.quarantined
recording.available
recording.asr.deferred
recording.derivative.completed
recording.failed
recording.deletion.started
recording.deleted
```

事件最少包含：

- tenant/interaction/recording ID。
- owner epoch。
- source/state/reason。
- object metadata reference，不含长期可用 URL。
- idempotency key。
- actor/processor version。
- occurred_at/observed_at。

LED/Converact Platform 只依赖 Converact Fabric API/SDK/事件，不直接依赖 LiveKit Egress、RustPBX recorder 或 RustDesk 文件目录。

## 15. 合规

新增或启动录制前必须：

- 通过 consent tracker。
- 写入 `consent_id`。
- 解析 `recording_mode`。
- 写入 `retention_until`。
- 执行 PCI/敏感段 pause/mask policy。
- 记录 AI disclosure/租户政策要求。

无 consent 或 policy 禁止时，recorder 不得仅凭底层默认配置开始录制。

访问录制要求：

- tenant scope。
- RBAC/ABAC purpose。
- 审计 reason。
- legal hold/retention 状态。
- 短期签名 URL。

## 16. Reconciliation

定期任务检查：

- manifest 在 recording/uploading，但 recorder/segment 已终止。
- object 存在但 manifest 缺 version/checksum。
- manifest available 但对象不存在。
- quarantine 超过处理期限。
- retention 到期但 legal hold 冲突。
- RustDesk uploaded 但本地 cleanup_pending。
- Provider completed 但 derivative callback 丢失。

Reconciliation 操作幂等，并产生 audit/event。不得通过静默改数据库掩盖证据缺口。

## 17. 验收

### 17.1 功能

1. 五种 recording source 使用统一 manifest/state/event。
2. consent、pause/resume/mask、retention、legal hold 生效。
3. multipart resume、checksum mismatch、重复 complete 幂等。
4. malware/quarantine 阻止下载和下游 OCR/ASR。
5. Provider/self-hosted OCR/ASR route 均可追溯。
6. RustDesk 本地删除失败跨重启恢复。

### 17.2 容量

1. 12,500 voice recordings 与 5,000 realtime ASR stream profile。
2. 2,000 个选中 A/V room、8,000 个独立 A/V TrackEgress job、100 RoomComposite、600 screen TrackEgress。
3. object storage 达到 profile write throughput。
4. spool 80%/90% admission 行为正确。
5. Egress/AI worker 扩容不影响 SFU/RTP P99。

### 17.3 故障

1. recorder、uploader、Egress worker、object storage、scanner、Provider 分别故障。
2. manifest/object reconciliation 无重复可见对象。
3. Data Zone 故障后核心录制 admission 保持，RoomComposite 可审计降级。
4. 24 小时 endurance 无 spool 泄漏、孤儿 multipart 和未界定状态。

## 18. 后果

### 正面

- 录制不会把媒体、API 和数据库热路径绑在一起。
- 原始证据和派生物可追溯。
- TrackEgress 大幅减少全量 RoomComposite CPU。
- 五种通道共享安全、OCR/ASR、保留和审计链路。
- 服务器数可以按真实录制向量计算。

### 成本

- 需要独立 Egress、uploader、scanner、derivative 和 Provider worker pools。
- 对象存储吞吐与容量成本很大。
- RustPBX、LiveKit 和 RustDesk fork 都要补原生 manifest/epoch hook。
- 录制中的最后一段 RPO 需要单独工程投入。

## 19. 不采用方案

| 方案 | 否决原因 |
| --- | --- |
| 所有视频都 RoomComposite | CPU 数量不可接受，原始 track 丢失 |
| 媒体经过 Converact Fabric API 上传 | API 带宽、内存和故障域被放大 |
| 录音二进制存 PostgreSQL | OLTP、备份、复制不可控 |
| 上传成功前删除本地 segment | 对象故障时永久丢失 |
| 只保存 AI 结论 | 无法复核、审计和重处理 |
| scanner 失败时默认放行 | 安全边界失效 |
| Redis 保存唯一 manifest | 不 durable，故障后不可审计 |

## 20. 实施边界

本 ADR 定义统一录制数据面和容量合同，不在本轮启动真实录制或 Provider。实现时必须优先写 manifest/state machine、capacity/admission 和 failure tests，再接入各底层 recorder。
