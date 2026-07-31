# ADR-4：IVR 播放队列与同步点（对标 Genesys Architect）

**Status:** Accepted（2026-06-25 Grilling 闭环）  
**Supersedes:** 部分 PL-1「每段 `playCompleted`」语义；ADR `ivr-2-g0-barge-in-gate` 中 M1 路径的 env 闸门策略  
**Implements:** M1 → 全量隐式/显式 flush

## 背景

OPC IVR 拆栈为 **OPC（流程大脑）+ RustPBX（媒体）**。加厚版 ADR-1.1 用 `playCompleted` 逐步回调推进 play，等价于 **G2 逐步回调**，与 Genesys Cloud Architect 的 **播放队列 + 同步点 flush** 不一致。

Grilling（2026-06-25）裁定：**完全对标 Genesys**。

## Genesys 参照行为

| Genesys | OPC 目标态 |
|---------|------------|
| Play Audio **入队**，逻辑继续 | `play.contents` → `context.audioQueue`，**段间不 advance** |
| Menu / Collect / Transfer / Disconnect **隐式 flush** | 进入这些节点前播完 `audioQueue` |
| Flush Audio **显式节点** | 新节点类型 `flush_audio` |
| barge-in 可跳过当前 + 剩余队列 | `bargeInDigits` + 清空 `audioQueue` |
| 设计即运行 | **E1**：图配置即行为，M1 路径不依赖 `IVR_*_PRODUCTION` |

参考：[Genesys Flush Audio](https://help.genesys.cloud/articles/flush-audio-action/)

## 决策

### G1 — 同步点模型

媒体层在同步点保证「播完再继续」，不以 OPC 超时自动 `playCompleted` 作为主路径。

### Q1 — 真·播放队列

- `context.audioQueue: AudioQueueSegment[]` 为播放队列 SSOT
- `play` 节点：解析 `contents` 后 **append** 到 `audioQueue`，沿 `out` 边 **逻辑推进**（不向 RustPBX 每段发 `play_audio`）
- **禁止** 段间 `playCompleted` 驱动 `playQueueIndex++`

### F2 — 隐式 + 显式 flush

| 类型 | 节点 |
|------|------|
| 隐式 | `menu`, `visual_menu`, `collect`, `collect_verify`, `transfer`, `disconnect`, `queue`（waitMusic） |
| 显式 | `flush_audio`（无 prompt，单 `out`） |

### B1 — Barge-in

队列未 flush 时，若当前/队列段 `interruptible`，RustPBX 上报 `bargeInDigits` → OPC 清空 `audioQueue`，digit 进入 `pendingDigits` / Menu。

### E1 — 图配置即行为（M1）

- `menu.bargeIn` / `play.contents[].interruptible` **直接生效**
- **`IVR_BARGE_IN_PRODUCTION` 不再改变 M1 路径语义**（可保留 env 仅用于日志/兼容，不得分叉行为）
- 媒体不支持 → 结构化 `last_error` + 可走 `error` 边，不静默 mock

### M1 — 首个 RustPBX 联调里程碑

`start → play（≥2 段）→ menu`：Menu 入口 flush 队列 + `gather_digits`。

### T1 — 破契约

改写 `ivr-play-sequence.test.ts` 等；不保留 `playQueueMode: legacy` 双轨。

## RWI 契约（M1 最小集）

```typescript
// gather_digits 扩展（或新命令 play_queue_then_gather）
{
  command: 'gather_digits',
  params: {
    call_id: string,
    prompt_queue: Array<{ prompt: string; prompt_type: 'tts'|'audio'; audio_url?: string; interruptible?: boolean }>,
    min_digits: 1,
    max_digits: 1,
    // ...existing gather fields
  },
  waitsForInput: true,
}
```

RustPBX 责任：

1. 按序播完 `prompt_queue`（尊重 `interruptible`）
2. barge-in 时中止剩余队列并上报 `digits_collected`
3. 队列播完后才开始 menu `timeout_sec` 计时

**生产准入：** M1 契约未实现 → IVR 不算生产就绪。

## `context` 字段

| 字段 | 说明 |
|------|------|
| `audioQueue` | 待 flush 的段列表（含 resolved prompt） |
| `audioQueueFlushed` | 可选：本同步点是否已消费队列（防重入） |

**废弃语义（T1）：** 段间用 `playQueueIndex` + `pendingAdvanceNodeId` 驱动多段 play action。

## 验证

- `test/ivr-m1-play-menu.test.ts` — M1 契约
- `test/ivr-play-sequence.test.ts` — 重写为队列语义
- `npm run typecheck` + `npx tsx --test test/ivr*.test.ts`

## 实施计划

见 [`.scratch/ivr-2026-06/plans/2026-06-25-ivr-genesys-audio-queue-plan.md`](../../.scratch/ivr-2026-06/plans/2026-06-25-ivr-genesys-audio-queue-plan.md)
