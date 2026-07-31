import { useAgentStore } from '../store/agent-store';
import { useLiveKit } from '../hooks/useLiveKit';
import { apiPost } from '../lib/api';

export default function CallRoomPage() {
  const seatId = useAgentStore((s) => s.seatId);
  const currentCall = useAgentStore((s) => s.currentCall);
  const transcript = useAgentStore((s) => s.transcript);
  const setCurrentCall = useAgentStore((s) => s.setCurrentCall);
  const setStatus = useAgentStore((s) => s.setStatus);
  const { connected, videoRef } = useLiveKit(
    currentCall?.room_name || null,
    currentCall?.livekit_token || null
  );

  async function hangup() {
    if (!seatId || !currentCall) return;
    await apiPost(`/api/call-center/seats/${seatId}/hangup`, {
      call_session_id: currentCall.call_session_id
    });
    setCurrentCall(null);
    setStatus('wrap_up');
  }

  if (!currentCall) {
    return <div className="p-8 text-slate-300">当前无通话。请从仪表盘接听队列来电。</div>;
  }

  return (
    <div className="min-h-screen p-6 text-slate-100 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">{currentCall.customer_name || '客户'}</h1>
          <p className="text-xs text-slate-400">{currentCall.call_session_id}</p>
        </div>
        <span className="text-xs">{connected ? '● 已连接' : '○ 连接中'}</span>
      </div>

      <video ref={videoRef} className="w-full max-w-3xl aspect-video bg-black rounded-lg" autoPlay playsInline />

      <div className="bg-slate-800 border border-slate-700 rounded-lg p-4 max-w-3xl">
        <h2 className="text-sm font-medium mb-2">AI 摘要</h2>
        <p className="text-sm text-slate-300">{currentCall.ai_summary || '—'}</p>
      </div>

      <div className="bg-slate-800 border border-slate-700 rounded-lg p-4 max-w-3xl max-h-48 overflow-y-auto">
        {transcript.map((line, index) => (
          <p key={index} className="text-xs text-slate-400">
            <span className="text-slate-500">{line.role}:</span> {line.text}
          </p>
        ))}
      </div>

      <button type="button" onClick={() => void hangup()} className="bg-red-600 hover:bg-red-700 px-4 py-2 rounded text-sm">
        挂断
      </button>
    </div>
  );
}
