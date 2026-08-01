# G02 Authority 与数据分类

## 1. 单一 Authority

| Domain fact | 唯一 writer/Authority | 允许的 executor/adapter | 禁止 |
| --- | --- | --- | --- |
| Tenant、Subject/Service Identity、session、revocation、policy version | Converact Platform Identity | IdP/JWKS/SCIM adapters | domain 自建 Tenant 或信任 unsigned tenant header |
| Consent evidence 与 ConsentLease generation | Converact Platform Consent/Policy | communication/recording/AI/tool adapters | 从 recording consent 推导 AI/translation/tool consent |
| Event schema/catalog/compatibility policy | Converact Platform Event Contract | domain outbox/inbox stores | event bus 成为业务或媒体 Authority |
| Append-only audit fact | Converact Platform Audit | domain audit SDK/store | 修改或删除历史 event；日志替代 audit |
| Effect lifecycle | Converact Engage Action Authority 或声明的 native domain Authority | provider executors/query adapters | Agent、worker 或 HTTP 成为第二 writer |
| Usage entry、rating session、customer bill | Converact Metering/Billing | receipt projectors、rating adapters | CDR/recording worker直接最终记账 |
| Secret/key/certificate metadata 与 rotation state | Converact Platform Key Lifecycle | KMS/PKI/secret-store adapters | raw key 进入 DB、event、log、prompt、evidence |
| Correlation contract 与 telemetry policy | Converact Observability | OTLP/Prometheus/log adapters | exporter 反压业务/媒体热路径 |
| Call/Leg/Dialog/CDR/recording intent/media plan | Unified RustPBX | Kamailio/RTPengine/voice-media adapters | 平台 event store 成为第二 Call Authority |
| ordinary RTP/RTCP/SRTP writer | RTPengine | RustPBX media-control adapter | DB/Event/AI/Observability 按包参与 |
| decoded processing/capture | `voice-media-rs` assigned edge generation | codec/DSP/recording/AI workers | 两个 active writer 处理同一 edge generation |
| Room/Participant/Publication/SFU route | LiveKit | Fabric Coordination adapter | Identity/Engagement store 镜像第二 Room |

## 2. Identity model

Identity kind 固定为：

- `human`：最终用户或运营人员；SubjectId 稳定，认证 session 可轮换；
- `service`：平台逻辑服务；ServiceIdentity 与部署实例分离；
- `workload`：短生命周期 workload/pod/process；绑定 workload identity 与 owner epoch；
- `edge`：Kamailio、RTPengine、LiveKit ingress 等受信边缘；只允许声明的 audience/capability；
- `provider`：外部 provider adapter；不能携带 `system` 全权身份。

每个授权请求至少绑定：`tenant_id`、`identity_id`、`identity_kind`、`session_id`、`token_id`、
`issuer`、`audience`、`key_id`、`issued_at`、`expires_at`、`policy_version`、
`revocation_epoch`、`role`、`capabilities`、`purpose`。resource tenant 与 token tenant 必须精确相等。

开发身份只有显式 `AUTH_DISABLED=1` 且 `NODE_ENV != production` 才能启用；缺少生产认证配置
必须启动/请求 fail closed，不能隐式回退 Header。

## 3. Consent 与 Policy scope

| Scope | 独立 consent | Purpose 示例 | 失效行为 |
| --- | --- | --- | --- |
| `phone_audio` | 是 | 人与人电话 | 拒绝建立或按通信法定流程处理 |
| `video` | 是 | WebRTC/ViLTE video | 关闭 video edge，不隐式保留摄像头 |
| `recording` | 是 | quality、legal、support evidence | 停止新 capture；通话继续 |
| `transcription` | 是 | caption、case note | detach ASR tap；通话继续 |
| `translation` | 是 | zh-CN↔en-US assist | detach translation；原语音/视频继续 |
| `ai_processing` | 是 | agent assist、summary | detach AI tap/worker；人工继续 |
| `tool_action` | 每个 action policy 是 | CRM update、remote operation | deny/abort action；通信继续 |
| `remote_control` | 是且短 TTL | attended remote assist | revoke tool session；通信继续 |

Consent evidence 必须包含 subject、scope、purpose、policy version、region、retention、legal hold
规则、evidence reference、actor 与 wall timestamp。Runtime 使用短期 ConsentLease：包含 generation、
wall expiry、monotonic duration、issuer key id 和 digest。lease 过期或 revocation snapshot stale 时
仅停止相应附加能力。

