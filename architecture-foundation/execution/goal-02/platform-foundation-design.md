# G02 平台基础设计

## 1. 绑定范围与状态

- Binding Goal：`goals/goal-02-platform-foundation-security-observability.md`
- Goal SHA-256：`742e194e6b2d3e2b6fe9390bbabe96a6bbe0f40bdf99d8ed4ae4060a711a87f9`
- 前置提交：G00 `c10a3a2c636fa0f62f8108a113a729138e367929`；G01
  `051ad988edcc204fbd716f6ea73ce92ec08ab4b2`
- 本文状态：`target_contract`
- Runtime 状态：在本 Goal 的红绿测试完成前为 `not_run`
- Production eligibility：`false`

G02 只建立所有产品域共享的平台护栏，不实现 SIP、codec、RTPengine、LiveKit handoff、
Engagement/Profile 或 Agent 业务。普通 RTP/RTCP/SRTP 数据面不调用本文任何接口。

## 2. Current-state audit

| 领域 | Current source | 处置 | 已确认缺口 |
| --- | --- | --- | --- |
| HTTP identity | `src/middleware/auth.ts`、`src/auth-http.ts`、`src/agent-runtime/security/rbac-store.ts` | `isolate_then_replace` | 未配置 issuer/JWT secret 时会隐式接受开发 Header；空 RBAC membership 有 bootstrap 放行语义；三套 role/capability 词汇；缺 audience、jti、session、revocation、service identity 与 policy version |
| Tenant DB context | `src/db-pg-tenant.ts`、`src/migrations/009_tenant_rls.sql`、`032_runtime_least_privilege.sql` | `reuse_and_harden` | `withPgRequestContext` 在无 context 时允许裸查询；新表的 RLS 不能继承 009，必须逐 migration 证明 |
| Capability | `src/agent-runtime/converact/authorization.ts` | `replace_facade` | 只覆盖少量角色能力；未绑定 authenticated、identity kind、session、tenant、purpose、policy revision |
| Edge-to-Core TLS | `src/agent-runtime/converact/internal-tls.ts` | `reuse_and_extend` | 已强制 client cert/CA/TLS 1.2+ 和 key 文件权限；缺 SAN→service identity、rotation、revocation、expiry 与 PKI/KMS 故障合同 |
| Voice consent | `src/agent-runtime/call-center/compliance/consent-tracker.ts`、`src/recording-policy.ts` | `isolate_then_replace` | consent 查询失败默认允许录音；无 purpose/region/policy revision/lease generation/monotonic deadline |
| Realtime audio grant | `src/agent-runtime/converact/voice/realtime-audio-tap-grant.ts` | `reuse_as_adapter` | 已有 tenant、purpose、consent ref、track、TTL、revision、idempotency；仍以 wall clock 授权，缺短租约、urgent revocation channel 与 policy snapshot |
| Tenant event journal | `src/agent-runtime/converact/tenant-event-store.ts` | `reuse_as_projection` | 有 tenant scope、cursor、retention、visibility；不是跨域权威 event envelope/outbox/inbox |
| Integration events | `src/agent-runtime/converact/integration-events/` | `reuse_worker_patterns` | 有 64 KiB 上限、catalog、lease、SKIP LOCKED、retry；v1 envelope 缺 aggregate revision、ordering、producer identity、trace/purpose/region 与 N/N-1 policy；tenant journal 对同 idempotency key 异 payload 尚未统一报冲突 |
| Audit | `src/agent-runtime/converact/operations/audit/` | `reuse_store_and_chain` | append-only、tenant hash chain、idempotency、redaction 可复用；缺 EffectReceipt 关联、`completed`/`state_observed` 明确阶段、clock quality 与 chain verification evidence |
| SIP effect oracle | `src/agent-runtime/converact/voice/sip-foundation/effect-oracle.ts` | `reuse_as_domain_adapter` | 已体现 prepare/commit/terminal/reconcile 与 owner epoch；不能成为横向 Effect/Usage Authority |
| Billing | `src/agent-runtime/call-center/billing/billing-store.ts` | `isolate_then_replace` | SQLite 月度可变计数无 billing key、generation、writer fence、immutable receipt 或 replay protection |
| CDR convergence | `src/agent-runtime/converact/voice/cdr-convergence.ts` | `reuse_as_input_adapter` | 有序列、owner epoch、payload hash、durable receipt、单次 billing event；不是最终 Billing Authority |
| Recording | `src/agent-runtime/converact/recordings/` | `reuse_and_bind` | capture/upload 隔离、owner epoch、segment generation、checksum、bounded spool 可复用；需绑定 ConsentLease 与唯一 segment billing key |
| Telemetry | `src/telemetry.ts`、`src/metrics.ts` | `reuse_and_harden` | OTLP queue/batch/timeout 有界；旧指标把 `tenant_id` 放入 Prometheus 标签，缺统一 correlation、cardinality budget 与 exporter 故障隔离证明 |
| Readiness/drain | `src/agent-runtime/converact/operations/readiness.ts`、`placement/` | `reuse_patterns` | 已有 migration/readiness/heartbeat/placement drain；尚无跨 Authority active-zero receipt 和平台统一 drain contract |
| Backup/restore | `src/agent-runtime/converact/operations/backup-runner.ts` | `reuse_and_qualify` | 有 checksum、partial marker、empty-target guard 与多 DB/object restore；真实 restore、RTO/RPO、region recovery 均未重新证明 |
| Clock | 分散的 `Date.now()`/`new Date()`，少数 placement 注入 clock | `replace_with_port` | wall/monotonic/RTP clock 未形成统一类型边界；部分名为 monotonic 的默认值仍是 `Date.now` |
| Secret/key | `src/sso-config-store.ts`、env resolvers、`internal-tls.ts`、各 provider resolver | `isolate_behind_port` | OIDC `client_secret` 有明文 SQLite 存储路径；没有统一 key version/rotation/revocation/zeroization/core-dump/native Gate |
| Fault/capacity evidence | 历史 `docs/evidence/*` 与现有 unit tests | `preserve_not_requalify` | G00 映射的 16 份历史 artifact 仅为 `evidence_exists_not_requalified`，不能证明当前 commit 或 production eligibility |

