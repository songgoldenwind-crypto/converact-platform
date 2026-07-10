import { useAgentWorkbench } from '../hooks/useAgentWorkbench';
import { useScreenRecording } from '../hooks/useScreenRecording';

export default function AgentWorkbenchPage() {
  const {
    seat,
    status,
    statusOptions,
    incoming,
    activeCallId,
    roomName,
    connected,
    onHold,
    error,
    dispositionCodes,
    selectedDisposition,
    setSelectedDisposition,
    transferSeatId,
    setTransferSeatId,
    peerSeats,
    audioContainerRef,
    updateStatus,
    acceptIncoming,
    dismissIncoming,
    toggleHold,
    blindTransfer,
    warmTransfer,
    completeWarmTransfer,
    endActiveCall,
    scriptProgress,
    assistTips,
    transcript,
    advanceScript,
    previewTasks,
    confirmPreviewDial,
    startVideoCall,
    remoteVideoRef,
    remoteScreenShareRef,
    localVideoRef,
    videoActive,
    customerJoinUrl,
    remotePresent,
    remoteScreenShareActive,
    intercomIncoming,
    callPeer,
    acceptIntercom,
    declineIntercom,
    endVideoCall,
    screenShareActive,
    screenSharePending,
    canScreenShare,
    toggleScreenShare
  } = useAgentWorkbench();

  const {
    screenRecordingStatus,
    screenRecordingError,
    startScreenRecording,
    stopScreenRecording,
    isScreenRecording
  } = useScreenRecording();

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">坐席工作台</h2>
          <p className="text-sm text-gray-500">
            {seat ? `${seat.display_name} · ${seat.id}` : '加载坐席中…'}
          </p>
        </div>
        <select
          value={status}
          onChange={(e) => void updateStatus(e.target.value as typeof status)}
          className="text-sm border border-gray-300 rounded-md px-3 py-2"
        >
          {statusOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-600">
          {error}
        </div>
      )}

      {previewTasks.length > 0 && !activeCallId && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 space-y-2">
          <p className="text-sm font-medium text-amber-800">预览拨号队列</p>
          {previewTasks.map((task) => (
            <div key={task.id} className="flex justify-between items-center text-sm">
              <span className="font-mono">{task.phone_number}</span>
              <button
                type="button"
                onClick={() => void confirmPreviewDial(task.id)}
                className="bg-amber-600 text-white px-3 py-1 rounded text-xs"
              >
                确认拨号
              </button>
            </div>
          ))}
        </div>
      )}

      {incoming && (
        <div className="bg-blue-50 border-2 border-blue-400 rounded-xl p-5 shadow-lg animate-pulse">
          <p className="text-xs font-semibold text-blue-600 uppercase tracking-wide mb-2">
            来电
          </p>
          <p className="text-xl font-mono font-bold text-gray-900">{incoming.from || '未知号码'}</p>
          {incoming.customer_summary && (
            <p className="text-sm text-gray-700 mt-2">{incoming.customer_summary}</p>
          )}
          <div className="flex gap-4 mt-3 text-sm text-gray-600">
            <span>意向分：{Math.round((incoming.intent_score || 0) * 100)}%</span>
            {incoming.transfer_reason && <span>原因：{incoming.transfer_reason}</span>}
          </div>
          <div className="flex gap-3 mt-5">
            <button
              type="button"
              onClick={() => void acceptIncoming()}
              className="bg-green-500 hover:bg-green-600 text-white px-5 py-2 rounded-md text-sm font-medium"
            >
              接听
            </button>
            <button
              type="button"
              onClick={dismissIncoming}
              className="border border-gray-300 px-5 py-2 rounded-md text-sm text-gray-700 hover:bg-white"
            >
              忽略
            </button>
          </div>
        </div>
      )}

      {intercomIncoming && (
        <div className="bg-indigo-50 border-2 border-indigo-400 rounded-xl p-5 shadow-lg animate-pulse">
          <p className="text-xs font-semibold text-indigo-600 uppercase tracking-wide mb-2">
            坐席呼叫 · {intercomIncoming.media === 'video' ? '视频' : '语音'}
          </p>
          <p className="text-xl font-bold text-gray-900">{intercomIncoming.from_display_name}</p>
          <div className="flex gap-3 mt-5">
            <button
              type="button"
              onClick={() => void acceptIntercom()}
              className="bg-indigo-500 hover:bg-indigo-600 text-white px-5 py-2 rounded-md text-sm font-medium"
            >
              接听
            </button>
            <button
              type="button"
              onClick={() => void declineIntercom()}
              className="border border-gray-300 px-5 py-2 rounded-md text-sm text-gray-700 hover:bg-white"
            >
              拒接
            </button>
          </div>
        </div>
      )}

      {videoActive && (
        <div className="bg-slate-900 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-white">
              视频通话
              {remotePresent ? (
                <span className="text-green-400 ml-2 text-xs">● 对方已接入</span>
              ) : (
                <span className="text-yellow-400 ml-2 text-xs">● 等待对方加入…</span>
              )}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={!canScreenShare || screenSharePending}
                onClick={() => void toggleScreenShare()}
                className="bg-slate-700 hover:bg-slate-600 text-white px-4 py-1.5 rounded-md text-sm disabled:opacity-50"
              >
                {screenShareActive ? '停止共享' : '共享屏幕'}
              </button>
              <button
                type="button"
                onClick={() => void endVideoCall()}
                className="bg-red-500 hover:bg-red-600 text-white px-4 py-1.5 rounded-md text-sm"
              >
                挂断视频
              </button>
            </div>
          </div>
          <div
            data-testid="agent-video-call"
            className="relative w-full max-w-2xl mx-auto aspect-video bg-black rounded-lg overflow-hidden"
          >
            <div
              data-testid="agent-remote-screen-share"
              ref={remoteScreenShareRef}
              className={`absolute inset-0 bg-black ${remoteScreenShareActive ? '' : 'hidden'}`}
            />
            <div
              data-testid="agent-remote-video"
              ref={remoteVideoRef}
              className={
                remoteScreenShareActive
                  ? 'absolute bottom-3 left-3 w-28 h-20 bg-slate-800 rounded-md overflow-hidden border border-slate-600'
                  : 'absolute inset-0'
              }
            />
            {!remotePresent && (
              <div className="absolute inset-0 flex items-center justify-center text-slate-400 text-sm">
                等待对方加入…
              </div>
            )}
            {remoteScreenShareActive && (
              <div className="absolute top-3 left-3 rounded bg-slate-950/70 px-2 py-1 text-xs text-slate-100">
                屏幕共享
              </div>
            )}
            <div ref={localVideoRef} className="absolute bottom-3 right-3 w-28 h-20 bg-slate-800 rounded-md overflow-hidden border border-slate-600" />
          </div>
          {customerJoinUrl && (
            <div className="bg-slate-800 rounded-lg p-3 space-y-2">
              <p className="text-xs text-slate-300">客户加入链接（发给客户或本地测试用）：</p>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={customerJoinUrl}
                  className="flex-1 text-xs bg-slate-700 text-slate-100 rounded px-2 py-1.5 font-mono"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button
                  type="button"
                  onClick={() => void navigator.clipboard?.writeText(customerJoinUrl)}
                  className="bg-slate-600 hover:bg-slate-500 text-white px-3 py-1.5 rounded text-xs"
                >
                  复制
                </button>
                <a
                  href={customerJoinUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded text-xs"
                >
                  新窗口打开（模拟客户）
                </a>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <p className="text-sm font-medium text-gray-700 mb-3">团队对讲</p>
        {peerSeats.length === 0 ? (
          <p className="text-xs text-gray-400">暂无其他坐席</p>
        ) : (
          <div className="space-y-2">
            {peerSeats.map((peer) => {
              const callable = peer.status === 'idle';
              return (
                <div key={peer.id} className="flex items-center justify-between text-sm">
                  <span className="text-gray-800">
                    {peer.display_name}
                    <span className={`ml-2 text-xs ${callable ? 'text-green-600' : 'text-gray-400'}`}>
                      （{peer.status}）
                    </span>
                  </span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={!callable || videoActive}
                      onClick={() => void callPeer(peer.id, 'voice')}
                      className="border border-indigo-300 text-indigo-700 px-3 py-1 rounded text-xs hover:bg-indigo-50 disabled:opacity-40"
                    >
                      语音
                    </button>
                    <button
                      type="button"
                      disabled={!callable || videoActive}
                      onClick={() => void callPeer(peer.id, 'video')}
                      className="border border-purple-300 text-purple-700 px-3 py-1 rounded text-xs hover:bg-purple-50 disabled:opacity-40"
                    >
                      视频
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-6 min-h-[200px]">
        {activeCallId ? (
          <div className="space-y-4">
            <div>
              <p className="text-sm text-gray-500 mb-1">通话中 {onHold && <span className="text-amber-600">（保持中）</span>}</p>
              <p className="font-mono text-gray-900">{activeCallId}</p>
              <p className="text-sm text-gray-500 mt-1">房间：{roomName}</p>
              <p className="text-sm mt-3">
                {connected ? (
                  <span className="text-green-600">● WebRTC 已连接</span>
                ) : (
                  <span className="text-yellow-600">● 开发模式（无 LiveKit）</span>
                )}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void toggleHold()}
                className="border border-gray-300 px-4 py-2 rounded-md text-sm hover:bg-gray-50"
              >
                {onHold ? '恢复' : '保持'}
              </button>
              <button
                type="button"
                onClick={() => void startVideoCall()}
                className="border border-purple-300 text-purple-800 px-4 py-2 rounded-md text-sm hover:bg-purple-50"
              >
                发起视频
              </button>
              {!isScreenRecording ? (
                <button
                  type="button"
                  onClick={() =>
                    void startScreenRecording({
                      callSessionId: activeCallId,
                      seatId: seat?.id
                    })
                  }
                  disabled={screenRecordingStatus === 'uploading'}
                  className="border border-slate-300 px-4 py-2 rounded-md text-sm hover:bg-gray-50"
                >
                  开始录屏
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => stopScreenRecording()}
                  className="bg-red-600 text-white px-4 py-2 rounded-md text-sm hover:bg-red-700"
                >
                  停止录屏
                </button>
              )}
            </div>
            {(screenRecordingStatus === 'recording' || screenRecordingStatus === 'uploading') && (
              <p className="text-xs text-amber-700">
                {screenRecordingStatus === 'recording' ? '正在录制屏幕…' : '正在保存录屏元数据…'}
              </p>
            )}
            {screenRecordingError && (
              <p className="text-xs text-red-600">{screenRecordingError}</p>
            )}

            <div className="flex flex-wrap gap-2 items-center">
              <select
                value={transferSeatId}
                onChange={(e) => setTransferSeatId(e.target.value)}
                className="text-sm border border-gray-300 rounded-md px-3 py-2"
              >
                <option value="">转接至坐席…</option>
                {peerSeats.map((peer) => (
                  <option key={peer.id} value={peer.id}>
                    {peer.display_name} ({peer.status})
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!transferSeatId}
                onClick={() => void blindTransfer()}
                className="border border-gray-300 px-4 py-2 rounded-md text-sm hover:bg-gray-50 disabled:opacity-50"
              >
                盲转
              </button>
              <button
                type="button"
                disabled={!transferSeatId}
                onClick={() => void warmTransfer()}
                className="border border-amber-300 text-amber-800 px-4 py-2 rounded-md text-sm hover:bg-amber-50 disabled:opacity-50"
              >
                暖转
              </button>
              <button
                type="button"
                disabled={!transferSeatId}
                onClick={() => void completeWarmTransfer()}
                className="border border-green-300 text-green-800 px-4 py-2 rounded-md text-sm hover:bg-green-50 disabled:opacity-50"
              >
                完成暖转
              </button>
            </div>

            <div className="flex flex-wrap gap-2 items-center pt-2 border-t border-gray-100">
              <select
                value={selectedDisposition}
                onChange={(e) => setSelectedDisposition(e.target.value)}
                className="text-sm border border-gray-300 rounded-md px-3 py-2"
              >
                {dispositionCodes.map((code) => (
                  <option key={code.code} value={code.code}>
                    {code.label}
                  </option>
                ))}
                {!dispositionCodes.length && <option value="completed">已完成</option>}
              </select>
              <button
                type="button"
                onClick={() => void endActiveCall()}
                className="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded-md text-sm"
              >
                挂断并保存
              </button>
            </div>

            <div ref={audioContainerRef} className="max-w-md" />

            {scriptProgress && (
              <div className="border border-blue-100 bg-blue-50 rounded-lg p-4 space-y-2">
                <div className="flex justify-between items-center">
                  <p className="text-sm font-medium text-blue-800">话术：{scriptProgress.template_name}</p>
                  <button
                    type="button"
                    onClick={() => void advanceScript()}
                    className="text-xs border border-blue-300 px-2 py-1 rounded text-blue-700"
                  >
                    下一步
                  </button>
                </div>
                <p className="text-sm text-gray-800">
                  {scriptProgress.steps[scriptProgress.current_step_index]?.title || '已完成'}
                </p>
                <p className="text-xs text-gray-600">
                  {scriptProgress.steps[scriptProgress.current_step_index]?.prompt}
                </p>
              </div>
            )}

            {transcript.length > 0 && (
              <div className="border border-gray-200 bg-gray-50 rounded-lg p-4 space-y-2 max-h-64 overflow-y-auto">
                <p className="text-sm font-medium text-gray-700">实时对话</p>
                {transcript.map((turn, idx) => (
                  <div key={idx} className={`text-sm flex gap-2 ${turn.role === 'customer' ? 'justify-start' : 'justify-end'}`}>
                    <div className={`rounded-lg px-3 py-1.5 max-w-[80%] ${turn.role === 'customer' ? 'bg-white border border-gray-200' : 'bg-blue-500 text-white'}`}>
                      <span className="text-xs opacity-60 mr-1">{turn.role === 'customer' ? '客户' : 'AI'}</span>
                      {turn.content}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {assistTips.length > 0 && (
              <div className="border border-amber-100 bg-amber-50 rounded-lg p-4 space-y-2">
                <p className="text-sm font-medium text-amber-800">坐席辅助</p>
                {assistTips.map((tip, idx) => (
                  <div key={idx} className="text-sm text-gray-800">
                    <span className="text-xs uppercase text-amber-600 mr-2">{tip.type}</span>
                    {tip.content}
                    {tip.source && <span className="text-xs text-gray-500 block">来源：{tip.source}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-gray-400 text-center py-12">
            等待来电… 请保持状态为「在线空闲」
          </p>
        )}
      </div>
    </div>
  );
}
