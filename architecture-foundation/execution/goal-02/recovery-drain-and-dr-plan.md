# G02 Recovery、Drain 与 DR 计划

## 1. 状态和目标声明

本文给出 target contract。Evidence index 已将一次冻结检查点恢复、一次固定主机控制面容量和一次
固定主机多进程 drain/node-loss 切片限定为 `verified_controlled`；这不证明 continuous-write PITR、
long-run、已部署 multi-node/fleet drain、region recovery、SIP/media/fleet capacity 或 production
eligibility，后述未测范围均保持 `not_run`。

| 数据/能力 | Target RPO | Target RTO | established media contract |
| --- | --- | --- | --- |
| identity/policy/revocation metadata | <= 60 s | <= 15 min | ordinary media 继续；新授权 fail closed |
| event/outbox/inbox/audit/effect/usage | <= 60 s | <= 30 min | ordinary media 继续；新 durable effects 可拒绝 |
| recording manifest/object | committed manifest 0；in-flight bounded spool | <= 4 h | 通话继续；recording 可降级 |
| configuration/placement snapshot | last signed revision | <= 15 min | 已建立 generation 固定；新 admission 可拒绝 |
| region control plane | <= 5 min | <= 60 min | 只声称外部数据面证据允许的 continuity |

这些数字不是现状性能声明；实测失败时保持 failed/not_run 并重新评估产品 SLO。

## 2. Readiness 与 liveness

- `livez` 只证明进程 event loop/worker supervisor 活着，不探测所有外部依赖；
- `readyz` 决定新 admission，检查 auth/key snapshot、schema compatibility、migration、必要 store、
  placement revision 和 drain state；
- notification/AI/recording/observability 等 optional dependency 不应让 Human Communication node
  liveness 失败，但应使相应 capability readiness 为 0；
- readiness probe 本身有 deadline/并发上限，不能造成依赖风暴；
- 已建立 session 不因 readiness 从 ready→not_ready 被主动终止。

## 3. Drain 状态机

```text
accepting
  -> route_draining        stop new interaction/effect admission
  -> worker_draining       stop claims; finish or release bounded leases
  -> authority_draining    query active sessions/edges/receipts
  -> active_zero_verified  signed checked-u64 zero receipts per authority
  -> quiesced              close exporters/stores after durable flush bounds
  -> stopped
```

禁止直接从 `accepting` 跳到 `stopped` 作为正常 rolling deploy。超时进入 `drain_failed`，记录
仍活跃 ID 的受控 digest 并保持 node not-ready；不能伪造 active-zero。

Active-zero 至少分别取得：

1. platform command/effect worker lease count；
2. domain outbox/inbox in-flight count；
3. communication/recording/AI attached generation count（由各自 Authority 提供）；
4. unobserved accepted/completed receipt count；
5. pending billing projection conflict count。

计数为 checked unsigned integer，overflow/unknown 均不等于 0。旧 schema/adapter 只有 active-zero +
orphan reconcile 通过后才可删除。

## 4. Rolling schema/event/key sequence

### Schema/Event N→N+1

1. 部署 N+1 reader，仍只写 N；
2. 验证 N+1 reader 读 N，N reader 对 N+1 additive/minor 按合同处理；
3. writer 逐 tenant/cell 切 N+1，保留 N/N-1 decoder；
4. old writer drain active-zero；
5. 未知 major、删字段、改变语义必须新 major，旧 reader quarantine；
6. rollback 只能恢复到仍能读已写数据的版本，不能丢弃 N+1 event。

### Key/Certificate N→N+1

1. 生成 N+1 并在 reader trust set staged；
2. 验证 SAN/audience/tenant/service mapping 和 expiry；
3. writer 切 N+1，N 在有限 overlap window 仍可验证；
4. drain N session/lease，确认 active-zero；
5. revoke N，发布 revocation snapshot；
6. destroy/zeroize raw N material，保留非秘密 receipt。

KMS/PKI 故障时不允许延长 overlap 到无限期或转 plaintext。

## 5. Crash/restart 与 reconciliation

- 每次 ownership acquisition 产生更高 owner epoch/generation；
- worker restart 先 query durable lease/receipt，再 claim，不能从内存猜测完成；
- stale generation write、completion、usage entry 一律拒绝；
- timeout/connection reset 后 effect 为 unknown，query provider/state；
- accepted 无 completed：按 effect policy query/abort/compensate；
- completed 无 state-observed：reconcile，禁止重复执行；
- recording segment checksum/owner epoch 与 object metadata 不符时 quarantine；
- event duplicate/reorder 由 inbox revision/digest 决策，不覆盖更高 revision。

## 6. Backup

每个 backup set 固定：backup id、source commit、schema/event versions、region、tenant scope、DB dump、
object manifest、object checksum/size/etag、key references、created/completed wall time 和 clock quality。
partial marker 永远不能作为可恢复 backup。Backup worker 独立限流，不占媒体/primary transaction pool。

Raw key/credential 不写 manifest。对象和 DB 必须一致地标记 cut；若不能做原子 snapshot，就记录各自
watermark，并在 restore 后 replay outbox/reconcile。Legal hold/deletion tombstone 随 backup 保存。

## 7. Restore rehearsal

1. 选择隔离、空 target；校验 destructive confirmation、region/key/schema compatibility；
2. 在写入前验证 manifest/checksum/signature；
3. 恢复 DB，再恢复 objects，再 replay bounded outbox/inbox；
4. 验证 Tenant/RLS、audit chain、effect/usage uniqueness、legal hold/deletion tombstone；
5. query/reconcile external effects，不盲目 replay；
6. 运行 cross-tenant negative tests；
7. 只开放 read-only validation，取得 signed restore receipt 后才允许 admission；
8. 记录实测 RPO/RTO、数据差异、source/config/hardware/raw output。

当前 `backup-runner.ts` 的 checksum、partial marker、empty-target guard 可复用，但不等于上述 rehearsal
已通过。

## 8. Region recovery

Region failover 不是 DNS 指向新地址这么简单：

- 新 region 必须拥有 compatible schema、signed config、tenant region permission、KMS/PKI trust、
  placement capacity 和 monotonically higher owner epoch；
- external system effect 必须 query，不能在两 region active-active 双写；
- billing/recording writer 以 generation/epoch fence；
- old region 回归先只读 reconcile，再 drain orphan；
- established media 是否继续只按其实际 data-plane/edge Evidence，不能从控制面恢复测试外推；
- split brain、DNS stale、clock skew、event reorder 和 object lag 是必测 fault schedule。

## 9. Evidence campaign

按顺序运行且独立签署：

1. local deterministic unit/property/schema tests；
2. single-node Postgres/event/object/KMS/DNS/config/clock fault injection；
3. process kill/restart、stale owner、duplicate/reorder；
4. rolling N/N-1 schema 和 key rotation；
5. backup/restore rehearsal；
6. fixed-host multi-process drain/node loss（已受控执行）以及独立的 deployed multi-node/fleet drain
   和 region recovery（仍未执行）；
7. 与真实 long human media 并行的全 fault matrix；
8. bounded queue/retry/fanout overload/capacity。

每份原始 Evidence 固定 commit/source/binary/image/config/hardware/clocks/workload/seed/time/output。
loopback、mock、upstream benchmark 和历史 artifact 不得升级真实依赖/production 状态。
