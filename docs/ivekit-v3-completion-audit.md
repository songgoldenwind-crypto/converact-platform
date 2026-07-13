# iveKit V3 完成审计与验收记录

更新日期：2026-07-13。本文对应 `codex/ivekit-v3-multimodal-translation`，用于记录 V3 多模态智能与翻译从代码审计、交付包到隔离服务器验收的可复验证据。

## 1. 审计范围

包含 OCR、ASR、录制源导入、AI 防绕单质检、人工复核、消息/附件翻译、租户策略、Provider health/preflight、PostgreSQL RLS、durable worker、SDK、参考客户端、Compose/Kubernetes 和独立交付包。

不包含 SIP/VoLTE、RTMP/HLS、数字人，也不把未选择的真实 OCR/ASR/AI/翻译厂商声明为已通过。

## 2. 当前状态

| 门禁 | 状态 | 证据 |
| --- | --- | --- |
| V3 focused tests | passed | Provider、策略、附件、质检、翻译、SDK/UI、standalone 和部署专项持续记录在 Git 历史 |
| TypeScript typecheck | passed | `npm run typecheck` |
| Compose render | passed | standalone 默认/acceptance profile 和 production 均已静态解析 |
| Helm template | pending_server | 本机没有 Helm CLI，目标服务器使用固定容器版本执行 |
| Full repository | pending | Task 19 执行并记录精确数量 |
| Real PostgreSQL/RLS | pending_server | fresh/upgrade/runtime role/跨租户/lease 测试待隔离数据库执行 |
| Controlled Provider HTTP | pending_server | success/timeout/429/5xx/4xx/invalid/oversized 待真实监听验收 |
| Reference browser | pending_server | unit/build/Playwright 待缓存 Playwright 镜像执行 |
| Restart recovery | pending_server | attachment/quality/translation claim 期间重启待执行 |
| Delivery archive | pending | 最终 commit、镜像 digest、manifest 和归档 SHA-256 待绑定 |

## 3. 已关闭的重要审查问题

1. OCR/ASR Provider 响应读取增加 1 MiB 硬上限，避免无界内存占用。
2. OCR/ASR、AI 质检和翻译数据请求统一使用 `redirect=manual`，防止 3xx 绕过已审计 Provider profile URL。
3. Compose/Kubernetes worker 默认关闭；profile、token、policy、preflight 和 health 完成后才启用。
4. Provider token 只从环境变量或 Kubernetes Secret 注入，不进入 profile JSON、API、事件或文档证据。

## 4. 验收事实边界

受控 Provider 只证明 iveKit 的 HTTP 协议、错误分类、重试、脱敏和状态收敛。真实厂商的准确率、配额、合规、账单、区域和生产延迟保持 `not_run`，直到选择厂商并提供目标环境凭据。

LiveKit/Tinode/RustDesk 的历史 V2 证据不会自动升级成当前 V3 release 证据。最终交付 manifest 将分别记录受控环境和真实环境状态，并绑定 source commit、migration、SDK、client、SBOM、image metadata 和验收状态 SHA-256。

## 5. 服务器隔离原则

目标服务器路径使用 `/opt/ivekit-v3-validation/<commit>`，Compose project、network、volume、container、image tag 和 loopback 端口均带 commit 前缀。不得重启或修改现有 LED、iveKit V2、LiveKit、Tinode 或 RustDesk 容器。

## 6. 待补最终证据

Task 19/20 完成后在本文追加：完整命令、测试数量、环境版本、完整 source commit、远端 commit、PostgreSQL 结果、Provider 故障矩阵、浏览器结果、重启恢复结果、镜像 digest、交付目录/归档 SHA-256、secret scan 和全部诚实 `not_run` 项。
