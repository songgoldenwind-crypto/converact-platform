import { useEffect } from 'react';
import { useAgentStore } from '../store/agent-store';
import { readAgentAuthStorage } from '../lib/auth-storage';

export function useSSE(seatId: string | null) {
  const setQueue = useAgentStore((s) => s.setQueue);
  const setCurrentCall = useAgentStore((s) => s.setCurrentCall);
  const appendTranscript = useAgentStore((s) => s.appendTranscript);
  const setStatus = useAgentStore((s) => s.setStatus);

  useEffect(() => {
    if (!seatId) return;
    const token = readAgentAuthStorage('token') || '';
    const source = new EventSource(
      `/api/call-center/seats/${seatId}/events?token=${encodeURIComponent(token)}`
    );
    source.addEventListener('queue_update', (e) => {
      const data = JSON.parse(e.data) as { queue: Array<Record<string, unknown>> };
      setQueue(
        data.queue.map((item) => ({
          id: String(item.id),
          call_session_id: String(item.call_session_id),
          room_name: String(item.room_name || ''),
          customer_name: String(item.customer_name || ''),
          customer_phone: String(item.customer_phone || ''),
          customer_summary: String(item.customer_summary || ''),
          intent_score: Number(item.intent_score || 0),
          waitingSince: String(item.enqueued_at || '')
        }))
      );
    });
    source.addEventListener('call_assigned', (e) => {
      const data = JSON.parse(e.data) as Record<string, unknown>;
      setCurrentCall({
        call_session_id: String(data.call_session_id || ''),
        room_name: String((data as { room?: { room_name?: string } }).room?.room_name || data.room_name || ''),
        livekit_token: String((data as { token?: { token?: string } }).token?.token || ''),
        customer_name: String(data.customer_name || ''),
        ai_summary: String(data.customer_summary || '')
      });
      setStatus('busy');
    });
    source.addEventListener('call_ended', () => {
      setCurrentCall(null);
      setStatus('wrap_up');
    });
    source.addEventListener('transcript', (e) => {
      const data = JSON.parse(e.data) as { role?: string; text?: string };
      appendTranscript({ role: String(data.role || 'system'), text: String(data.text || '') });
    });
    return () => source.close();
  }, [seatId, setQueue, setCurrentCall, appendTranscript, setStatus]);
}
