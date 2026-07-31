# Wave 3 实时旁路进程恢复服务器验证

## 1. 结论

2026-07-23 在 `64.225.122.227` 的隔离验证空间完成两项实际进程故障注入：

1. 已建立连接后停止实际 PostgreSQL 16 容器进程，final 投影观察到 3 次有界重试；数据库恢复后
   投影成功，幂等表中只存在 1 行。
2. Python LiveKit audio tap transport 已发送序号 1 后终止实际 Node gateway 子进程；重新启动
   不同 PID 的 gateway 后，transport 重新授权并送达序号 2。

机器报告为
`docs/evidence/wave3-realtime-process-recovery-2026-07-23.json`，状态
`passed`，验证范围固定为 `controlled_server_process_recovery`。

该结果证明受控服务器上的进程恢复，不证明真实 LiveKit track、RTP/WebRTC 媒体连续性、
CloudNativePG 主备切换、Kubernetes Pod 滚动、真实 Provider 或容量。
`real_media_continuity_evidence=false`、`real_vendor_evidence=false`、
`capacity_claim=none`。

## 2. 隔离与制品

| 项目 | 值 |
| --- | --- |
| 服务器源码目录 | `/opt/opc-wave123-validation-20260722/source` |
| PostgreSQL | `postgres:16@sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20` |
| AI Agent | `opc-validation/ai-agent:provider-fallback@sha256:0f83a1c0814365dddff5d3d917751a9f6928e8a06c359f39d50b122664c8a74b` |
| 网络暴露 | PostgreSQL 只发布到 loopback；授权 HTTP 和 gateway WebSocket 只绑定本次运行专属的 internal Docker bridge |
| Python 身份 | UID/GID `10001:10001`、只读根文件系统、drop all capabilities、禁止提权 |
| 数据隔离 | 每次运行使用唯一 Compose project、网络、卷、预留 loopback 端口、密码和临时目录 |
| 清理 | 成功与失败均执行 `compose down --volumes --remove-orphans` 并终止子进程 |

临时目录权限为 `0711`；宿主状态目录为 root 独占的 `0700`，transport 输出目录和只读事件目录
分别为 UID/GID `10001:10001` 独占的 `0700`，事件文件为 `0600`。transport 只能写自己的输出
目录，事件与故障控制目录均以只读方式挂载。Python 容器显式使用 `--workdir /workspace` 和
`PYTHONPATH=/workspace:/test-deps`，并同时校验模块路径与 SHA-256，确保导入挂载的当前源码，
而不是镜像 `/app` 中的旧副本。

## 3. 发现并修复

首次实际停库暴露了生产连接池缺口：PostgreSQL 终止空闲连接时，`pg.Pool` 发出
`error(57P01)`，原实现没有 Pool 级 listener，Node 进程会在投影重试前退出。

`src/db-pg.ts` 现在为 runtime pool 和 migration pool 注册统一 listener：

- 只输出 `postgres.pool.idle_client_error`、合法错误码和
  `connection_discarded`，不输出连接串、SQL、租户或数据库原始错误正文；
- reporter 同步抛错或异步 rejection 都不能重新造成未处理 `error`；
- 活跃查询仍正常失败，由上层有界 dispatcher 决定是否重试；
- `pg` 丢弃失效连接并在后续查询时按需建立新连接。

验收脚本同时增加：

- 宿主机发布端口的真实 `SELECT 1` 就绪检查；
- 启动前预留固定 loopback 端口并在容器恢复后校验映射不漂移，避免 Docker 对宿主机端口
  `0` 在重启时重新分配端口；自动选端口发生绑定竞争时最多重新分配 3 次；
- 等待 marker 时监视子进程，提前退出或超时时输出脱敏日志；
- 所有外部等待和 readiness fetch 有界，超时后先 `TERM` 再 `KILL`；PID 等待使用
  `tail --pid`，不遗留持有 SSH 输出管道的 watchdog 子进程；
