import { useEffect, useRef, useState } from 'react';
import { getWsUrl } from '../api/client';

export function useWebSocket(onMessage?: (type: string, data: unknown) => void) {
  const [connected, setConnected] = useState(false);
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;

  useEffect(() => {
    const url = getWsUrl();
    if (!url) return;

    const ws = new WebSocket(url);
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as { type?: string; data?: unknown };
        if (msg.type && msg.type !== 'connected') {
          handlerRef.current?.(msg.type, msg.data);
        }
      } catch {
        // ignore malformed frames
      }
    };

    return () => ws.close();
  }, []);

  return { connected };
}