以上处置不授权复制 legacy worktree。G00 映射到 G02 的 543 条要求逐条保留在本 Goal 的
traceability artifact；历史实现和 Evidence 不因存在而升级状态。

## 3. 方案选择

### 3.1 采用：小型深模块 + 现有 domain adapter

新增 `platform-foundation` 深模块只拥有合同、纯判定、时钟和不可变 ledger 语义；现有 audit、
event、recording、placement 和 backup 通过 adapter 接入。每个外部副作用仍由自己的 domain
transaction 提交 outbox/receipt，不建立跨所有域的大事务。

选择原因：

1. 能在不重写现有平台的前提下收紧 fail-closed 行为；
2. 普通媒体数据面没有新的函数调用或同步依赖；
3. identity、event、receipt、clock 可独立测试、迁移和回滚；
4. domain store 保留局部事务和故障域，避免共享总线故障放大。

### 3.2 拒绝：把现有模块全部原样提升为 Authority

现有模块的 tenant、consent、event 和 billing 语义不一致，且包含 fail-open 行为。原样提升会
把历史兼容行为变成新平台合同。

### 3.3 拒绝：建立统一 Platform Service/Database transaction

统一事务会把 DB/Event/Observability 变成同步依赖并扩大故障半径；也会让录音、AI 或计费故障
经共享锁或连接池影响 Human Communication。

## 4. 目标模块边界

