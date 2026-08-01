# G02 Threat Model

## 1. Scope 与安全目标

保护 Tenant/Identity/Consent/Event/Audit/Billing/Secret/Observability/Recovery 平台边界，同时保证
这些控制面、附加能力和存储故障不会因果性中断已经建立的人与人媒体。本文不声称防护尚未测试的
SIP/RTP/LiveKit 数据面；它只约束平台调用不能进入 ordinary packet hot path。

安全目标按优先级：

1. cross-tenant 数据、token、Room、Call、Evidence、Action 全部 fail closed；
2. 单一 writer、generation/owner epoch/fence 不被 replay 或 stale worker 绕过；
3. consent/purpose/region/retention 独立授权且可及时撤销；
4. Effect/Usage/Audit 可重建、不可静默重复、不可伪造成功；
5. secret/key 不泄漏且不降级 plaintext；
6. 控制面攻击或故障不能放大为 established human media outage。

## 2. Trust boundaries

1. Browser/mobile/customer edge → public API；
2. Kamailio/RTPengine/LiveKit/provider edge → Converact core；
3. Core process → Postgres/event/object store/KMS/PKI/DNS/config/OTLP；
4. Core → AI/GPU/recording/native/unsafe worker；
5. Region/cell → region/cell；
6. Backup/evidence operator → controlled evidence store；
7. build/source/dependency → runtime artifact。

跨 2–5 必须有强 identity、audience、tenant、generation、deadline 与 bounded payload；不能因为位于
内网就信任 Header。

## 3. Threat register

| ID | Threat | Existing exposure | Target mitigation | Gate/status |
| --- | --- | --- | --- | --- |
| T01 | 生产缺 auth config 时伪造 tenant/user Header | `resolveAuthContext` 隐式 dev fallback | production 仅显式、受限 dev mode；缺 config fail closed；claims 与 resource tenant 双检查 | 首批红测；runtime `not_run` |
| T02 | shared media token + unsigned tenant claim 跨租户 | media request tenant 来自 Header/query/body | mTLS service identity + signed tenant/audience capability；禁止 shared bearer 决定 tenant | integration `not_run` |
| T03 | consent store timeout 导致未授权录音 | `recording-policy.ts` catch 后允许 | unknown/timeout deny new capture；已有通话继续 | 首批红测 |
| T04 | stale/duplicate event 重复外部 effect | envelope 缺 ordering/generation/writer | event id + ordering key + aggregate revision + payload digest + inbox uniqueness + query/reconcile | contract/unit `not_run` |
| T05 | unknown event 被旧 reader误接受 | 无统一 N/N-1/unknown policy | unknown major/authority quarantine；minor additive only；fail closed for effects | schema test `not_run` |
| T06 | usage/CDR/recording 重复计费 | mutable counters、多个 event source | deterministic billing key、single writer epoch、immutable usage entry、conflict freeze | ledger test `not_run` |
| T07 | audit tamper/truncation | per-tenant hash chain但无全链验证证据 | verify/export receipt、anchor/checkpoint、idempotent append、legal hold | real store `not_run` |
| T08 | cert/key theft or stale cert | TLS file checks，无 identity mapping/rotation | SAN allowlist、short-lived cert、overlap rotation、revoke/expiry、core dump off、zeroize | PKI rotation `not_run` |
| T09 | KMS/PKI outage triggers plaintext downgrade | 未统一约束 | reject new secure work；never downgrade；existing context only to expiry | fault `not_run` |
| T10 | telemetry cardinality/PII/secret exfiltration | TenantId labels、自动 instrumentation | label allowlist、redaction、bounded exporter、sampling policy、secret-shaped tests | unit/runtime `not_run` |
| T11 | queue/retry amplification | worker实现分散 | fixed concurrency/pending/retry/fanout/deadline；explicit overload + DLQ/query | capacity `not_run` |
| T12 | DB/event/object store starvation affects calls | shared process/connection/CPU pool可能竞争 | bulkhead pools、ordinary media bypass、load shedding、priority/admission | long media fault `not_run` |
| T13 | wall clock jump extends token/consent or breaks timers | Date APIs 混用 | wall/monotonic/RTP types；max lease；clock quality/skew gate | clock test `not_run` |
| T14 | stale worker writes after takeover | 部分模块有 owner epoch，平台无统一合同 | generation + owner epoch + fence on every receipt/write | crash/restart `not_run` |
| T15 | backup restore revives deleted/foreign-region data | backup可 restore，但无 deletion/region proof | manifest region/key/schema, deletion tombstone replay, empty target, post-restore verify | DR `not_run` |
| T16 | native/unsafe crash or memory disclosure | worker和 FFI 证据不统一 | isolate feature/fault domain、bounded memory、fuzz/ABI/source digest、core-dump/zeroize Gate | independent native Gate `not_run` |
| T17 | malicious provider response/payload causes allocation or fanout | provider safety局部实现 | bounded bytes/depth/items/fanout, deadline, schema validation, no recursive retry | property/capacity `not_run` |
| T18 | forged urgent revocation or revocation suppression | 独立 control channel尚未实现 | signed monotonic sequence, audience/tenant/generation, replay window, max ConsentLease TTL | integration `not_run` |
| T19 | DNS/config poisoning changes live owner | snapshot identity/expiry不统一 | signed revision/digest, pin generation, new work only, active session immutable until controlled switch | fault `not_run` |
| T20 | operator/evidence process leaks credentials | runtime access/evidence artifacts可包含 secret | allowlisted evidence fields、redaction scan、hash/source refs、不提交 credentials | artifact tests `not_run` |

