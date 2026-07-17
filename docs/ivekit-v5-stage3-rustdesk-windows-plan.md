# iveKit V5 阶段三 RustDesk Windows 闭环实施计划

更新日期：2026-07-15

## 1. 目标与边界

在不实现 OPC/LED 业务逻辑、不开发移动端、不重写 RustDesk 远程桌面协议的前提下，完成
可复用的 Windows 远控闭环：

1. 一次性授权码、客户 consent、有人/无人值守策略和单控制者租约。
2. RustDesk OSS Windows 客户端安装、固定版本、服务、self-hosted server 配置和 edge agent。
3. 画面、键鼠、剪贴板、文件传输、多显示器、客户端录屏和重连的权限、状态、操作观测与审计。
4. 会话结束/撤权后的 launch 失效、设备侧物理断开、重试、恢复和失败可见性。
5. API、SDK、事件、Windows 部署包、验收包和 LED 对接文档。

RustDesk OSS native client 继续负责屏幕像素、键鼠输入、显示器切换、文件字节、剪贴板正文和
客户端录屏字节。iveKit 不复制这些数据，也不把 RustDesk 变成浏览器内远桌面；iveKit 负责
tenant/business binding、授权、scope、设备/会话状态、launch、控制权、操作审计、证据引用和
断开命令。

真实两台 Windows 物理机、真实 UAC/login screen、真实 relay/P2P、键鼠效果、文件校验、
剪贴板方向、双屏切换、录像播放和物理断开按总 Goal 约定保持 `not_run`，不阻塞代码交付，
也不得由受控测试冒充通过。

## 2. 官方能力依据

- RustDesk OSS server 提供 `hbbs` rendezvous/signaling 和 `hbbr` relay；OSS 不提供 Pro Web
  Console/API，因此 iveKit 保持独立控制面：<https://rustdesk.com/docs/en/self-host/rustdesk-server-oss/>。
- 官方客户端支持 Windows silent/service install、`--config`、`--get-id` 和 `--password`：
  <https://rustdesk.com/docs/en/self-host/client-deployment/>。
- 官方高级配置包含 keyboard、clipboard、file transfer、record session、自动录屏、多显示器、
  单向剪贴板和单向文件传输等开关：
  <https://rustdesk.com/docs/en/self-host/client-configuration/advanced-settings/>。

iveKit 不保存或下发 RustDesk permanent/temporary password。有人值守使用客户 consent、iveKit
一次性授权码和 RustDesk 本机接受动作；无人值守只开放策略与 launch gate，实际 secret 未来
只能由设备本地/外部 Secret 管理，不进入 PostgreSQL、API、SDK、日志或交付包。

## 3. 基线审计

2026-07-15 初始本机 RustDesk 专项回归 `401/401` 通过；Task 2 完成后扩展为
`412/412` 通过。已有实现包括：

- 设备注册、business ref、心跳、在线 TTL、FORCE RLS 和 client/server 版本矩阵。
- consent、attended/unattended policy、scope 子集、签名 launch、协议 URL 和旧链接失效。
- 单控制者 lease、heartbeat、release、transfer 和敏感操作二次 confirmation。
- RustDesk gateway event、operation observation、dead-letter/replay、audit export/coverage。
- 设备绑定 edge token、断开命令 lease、崩溃恢复、Windows session hook、服务重启 fallback。
- 真实终端 acceptance schema v2，分别校验画面、键鼠、多屏、文件、剪贴板、录屏、重连、
  撤权和物理断开，不接受 mock/Playwright 作为真实证据。

仍需补齐的代码缺口：

1. 现有 secondary confirmation 是内部资源 ID，不是客户可读取、工程师可输入的一次性授权码。
2. Windows 分发 profile 只提供 installer metadata/manual fields，缺少可审计、可回滚的固定版本
   安装/配置/edge-service 部署包。
