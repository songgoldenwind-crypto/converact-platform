# LiveKit 生产网络与独立媒体底座设计

> 状态：本地实现完成；真实服务器与客户端验收待执行
>
> 日期：2026-07-11
>
> 适用范围：OPC 与后续 LED 项目共用的 iveKit Media Core

## 1. 背景与目标

OPC 已具备 LiveKit 房间、参与人、Token、录制、Webhook、浏览器视频、语音、屏幕共享以及远程协助媒体会话等业务能力，也已经有 Compose、Kubernetes、Egress、MinIO 和部署预检代码。但当前部署配置仍不能作为可直接上线的生产媒体底座。

本设计解决以下问题：

1. 让浏览器拿到真正可访问的公网或企业网 `wss://` LiveKit 地址，而不是容器内地址。
2. 为自建 LiveKit 补齐 TLS/WSS、ICE TCP/UDP、TURN/TLS、TURN/UDP 和 NAT 配置。
3. 让 LiveKit、Egress、Redis、MinIO 的配置遵循同一套版本和 schema。
4. 明确单机 Linux 与 Kubernetes 两种部署方式，避免用普通 Web 服务的方式部署 WebRTC SFU。
5. 让媒体底座可以独立部署并被 OPC、LED 或其它系统复用。
6. 在不连接真实服务器的阶段，尽可能通过静态检查、契约测试和本地渲染门禁提前发现错误。

本设计不包含：

- 数字人能力。
- Tinode IM、OCR、ASR、AI 质检。
- RustDesk 远控链路。
- 本次直接上传或连接真实服务器。
- 多地域媒体调度和全球流量加速。

## 2. 审计依据

本次审计以当前仓库代码和 LiveKit 官方资料为准：

