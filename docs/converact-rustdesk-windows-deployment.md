# Converact Fabric RustDesk Windows 固定版本部署

更新日期：2026-07-22

## 1. 用途与边界

本部署包面向 Converact Platform、LED 及其它业务的 Windows x64 受控终端，负责安装和校验以下组件：

1. RustDesk OSS Windows client `1.4.9` Converact Fabric overlay。
2. 与 RustDesk OSS server `1.1.16` Converact Fabric fork 对齐的 self-hosted network config。
3. Converact Fabric effective capability policy。
4. Converact Fabric RustDesk edge companion 及 Windows 断开/服务恢复 adapter。
5. 固定 WinSW `2.12.0` 的独立 Windows service。

RustDesk native client 继续负责屏幕、键鼠、多屏、剪贴板、原生文件传输和本地录屏。Converact Fabric
companion 负责设备身份、心跳、受限命令、操作观测、恢复和审计。默认不读取屏幕像素、按键、
剪贴板正文、文件内容、本地绝对路径或录屏字节；只有本地受控 producer 明确选择文件/录屏并提交
安全 manifest 时，evidence uploader 才会把对应字节送入 Converact Fabric 安全文件扫描链路。

生成包、PowerShell `validate` 和 Windows CI 通过，不等于真实双机远控通过。两台 Windows 物理机、
UAC/login screen、真实 P2P/relay、键鼠、双屏、文件、剪贴板、录像和物理断开证据在执行前必须保持
`not_run`。

## 2. 固定版本与供应链

| 组件 | 固定版本 | 校验 |
| --- | --- | --- |
| RustDesk Windows x64 client | `1.4.9@6c578292e8ebbbec708b76986ba8c4bc7c509747` | profile URL/filename/version、SHA-256、安装前 Authenticode publisher、overlay source identity |
| RustDesk OSS server | `1.1.16@73523b31cfd25d77dee862e6fc9f5e1fb5e485ef` | client profile、server evidence 与 fork manifest pin |
| WinSW x64 | `2.12.0` | 官方 release URL、运维录入的 SHA-256 |
| Node.js | `>=24.0.0 <25.0.0` | Windows `validate/install/repair` 读取实际 `node --version` |
| Converact Fabric companion | manifest schema `1`、package version `6` | edge files manifest SHA-256、source commit、package aggregate hash、placement 与 owner-epoch protocol |

RustDesk profile 必须先由 `npm run rustdesk:client-profile-pack` 从 Converact Fabric API 生成。Windows generator
只接受 `ready=true`、Windows `x86_64` artifact 已配置、版本和 server fingerprint 与部署 pin 完全
相同的 profile。它不会访问“latest”URL，也不会下载二进制。

WinSW 选择稳定 `2.12.0`，不使用 3.x alpha。部署前从官方 release 获取 `WinSW-x64.exe` 的真实
SHA-256，填写 `CONVERACT_RUSTDESK_WINDOWS_WINSW_SHA256`；示例或 CI 中的重复字符 hash 仅是受控契约
fixture，不可用于真实安装。

## 3. 生成输入

```bash
export CONVERACT_RUSTDESK_WINDOWS_PACKAGE_DIR=/secure/release/rustdesk-windows-x64
export CONVERACT_RUSTDESK_WINDOWS_PROFILE_FILE=/secure/evidence/rustdesk-client-profile.json
export CONVERACT_RUSTDESK_WINDOWS_NETWORK_CONFIG_FILE=/secure/input/rustdesk-network-config.txt
export CONVERACT_RUSTDESK_WINDOWS_SOURCE_COMMIT=<40-char-git-commit>
export CONVERACT_RUSTDESK_WINDOWS_EXPECTED_FINGERPRINT=sha256:<16-lower-hex>
export CONVERACT_RUSTDESK_WINDOWS_SERVICE_NAME=IveKitRustDeskEdge
export CONVERACT_RUSTDESK_WINDOWS_WINSW_VERSION=2.12.0
export CONVERACT_RUSTDESK_WINDOWS_WINSW_URL=https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe
export CONVERACT_RUSTDESK_WINDOWS_WINSW_SHA256=<64-lower-hex>
export CONVERACT_FABRIC_PLACEMENT_ENABLED=1
npm run rustdesk:windows-package
```