- 当前源码路径与哈希约束；
- Docker 枚举失败、LED 基线不是 7 个或为空均 fail closed；机器 JSON 记录实际剩余资源数、
  internal transport 网络、LED 容器前后身份、启动时间和健康状态；
- transport 使用单独创建的 internal 网络，不再使用 host 网络，也不与 PostgreSQL 或 LED
  容器共享网络；
- 注入 PostgreSQL 启动后失败时退出码为 `97`，容器、网络和卷仍全部清理。

## 4. 故障结果

| 场景 | 结果 | 直接观测 |
| --- | --- | --- |
| PostgreSQL 实际进程停止与恢复 | passed | `retry_events=3`、`projection_succeeded=true`、`persisted_rows=1` |
| Node gateway 实际进程终止与重启 | passed | PID `3764056 -> 3764266`、重新授权 4 次、送达序号 `[1,2]` |
| 资源清理 | passed | 无 `ivekit-realtime-recovery-*` 容器、网络或卷残留 |
| LED 隔离 | passed | 7 个 `led-platform-*` 容器 ID、启动时间均未变化且全部保持 `healthy` |
| transport 网络隔离 | passed | `transport_network_internal=true`，未使用 host 网络 |

## 5. 回归

| 门禁 | 结果 |
| --- | --- |
| 进程恢复验收合同 | `5/5` |
| PostgreSQL pool error 回归 | `3/3` |
| 实时语音、audio tap、投影、部署与恢复 Node 合集 | `78/78` |
| AI Agent Python 全量，当前 `/workspace` 源码 | `67/67` |
| TypeScript | `tsc --noEmit`，退出码 `0` |
| Shell 与工作树格式 | `sh -n`、`git diff --check`，退出码 `0` |

可重复入口：

```bash
npm run ivekit:realtime-recovery-acceptance
```

服务器缓存工具链没有 npm 时，使用固定 Node、Python dependency 目录执行同一
`services/ivekit-service/acceptance/realtime-recovery/accept.sh`。

## 6. 源码哈希

```text
76b0b8c539b61598d6992486f9e01a1c9596cb712d4fe384eed129dbde9ee308  src/db-pg.ts
0d173dbf13721f5a5b8927eb3b0a897824a2c78e1e9ef357cc7abd34875a350e  test/db-pg-pool-error.test.ts
49a111eb2ba629128fbb7a5b966f1b18cc9f7f8572d202f7f81b9ee9654709c4  test/ivekit-realtime-recovery-acceptance.test.ts
697fc424499af4b32448caf2d83658e98b73d625766cf98867bcf2fd5c563a2e  services/ivekit-service/acceptance/realtime-recovery/docker-compose.yml
c438a3615c7b24b6db1f0f56280387b16964244718d4f94c4e728a3c0ddf045f  services/ivekit-service/acceptance/realtime-recovery/probe.ts
5f43b39b23fdf2591adebdad709d2ce2207aef1576e9e1a39ee4ec29551454d2  services/ivekit-service/acceptance/realtime-recovery/gateway-child.ts
4b68314e279d034ca1f98921bb248a968209f987ea06df12611641bbf4fee564  services/ivekit-service/acceptance/realtime-recovery/transport_probe.py
c5cda1aa8161428eb6f77cef1dfccb47f1306d986a646665322e28e3fbd6d0d8  services/ivekit-service/acceptance/realtime-recovery/accept.sh
932c15c119c1ea0a3f5c18e6806e58b159e2f4830fbb35341ebab7296d64cf57  services/ai-agent-py/livekit_audio_tap_transport.py
```

## 7. 仍为 not_run

- 真实 LiveKit subscribed track、RustPBX RTP 和电话/视频主媒体连续性；
- CloudNativePG 主备切换、连接池并发恢复和双 Zone 数据面；
- gateway Kubernetes Pod rolling restart、多副本路由与 draining；
- 真实流式 ASR/翻译 Provider、字幕客户端、弱网和跨地域；
- P50/P95/P99、丢包、抖动、首帧、长稳、单机 frontier、1/2/4/8 扩展效率、
  Cell-10K 和 MIX-100K。
