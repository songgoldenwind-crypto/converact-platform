# Wave 3 实时音频旁路服务器验证证据

> 日期：2026-07-23
> 环境：`root@64.225.122.227`
> 源码目录：`/opt/opc-wave123-validation-20260722/source`
> 范围：RustPBX/LiveKit PCM 旁路、授权、运行时、指标、Helm 与 Compose 静态/受控服务器回归
> 容量声明：`capacity_claim=none`

## 1. 验证边界

本轮证明以下代码和部署合同在受控服务器成立：

1. LiveKit 与 RustPBX 双网关共享统一实时语音 Provider 路由。
2. LiveKit token 绑定 tenant、call、room、participant、track、短 TTL 和一次性 nonce。
3. Kubernetes token 使用 Pod 派生密钥，并返回签发 Pod 的 headless DNS。
4. Provider 启动慢时使用有界 pre-start/track queue，旁路丢帧而不反压主媒体读取。
5. Python LiveKit `AudioStream` 采集、LAT1 PCM 编码、重授权和有界重连合同成立。
6. 两套 Helm 和两份 Compose 能生成一致的运行配置。
7. 旁路失败、丢弃和重放拒绝具备低基数指标、告警与 Grafana 查询。

本轮不证明真实 LiveKit 房间、真实 RustPBX RTP、真实外部流式 ASR/翻译、弱网、吞吐、容量或
P50/P95/P99。上述项目保持 `not_run`。

## 2. 不可变工具输入

| 工具 | 输入 |
| --- | --- |
| Node.js | 服务器缓存 `/opt/opc-wave123-validation-20260722/cache/toolchain/bin/node` |
| Python | `python:3.12-slim@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de` |
| Helm | `alpine/helm@sha256:e7ecbf4a200dea73d64bfb8cb0936829164945f2b4d02a0274093073ee8d264f` |
| Python WebSocket | `websockets==15.0.1` |
| pytest | `pytest==8.4.2`、`pytest-asyncio==1.2.0` |

## 3. TypeScript 回归

执行：

```bash
node --import tsx --test \
  test/ivekit-realtime-audio-tap-runtime.test.ts \
  test/ivekit-livekit-realtime-audio-tap-gateway.test.ts \
  test/ivekit-realtime-audio-tap-gateway.test.ts \
  test/ivekit-voice-metrics.test.ts \
  test/ivekit-livekit-realtime-audio-tap-api.test.ts \
  test/ivekit-realtime-audio-tap-server-wiring.test.ts \
  test/ivekit-realtime-audio-tap-deployment.test.ts
```

结果：`25 passed, 0 failed`。

覆盖：

- host 创建、查询和撤销 consent-scoped grant；
- system worker 只能为 active call participant 的一条 track 取得 token；
- LiveKit/RustPBX 网关认证、协议、慢 Provider 缓冲和非阻塞丢弃；
- token 篡改、过期、同 Pod replay 与跨 Pod 派生密钥隔离；
- 双网关启动、回滚和 shutdown；
- 服务器路由接线；
- 指标标签白名单；
- standalone/full-platform Helm 与 Compose 的 Pod/headless/NetworkPolicy 合同。

随后执行：

```bash
node node_modules/typescript/bin/tsc --noEmit
```

结果：退出码 `0`，无 TypeScript 错误。

## 4. Python 回归

在固定 Python 镜像中安装固定测试依赖后执行：

```bash
python -m compileall -q .
pytest -q \
  tests/test_livekit_audio_tap.py \
  tests/test_livekit_audio_tap_transport.py
```

结果：`8 passed in 0.17s`，`compileall` 退出码 `0`。

覆盖：

- metadata/consent/call/feature 严格解析；
- 已存在和后订阅 LiveKit 音轨；
- 每 track 有界队列和最老帧丢弃；
- PCM16LE/16 kHz/LAT1 编码；
- authorization 响应和 WebSocket subprotocol 校验；
- 发送失败后申请新的一次性 token 并有界重连；
- 启动失败清理和旁路关闭。

## 5. Helm 与 Compose

Standalone Chart：