```text
authenticated edge/service request
        |
        v
IdentityPolicy.evaluate() ---- RevocationSnapshot
        |
        +--- deny (fail closed + audit intent)
        |
        v
ConsentPolicy.issueLease() ---- wall expiry + monotonic deadline + generation
        |
        v
domain command transaction
        +--- domain state
        +--- versioned outbox event
        +--- accepted EffectReceipt
        |
        v
bounded executor -- completed/state-observed receipt -- immutable UsageEntry
        |
        +--- retry/query/reconcile (never blind retry after unknown)

ordinary RTP/SRTP packet path ---------------------------------> unchanged
```

### 4.1 `clock.ts`

提供 `PlatformClock`：`wallNow()` 只产生可持久化 UTC 时间；`monotonicNowMs()` 只用于本进程
elapsed/deadline。任何持久化 lease 同时保存 wall expiry 和 duration，恢复后重新授权，不持久化
monotonic instant。RTP timestamp 不进入此模块。

### 4.2 `identity-policy.ts`

解析已经过密码学验证的 identity claims，不在模块内读取 JWKS/KMS/DB。纯判定输入包含 Tenant、
subject/service identity、session、token id、issuer/audience、key id、role/capabilities、policy version、
revocation epoch、purpose 和 resource tenant。缺失、过期、跨租户、stale policy/revocation 或未知
capability 一律 deny。

### 4.3 `consent-policy.ts`

把 consent evidence + policy snapshot 编译为短期 `ConsentLease`。每项能力（phone、video、
recording、transcription、translation、AI、tool action）分别授权；一个授权不能推导另一个。
正常撤销通过 versioned event 更新 snapshot；紧急撤销使用签名的独立 control channel。lease 到期
自动 detach 附加能力，不终止 Human Communication。

### 4.4 `event-contract.ts`

只负责 envelope canonicalization、N/N-1 compatibility、ordering key、idempotency/replay 决策和
unknown-event 策略。存储仍由 domain outbox/inbox adapter 拥有。Envelope payload 上限 64 KiB；
未知 major 或 authority 一律 quarantine/fail closed；重复同 hash 返回 replay，重复异 hash冲突。

### 4.5 `effect-usage-ledger.ts`

定义三种 append-only receipt：`accepted`、`completed`、`state_observed`。网络超时产生
`unknown`，必须 query/reconcile。Usage 只从符合 domain rule 的 receipt 派生；billing key 是
O(1) 确定性组合：

- directed media edge：tenant + interaction + edge + generation + direction；
- AI run：tenant + AgentRun + run generation；
- recording segment：tenant + manifest + segment + owner epoch；
- external action：tenant + ActionIntent + attempt generation。

同一 billing key 只允许一个 writer identity/epoch；重复相同 digest 幂等，重复异 digest 冲突。
现有 `BillingStore`、`QuotaStore` 与 Voice CDR billing event 在迁移期只作为订阅/额度投影和
domain input adapter；它们不得自行形成权威 charge、修改已入账 Usage 或绕过 receipt/writer fence。

### 4.6 `correlation.ts`

验证并传播低开销 correlation context；日志/trace 可以包含高基数 ID，Prometheus label 只能包含
合同白名单中的低基数维度。Tenant/Profile/Engagement/Call/Room 等 ID 不进入无界 metric label。
Exporter 使用有界队列，丢 telemetry 时只计 drop，不回压媒体或业务成功路径。

### 4.7 `key-lifecycle.ts`

只保存 versioned KMS/PKI reference 和状态，不保存 raw material。Rotation 是 bounded
dual-read/single-write；SAN、service、audience、key version、expiry 与 revocation 全部匹配后才接受
Edge-to-Core identity。KMS/PKI 故障拒绝新的 stage/activate/destroy，仍允许 fail-closed revocation，
禁止 plaintext downgrade。Native/unsafe slice 必须同时通过 exact source、ABI、memory bound、
zeroize、core-dump disabled、fuzz/sanitizer evidence 与独立 fault isolation Gate。

当前 `sso-config-store.ts` 的明文 OIDC `client_secret` 路径明确为 `not_production_eligible`。
在独立完成 versioned secret-ref migration、rotation/revocation 和回滚测试以前，不得由 ad-hoc
本地加密掩盖该缺口，也不得把它纳入新 Key Lifecycle 的合格路径。