3. `rustdesk-operation-observer` 需要平台 API credential 和外部 JSONL；设备侧没有使用 edge token
   的 operation observation API、durable spool 和 Windows companion 输入协议。
4. Windows 客户端 capability 配置与 iveKit scope 尚未形成一份机器可校验的 effective policy。
5. 当前 release 需要重新绑定 Stage 3 migration/config/Windows package 的 release evidence。

## 4. 架构

```text
LED/OPC customer UI                 LED/OPC operator UI
       | create/display code                | verify code + launch
       +------------------+-----------------+
                          v
              iveKit RustDesk control plane
        consent / auth code / policy / lock / audit
                          |
               device-bound edge token
                          v
              iveKit Windows companion
       heartbeat / command / observation durable spool
                          |
         allowlisted local adapters, shell disabled
                          v
              RustDesk OSS Windows client
 screen / input / displays / file / clipboard / recording
```

一次性授权码与 RustDesk password 完全不同：它只允许一个具名工程师把已存在的客户 consent
兑换成一次 gateway launch。code 使用 CSPRNG 生成，只在创建响应返回一次；数据库仅保存带
server-side pepper 的 HMAC，限制 TTL、尝试次数和单次消费。code 泄露不能绕过 tenant、参与人、
device、business ref、consent、scope、policy 或 control ownership。

Windows companion 不接收任意 shell。服务器只下发固定 command/operation type 和资源 ID；
本地 executable/argv 来自受保护配置。观测只上报操作 ID、方向、display ID、byte count、
SHA-256、duration、状态和 evidence ref，不上传画面、按键、路径、文件/剪贴板/录屏内容。

## 5. 数据与 API

### 5.1 migration 064：授权码

新增 `rustdesk_authorization_codes`：

- `id/tenant_id/remote_session_id/device_id`
- `scopes/requested_by/requested_at/idempotency_key/request_hash`
- `code_salt/code_hmac/expires_at/max_attempts/attempt_count`
- `status=pending|verified|consumed|expired|locked`
- `verified_by/verified_at/consumed_external_id/consumed_at`

要求 append-only ownership 字段、合法状态转换、租户一致性、FORCE RLS 和 runtime 最小 DML。
raw code、RustDesk password、edge token 和 HMAC pepper 不得入库。

新增 API：

| Method | Path | 用途 |
| --- | --- | --- |
| POST | `/api/ivekit/rustdesk/authorization-codes` | 客户/管理员为 remote session + device + scopes 创建一次性 code |
| GET | `/api/ivekit/rustdesk/authorization-codes/:id` | 读取脱敏状态、TTL、尝试数，不返回 code/hash/salt |
| POST | `/api/ivekit/rustdesk/authorization-codes/:id/verify` | 工程师提交 code；成功绑定 verified identity |
| POST | `/api/ivekit/rustdesk/gateway-sessions` | attended 严格模式携带 `authorization_id` 并在激活时一次消费 |

### 5.2 Edge operation observation

新增 device-token route：

| Method | Path | 用途 |
| --- | --- | --- |
| POST | `/api/ivekit/rustdesk/edge/heartbeat` | edge token 对预注册 device 做身份绑定心跳 |
| POST | `/api/ivekit/rustdesk/devices/:device_id/observations` | edge token 上报单条/批量安全 operation observation |

token 中的 tenant、RustDesk runtime ID 和 edge instance 必须与 URL device、gateway target 一致；
session 必须 active，scope/control version/operation grant 必须通过现有事务门禁。普通应用 API key
不能冒充 edge observer，edge token 也不能访问业务读 API。

## 6. 实施任务

### Task 1：基线与计划

- [x] 运行 RustDesk 全专项回归并记录 `401/401`。
- [x] 核对 OSS server/client 官方能力与 iveKit ownership boundary。
- [x] 识别授权码、Windows 部署和 edge observation 三个真实缺口。

### Task 2：一次性授权码

