# Wave 3 Tinode 性能采集器服务器验证

## 1. 结论

2026-07-23 在 `64.225.122.227` 的隔离环境中，新的 Tinode WebSocket 容量 worker
连接实际自编译 Tinode `v0.25.3` 与 PostgreSQL 16，完成消息交互、长连接和离线恢复的
低负载受控回归。

结果为 `passed_controlled_server`：

- 20 条实时消息全部收到发布确认和 echo delivery；
- 持久消息丢失、重复和最终业务乱序均为 0；
- 5 条离线消息在按 cursor 重连后全部恢复；
- 2 个长连接全部建立、同时保持活跃并正常关闭；
- presence 查询、typing 和 receipt 使用真实 Tinode wire protocol；
- focused 回归 `9/9`，capacity TypeScript 检查通过。

机器证据为
`docs/evidence/wave3-tinode-capacity-collector-2026-07-23.json`。本轮固定声明
`verification_scope=controlled_server_tinode_protocol`、
`observation_scope=client_only` 和 `capacity_claim=none`。它证明采集器可用，不证明
Tinode 单机容量、三节点高可用、Cell-10K 或 MIX-100K 达标。

## 2. 实现范围

| 能力 | 实现 |
| --- | --- |
| 真实协议 | WebSocket open、`hi`、basic/token login、topic subscribe、metadata get、publish、data delivery、receipt、typing 和 graceful close |
| 消息质量 | 独立统计 send-to-ACK 与 send-to-delivery 的 P50/P95/P99，验证发布序号与 delivery 序号一致 |
| 可靠性 | 统计持久丢失、重复、在线乱序；离线阶段使用 marker 与 `since` cursor 验证精确补偿 |
| 长连接 | 分片内先建立全部 socket，再在 hold window 内周期执行 presence 与 typing，记录 active peak、关闭数和重连数 |
| Worker | 接受通用 `CapacityStartShardCommand`，支持 `interaction:tinode_im` 与 `connection:tinode_websocket` |
| 凭据 | 独立 `0600` credential bundle；拒绝符号链接、非普通文件、超限文件和 group/other 可读权限；证据不包含 API key、token 或 password |
| 证据边界 | worker 固定输出 `capacity_claim=none` 和 `observation_scope=client_only`，不能自行升级生产容量结论 |

可执行入口为 `scripts/ivekit-capacity-tinode-worker.ts`。它只接受有界 stdin JSON，
校验输入中的 result path 与命令行一致，并使用同目录临时文件、`0600` 权限和原子 rename
写结果。capacity 镜像以 `0755` 复制该入口，根 package script 与独立 capacity tsconfig
均已接入。

## 3. 发现并修复

### 3.1 Tinode metadata 响应

初版采集器把所有请求都当成 `{ctrl}` ACK。真实 Tinode 的 `get` 成功响应是带相同 request
ID 的 `{meta}`，因此 presence 查询会错误超时。采集器现在同时处理 `{meta}` 成功完成与
`{ctrl}` 拒绝；回归用例明确使用“只回 meta、不回 ctrl”的真实协议形状。

### 3.2 离线历史回放顺序

真实 Tinode 对历史消息可按最新到最旧的线序回放。本轮 5 条补偿消息在线上观察到 4 次
sequence regression，但每条消息携带的 provider sequence 均与原 publish ACK 完全一致，
按 sequence 重建后业务乱序为 0。

采集结果因此拆成：

- `offline_recovery_wire_out_of_order_count`：保留原始网络到达次序，本轮为 4；
- `offline_recovery_out_of_order_count`：验证 provider sequence 与逻辑发布顺序能否无损
  收敛，本轮为 0，并由质量门约束。

这样既不隐藏 Tinode 的回放行为，也不会把协议允许、客户端可确定性重建的倒序历史误判为
消息一致性失败。

## 4. 服务器结果

### 4.1 实时消息

| 指标 | 结果 |
| --- | ---: |
| 发布 / delivery | `20 / 20` |
| 持久丢失 | `0` |
| 重复 | `0` |
| 业务乱序 | `0` |
| send-to-ACK P95 / P99 | `6.293 / 7.885 ms` |
| send-to-delivery P95 / P99 | `6.250 / 7.837 ms` |
| 离线恢复 | `5 / 5` |
| 离线恢复 P99 | `79.027 ms` |
| 离线 wire / 收敛乱序 | `4 / 0` |

这些数值来自 loopback 上的一次低负载受控运行，只用于验证计时、关联和质量门，不是可宣传的
生产延迟基准。

### 4.2 长连接

| 指标 | 结果 |
| --- | ---: |
| 尝试 / 接受 / active peak / 正常关闭 | `2 / 2 / 2 / 2` |
| presence 查询 | `10` |
| typing note | `10` |
| 协议错误 | `0` |

### 4.3 隔离

- Tinode 使用
  `ivekit/tinode:v0.25.3-ivekit.3-22a7c18e-amd64`，镜像 ID
  `sha256:6c83d13fc244b000b5bd0b2489a918b3fd4ac90bbab46039fea6656fa41b6650`；
- PostgreSQL 固定 digest
  `sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20`；
- Tinode 以只读根文件系统、drop all capabilities、禁止提权和独立 tmpfs 运行；
- API key、数据库密码、token key 和 UID key 每次生成，未写入证据；
- 成功和失败路径均清理专用容器、网络和临时凭据，最终残留资源为 0；
- 7 个 `led-platform-*` 容器始终保持 healthy。

## 5. 自动化回归

| 门禁 | 结果 |
| --- | --- |
| Tinode protocol + worker | `9/9` |
| TypeScript | `tsc --noEmit -p infra/capacity/tsconfig.json`，退出码 `0` |
| 外部入口 | SHA-256 固定的 `0755` worker 由通用 external driver 成功启动 |
| 格式 | 相关文件 `git diff --check`，退出码 `0` |

覆盖的反例包括登录拒绝、ACK 延迟超限、重复 delivery、倒序历史回放、credential bundle
权限过宽、结果路径不一致和 worker 二进制 hash 约束。

## 6. 仍为 not_run

- Tinode 单机连接数、消息吞吐、扇出、公平性、CPU、内存、网络和每连接成本 frontier；
- Tinode 三节点真实故障切换、重连风暴、慢消费者、长稳和数据库主备切换；
- SIP CPS、RTP mouth-to-ear/MOS、丢包、抖动和 codec/transcoding；
- LiveKit join、首音频、首视频、glass-to-glass、freeze、A/V sync、TURN 和 Egress；
- RustDesk 双 Windows 的 input-to-photon、文件传输、多屏和恢复；
- 限带宽、loss+jitter、handoff、cross-region，以及 1/2/4/8 节点扩展效率；
- Cell-10K、MIX-100K 和十万并发平台 finalizer。

因此当前回答“是否正在测试所有性能指标”仍然是否定的：Tinode 的真实采集链路已经关闭，
完整性能矩阵仍需按组件和负载阶梯继续执行。
