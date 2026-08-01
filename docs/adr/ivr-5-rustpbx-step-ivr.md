# ADR-5：RustPBX M1 媒体路径 — Step IVR 替代 RWI

**Status:** Accepted（2026-06-25）  
**Related:** ADR-4（Genesys 播放队列）、[`ivr-4-genesys-audio-queue.md`](ivr-4-genesys-audio-queue.md)

## 背景

M1 原计划用 Converact Platform↔RustPBX **RWI** 下发 `gather_digits.params.prompt_queue`（ADR-4 扩展契约）。联调 `ghcr.io/restsend/rustpbx:latest`（0.4.7-community）时发现：

| 项 | 结论 |
|----|------|
| `POST ws://…/rwi/v1` | 即使 `[rwi] enabled = true`，WebSocket 握手 **404** |
| `gather_digits` / `prompt_queue` | 社区镜像二进制中 **无** 该字符串；非官方内建命令 |
| 官方动态 IVR | **Step IVR**（HTTP Provider），文档：[Step IVR Integration](https://miuda.ai/docs/addons/step-ivr) |

GitHub [restsend/rustpbx#219](https://github.com/restsend/rustpbx/issues/219) 有同类报告；维护者称 "RWI works" 但未给出 community 镜像修复方案。

## 决策

### D1 — M1 SIP 媒体走 Step IVR

```
SIP → RustPBX HTTP Router → Converact Platform not_handled（建 voice + ivr session）
    → 静态路由 application = ivr:opc-m1
    → RustPBX Step IVR → POST /api/ivr/rustpbx/step
    → Converact Platform 映射 IvrAction → ActionNode（prompt 链 + dtmf_menu）
```

### D2 — ADR-4 RWI 契约保留为 Converact Platform 内部/RWI 就绪后的目标态

- `ivr-rwi-bridge.ts` 与 `gather_digits.prompt_queue` **不删除**
- 生产 SIP 在 RWI 可用前，**Step IVR 为唯一媒体路径**
- `CONVERACT_DISABLE_IVR_RWI=1` 在 callcenter compose 默认关闭 RWI runtime

### D3 — Action 映射（M1 最小集）

| IvrAction | Step ActionNode |
|-----------|-----------------|
| `menu` + `promptQueue` | `prompt` 链式 `next` → 末尾 `dtmf_menu` |
| `play` / `compliance` | `prompt` |
| `transfer` (queue) | `queue` |
| `transfer` (其他) | `transfer` |
| `disconnect` | `hangup` / `play_and_hangup` |
| `collect_digits` | `prompt` 链 → `collect_dtmf` |

### D4 — 事件映射

| Step `event.type` | Converact Platform `advanceIvrStep` 输入 |
|-------------------|---------------------------|
| `session_start` | 不 advance，walk 至首个可播 action |
| `dtmf` | `{ dtmf }` |
| `dtmf_timeout` / `dtmf_menu_timeout` | `{ timedOut: true }` |
| `audio_complete` | `{ playCompleted: true }`（`interrupted` 时配合后续 `dtmf`） |

## 配置

- `config/ivr/converact_m1.toml` — Step IVR 定义，`provider.url = http://converact:3000/api/ivr/rustpbx/step`
- `config/rustpbx-routes/m1-ivr.toml` — `application = "ivr:opc-m1"`
- 认证：`X-PBX-Key`（与 call-router 相同）

## 验证

- `test/ivr-step-adapter.test.ts` — M1 menu 链映射
- curl 模拟 Step IVR `session_start` / `dtmf`
- SIP 拨 `40000001@<rustpbx>:5060`（任务 3）

## 未决

- community 镜像 RWI 404 根因（需 restsend 确认或换镜像 tag）
- ~~静态路由 `routes_files` 加载格式~~ **已解决**：见下方

## 附录：routes total=0 根因（2026-06-26）

RustPBX 容器未传 `--conf`，启动日志为 `Loading default config`，挂载的 `/app/rustpbx.toml` 被忽略。

**修复**：`docker-compose.callcenter.yml` 增加 `command: ["--conf", "/app/rustpbx.toml"]`。

**路由文件格式**：

| 位置 | TOML 段名 |
|------|-----------|
| 主配置 `rustpbx.toml` | `[[proxy.routes]]` + `[proxy.routes.match]` |
| `routes_files` 外挂文件 | `[[routes]]` + `[routes.match]`（非 `proxy.routes`） |

修复后日志：`routes reloaded total=1 config_count=1`。
