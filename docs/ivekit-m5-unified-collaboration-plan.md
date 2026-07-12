# iveKit M5 统一协作客户端实施计划

更新日期：2026-07-12

## 1. 目标

将已完成的 IM、LiveKit 和 RustDesk 独立工作区收敛为同一个可被 LED 和其他项目复用的协作客户端与交付包。M5 不改写 provider 数据面，不把 OPC call-center 业务带入 iveKit，也不以本地受控测试代替真实环境验收。

## 2. 边界

1. 入口以 `tenant_id + business_ref` 为权威，不允许前端直接查询数据库。
2. Chat、Media Call、Remote Gateway 保留各自深模块和稳定 HTTP/SDK 契约。
3. 统一层只负责导航、参与人投影、授权摘要、事件时间线和 evidence 索引。
4. 短令牌只在内存中使用；Tinode、LiveKit、RustDesk provider credential 不进入 DOM 或持久化。
5. OCR/ASR/AI provider 选型、SIP/VoLTE、RTMP/HLS、数字人继续不纳入 M5。
6. 不上传服务器；真实 Tinode/LiveKit/RustDesk 结果继续使用各自 validator，缺失时为 `not_run`。

## 3. 目标架构

```text
LED / other host
  -> iveKit host bridge (token, identity, openExternal)
  -> Unified Collaboration Shell
       -> Business Context Loader
       -> Messages Workspace -> iveKit Chat SDK -> Tinode receive adapter
       -> Calls Workspace    -> iveKit Media SDK -> LiveKit client
       -> Remote Workspace   -> iveKit RustDesk SDK -> native RustDesk
       -> Unified Timeline / Evidence Index
```

统一 shell 不复制三套业务状态机。它只持有当前 business context、选中的资源 ID、路由和跨模块摘要；模块终态与撤权仍由各自服务端状态决定。

## 4. 实施任务

### Task M5.1：统一业务上下文

**状态：已完成（2026-07-12）。**

1. 定义 `CollaborationContext`：tenant、business_ref、viewer identity、会话/通话/远协摘要。
2. 增加按 business ref 获取聚合摘要的 facade/SDK 方法；不返回 provider secret。
3. 已验证跨租户、非参与人和已离开参与人的访问拒绝；关闭资源允许成员读取历史摘要，但各模块继续拒绝终态写入。
4. 已接入参考客户端：business ref 深链接驱动消息筛选、最新通话、远协默认值和顶栏脱敏数量摘要。

### Task M5.2：统一导航与深链接

**状态：已完成（2026-07-12）。** `workspace`、`business_ref_type`、`business_ref_id`、`session_id`、`call_id`、`remote_session_id` 均进入 URL；用户导航使用 history push，自动补全和输入同步使用 replace，浏览器前进/后退可恢复状态。跨 business ref 会原子清除旧 Call/Remote ID，旧 context 响应不能污染新业务。受控浏览器 E2E 已覆盖三工作区切换、后退恢复和桌面无横向溢出。

1. 将 workspace 路由编码为 URL 参数或 host route state，支持 messages/calls/remote 深链接。
2. 保持移动端返回、刷新和宿主嵌入行为一致。
3. 未授权模块显示可执行状态，不猜 provider 是否可用。

### Task M5.3：统一参与人与授权摘要

**状态：已完成（2026-07-12）。** Context 响应按可见资源投影 Chat/Media 参与人、viewer role/status、Remote consent scopes、活动 RustDesk gateway permissions 和 control owner；不返回 user_ref、metadata、provider credential、launch URL、RustDesk ID 或确认/操作授权。参考客户端提供只读授权摘要抽屉，写操作仍由三个工作区调用各自命令。

1. 投影 Chat participant、Media participant 与 Remote controller，不合并底层主键。
2. 展示当前 viewer role、授权 scope、控制 owner、终态和撤权原因。
3. 任何写操作继续调用对应模块命令，不从聚合层绕过 RBAC。

### Task M5.4：统一事件时间线与 evidence 索引

1. 以服务端发生时间、稳定 event ID 和资源类型分页。
2. 聚合消息变更、呼叫生命周期、录制 evidence、远协操作观察与断开状态。
3. 时间线只保存脱敏 metadata 和 evidence ref，不保存正文副本、屏幕像素、剪贴板或文件内容。

### Task M5.5：前端拆包与性能

1. Messages、Calls、Remote 按路由懒加载；LiveKit 和 Tinode 不进入初始 Remote chunk。
2. 为 chunk 大小建立可重复门禁，消除当前媒体 chunk 超过 500 kB 的构建警告或记录可接受预算。
3. 验证桌面 1440x900、手机 390x844、窄屏 320px 无横向溢出和控件遮挡。

### Task M5.6：独立交付包

1. 固定 SDK exports、参考客户端 host bridge、runtime config 和部署环境变量。
2. 输出 LED 最小接入示例、升级/回滚、数据库 migration、Compose 与 provider 分离说明。
3. 生成不含 OPC 内部源码依赖和秘密的 SDK dry pack、客户端 dist 与 acceptance bundle。

### Task M5.7：验收

1. 单元/组件：业务上下文、路由、聚合投影、撤权和终态。
2. 受控 E2E：同一 business ref 在三个 workspace 间切换、深链接、移动布局、token 零持久化。
3. 全仓：`npm run verify`、SDK build/pack、前端 build、Compose config 和秘密扫描。
4. 真实环境：分别引用 IM、LiveKit、RustDesk 的真实报告；任一缺失均保持对应模块 `not_run`，统一报告不得提升状态。

## 5. 完成定义

1. LED 只需 public iveKit base URL、短期 access token、tenant/business ref 和 SDK/参考客户端包即可接入。
2. 三个工作区共享业务上下文和导航，但保持独立状态机、权限和 provider adapter。
3. 跨租户、撤权、终态、旧链接、token 持久化和敏感 evidence 门禁均有自动化覆盖。
4. SDK、dist、Compose、迁移、升级、回滚和验收材料可独立交付。
5. 本地门禁通过且无未解决 Critical/Important；真实 provider 没有报告时准确显示 `not_run`。