## 4. 数据分类

| Class | 内容 | At rest/in transit | Log/metric/prompt/evidence | 默认 retention/region |
| --- | --- | --- | --- | --- |
| `C0_PUBLIC` | 公开 schema/version、非敏感 capability catalog | integrity + TLS | 可记录，仍有大小限制 | 产品策略 |
| `C1_INTERNAL` | service name、low-cardinality status、deployment revision | TLS；at-rest access control | 允许低基数聚合；不含 instance secret | 运维策略 |
| `C2_CONFIDENTIAL` | Tenant config、business refs、policy、audit metadata、usage | envelope encryption + TLS/mTLS | 只记录受控 ID/digest；不进 metric labels | tenant policy + region pin |
| `C3_SENSITIVE` | call/video metadata、recording/transcript/translation、PII | tenant/region key + mTLS/SRTP | payload 不进日志/metric/prompt evidence；只存引用与 digest | explicit consent/retention/legal hold |
| `C4_SECRET` | token、password、private key、SRTP/DTLS key material | KMS/PKI/locked memory；never generic DB | 永不进入日志、Prompt、Evidence、core dump | 最短生命周期；rotation/revoke/zeroize |

Profile type、TenantId、UserId、EngagementId、CallId、RoomId 等都是高基数值：可进入受控 trace/log，
不得成为 Prometheus label。日志必须在 sink 前执行 key/value 双重 secret/PII redaction。

## 5. Region、retention、legal hold 与 deletion

- `region_policy` 先于 provider selection；不支持目标 region 的 provider fail closed；
- legal hold 只冻结声明的数据类别/资源，不允许把所有 Tenant 数据无限期保留；
- deletion 是 append-only request/receipt/verification 流程；对象删除失败为 `unknown`，需 query；
- recording/transcript/translation/AI derived data 分别有 retention，不互相继承；
- backup 遵守同一 region/key/retention，并证明已删除数据不会由正常 restore 静默复活；
- immutable audit/usage 的纠错使用 reversal/credit/tombstone，不物理改写历史事实。

## 6. Secret、Key 与 Certificate lifecycle

状态机：`generated -> staged -> active -> retiring -> revoked|expired -> destroyed`。

- key/cert 由 `key_id`/version 引用，raw material 不持久化到业务模型；
- rotation 采用 overlap window，先让 N/N+1 reader 接受，再切 writer，最后 revoke N；
- cert identity 必须校验 SAN/SPIFFE-like identifier、issuer、audience、expiry、revocation 与 service allowlist；
- PKI/KMS 不可用时，拒绝新 session/key derivation；已建立 ordinary media 按已有安全上下文继续至
  自身有效期，不允许 plaintext downgrade；
- native/unsafe/FFI 处理 C4 时必须有 bounded buffer、zeroize、panic/abort policy、core dump disable、
  ABI/supply-chain/fuzz evidence；未通过则 feature disabled。

## 7. Billing writer 与 key

| Usage source | Billing key | 唯一 writer |
| --- | --- | --- |
| directed media edge generation | `edge:{tenant}:{interaction}:{edge}:{generation}:{direction}` | Converact Metering projector from committed media receipt |
| AI run generation | `ai:{tenant}:{agent_run}:{generation}` | Agent Runtime usage adapter → Metering |
| recording segment | `recording:{tenant}:{manifest}:{segment}:{owner_epoch}` | Recording receipt projector → Metering |
| external action attempt | `action:{tenant}:{intent}:{attempt_generation}` | Engage Action receipt projector → Metering |

Writer identity/epoch、source receipt digest 和 unit/value 是不可变字段。重复同 digest 不增加用量；
同 key 异 digest 或异 writer 必须冲突并冻结 rating。CDR、Provider invoice 和 telemetry 只能用于
reconciliation，不能旁路 ledger 直接改最终账单。

## 8. 当前、目标和生产资格

- Current：上表列出的现有模块各自实现局部能力；没有统一 G02 runtime Authority；
- Target：机器合同 + deep-module interfaces + adapter + migration + TDD/fault harness；
- Production eligible：必须取得当前 commit 的真实 dependency、rotation、fault、long media、
  drain/restore/region recovery、capacity 和独立审查 Evidence。当前为 `false`。
