# Wave 3 实时音频旁路恢复服务器验证

## 1. 结论

- 验证时间：`2026-07-23T10:01:50Z`，北京时间 `2026-07-23 18:01:50`。
- 验证主机：`64.225.122.227`。
- 验证范围：`controlled_server_realtime_audio_tap_recovery`。
- 结论：LiveKit audio tap 有界重连、loopback gateway 监听器重启、PostgreSQL projection 受控短故障、
  有界队列、部署渲染和相关回归通过。
- `real_postgresql_process_outage=false`。
- `real_gateway_process_or_pod_restart=false`。
- `real_media_continuity_evidence=false`。
- `real_vendor_evidence=false`。
- `capacity_claim=none`。

## 2. 环境

| 项目 | 值 |
| --- | --- |
| 服务器源码 | `/opt/opc-wave123-validation-20260722/source` |
| 本地基线提交 | `578a78bf42e3703a9d78fc0766be6a3b3cd5c35e`，验证包含未提交工作树改动 |
| Node.js | `v24.18.0` |
| Docker Server | `29.1.3` |
| AI Agent 验证镜像 | `opc-validation/ai-agent:provider-fallback` |
| AI Agent image ID | `sha256:0f83a1c0814365dddff5d3d917751a9f6928e8a06c359f39d50b122664c8a74b` |
| Helm | `alpine/helm@sha256:e7ecbf4a200dea73d64bfb8cb0936829164945f2b4d02a0274093073ee8d264f` |
| 容器约束 | `--network none`、只读根、`no-new-privileges`、drop ALL capabilities、64 MiB `/tmp` |

`--network none` 仍保留容器 loopback；gateway 重启用例没有访问公网或外部 Provider。

## 3. 修复内容

### 3.1 LiveKit audio tap transport

1. 初次连接和断线恢复使用同一有界重试预算。
2. 默认最多 8 次重试，延迟为 `0.05/0.2/0.5/1/2/2/2/2 s`，总等待约 `9.75 s`，另加每次连接上限。
3. 每次成功连接或成功发送后重置预算，后续独立故障不会继承旧失败次数。
4. 每次重连重新向 OPC 申请一次性 token；不会复用已消费 token。
5. 预算耗尽只终止辅助 tap，不控制 LiveKit room、track 或主媒体。

### 3.2 Realtime projection dispatcher

1. gateway 回调使用同步、非阻塞 `offer()`，不再为每个 Provider event 创建无界 Promise。
2. 默认最多排队 4096 项，合法范围 `1..100000`，另有最多 1 个正在执行的项。
3. final 投影失败按 `100/250/500/1000/2000 ms` 重试；partial 失败即丢弃。
4. 队列满时，新 partial 直接丢弃；新 final 优先淘汰一个已排队 partial；队列全为 final 时拒绝新 final。
5. 关闭默认最多等待 1000 ms，合法范围 `10..30000 ms`；超时后丢弃剩余项并结束。
6. 观测事件只允许 `projection_failed`、`projection_queue_overflow`、
   `projection_shutdown_timeout`，不携带数据库错误、租户、会话或正文。

## 4. 受控故障矩阵

| 场景 | 结果 | 边界 |
| --- | --- | --- |
| 初次 gateway 连续失败 2 次后恢复 | passed | 第 3 次重新授权并连接 |
| 成功恢复后再次断线 | passed | 重连预算已重置，当前帧在新连接送达 |
| 默认 8 次短失败后恢复 | passed | 第 9 次连接成功，预算有硬上限 |
| loopback 监听器关闭并同端口重启 | passed | 真实 TCP/WebSocket listener 重启；不是独立生产进程或 Pod |
| final projection 首次失败后恢复 | passed | 受控 dependency stub；不是 PostgreSQL 进程停启 |
| projection 队列溢出 | passed | final 优先于已排队 partial，工作量保持有界 |
| projection shutdown 超时 | passed | 有硬截止时间，不阻塞媒体关闭 |

## 5. 回归结果

| 门禁 | 结果 |
| --- | --- |
| LiveKit transport 专项 | `8 passed` |
| AI Agent Python 全量 | `67 passed in 5.41s` |
| 实时语音、双 gateway、投影、治理、部署 Node 合集 | `73 passed` |
| 部署静态合同 | `7 passed`，已包含在 Node 73 项中 |
| TypeScript | `tsc --noEmit`，退出码 `0` |
| Standalone Compose | `docker compose config --quiet`，退出码 `0` |
| Full-platform Compose | 使用仅用于渲染的占位必填值，`docker compose config --quiet`，退出码 `0` |
| Standalone Helm | core + AI profile，`helm lint` 与 `helm template` 通过 |
| Full-platform Helm | 启用 realtime audio tap 的 `helm lint` 与 `helm template` 通过 |
| 工作树格式 | `git diff --check`，退出码 `0` |

验证使用固定 Node 二进制直接运行测试，因为服务器缓存工具链不包含 npm；这不改变测试入口所加载的
源码、tsx loader 或断言。

## 6. 服务器源码 hash

```text
932c15c119c1ea0a3f5c18e6806e58b159e2f4830fbb35341ebab7296d64cf57  services/ai-agent-py/livekit_audio_tap_transport.py
2880fa83eac31aff02bbe20dab2c65ebcced93085116864768e05dce2618fca6  services/ai-agent-py/tests/test_livekit_audio_tap_transport.py
2697e2b2d40845ab35abffc74778301a14647ac720e76976558291f07e518723  src/agent-runtime/ivekit/voice/realtime-speech-projection-dispatcher.ts
ac99722c1bd1004f341cc7deb383750ae80a29816a3c25be5ce52cdb41974400  src/agent-runtime/ivekit/voice/realtime-audio-tap-runtime.ts
d4db63080dfbfb5ca1cf6de300172e845e72500980a1b565b40f4a72708c3ecd  test/ivekit-realtime-speech-projection-dispatcher.test.ts
cfac7196bdb143d21b57979fcd8051ce26962cea15421f1f29b6343e33a644f1  test/ivekit-realtime-audio-tap-deployment.test.ts
```

## 7. 未运行项

1. 实际 PostgreSQL 或 CloudNativePG 进程短停、主备切换和连接池恢复。
2. 独立 gateway 进程、API Pod、AI Agent Pod 或 Kubernetes rolling restart。
3. 真实 LiveKit track、RustPBX RTP、TURN/弱网下的媒体连续性。
4. 真实第三方/自建实时 ASR、翻译、LLM、TTS Provider。
5. 长稳、P50/P95/P99、单机 frontier、Cell-10K 和 MIX-100K。

以上状态保持 `not_run`，不得由本文件的受控结果推导为生产通过。

后续同日验收已完成隔离 PostgreSQL 容器进程停启和实际 Node gateway 子进程重启，见
`docs/evidence/wave3-realtime-process-recovery-server-validation-2026-07-23.md`。本文件保留为
listener/dependency 阶段的历史快照；CloudNativePG 主备、Kubernetes Pod rolling 和真实媒体仍未运行。