- `helm lint` 使用 core + AI profile：`1 chart(s) linted, 0 failed`；
- `helm template` 成功渲染两副本 API、3010 内部端口、Pod name 实例 ID、Pod 直连
  `ws://$(POD_NAME).ivekit-ivekit-audio-tap.communications.svc:3010/...`、headless Service 和
  AI Agent-only NetworkPolicy；
- Voice + AI profile 额外渲染每个 RustPBX Pod 的 `realtime-audio-tap-gateway` sidecar，
  RustPBX 与 sidecar 共享 memory `emptyDir` UDS；API Pod 不再分配无用的 UDS 卷。

Full-platform Chart：

- 使用 synthetic 非生产值渲染成功；
- 生成 Pod 直连
  `ws://$(POD_NAME).opc-opc-audio-tap.communications.svc:3010/...`、headless Service和
  AI Agent-only NetworkPolicy；
- 启用 Voice + realtime audio tap 后成功渲染 RustPBX 专用 gateway sidecar、受限 renderer
  参数和 Pod-local memory UDS。

Compose：

```bash
docker compose --env-file services/ivekit-service/env.example \
  -f services/ivekit-service/docker-compose.yml config --quiet

docker compose -f infra/docker-compose.production.yml \
  config --no-interpolate --quiet
```

两条命令退出码均为 `0`。3010 只在 Compose service 网络暴露，没有发布为宿主机端口。
Voice overlay 与完整平台 Compose 还验证了 RustPBX/iveKit 同时挂载
`realtime_audio_tap:/run/ivekit`，RustPBX renderer 输出 socket、队列容量和发送超时边界。

## 5.1 RustPBX 部署闭环增量回归

服务器执行运行时、renderer、部署、入口与 standalone source graph 合并回归：

```bash
node --import tsx --test \
  test/ivekit-realtime-audio-tap-runtime.test.ts \
  test/ivekit-voice-deployment.test.ts \
  test/ivekit-realtime-audio-tap-deployment.test.ts \
  test/ivekit-server-entrypoint.test.ts \
  test/ivekit-standalone-source-graph.test.ts \
  test/ivekit-standalone-build-context.test.ts
```

首次增量结果为 `46 passed, 0 failed`；加入既有 gateway/API/metrics/monitoring 契约后的最终
合并回归为 `65 passed, 0 failed`。随后全量 `tsc --noEmit` 退出码为 `0`，Standalone 与
full-platform Voice/realtime-audio-tap Helm 实际渲染成功，两套 Compose
`config --no-interpolate --quiet` 均退出 `0`。

最后在固定 Node 24 镜像内执行 standalone context 生成、`npm ci` 和 `tsc` 构建验证，结果
`status=passed`、`source_files=383`，并确认产物包含
`dist/ivekit-realtime-audio-tap-worker.js`。这证明 sidecar 使用的编译入口已进入独立 iveKit
交付图，而不是只存在于 OPC 根仓源码中。

## 6. 故障隔离结论

代码合同证明媒体读取任务与 Provider/WebSocket 发送任务分离，并以有界队列连接。旁路失败会产生
`tap.session.failed`、`tap.gateway.error` 或 dropped-seconds 指标；主媒体不会等待 Provider、数据库、
对象存储或 NATS。本结论仍需在真实媒体环境用 packet/track continuity observation 复核，不能只用
单元测试宣称通话或视频在所有故障下连续。

## 7. 保留的 not_run

- 真实 LiveKit 双端音频和多 track `AudioStream`；
- 真实 RustPBX 双腿 RTP PCM tap；
- 外部实时 ASR、实时翻译以及 third-party/self-hosted failover；
- Provider 高首包延迟、断流、429、超时和恢复期间的主媒体连续性；
- API Pod 滚动、3010 网络阻断、AI Agent 重启和跨 Zone；
- P50/P95/P99 partial/final latency、丢弃率、重连成功率、单机连接上限；
- Cell-10K/MIX-100K 容量和横向扩展边际。

因此当前状态是 `implemented_controlled_server`，不是生产媒体验收完成。