`rustdesk-network-config.txt` 是从已验证 RustDesk 客户端“Export Server Config”得到并交给
`rustdesk.exe --config` 的单行 network config。它只能包含 ID/relay/API server 和 public server key，
不得包含 permanent/temporary password、API key、device token、private key、Bearer credential 或
其它 secret。generator 会拒绝空值、控制字符、超长值和明显 secret assignment。

输出目录必须不存在或为空，避免旧文件混入新 release。生成结果包含：

- `manifest.json`
- `Deploy-IveKitRustDesk.ps1`
- `IveKitRustDeskEdge.xml.template`
- `rustdesk-network-config.txt`
- `effective-capability-policy.json`
- `edge/*.js`
- `edge/adapters/windows-disconnect.ps1`
- `edge/adapters/windows-restart.ps1`
- `README.md`

`manifest.json` 绑定 source commit、RustDesk client/server、installer、server fingerprint、network config、
capability policy、WinSW、companion aggregate 和每个包文件的 SHA-256/size。manifest 本身不保存
device token、平台 API key、RustDesk password 或 private key。

启用 placement 时，profile 中的 Windows x86_64 installer 必须声明
`native_control_protocol=ivekit-rustdesk-native-control-v2`，manifest 记录
`placement.enabled=true`、`owner_epoch_required=true` 和 `owner_epoch_fence=durable`。v1 只允许生成
`CONVERACT_FABRIC_PLACEMENT_ENABLED=0` 的滚动兼容包，不能加入 Cell owner failover。

## 4. Capability Policy

package 使用 `access-mode=custom` 和 click approval。Converact Fabric session scope 仍是每次会话的最终授权；
本地 policy 只声明这台终端允许支持的最大能力。

| Converact Fabric 能力 | RustDesk option |
| --- | --- |
| `view_screen` | `access-mode=custom`、`show-monitors-toolbar=Y` |
| `control_mouse_keyboard` | `enable-keyboard=Y` |
| `clipboard` | `enable-clipboard=Y`、`disable-clipboard=N` |
| `transfer_file` | `enable-file-transfer=Y`、`enable-file-copy-paste=Y` |
| `record_screen` | `enable-record-session=Y`、`allow-auto-record-incoming=N` |

同时关闭 camera、audio、terminal、TCP tunnel、remote printer、remote restart、block input、privacy mode
和 remote config modification。客户不能在 accept window 改写 package capability。安装/修复会逐项调用
`rustdesk.exe --option <name> <value>`，随后用 `--option <name>` 回读；缺项、未知项或回读漂移都会
fail closed 并进入回滚。

## 5. Windows 执行

先在 Windows x64 管理终端执行无副作用验证：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\Deploy-IveKitRustDesk.ps1 `
  -Mode validate
```

`validate` 只读取 package、Node runtime 和平台信息，不创建 install root、不下载文件、不安装服务、
不修改 RustDesk option。Windows CI 使用 PowerShell AST parser 校验脚本，再生成 controlled package 并
断言 validate 未创建 install root。

安装：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\Deploy-IveKitRustDesk.ps1 `
  -Mode install `
  -BaseUrl https://fabric.converact.example.com `
  -TenantId tenant-led `
  -BusinessRefType led_device `
  -BusinessRefId LED-10001 `
  -DisplayName 'LED control PC' `
  -DeviceTokenFile C:\SecureInput\converact-edge-token