### 4.8 `fault-policy.ts`

把 dependency fault 映射为 `continue_human_media`、`degrade_attachment`、`reject_new_work`、
`query_reconcile` 或 `interrupt_only_owned_edge`。该模块是断言和 admission policy，不是运行时总线。

## 5. 一致性、事务和并发

- Tenant/RLS：应用层先比对 resource tenant，数据库再用 `FORCE RLS`；两层任一未知都拒绝。
- Outbox：domain state 与 outbox 在同一 domain transaction；跨 domain 不共享事务。
- Inbox：`(tenant_id, consumer, event_id)` 唯一；payload digest 不同为冲突，不覆盖。
- Receipt：`(tenant_id, effect_id, stage, generation)` 唯一；stage 只能单调推进。
- Usage：`billing_key` 唯一且不可修改；纠错使用 reversal/credit entry，不更新历史。
- Worker：固定 concurrency、有界 pending、显式 overload；按 tenant/partition 公平轮转，禁止全表扫描。
- Cache：可丢弃的 policy/revocation snapshot；stale 或读取失败时拒绝新附加能力。
- Locks：不得出现媒体热路径全局锁。DB advisory lock 只允许在 audit 等离线 tenant transaction。

预期复杂度：identity/consent/correlation/receipt key 判定为 O(1)；event decode 与 payload bytes
线性；worker claim 与 batch size 线性但严格有界；禁止按全局 Tenant/Call/Profile 数量扫描。

## 6. 故障语义

| 故障 | 已建立 Human Communication | 新动作/附加能力 | 恢复 |
| --- | --- | --- | --- |
| DB/Event/Object Store | 继续；普通媒体不访问它们 | 拒绝需要 durable gate 的新动作；录音 upload 可积压至 spool 上限 | query/reconcile；不得伪造完成 |
| PKI/KMS/identity provider | 既有 packet path 继续；已到期附加 lease detach | 新 session/effect fail closed | key/cert refresh 后重新授权 |
| DNS/config | 已解析且已建立路径继续至自身 lease/TTL | 新连接拒绝或使用签名且未过期 snapshot | 新 generation |
| wall clock jump/skew | monotonic timer 不跳变 | durable timestamp 标记 clock quality；严重 skew 拒绝新 lease | 校时后重新签发 |
| AI/GPU | 人与人媒体继续 | AI tap detach、降级人工 | fenced worker restart |
| recording/upload | 通话继续 | capture 按 bounded spool policy；upload 降级 | checksum + generation reconcile |
| observability | 通话与业务路径继续 | drop telemetry，有界计数 | exporter 恢复后不回放无限 backlog |
| node crash | 外部 RTPengine 所有的 ordinary edge 按其证据语义继续；进程内 owned edge 可中断 | 新 admission 迁移 | owner epoch/fence/takeover |

以上是 target contract，不是当前 production claim；真实 fault/long-run Evidence 未运行时保持
`not_run`。

## 7. 迁移与兼容

1. 先增加纯合同与 adapter，不切换现有请求；
2. 影子评估 identity/event/receipt，记录差异但不产生副作用；
3. 新 session/new effect 使用新合同；旧 session 固定旧 generation；
4. N+1 reader 先部署，随后 N+1 writer；回滚时 writer 只发 N/N-1 交集；
5. drain：停止新 admission → 等 worker/receipt/edge 各自 active-zero → 生成 zero receipt → 关闭；
6. 只有旧 generation active-zero 且 reconcile 无 orphan 后，才删除旧 adapter/schema。

## 8. Verification boundary

本地 unit/property/schema 测试只能把相应条目标为 `verified_local`。真实 Postgres、event bus、
object store、PKI/KMS、DNS、clock fault、long media、multi-node drain、backup restore、region DR、
capacity 与 overload 在取得当前 commit 原始 Evidence 前全部 `not_run`。历史 Evidence 不继承。