## 4. Abuse cases

### Cross-tenant action

攻击者用 Tenant A token 请求 Tenant B resource。Identity policy 在 DB 前比较 resource tenant；RLS
再次限制。两者任一 context 缺失即 403，不允许“系统默认 tenant”或裸查询。Audit 仅记录受控
identity/resource digest，不记录 token。

### Replay/unknown external effect

攻击者重复、乱序或篡改 event。Inbox 先比较 `(tenant, consumer, event_id)` 与 payload digest；同
digest 返回 replay，异 digest 冲突。若 executor timeout，effect 为 `unknown`，只允许 query；query
前禁止重新执行。state-observed receipt 才能解除 unknown。

### Resource exhaustion

攻击者制造大量 provider/webhook/AI/recording work。每个 executor 有 fixed concurrency、pending、
payload、fanout、retry、deadline 和 per-tenant fairness。达到上限拒绝新附加能力；不能排队普通
media packet，不能挤占 RTPengine。

### Consent revocation race

正常 revocation event 延迟时，ConsentLease max TTL 保证自动 detach；紧急通道用签名 sequence
立即 revoke。旧 generation 输出被 fence。撤销 recording/AI 不能发送 BYE 或销毁 Human
Communication owner。

## 5. Key/native/supply-chain review

- 构建固定 source commit、lockfile、binary/image digest；不借 upstream benchmark；
- native/unsafe/FFI 每个 slice 单独列 source、ABI、feature、memory ownership、panic/abort、fuzz、
  sanitizer 与 CVE/license 状态；
- C4 secret buffer 不跨 event/log/prompt/evidence；释放时 zeroize；禁 core dump；
- key/cert rotation、revocation、expiry、PKI/KMS partition 必须实测；
- 未有 exact-source 和原始结果的 slice 保持 disabled/`not_run`。

## 6. Residual risk 与停止条件

任何 open Critical/High、cross-tenant fail-open、plaintext downgrade、两个 billing writer、无界 queue、
stale generation 可提交、secret 出现在 Evidence、或 established media 因附加能力故障终止，均阻断
G02 production eligibility。真实依赖/long-run/region DR 尚未执行本身不是伪装成通过的理由；对应项
保持 `not_run`，但继续完成独立离线工作。
