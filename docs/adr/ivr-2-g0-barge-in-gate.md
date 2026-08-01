# ADR: IVR 原则二 2-G0 — RustPBX Barge-in 生产闸门

**Supersedes（M1 路径，ADR-4 E1）：** 自 [`ivr-4-genesys-audio-queue.md`](./ivr-4-genesys-audio-queue.md) 落地起，**队列未 flush 前**的 barge-in 由 `gather_digits.prompt_queue` / `flush_play_queue` 的 `interruptible` 驱动；`IVR_BARGE_IN_PRODUCTION` **不再改变** M1 语义（图配置即行为）。下列 env 闸门仅约束 **独立 `play_audio`** 路径（若生产仍单独下发 play action）。

**Status:** Provisional（Converact Platform Phase B 以环境变量灰度，待 RustPBX 团队书面确认）
**Date:** 2026-06-25

## 背景

原则二要求 `play` 节点在 `bargeIn` / `interruptible` 时，来电方按键可打断播报并将按键传递给后续 `menu`/`collect`（`pendingDigits` / ADR-1.1）。

## 闸门结论（待 RustPBX 确认）

| 项 | Converact Platform 假设（Phase B） | 待确认 |
|----|---------------------|--------|
| `play_audio.interruptible` | 已映射至 RWI（`ivr-rwi-bridge.ts`） | 参数名是否一致 |
| 播中 DTMF | 媒体层 `digits_collected` → `advance({ playCompleted, bargeInDigits })` | 是否停止 TTS 并立即上报 |
| 无原生支持时 | `IVR_BARGE_IN_PRODUCTION` 保持未设置；设计器仍可配置，生产不转换 | 2-G0.3 降级 |

## Converact Platform 决策

1. **Phase A**（已完成）：模拟器 + `interruptible` action + 单元测试。
2. **Phase B**（本 ADR）：`IVR_BARGE_IN_PRODUCTION=1` 时，`advanceIvrStep` 将播中 `dtmf` 转为 `playCompleted + bargeInDigits`（**仅限非 ADR-4 队列路径**）。
3. **默认关闭**：未设环境变量时，独立 play 路径行为与 Phase A 一致（仅 HTTP advance 显式字段生效）。**M1 队列路径不受此项约束**（见 ADR-4 E1）。

## 验证清单（RustPBX）

- [ ] 2-G0.1 `play_audio` 支持 `interruptible: true`
- [ ] 2-G0.2 打断后 `digits_collected` 语义
- [ ] 2-G0.3 不支持时的降级版本号
