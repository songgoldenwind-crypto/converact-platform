# Wave 1 Kamailio HEP 高水位服务器验证

## 1. 结论

2026-07-25 在隔离 Linux 服务器完成 Kamailio HEP 动态高水位闭环。route-agent 可以根据
HOMER queue、CPU、HEP 包率、接收/处理 gap 和采集失败连续样本，把每个 Edge 的 HEP 模式在
`full -> sampled -> off -> sampled -> full` 之间切换；切换通过 loopback authenticated
JSON-RPC 写入共享 htable，不需要重启或 reload Kamailio。Kamailio 重启时 htable 先以 `off/0`
启动；同一控制器发现远端 revision 丢失后会重放目标状态。route-agent 单独重启时，新的控制器
也从 `off` 启动，在导数预热和恢复迟滞完成前不会把 Kamailio 中保留的保护状态误放宽为 `full`。
本地 desired、远端 confirmed-applied、pending 与 observation-valid 始终独立报告。

结果为 `passed_controlled_server`。这组测试证明观测旁路可动态降级且不阻断 SIP 主路径，不是
RustPBX、Kamailio、HOMER 或整机容量上限证据，固定
`capacity_claim=none`、`production_capacity_evidence=false`。

## 2. 绑定制品

| 制品 | 身份 |
| --- | --- |
| Kamailio 镜像 | `ivekit/kamailio:6.0.7-capacity-ced1eeb0` |
| 镜像 ID | `sha256:7f07e0f0e5d5b1736f91b4e05a4ae984f7ed1511355b29318825b17bd7f2a762` |
| SIPp | `3.7.7-PCAP`，SHA-256 `8e8ecdbe923bf608c844038adfa35c8595400c4629d629f00d51539ac24cdfef` |
| SIP 场景 | `inbound-reject-486-uac.xml`，SHA-256 `970324a194b40851f5a651b6ef92335895c929050b6064b5352c7a4eb42798f8` |
| 渲染配置 | `kamailio.cfg` SHA-256 `fda5353c8d7b9ae9da7bdcdcb1860a66ccea66e973ae15112cfa497a8ff65e4f` |
| 机器证据 | `wave1-homer-hep-high-water-server-validation-2026-07-25.json`，SHA-256 `591b84dfb4fa56c08a4da57806579c87aedfb019d618924c35ba72e14536f53b` |

机器证据还逐项绑定 controller、route-agent、Kamailio renderer、验收脚本和 TLS 渲染文件的
SHA-256。服务器源码目录是 dirty worktree，因此发布时不能只绑定 Git commit，必须同时校验这些
内容哈希。

## 3. 静态门禁

| 门禁 | 结果 |
| --- | --- |
| HEP controller、route-agent、Helm、Compose、监控聚焦测试 | `63/63 passed` |
| 根 TypeScript `tsc --noEmit` | `passed` |
| Helm 启用 sipTrace/highWater 渲染 | `passed`，`64,524` bytes |
| Helm fail-closed 反例 | 缺 high-water 或关闭 NetworkPolicy 均拒绝渲染 |
| Compose fail-closed 反例 | sipTrace 与 high-water 任一单独启用均拒绝编译运行配置 |
| 真实 Kamailio 镜像配置检查 | `passed` |
| 证据 JSON 解析、权限与敏感信息扫描 | `passed` |

Helm 渲染同时验证了 HOMER metrics endpoint、HEP UDP egress、metrics TCP egress 和所有有序阈值；
阈值配置不满足 `recover < sampled < off` 时模板必须失败。

## 4. 运行结果

所有呼叫都使用预期 486 终止的纯 SIP 场景。该场景没有 RTP，用于隔离 HEP 控制行为。

| 阶段 | 模式/修订 | 负载 | SIP 结果 | HOMER 结果 |
| --- | --- | --- | --- | --- |
| 全量参考 | `full/304` | 200 calls，50 CPS | 200 成功，0 失败 | 200 Call-ID，1,600 rows，每会话 8 rows |
| 确定性采样 | `sampled/301` | 1,000 calls，100 CPS | 1,000 成功，0 失败 | 100 Call-ID，800 rows，每会话 8 rows |
| 完全关闭 | `off/302` | 200 calls，50 CPS | 200 成功，0 失败 | 0 Call-ID，0 rows |
| 恢复全量 | `full/303` | 200 calls，50 CPS | 200 成功，0 失败 | 200 Call-ID，1,600 rows，每会话 8 rows |

10% 配置被编译为 `102/1024` 个稳定 hash bucket，有效目标为 `9.9609375%`；本轮实际采样
`10.0%`，位于预设 `7%..13%` 接受区间。每个被采中的 Call-ID 都是完整 8 行，证明采样单位是
完整会话，而不是随机丢弃单条 SIP 消息。

最终 Edge 状态为 `running`、`restart_count=0`、`OOMKilled=false`，模式为 `full/304`。
Edge 最近日志没有 error、critical、panic、fatal 或 OOM；四组 SIPp 均为退出码 0、零失败、
零重传。

## 5. 控制器行为

受控 metrics fixture 先把实际 Kamailio htable 置为 `off/200`，再启动全新的控制器进程，以模拟
route-agent 单独重启。控制器按以下顺序得到并写入实际 htable：

1. 首次观测的导数尚未可比，继续写入 `off/201`；
2. 首个可比 healthy 样本仍保持 `off`；
3. 连续 healthy 样本满足迟滞后逐级进入 `sampled/202`、`full/203`；
4. queue high 立即进入 `sampled/204`；
5. queue critical 立即进入 `off/205`；
6. 连续 healthy 样本再次逐级恢复为 `sampled/206`、`full/207`；
7. 模拟远端 htable revision 重置为 0，同一控制器重放 `full/208`。

每次变更先写 `sample_buckets`，再写 `mode`，最后写单调递增的 `revision`。单元测试另外覆盖
HOMER scrape 连续失败时先 sampled 后 off、导数指标预热时禁止恢复、RPC 写入失败后重试、
并发 poll 单飞、第二步 RPC 失败时 revision 不提交、revision 已提交但响应丢失后的单调恢复，
以及 metrics 响应超时、超限和无凭据访问。RPC 读取只接受真实数值 revision，不把 `null` 或
字符串强制转换为有效版本。

## 6. 运行边界

本轮未执行：

- HEP 持续高负载下的主动 UDP 丢包注入；
- 多小时 HEP soak 和生产数据量 retention 吞吐；
- 独立 generator/SUT；
- 目标 Kubernetes 双 Zone、节点丢失和 PostgreSQL HA failover；
- Cell-10K、MIX-100K；
- Registry 多架构发布、SBOM、签名、provenance 和最终漏洞门禁。

在这些门槛完成前，生产目标仍默认 `sipTrace.enabled=false`。显式启用 HEP 的 Cell 必须同时启用
high-water controller、NetworkPolicy、告警和有限保留策略。
