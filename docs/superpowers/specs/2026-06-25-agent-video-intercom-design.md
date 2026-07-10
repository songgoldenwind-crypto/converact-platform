# 坐席视频通话 + 坐席间互通 设计方案

## 概述

两条实时音视频通话流程，共用 LiveKit 房间作为媒体中枢：
1. **坐席 ↔ 客户视频通话**：坐席发起，客户通过 H5 链接加入，双向音视频
2. **坐席 ↔ 坐席互通**：内部对讲/团队通话，语音或视频

## 核心架构原则：LiveKit 房间是媒体中枢

所有参与者（坐席、客户、未来的 AI 数字人、VoLTE-SIP 腿）都只是"往房间里发布/订阅音视频轨道"。参与者从哪条链路接入对其他参与者透明。

```
现在:   客户 H5 (WebRTC) ──────────────→ LiveKit 房间 ←── 坐席 (WebRTC)
后续:   客户手机 (VoLTE视频) → SIP → RustPBX → livekit-sip → LiveKit 房间 ←── 坐席
```

### 前瞻性接缝（为未来 4G VoLTE 视频 SIP 线路预留）

后续客户腿将通过 `坐席 - LiveKit - RustPBX - SIP线路` 接入 VoLTE 视频。为平滑接入：
- 房间 metadata 记录 `customer_leg_type`（`webrtc` | `sip_volte`），消费方据此区分但不改媒体处理
- 现有 `pstn_bridge` purpose + `livekit-sip` 容器已为音频桥接，VoLTE 视频是把该桥从 audio 扩到 video
- 双画面视频组件、intercom 逻辑均与接入链路无关，未来不需重构

SIP 线路本身后续单独接，本次不实现。

## 流程一：坐席 ↔ 客户视频

后端 `/api/call-center/video/start` 已完整（建 video_service 房间 + 签发 agent token + 返回 customer_join_path）。本次改前端：

- **Hook**：存完整客户加入 URL；远端摄像头/数字人→remoteVideoRef，远端屏幕共享→remoteScreenShareRef，本地摄像头→localVideoRef，音频→隐藏容器；监听 ParticipantConnected/Disconnected 更新客户在线状态
- **坐席 UI**：双画面（对端大画面 + 本地小窗 PiP）；屏幕共享时共享内容占主画面，对端摄像头/数字人保留小窗；客户加入链接可复制 + "在新窗口打开（模拟客户）"；状态提示"等待客户加入/客户已接入"
- **客户端 VideoCallPage**：加本地自预览小窗 + "对方已接入"提示；按 LiveKit track source 区分屏幕共享与摄像头/数字人画面

## 流程二：坐席 ↔ 坐席互通（新增）

现有转接/会议都强绑客户 call_session，无纯坐席直呼。新增：

### 后端
- `POST /api/call-center/intercom/start` — 坐席A 发起：建 `conference` 房间（复用现有 purpose，无迁移）→ 直接返回 A 的 token → 广播 `intercom.incoming`（target_user_id=B、caller 信息、media: voice|video、room_name）
- `POST /api/call-center/intercom/:room/accept` — 坐席B 接听：用该房间名签发 B 的 agent token 返回 → 广播 `intercom.accepted`
- 新事件：`intercom.incoming` / `intercom.accepted` / `intercom.declined` / `intercom.cancelled`

### 信令
复用现有约定：tenant 广播 + 前端按 target_user_id 过滤（与现有 call.incoming 一致，不改 ws.ts）。同租户坐席互信。

### 前端
- 同事列表（peerSeats 按 status==='idle' 筛）+ 每人"语音呼叫""视频呼叫"按钮
- 坐席B 收 intercom.incoming → 来电弹窗（区别客户来电）→ 接听/拒接
- 互通后：语音隐藏视频区，视频走双画面布局（与流程一共用）

## 共用基建

LiveKit 房间/token、双画面视频组件、setCameraEnabled 控制音/视频、setScreenShareEnabled 控制屏幕共享。

## 错误处理

- 拒接/未应答/取消 → intercom.declined/cancelled 事件回传
- 摄像头权限失败 → 不中断，降级音频
- 对端未配置 LiveKit（dev-token）→ 显示链接但跳过真实连接

## 验证（全本地，无需 GPU/真实 SMS/SIP）

- 流程一：workbench 点发起 → 新窗口开客户链接 → 互看视频 → 坐席共享屏幕 → 客户主画面看到共享内容且摄像头/数字人保留小窗
- 流程二：两个浏览器各登录一坐席 → A 呼 B → B 接听 → 互通语音/视频