- [x] 先写 migration/store 状态机、HMAC、TTL、attempt、idempotency 和跨租户失败测试。
- [x] 创建 migration 064，加入 full schema、standalone source policy 和交付 migration manifest。
- [x] 实现 create/get/verify/consume；code 只返回一次，比较使用 constant-time，失败不泄露状态。
- [x] 接入 HTTP、in-process facade 和 SDK；attended strict mode 在 gateway activation transaction 消费。
- [x] 写 requested/verified/failed/locked/consumed 安全审计和 tenant event。

Task 2 验证证据（2026-07-15）：

- RustDesk 专项与 remote gateway 回归 `412/412` 通过。
- migration 064 在 standalone PostgreSQL 全新建库、旧 OPC 库升级、幂等和 FORCE RLS 验证中通过。
- 部署、交付、OpenAPI、standalone source graph 等契约测试 `57/57` 通过。
- 根项目 `npm run typecheck`、iveKit SDK `npm run build` 和 `git diff --check` 通过。

### Task 3：Windows 固定版本部署包

- [x] 生成 secret-free manifest，绑定 RustDesk `1.4.7`、installer SHA-256、server `1.1.15`、
  public-key fingerprint、edge package hash 和 source commit。
- [x] PowerShell 支持 `validate|install|repair|uninstall`；校验管理员、Windows x64、checksum、
  Authenticode 状态、service、`--config` 结果、`--get-id` 和 rollback metadata。
- [x] 安装 edge agent 为独立 Windows service，token 从 ACL 收紧文件读取，不进入 argv/registry/log。
- [x] effective capability policy 显式映射 keyboard/clipboard/file/recording/display；未知或漂移 fail closed。
- [x] controlled PowerShell contract、package hash/语法和无副作用 validate 合同测试通过；Windows hosted
  runner 的真实执行保持待 CI 环境验证。

Task 3 当前证据（2026-07-15）：

- 固定 RustDesk client `1.4.7`、server `1.1.15` 和稳定 WinSW `2.12.0`；拒绝 latest、3.x alpha、
  artifact/fingerprint/source commit 漂移。
- package generator、完整 edge 源码转译、`node --check`、edge token file 和部署接线测试通过，根项目
  类型检查通过。
- Windows hosted workflow 已加入 PowerShell AST parse、controlled package 和 read-only validate，必须等待
  Windows runner 实际执行后才能勾选最后一项；本机没有 `pwsh`，不得把静态合同冒充 Windows 通过。
- 运行手册见 `docs/ivekit-rustdesk-windows-deployment.md`；真实双 Windows 终端仍为 `not_run`。

### Task 4：设备侧 operation bridge

- [x] 新增 edge-token observation API 和 batch idempotency，复用既有事件 allowlist/permission/control gate。
- [x] 新增 Windows companion observation spool；`received -> forwarding -> forwarded|dead_letter` 可恢复。
- [x] 支持 allowlisted native/log/hook 输入协议，输出固定 JSON schema；不得执行服务器下发命令文本。
- [x] schema/bridge 覆盖 view/control/multi-display/file/clipboard/recording/reconnect/disconnect，缺 telemetry 保持
  `not_observed`。
- [x] 测试跨 device/tenant/session、终态 session、旧 control version、grant replay、崩溃恢复和秘密扫描。

Task 4 当前证据（2026-07-15）：

- device token heartbeat 只能匹配预注册 tenant/business ref/RustDesk ID；edge 不能自注册，也不能访问
  普通业务读 API。
- observation HTTP 覆盖 batch idempotency、owner actor 绑定、错误 device、结束 session、旧 control
  version、敏感字段和无认证拒绝；服务端写入时再次事务校验 control ownership。
- companion spool/bridge 覆盖原子 inbox、重复接收、租约恢复、退避、最大尝试 dead letter、进程锁、
  symlink、脱敏 quarantine 和 token 不落盘。成功记录只保留 observation hash。
- agent/Windows package 已包含 observation contract、spool 和 bridge，固定 service 环境声明 client
  `1.4.7`、Windows、inbox/spool 与 2 秒 poll。相关本机测试 `23/23` 通过；真实 Windows 仍 `not_run`。