```

`install` 和 `repair` 必须在管理员 PowerShell 中运行。流程依次完成：

1. 校验 package manifest、所有文件 hash、Windows x64 和 Node version。
2. 保存已有 RustDesk binary、版本、service 状态、所有受管 option 和 `video-save-directory` 到 `rollback-state.json`。
3. 下载固定 installer，校验 SHA-256 和 Authenticode，再执行 `--silent-install`。
4. 校验安装后的 `--version`，安装/启动 RustDesk service。
5. 执行 `--config`、逐项设置并回读 capability policy、执行 `--get-id`。
6. 把 device token 复制到 `%ProgramData%\Converact Fabric\RustDesk\secrets\edge-token`，移除继承，只允许
   LocalSystem 和 Administrators 读取。
7. 创建 ACL 加固的 native evidence candidate/event/spool、文件和录屏目录，原子写入
   `state\native-evidence-roots-v1.txt`，并设置、回读 RustDesk `video-save-directory`。
8. 创建 owner epoch 状态目录；每个 exact external session 使用独立 SHA-256 命名状态分片，拒绝旧 epoch，
   equal command ID 幂等重放，并在 companion 异常退出后恢复僵尸锁。
9. 安装并启动独立 `IveKitRustDeskEdge` service。

service 同时创建并轮询 `%ProgramData%\Converact Fabric\RustDesk\observations\inbox`，持久队列位于
`observations\spool`。本地 RustDesk log adapter 或受控 companion hook 必须把一条完整 JSON 写到同目录
临时文件，`fsync/close` 后再原子 rename 为 `.json`；不得让 bridge 读取仍在写入的文件。允许的
`source_adapter` 只有 `native_client`、`rustdesk_log` 和 `companion_hook`。生产 adapter 账户只授予
inbox 写入/rename 权限，不授予 token、spool 或 service XML 读取权限。

bridge 先持久化再删除 inbox 文件，断网和 408/429/5xx 使用同一幂等 observation 重试。非法、超大、
symlink 或未知字段输入会被删除，并在 `inbox\quarantine` 写入不含原正文的 hash/reason 记录。上传成功
后 spool 删除原始 observation，只保留 SHA-256 和终态。dead letter 保留的也只是严格白名单字段，
不允许剪贴板正文、文件内容/路径、画面、按键、录屏字节、token 或 password。

device token 不进入 PowerShell argv、WinSW XML value、registry、manifest、rollback state 或日志；XML
只保存 token file path。companion 使用 `CONVERACT_RUSTDESK_EDGE_DEVICE_TOKEN_FILE` 读取同一 device-bound
credential，禁止同时配置旧 platform API/command credentials。

定制 RustDesk 客户端读取 `state\native-evidence-roots-v1.txt`，只扫描其中 `file` 和 `recording` 根。
首次扫描只建立基线；后续新出现的非链接普通文件连续两次稳定后，在 `native-evidence\candidates`
原子写入元数据候选。候选不读取文件正文，只记录受控源路径、文件名、大小、时间和当时 active
controller RustDesk ID。companion 从 device-token `/evidence-context` 获取 30 秒授权快照，按设备、
controller、operation、预期文件名和时间窗做唯一匹配；无匹配或多匹配都保持等待，超时只写脱敏
quarantine，不上传内容。

唯一匹配后，correlator 在 `native-evidence\events` 生成 `rustdesk-native-evidence-v1` event。watcher 再
验证白名单、文件类型、链接和稳定性，把受管副本送到 `%ProgramData%\Converact Fabric\RustDesk\evidence\inbox`；
uploader 使用 `evidence\spool` 恢复进度，复核 size/hash，按单文件或断点分片上传到 device-token API。
服务端确认后才生成 operation observation。成功删除受管副本；中断只保留最小恢复状态。

会话结束后的录屏 flush 必须在 15 分钟 finalization window 内完成；候选观察时间和服务端收到时间均不得超过该上限。evidence uploader 的 terminal 4xx/超限重试记录保留 payload 供运维调查，`CONVERACT_RUSTDESK_EDGE_EVIDENCE_DEAD_LETTER_RETENTION_MS=604800000` 默认七天；到期或数量超限时由 companion 先删 payload 再删状态，不可手工只清理 `records.json`。远端上传和 observation 已成功但 payload 因文件锁、杀毒或 ACL 暂时删不掉时，`records.json` 会保留 `uploaded` 记录及 manifest，后续轮询或服务重启只重试本地删除；只有删除成功或确认 `ENOENT` 后才移除 manifest，禁止把这种记录当普通 uploaded history 压缩。

`Publish-IveKitRustDeskEvidence.ps1` 仅用于故障恢复，不是正常 producer。RustDesk 原生直传若处于白名单
之外、使用未集成客户端或无法唯一绑定授权，审计必须标为 `native_unscanned`；只保留在本机的录屏必须
标为 `local_only`。两者都不能向 LED/Converact Platform 展示“已病毒扫描”或“可用于 OCR/ASR”。

## 6. 修复、卸载与回滚

`repair` 复用原始 rollback snapshot，重新验证下载物、network config、capability readback 和 companion
service，不覆盖初次安装前的基线。

任一 install/repair 步骤失败会调用 `Restore-IveKitRollback`：停止并卸载 companion；如果安装前已有
RustDesk，则使用保存的 binary 恢复版本、所有受管 option、`video-save-directory` 和原 service 状态；如果安装前没有
RustDesk，则卸载本次安装。

安全卸载必须使用原 install root 中的 `rollback-state.json`：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\Deploy-IveKitRustDesk.ps1 `
  -Mode uninstall
