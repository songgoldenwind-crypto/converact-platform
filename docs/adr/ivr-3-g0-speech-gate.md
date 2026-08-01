# ADR: IVR 原则三 3-G0 — gather_speech 生产闸门

**Status:** Provisional（Converact Platform Phase B 以环境变量灰度，待 RustPBX / STT 能力确认）
**Date:** 2026-06-25

## 背景

原则三要求 menu 在 `speechEnabled` 时除 DTMF 外接受语音输入；`resolveMenuInput` 为唯一入口（Phase A：HTTP `speechResult` + 模拟器）。

## 闸门结论（待确认）

| 项 | Converact Platform 假设（Phase B） | 待确认 |
|----|---------------------|--------|
| RWI 命令 | 新增 `gather_speech`（`rwi-types.ts`） | RustPBX 是否实现或改由 LiveKit STT |
| 结果事件 | `speech_result` → `advance({ speechResult })` | 事件名与 payload |
| 无能力时 | `IVR_SPEECH_PRODUCTION` 未设置 → 仍用 `gather_digits` | 3-G0.2 隐藏或 Beta |

## Converact Platform 决策

1. **Phase A**（已完成）：`speechResult` on advance API + `ivr-menu-speech.test.ts`。
2. **Phase B**：`IVR_SPEECH_PRODUCTION=1` 且节点 `speechEnabled` 时，RWI 发 `gather_speech` 而非 `gather_digits`。
3. **默认关闭**：未设环境变量时生产仍仅 DTMF gather。

## 验证清单

- [ ] 3-G0.1 RustPBX / 媒体层 `gather_speech` 支持
- [ ] 3-G0.2 无 STT 时的产品降级文案
- [ ] 3-G0.3 结论回填本 ADR Status