### Task 5：文件、录屏与证据

- [x] 文件/录屏 observation 绑定 byte count、SHA-256 和 secure evidence ref；不接收本地绝对路径。
- [x] 可选 companion uploader 只把明确选择的录屏/证据送入 Stage 2 secure-file state machine，
  扫描为 `ready` 前不可下载或进入 OCR/ASR。
- [x] RustDesk 原生直接文件传输明确标记 `native_unscanned`，不冒充 iveKit 已扫描文件。
- [x] retention、删除、感染/失败和会话撤权复用 Stage 2 状态机并保持可审计。

Task 5 当前证据（2026-07-15）：

- device-token evidence API 支持 single/multipart/list parts/complete/get/abort；文件绑定 tenant、device、
  edge instance、gateway session 和 operation，公开 DTO 不暴露 object key、storage URL 或 upload ID。
- uploader 使用私有 inbox/spool、流式 SHA-256、稳定幂等键、服务端分片恢复、重试/dead letter 和脱敏
  quarantine；重启后不重复创建 secure file，成功后原子生成 observation 并删除本地受管 payload。
- agent、Windows service template、Windows package、根/standalone env example 与总交付包已包含完整
  observation/evidence runtime；真实双 Windows 字节链路仍为 `not_run`。

### Task 6：部署、发布与受控验收

- [x] Compose/Helm/交付包纳入授权码 secret 名称、Windows package 和 Stage 3 evidence fingerprint。
- [x] 受控双 edge/双 actor 覆盖 code、launch、control、operation、recovery、end/disconnect 全链路。
- [x] SDK build/pack、RustDesk suite、PostgreSQL fresh/upgrade/RLS、Windows script contract、交付包通过。
- [x] 更新 OpenAPI、LED 指南、详细设计、运维、版本矩阵和 completion audit。
- [x] 两台 Windows 真实终端继续 `not_run`，生成可直接执行的 acceptance template/runbook。

Task 6 已由后续 V6 门禁完成：授权码、Windows package v6、native control/evidence overlay、
edge observation/evidence、精准断开、emergency fallback、SDK/OpenAPI、交付包和真实环境模板均已纳入
source-bound 验收。这里勾选表示代码和可执行交付入口完成，不表示 Windows CI、签名安装包或两台
物理 Windows 已通过；这些项目继续按 `docs/ivekit-v6-real-environment-acceptance.md` 保持 `not_run`。

## 7. 安全不变量

1. raw authorization code 只出现于首次 HTTPS 响应，不写数据库、事件、日志、metrics、错误或包。
2. code 不能替代 consent、policy、participant、scope、control ownership 或 edge device identity。
3. Windows companion 不持有平台 API key；命令和 observation 使用受限 device-bound edge token。
4. edge token、claim token、authorization code、RustDesk password、private key 不进入 child argv 或 spool。
5. iveKit 不存屏幕像素、按键、剪贴板正文、文件内容、绝对路径或录屏字节。
6. 结束/撤权先让 launch 和 control-plane 失效，再异步执行物理断开；设备失败不能恢复授权。
7. 受控 adapter/CI 只能证明协议和恢复，不得把真实 RustDesk 操作状态改为 passed。

## 8. 完成标准

1. 授权码、Windows 部署、operation bridge、文件/录屏证据的代码、迁移、API、SDK、事件和文档完成。
2. 重试、竞态、过期、重放、跨租户/设备、崩溃恢复、secret safety 和 rollback 有反向测试。
3. LED 只依赖 SDK/API/edge package，不导入 OPC call-center 代码或读取 PostgreSQL。
4. 已有 RustDesk 401 项基线无回归，新增 Stage 3 门禁全部通过。
5. 真实两台 Windows 环境未执行时明确保留 `not_run`，但代码交付不再缺少可执行步骤和验收合同。