```

缺少 rollback state 时脚本拒绝猜测性卸载，避免破坏客户原有 RustDesk 环境。

## 7. 交付门禁

代码侧完成门禁：

- `node --import tsx --test test/rustdesk-windows-package.test.ts test/rustdesk-edge-agent.test.ts`
- `node --import tsx --test test/rustdesk-owner-epoch-fence.test.ts test/rustdesk-edge-command.test.ts`
- `npm run typecheck`
- Windows CI PowerShell AST parse
- controlled package generation和 read-only validate
- package files、edge JavaScript syntax、hash、secret marker 和 drift 反向测试

真实环境最终验收仍使用 `rustdesk:client-acceptance` 和 Stage 3 evidence pack，至少覆盖 screen、
keyboard/mouse、multi-display、file、clipboard、recording、reconnect、authorization revoke、旧 launch
失效、主动断开和完整 audit timeline。未提供真实证据时结果必须保持 `not_run`。

## 8. 故障定位

| 错误 | 检查 |
| --- | --- |
| package hash/size mismatch | 包是否被改写、换行是否被工具转换、是否混入旧 release 文件 |
| installer identity/version drift | client profile 是否来自当前 Converact Fabric release，URL 是否仍指向 `1.4.9` |
| Authenticode validation failed | 下载物是否被代理替换、签名链是否受信、publisher 是否包含 RustDesk |
| `--config` 或 `--option` 被拒绝 | 是否已管理员安装、RustDesk settings 是否被更高优先级 policy 禁止 CLI 修改 |
| option readback drift | 本机策略/用户设置是否覆盖 package policy；不得绕过，应修复后重跑 repair |
| invalid runtime ID | RustDesk service、ID server DNS/端口/key 是否正确 |
| companion 启动失败 | Node >=24、WinSW wrapper log、token ACL、BaseUrl/Tenant/business ref 和 spool 路径 |
| observation 不上报 | device 是否预注册、token identity/RustDesk ID、inbox 是否原子 `.json`、spool/quarantine 状态 |
| evidence 不上传 | gateway 是否 active 且有 `record_screen/transfer_file` scope、manifest 是否无绝对路径、payload 是否已原子入 inbox、evidence spool/retry 状态 |
| evidence 已上传但不可下载 | 正常检查 `scanning/processing/infected/failed`；只有 Stage 2 安全文件状态 `ready` 可下载 |
| physical disconnect unavailable | device token、command capability heartbeat、native-control v2、当前 reservation/epoch、adapter 固定路径和 RustDesk service name |
