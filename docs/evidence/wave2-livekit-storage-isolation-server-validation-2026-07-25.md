# Wave 2 LiveKit 录制存储故障隔离服务器验证

## 1. 结论

2026-07-25 在隔离 Linux 服务器完成真实 LiveKit Server、RoomComposite Egress、MinIO、Valkey
和双 Chromium WebRTC peer 故障演练。首个录制进入 active 后停止 MinIO；Egress 在结束上传时
以 `storage_upload_failed` 失败，但两端音频/视频字节、RTP 包和视频解码帧在故障期间及录制
失败后继续增长。MinIO 恢复并重新初始化私有 bucket 后，同一房间的第二个录制成功完成，上传
对象为 99,530 bytes 的 `video/mp4`。

裁决为 `passed_controlled_server`。它证明录制和对象存储故障不会反向中断本轮已有 LiveKit
媒体会话，同时证明恢复后的新录制可用；它不是容量、生产对象存储、高可用或跨 Zone 证据，
固定 `capacity_claim=none`、`production_capacity_evidence=false`。

## 2. 绑定制品

| 制品 | 身份 |
| --- | --- |
| LiveKit | `ivekit/livekit-server:v1.13.4-ivekit.1-0b3fd288`，镜像 ID `sha256:95b4473a...23963` |
| Egress | `ivekit/livekit-egress:v1.13.0-ivekit.1-7d3572a0-amd64`，镜像 ID `sha256:e266932c...d3fe` |
| MinIO | `RELEASE.2025-04-22T22-12-26Z`，镜像 ID `sha256:a1ea29fa...015e` |
| Valkey | 受控本地标签绑定镜像 ID `sha256:1da6597c...cec8` |
| 浏览器 | HeadlessChrome `149.0.7827`，LiveKit Client `2.20.1` |
| runner | SHA-256 `9154786200ba4f1e91b9c3d03b823520bb56d7e4277285b97e4cfd93a8afb0c4` |
| 测试 | SHA-256 `5ad45b835eb2cc72535a2309e374bcb9523383bdf35a8b9d929e4de4d3338228` |
| 原始结果 | SHA-256 `6d8ad6b2071bc5e5221d7a132547e5490a71886019ccccc2fc197442ba334893` |
| 机器证据 | SHA-256 `3df72d263ffe7d544b91c66598e9da0b7b277ea8a014feda1fe050b5d135db7a` |

服务器源码目录为 dirty worktree，因此不能只用 Git commit 归因；机器证据逐项绑定 runner、测试、
Compose、LiveKit 配置、Egress 配置和原始结果的 SHA-256。

## 3. 媒体连续性

四次采样均为两个不同 identity，双方始终 `connected`，各有 1 个远端参与人、2 条远端轨和
2 条本地轨。验收不再把“连接和 publication 仍存在”当作媒体流动证明，而是要求每个 peer 的以下
七个累计量相对上一阶段严格增长：

- inbound audio bytes；
- inbound video bytes；
- outbound audio bytes；
- outbound video bytes；
- inbound RTP packets；
- outbound RTP packets；
- decoded video frames。

例如 agent-a 的 inbound video bytes 按
`1,213 -> 1,088,138 -> 1,197,099 -> 2,116,541` 增长，decoded video frames 按
`3 -> 250 -> 272 -> 460` 增长；agent-b 的对应值为
`4,645 -> 1,209,367 -> 1,313,155 -> 2,182,878` 和
`11 -> 268 -> 290 -> 478`。七项、双端、四阶段单调性校验全部通过。

## 4. 录制故障与恢复

| 阶段 | 结果 |
| --- | --- |
| 首次录制 | `EG_XTxdm8YhXCgZ` 先进入 active |
| MinIO 停止 | LiveKit 媒体持续，双端七项计数继续增长 |
| 首次录制结束 | Egress 因对象上传不可达进入 `failed`，外部报告仅保留 `storage_upload_failed` |
| MinIO 恢复 | bucket bootstrap 幂等成功，媒体仍持续 |
| 恢复录制 | `EG_dRrUH8GeZ29k` 进入 active 后完成，终态 `complete` |
| 对象核验 | `recovery/ivekit-storage-isolation-mrzg6n79.mp4` 存在，99,530 bytes，`video/mp4` |

报告权限为 `0600`；API secret、token、访问密钥、HTTP/WSS endpoint 和原始 Egress 错误扫描为空。
隔离 LiveKit、Egress、MinIO、Valkey 均 `RestartCount=0`、`OOMKilled=false`。同时核验九个既有
HOMER、Kamailio、RustPBX、PostgreSQL、LiveKit 基线容器全部运行、零重启、未 OOM。

## 5. 自动门禁

| 门禁 | 结果 |
| --- | --- |
| 存储隔离专项本机 | `11/11 passed` |
| 存储隔离专项服务器 | `11/11 passed` |
| LiveKit/Egress/Delivery 相关回归 | `97/97 passed` |
| 根 TypeScript | `passed` |
| Playwright evaluator 自包含门禁 | `passed`，序列化函数不再引用 Node/tsx 的 `__name` |
| 双端七项媒体计数单调性 | `passed` |

## 6. 未覆盖边界

本轮仍未覆盖生产对象存储、跨 Zone 存储故障、多 Egress 池故障切换、磁盘满、长时间故障与 spool
水位、公网 TURN/TLS 路径、目标 Kubernetes，以及 RustPBX 真实 RTP 录音存储故障。后续不能用这份
受控服务器报告替代这些生产验收。
