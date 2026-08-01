# IVR 视频 / DataChannel 事件协议（VC-3）

**Status:** Draft（Converact Platform Phase C 模拟器 + advance API 已落地；LiveKit DataChannel 待联调）
**Date:** 2026-06-25

## 适用范围

| 节点 | 通道 | advance 字段 |
|------|------|--------------|
| `visual_menu` | DataChannel + 并行 DTMF gather | `visualSelection` / `dtmf` |
| `screen_share` | DataChannel 权限 UI | `screenShareEvent` |
| `video_play` | 媒体层播完回调 | `videoEvent` |
| `avatar_switch` | 同步切换（无挂起） | `mediaType=video` 闸门 |

## 会话闸门

- `IvrStepInput.mediaType` 必须为 `'video'` 才能进入 `video_play` / `screen_share` / `avatar_switch`。
- 语音会话（缺省或 `voice`）走各节点 `error` 出边，变量 `video_error=voice_session`。

## visual_menu（VMN-1）

### 下行（Converact Platform → 客户端）

RWI `gather_digits` 的 `metadata.visual_payload`：

```json
{
  "title": "请选择服务",
  "items": [
    { "digit": "1", "label": "销售" },
    { "digit": "2", "label": "支持" }
  ]
}
```

### 上行（客户端 → Converact Platform）

`POST /api/ivr/sessions/:id/advance`：

```json
{ "visualSelection": "2" }
```

等价于 `dtmf: "2"`，统一经 `handleMenuStep` / `resolveMenuInput` 路由。

## screen_share

挂起：`context.waiting.kind === 'video'`（与 video_play 共用等待槽）。

```json
{ "screenShareEvent": { "kind": "accepted" } }
{ "screenShareEvent": { "kind": "denied" } }
{ "screenShareEvent": { "kind": "error", "reason": "permission_denied" } }
```

出边：`out` / `denied` / `error`。

## video_play

```json
{ "videoEvent": { "kind": "completed" } }
{ "videoEvent": { "kind": "skipped" } }
{ "dtmf": "#" }
```

`skippable: true` 时 `#` 与 `skipped` 等效。出边：`out` / `skipped` / `error`。

## 视频桥接命令

见 `ivr-video-bridge.ts`：`switch_avatar` | `play_video` | `screen_share_request`。

## 待 RustPBX / LiveKit 确认

- [ ] DataChannel topic 命名（建议 `converact.ivr`）
- [ ] `visual_selection` 事件是否替代 HTTP advance
- [ ] `record_audio` RWI（VM-1）与 VoicemailStore 回调 URL
