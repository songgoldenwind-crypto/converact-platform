import { useEffect } from 'react';
import { apiPost } from '../lib/api';

export function useHeartbeat(seatId: string | null) {
  useEffect(() => {
    if (!seatId) return;
    const tick = () => void apiPost(`/api/call-center/seats/${seatId}/heartbeat`, {}).catch(() => undefined);
    tick();
    const interval = setInterval(tick, 30_000);
    return () => clearInterval(interval);
  }, [seatId]);
}