- [LiveKit production deployment](https://docs.livekit.io/transport/self-hosting/deployment/)
- [LiveKit ports and firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/)
- [LiveKit virtual machine deployment](https://docs.livekit.io/transport/self-hosting/vm/)
- [LiveKit Kubernetes deployment](https://docs.livekit.io/transport/self-hosting/kubernetes/)
- [LiveKit distributed deployment](https://docs.livekit.io/transport/self-hosting/distributed/)
- [LiveKit Egress deployment](https://docs.livekit.io/transport/self-hosting/egress/)
- [LiveKit server config sample](https://github.com/livekit/livekit/blob/master/config-sample.yaml)
- [LiveKit Egress config](https://github.com/livekit/egress)

官方约束中与本项目直接相关的结论：

1. 浏览器生产入口必须使用受信任证书的 `wss://`。
2. LiveKit 信令端口应放在支持 WebSocket 的 TLS 终止层后面。
3. ICE UDP、ICE TCP 和 TURN 不是普通 HTTP 流量，不能只靠现有 HTTP Ingress 或 Kong 解决。
4. LiveKit 自带与信令鉴权集成的 TURN 服务，当前没有必要增加 coturn。
5. 单机生产部署推荐 Linux host networking；官方 VM 方案使用 `livekit/caddyl4`。
6. Kubernetes 中 LiveKit Pod 需要直接使用节点网络，官方推荐独立 LiveKit Helm chart。
7. Redis 是 LiveKit 多节点、Egress 调度和消息总线的共同依赖。

## 3. 当前审计结论

### 3.1 P0：内部地址被返回给浏览器

当前 `src/agent-runtime/livekit/config.ts` 只有一个 `url`。它同时用于：

- `RoomServiceClient`、Egress、AI Agent 等服务端连接。
- `issueLiveKitToken()` 返回的 `livekit_url`。
- 浏览器 `room.connect(livekit_url, token)`。

生产 Compose 给 OPC 配置的是：

```text
LIVEKIT_URL=ws://livekit:7880
```

该地址只在 Docker 网络内有效。Token API 会把它原样返回给外部浏览器，浏览器无法解析 `livekit` 容器名，也不能在 HTTPS 页面连接明文 `ws://`。

结论：当前 Compose 即使所有容器都正常，真实浏览器仍可能无法加入房间。

### 3.2 P0：生产 Compose 没有媒体边缘入口

`infra/docker-compose.production.yml` 当前直接映射 `7880`、`7881/tcp` 和 `7882-7892/udp`，但没有：

- 信令 `wss://` 入口。
- 受信任 TLS 证书和自动续期。
- TURN/TLS 和 TURN/UDP。
- 两个域名的 SNI 路由。
- Linux host networking 生产模式。

现有配置只能作为内网联调基础，不能命名为已完成的公网生产媒体部署。

### 3.3 P0：仓库自带 Kubernetes LiveKit 模板不是生产拓扑

当前模板存在以下问题：

- LiveKit 使用普通 `Deployment` 和 `ClusterIP Service`。
- 没有 `hostNetwork: true`。
- 没有为 ICE UDP 范围提供正确的节点级暴露。
- 没有 LiveKit 公网 WSS 入口。
- 没有 TURN/TLS、TURN/UDP 和证书 Secret。
- 通用 `ingress.yaml` 只认识 OPC 和 frontend HTTP 后端。
- LiveKit 固定单副本，未提供节点调度、优雅下线和媒体节点约束。

它可以保留给开发环境，但不能继续作为 Kubernetes 生产方案。

### 3.4 P0：Kubernetes Egress 配置落后于当前 schema

Compose 渲染器使用当前 Egress schema：

```yaml
logging:
  level: info
redis:
  address: redis:6379
storage:
  s3:
    bucket: recordings
```

Kubernetes 模板仍使用旧式顶层 `log_level` 和 `s3`，并且缺少 Redis。当前 Egress 依赖 Redis 与 LiveKit 发现和调度任务，这会导致录制请求无法稳定找到 Egress worker。

### 3.5 P1：预检混淆内部连接和浏览器连接

`scripts/livekit-deployment-preflight.ts` 当前只检查一个 `LIVEKIT_URL`，并同时描述为浏览器和服务端地址。它接受 `ws://` 和 `wss://`，因此生产环境配置 `ws://livekit:7880` 也能通过静态预检。

预检目前也没有检查：

- 生产公开地址是否为 `wss://`。
- TURN 是否启用。
- TURN 域名和证书输入是否完整。
- 配置选择的是单机 host-network 模式还是外部 LiveKit 模式。
- 镜像版本是否固定。

### 3.6 P1：镜像版本不可复现

当前组合包含：

- `livekit/livekit-server:v1.8`
- `livekit/egress:latest`
- `livekit/sip:latest`

这会让同一份代码在不同日期拉取到不同 Egress/SIP 行为，也可能让较老 Server 与较新 Egress 组合超出已验证兼容范围。

### 3.7 P1：Egress 运行门禁不完整

当前生产 Compose 的 Egress 没有：

- 明确 `health_port` 和 healthcheck。
- 当前官方文档要求的 Chrome sandbox 容器能力配置。
- 失败录制的 backup storage 策略。
- 固定资源额度和并发容量说明。

这些问题不影响业务 API 编译，但会直接影响房间合成录制。

## 4. 架构决策

### 4.1 决策 A：拆分内部地址与公开地址

新增明确的双地址契约：

| 环境变量 | 用途 | 示例 |
| --- | --- | --- |
| `LIVEKIT_URL` | OPC、AI Agent、SIP、Egress 等服务端连接 | `ws://livekit:7880` |
| `LIVEKIT_PUBLIC_URL` | 返回给浏览器和移动端 SDK | `wss://livekit.example.com` |
| `OPC_LIVEKIT_URL` | 内部地址兼容别名 | `ws://livekit:7880` |
| `OPC_LIVEKIT_PUBLIC_URL` | 公开地址兼容别名 | `wss://livekit.example.com` |

代码模型调整为：

```ts
interface LiveKitConfig {
  url: string | null;
  publicUrl: string | null;
  apiKey: string | null;
  apiSecret: string | null;
}
```

解析规则：

1. `url` 只从 `LIVEKIT_URL` 或 `OPC_LIVEKIT_URL` 读取。
2. `publicUrl` 只从 `LIVEKIT_PUBLIC_URL` 或 `OPC_LIVEKIT_PUBLIC_URL` 读取。
3. 开发和测试环境允许 `publicUrl` 回退到 `url`，保持现有本地开发兼容。
4. 生产环境禁止回退，缺少独立公开地址时 fail-closed。
5. 生产 `publicUrl` 必须使用 `wss://`。
6. 不强制公开地址必须是公网 IP，允许企业内网 DNS 和受信任企业证书。

使用规则：

- Token、Join Plan 和前端连接响应只返回 `publicUrl`。
- RoomService、Webhook、Egress、SIP 和 Agent 使用 `url`。
- `isLiveKitConfigured()` 继续表示服务端能力可用。
- 新增浏览器连接就绪判断，要求服务端配置和 `publicUrl` 同时有效。

对外 API 字段仍叫 `livekit_url`，不破坏 OPC 和 LED 的 SDK 合同，只修正字段值来源。

### 4.2 决策 B：媒体底座支持三种部署模式

#### 模式 1：external

OPC 不启动 LiveKit Server/Egress，只消费独立媒体平台提供的地址和凭证。

适用场景：

- OPC 和 LED 共用同一套媒体底座。
- 媒体服务单独扩容、升级和运维。
- Kubernetes 生产部署。

这是长期推荐模式。

#### 模式 2：standalone-vm

仓库提供独立 `infra/livekit/` 单机 Linux 部署包，遵循官方 VM 拓扑：

```text
Browser
  -> livekit.example.com:443
  -> livekit/caddyl4
  -> LiveKit signal :7880

Restricted network browser
  -> turn.example.com:443
  -> livekit/caddyl4
  -> LiveKit embedded TURN/TLS

Direct media
  -> ICE/TCP :7881
  -> ICE/UDP configured range
  -> TURN/UDP :3478
```

LiveKit、Caddy L4 和 Redis 使用 host networking。Egress 可以独立运行，并与 LiveKit 使用同一个 Redis。OPC 通过可配置的内部地址访问该底座。

适用场景：

- 第一版单台 Linux 云主机。
- 需要最快获得完整 WSS、TURN 和录制能力。
- 后续把媒体底座整体交给 LED 项目使用。

#### 模式 3：bundled-dev

保留现有 Compose/Kubernetes 简化部署，只用于本地开发、单元测试和无公网环境联调。文档、配置和 preflight 必须明确标记它不具备生产网络保证。

### 4.3 决策 C：TURN 使用 LiveKit embedded TURN

第一版不增加 coturn，原因如下：

1. LiveKit 内置 TURN 与房间信令鉴权集成，不需要维护独立静态用户体系。
2. 官方 VM 和 Kubernetes 方案都直接支持 embedded TURN。
3. 减少一个状态、密钥和升级边界。
4. 满足 TURN/TLS 和 TURN/UDP 的连接覆盖要求。

只有出现以下需求时再评估 coturn：

- 多个非 LiveKit WebRTC 系统共用 TURN。
- 需要独立 TURN 容量池和计费。
- 现有企业网络已经有统一 TURN 基础设施。

### 4.4 决策 D：单机边缘使用 `livekit/caddyl4`

普通 Caddy/Nginx HTTP 反向代理不能完整处理同一 `443/tcp` 上的 LiveKit WSS 与 TURN/TLS。采用 LiveKit 官方 VM 方案中的 `livekit/caddyl4`，按 SNI 区分：

- `livekit.example.com`：HTTPS/WSS 信令。
- `turn.example.com`：TURN/TLS。

证书由边缘组件通过 ACME 获取并续期。两个域名都必须解析到媒体节点公网 IP。

### 4.5 决策 E：Kubernetes 生产使用官方 Helm

不继续扩展仓库内的普通 LiveKit Deployment 来模拟生产 SFU。生产部署使用：

- LiveKit 官方 server Helm chart。
- LiveKit 官方 Egress Helm chart。
- 独立 Redis 或现有受控 Redis。
- 官方 chart 支持的 LoadBalancer、host networking、TURN TLS Secret 和优雅下线。

OPC Helm chart 只负责消费：

```yaml
livekit:
  enabled: false
  url: ws://livekit-livekit-server.media.svc.cluster.local:7880
  publicUrl: wss://livekit.example.com
  apiKeySecretRef: livekit-credentials
```

仓库自带 LiveKit/Egress 模板保留为开发模式，并修正明显 schema 错误，避免开发环境误导。

### 4.6 决策 F：镜像使用显式兼容矩阵

禁止媒体生产服务使用 `latest`。新增一个集中版本清单，至少固定：

- LiveKit Server。
- LiveKit Egress。
- LiveKit SIP。
- `livekit/caddyl4`。
- Redis 和 MinIO。

第一轮本地实现已固定以下候选版本：

- LiveKit Server `v1.13.3`。
- LiveKit Egress `v1.13.0`。
- LiveKit SIP `v1.6.0`。
- `livekit/caddyl4` `v2.11.3`。
- Redis `7.4.9`。

这些 tag 已通过静态渲染和契约测试，但 Docker daemon 未运行，尚未完成配置启动、双浏览器、录制和 SIP smoke。因此它们是“已固定候选版本”，不是“真实环境已验证版本”。

### 4.7 决策 G：Egress 使用当前配置 schema

统一 Compose、独立 VM 和开发 Kubernetes 模板：

```yaml
logging:
  level: info
api_key: ${LIVEKIT_API_KEY}
api_secret: ${LIVEKIT_API_SECRET}
ws_url: ws://127.0.0.1:7880
insecure: true
redis:
  address: 127.0.0.1:6379
health_port: 8091
storage:
  s3:
    endpoint: http://minio:9000
    bucket: recordings
    force_path_style: true
```

容器同时增加：

- `SYS_ADMIN` capability，满足当前 Chrome sandbox 要求。
- `health_port` 对应的健康检查。
- CPU/内存资源建议。
- 可选 backup storage 挂载。

### 4.8 决策 H：网络验收区分静态、连接和媒体三层

#### 第一层：静态配置门禁

不访问网络，适合本地和 CI：

- 内部 URL 与公开 URL 分离。
- 生产公开 URL 是 `wss://`。
- 两个域名、TURN 开关、端口和证书输入一致。
- Compose 和渲染后的 YAML 语法正确。
- 镜像无 `latest`。
- Egress 与 LiveKit 使用同一个 Redis 地址。

#### 第二层：网络连接门禁

只在明确开启时访问目标环境：

- DNS 解析。
- 信令 TLS 证书链和有效期。
- WSS 握手。
- ICE TCP/UDP 端口探测。
- TURN/TLS 与 TURN/UDP 入口存在。

#### 第三层：真实媒体门禁

必须在服务器和真实浏览器执行：

- 两个不同网络的浏览器加入同一房间。
- 双向语音、视频、屏幕共享。
- 断开 UDP 后回退 ICE/TCP。
- 强制 relay 后确认选中的 candidate pair 为 TURN relay。
- 启停 Egress 并确认 MinIO 对象可读、可导出。
- 重启 LiveKit/Egress 后验证房间和录制任务的预期行为。

静态门禁通过不能替代第二层和第三层。

## 5. 代码边界

### 5.1 业务代码

预计修改：

- `src/agent-runtime/livekit/config.ts`
- `src/agent-runtime/livekit/token-service.ts`
- `src/agent-runtime/livekit/types.ts`
- `src/agent-runtime/livekit/index.ts`
- iveKit Media 能力摘要和 HTTP SDK 类型

主要约束：

- 不修改现有 `livekit_url` API 字段名。
- 不新增数据库迁移。
- 不把 TLS、TURN 或部署细节泄漏到领域层。
- 依赖注入测试仍可只传一个 URL；测试 helper 负责补齐 `publicUrl`。

### 5.2 部署代码

预计新增或修改：

- 独立 `infra/livekit/` VM 部署包。
- `scripts/render-media-configs.ts`。
- `infra/docker-compose.production.yml` 的 external/bundled 模式边界。
- `infra/k8s/values.yaml` 和 OPC deployment 的双地址输入。
- 开发 K8s Egress schema。
- 镜像版本清单和静态扫描。

### 5.3 验收代码

预计修改：

- `scripts/livekit-deployment-preflight.ts`。
- `scripts/video-readiness-suite.ts`。
- 浏览器 smoke 的 relay 证据采集。
- 配置渲染和 Compose/Kubernetes 静态测试。

## 6. 实施阶段

### 阶段 1：地址契约和 fail-closed

1. 先写测试证明当前内部地址会泄漏给浏览器。
2. 增加 `publicUrl` 配置和解析规则。
3. Token/Join 响应改用公开地址。
4. 服务端 SDK 保持使用内部地址。
5. 生产缺少 `LIVEKIT_PUBLIC_URL` 或使用 `ws://` 时明确失败。

### 阶段 2：Egress 和版本可复现

1. 修正 Kubernetes Egress schema 和 Redis。
2. 为 Compose Egress 增加 healthcheck、capability 和资源说明。
3. 移除媒体生产服务的 `latest`。
4. 增加版本兼容矩阵文档和静态扫描。

### 阶段 3：独立 VM 媒体底座

1. 增加 LiveKit/Caddy L4/Redis/Egress 配置渲染。
2. 支持信令域名、TURN 域名、ACME 邮箱和 webhook 地址。
3. 支持 embedded TURN/TLS、TURN/UDP 和 ICE TCP/UDP。
4. 生成防火墙清单和脱敏 preflight 报告。
5. 保证媒体底座可在没有 OPC 源码的情况下独立启动。

### 阶段 4：Kubernetes 外部媒体集成

1. OPC chart 增加 `livekit.publicUrl`。
2. 生产 values 示例改用官方 LiveKit/Egress Helm。
3. 自带 LiveKit 模板标记为开发用途。
4. 增加生产模式误启 bundled LiveKit 的 fail-closed 校验。

### 阶段 5：真实环境验收

此阶段保留到用户允许上传或连接服务器后执行：

1. DNS、证书、WSS、TURN 和防火墙。
2. 双浏览器媒体与屏幕共享。
3. 强制 TURN relay。
4. Egress 到 MinIO。
5. 多副本、故障切换和容量测试。

## 7. 测试要求

### 7.1 单元测试

- 开发环境允许公开地址回退。
- 生产环境不允许回退。
- 生产只接受 `wss://` 公开地址。
- Token、普通 Join、主管监听/插话/耳语都返回公开地址。
- RoomService、录制和 Agent dispatch 仍使用内部地址。
- 配置和错误消息不泄漏 API Secret。

### 7.2 配置测试

- LiveKit YAML 包含 Redis、RTC、TURN、webhook 和 logging。
- Egress YAML 包含当前 `logging`、`redis`、`storage.s3`。
- 独立 VM Compose 使用 host network。
- Caddy L4 同时包含 signal 和 TURN SNI。
- 生产镜像全部固定版本。
- Kubernetes 生产示例禁用 bundled LiveKit。

### 7.3 回归测试

- Node 全量测试。
- TypeScript typecheck。
- 前端 build。
- Python、Go、Rust sidecar 检查。
- Compose profiles 静态解析。
- 文档与 env 示例键名扫描。

## 8. 完成定义

代码级完成必须同时满足：

1. 公开/内部 URL 已拆分，所有浏览器 Join 路径都有测试。
2. 生产 preflight 不再接受单一内部 `ws://` 作为完整配置。
3. Egress 配置遵循当前官方 schema，并有 Redis 和健康检查。
4. 单机独立媒体部署包可完整渲染，配置中没有默认弱口令和 `latest`。
5. Kubernetes 生产方案明确使用官方 chart，OPC 能消费外部 Media Core。
6. 全量本地回归通过。
7. 文档明确标记真实 WSS、TURN、双浏览器和录制仍待服务器验收。

真实生产完成还必须满足：

1. 可信 TLS 证书和 DNS 生效。
2. 不同网络浏览器真实双向音视频成功。
3. 强制 TURN relay 成功。
4. 录制对象真实写入并可读取。
5. 故障切换和容量达到目标。

## 9. 风险与回滚

| 风险 | 控制措施 |
| --- | --- |
| 新增公开地址后旧环境启动失败 | 只在 production fail-closed，开发测试保留回退 |
| LiveKit/Egress 升级引入兼容变化 | 固定版本、版本矩阵、真实 smoke 后才标记已验证 |
| host network 与现有端口冲突 | 独立媒体部署包先做端口 preflight |
| DNS 或 ACME 未准备好 | 静态配置可生成，但 readiness 明确失败，不降级为明文 WS |
| TURN 443 与 HTTPS 443 冲突 | 使用官方 Caddy L4 SNI 分流和两个域名 |
| Kubernetes 自带模板被误用于生产 | production values 校验直接拒绝 bundled 模式 |

回滚策略：

- `LIVEKIT_PUBLIC_URL` 的业务改动可以回滚到旧版本，数据层无迁移。
- 独立媒体底座版本通过镜像 tag 回滚。
- LiveKit Server/Egress 必须按兼容矩阵成组回滚。
- 不在回滚中删除 Redis、MinIO 或录制对象。

## 10. 推荐结论

建议按本设计实施，不再引入 coturn，也不继续把仓库内普通 Kubernetes Deployment 扩展成生产 LiveKit。第一优先级是修复内部地址被返回给浏览器的问题；随后补齐 Egress、固定版本和独立 VM 媒体底座；Kubernetes 生产直接接官方 Helm。

这样得到的不是只服务 OPC 的一组页面功能，而是一套可以独立部署、由 OPC 与 LED 共同消费的 Media Core。
