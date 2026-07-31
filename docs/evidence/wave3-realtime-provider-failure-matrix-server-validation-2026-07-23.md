# Wave 3 实时语音 Provider 故障矩阵服务器验证证据

> 日期：2026-07-23
> 环境：`root@64.225.122.227`
> 源码目录：`/opt/opc-wave123-validation-20260722/source`
> 基线提交：`578a78bf42e3703a9d78fc0766be6a3b3cd5c35e` 加未提交工作树
> 范围：实时 ASR/翻译 WSS adapter、启动路由、背压和断开语义
> 容量声明：`capacity_claim=none`

## 1. 结论

本轮在服务器使用受控 loopback WebSocket Provider，直接验证正式
`ivekit-realtime-speech-v1` adapter、正式 `PolicyRealtimeSpeechRouter` 和正式 Provider 治理存储。
11 个固定检查全部通过：

1. 二进制 PCM audio envelope 与 normalized final event；
2. 429 `provider_rate_limited`；
3. 5xx `provider_transient_failure`；
4. 终态 `provider_rejected`；
5. `provider_auth_failed`；
6. `protocol_mismatch`；
7. 启动 `provider_timeout`；
8. 有界 audio queue overflow；
9. retryable 启动期 failover；
10. terminal 启动错误不 failover；
11. 已建立会话断开后 degraded，不在音频中途切换 Provider。

报告固定为 `verification_scope=controlled_loopback_realtime_provider` 和
`real_vendor_evidence=false`。它不证明真实供应商、真实媒体、弱网、延迟或容量。

## 2. 服务器与输入

| 输入 | 值 |
| --- | --- |
| UTC 时间 | `2026-07-23T09:19:26Z` |
| 北京时间 | `2026-07-23T17:19:37+0800` |
| Node.js | `v24.18.0` |
| 验收脚本 SHA-256 | `9369369633e3facaf166388e8674a646c3d181df2aac556bdc166438ebb8eb00` |
| 验收测试 SHA-256 | `042f3d0e6cbe7f4eeaa4dd80dff94a602601c226aa938397d8e5275fc7e0b194` |
| WSS adapter SHA-256 | `462716cabd4e63bf44f26465cf0e713d3f49e16597ea290f5316b3745d8c923a` |
| Voice errors SHA-256 | `c7a9b966937149346f83b7b83da6d181e5c5b4e34ecd29b60cfa1fbd79f7ddcc` |
| adapter test SHA-256 | `b726018282c4ce20ffbb82ba36a7ae2bad810473aef63192f6b04637700370a0` |
| package.json SHA-256 | `43681054e135641b8e082d0cb1ec9d2bff9fd699b2088b56cf5b989d55d8870a` |

工作树尚未提交，因此基线提交只标识起点，文件 hash 才是本轮服务器实际输入。该证据不能作为
发布 commit、Registry 制品或签名供应链证据。

## 3. TDD 与服务器结果

| 检查 | 结果 |
| --- | --- |
| RED | 新测试首次运行因验收模块不存在，以 `ERR_MODULE_NOT_FOUND` 失败 |
| GREEN 合同测试 | `1/1` passed |
| 验收命令 | `status=passed`，11/11 checks passed |
| 实时语音与 audio tap 回归 | `51/51` passed，0 failed，0 skipped |
| TypeScript | `tsc --noEmit` 退出码 `0` |
| Diff 静态检查 | 相关文件 `git diff --check` 退出码 `0` |

验收命令：

```bash
npm run ivekit:realtime-speech-provider-acceptance
```

服务器实际使用等价的固定 Node 入口：

```bash
/opt/opc-wave123-validation-20260722/cache/toolchain/bin/node \
  --import tsx scripts/ivekit-realtime-speech-provider-acceptance.ts
```

服务器系统 `PATH` 未提供 `npm`，缓存工具链也只固定了 Node 二进制，因此本轮没有用
`npm run` 包装器执行；合同测试已验证 package script 精确映射到上述 Node 入口。该环境差异不影响
验收逻辑，但后续把工具交给人工直接运行前应提供 npm/Corepack 或继续使用固定 Node 命令。

## 4. 安全与故障边界

- loopback Provider 的 URL、Authorization、token、原始错误、音频和 transcript 不进入报告；
- 第三方生产 profile 仍强制 WSS，本轮 `ws://127.0.0.1` 只用于 self-hosted loopback 验收；
- 音频写入保持同步非阻塞，超限返回 `dropped_overflow`；
- 429/5xx 允许启动期按租户 route failover，终态和认证错误不切换；
- 已建立会话断开后只关闭辅助链路并发出 `provider.degraded`，不自动把同一音频流拼到后备
  Provider；
- 所有临时监听器和 socket 在每项检查后关闭，没有启动 Docker 验证容器。

## 5. LED 不变量

验收结束后服务器运行容器仍精确为：

```text
led-platform-admin-1
led-platform-api-1
led-platform-edge-1
led-platform-minio-1
led-platform-postgres-1
led-platform-system-tasks-1
led-platform-web-1
```

共 7 个，未发现 OPC 或受控 Provider 验证容器。

## 6. 保留的 `not_run`

- 真实 third-party/self-hosted WSS ASR/翻译 Provider 与凭据；
- 真实 RustPBX RTP、LiveKit subscribed track、TURN 和客户端字幕；
- 真实 429、DNS、TLS、慢首包、断流、区域故障和 loss/jitter；
- PostgreSQL 短停、gateway 进程重启、多副本滚动和长稳；
- 准确率、P50/P95/P99、资源曲线、单机 frontier、Cell-10K 和 MIX-100K。

因此本轮状态是 `implemented_controlled_server`，不是生产 Provider、真实媒体或容量验收完成。
